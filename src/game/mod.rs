//! The authoritative game simulation. A single task owns the `World` and
//! advances it at a fixed tick rate. Clients feed it through lock-free input
//! slots and get snapshots encoded into a reusable arena, so a steady-state
//! tick performs no heap allocation.

pub mod ai;
pub mod bomb;
pub mod items;
pub mod link;
pub mod map;
pub mod player;
pub mod rng;

use std::collections::HashMap;
use std::time::{Duration, Instant};

use bytes::{Bytes, BytesMut};
use tokio::sync::{mpsc, oneshot};

use crate::protocol::{self, ArenaRing, ServerMsg, TileChange, Wire};
use bomb::{Bomb, Explosion};
use items::{Item, Mystery};
use link::ClientLink;
use map::{Map, Tile};
use player::{AOI_DEFAULT, AOI_MAX, DIRS, MAX_BOMBS, MAX_RANGE, MAX_SPEED_LVL, Player, step_move};
use rng::Rng;

pub const TICK_RATE: u32 = 20;
pub const DT: f32 = 1.0 / TICK_RATE as f32;
const RESPAWN_TICKS: u64 = 3 * TICK_RATE as u64;
const SPAWN_SHIELD_TICKS: u64 = 2 * TICK_RATE as u64;
const BUCKET: i32 = 8;
const CRATE_DENSITY: f32 = 0.45;
/// Fraction of the initial crate count the map regrows towards.
const CRATE_REGROW_TARGET: f32 = 0.85;
/// Chance that a regrowth spot gets a lone secret box instead of a crate.
const REGROW_MYSTERY_CHANCE: f32 = 0.03;
const LEADERBOARD_EVERY: u64 = TICK_RATE as u64;
const ITEMS_DROPPED_ON_DEATH: usize = 3;
/// Per-arena capacity: a tick's worth of snapshots, and of reliable events.
const SNAPSHOT_ARENA_CAPACITY: usize = 1024 * 1024;
const EVENT_ARENA_CAPACITY: usize = 64 * 1024;

pub struct Config {
    pub map_w: i32,
    pub map_h: i32,
    pub max_players: usize,
    /// AI bots kept in the arena; they make room for humans when full.
    pub bots: usize,
}

/// Rare events from connections. Input doesn't go through here: it's read
/// from each client's `InputSlot` every tick.
pub enum GameEvent {
    Join { name: String, link: ClientLink, reply: oneshot::Sender<Result<u32, &'static str>> },
    Leave { id: u32 },
}

/// Buffers reused every tick so the hot path doesn't allocate.
#[derive(Default)]
struct Scratch {
    ids: Vec<u32>,
    bomb_ids: Vec<u32>,
    chain: Vec<u32>,
    blast: Vec<(usize, u8, i32, i32)>,
    drops: Vec<(i32, i32, Item)>,
    victims: Vec<(u32, u32)>,
    broadcasts: Vec<Bytes>,
    dropped: Vec<u32>,
}

pub struct World {
    pub tick: u64,
    pub map: Map,
    pub rng: Rng,
    max_players: usize,
    pub players: HashMap<u32, Player>,
    next_player_id: u32,
    pub bombs: HashMap<u32, Bomb>,
    pub bomb_grid: Vec<u32>,
    pub next_bomb_id: u32,
    pub items: Vec<u8>,
    pub flame_until: Vec<u64>,
    pub flame_owner: Vec<u32>,
    pub explosions: Vec<Explosion>,
    /// Tile changes made during the current tick, sent to every client.
    pub tile_changes: Vec<TileChange>,
    crate_target: usize,
    crate_count: usize,
    buckets: Vec<Vec<u32>>,
    buckets_w: i32,
    /// Messages for everyone (joins, leaves, kills), flushed each tick.
    broadcasts: Vec<Bytes>,
    /// Brains of the server-side bots, keyed by player id.
    pub bots: HashMap<u32, ai::BotBrain>,
    /// Bot ids in ascending order, for a stable update order.
    bot_ids: Vec<u32>,
    target_bots: usize,
    bots_created: usize,
    pub stats: WorldStats,
    /// All outgoing messages are encoded here; each message is a zero-copy
    /// slice of it.
    snapshot_arenas: ArenaRing,
    /// Reliable events use their own arenas, so a slow client holding queued
    /// events never pins the (much larger) snapshot buffers.
    event_arenas: ArenaRing,
    scratch: Scratch,
    ai_scratch: ai::AiScratch,
}

/// Running totals, handy for logs and for judging the bots in tests.
#[derive(Default, Debug, Clone, Copy)]
pub struct WorldStats {
    pub deaths: u64,
    pub suicides: u64,
    pub crates_destroyed: u64,
    pub items_picked: u64,
    pub mysteries_opened: u64,
}

impl World {
    pub fn new(cfg: &Config) -> Self {
        let mut rng = Rng::from_time();
        let map = Map::generate(cfg.map_w, cfg.map_h, CRATE_DENSITY, &mut rng);
        let mut world = Self::with_map(map, rng, cfg.max_players);
        world.set_target_bots(cfg.bots);
        world
    }

    pub fn with_map(map: Map, rng: Rng, max_players: usize) -> Self {
        let n = (map.w * map.h) as usize;
        let crate_count = map.count(Tile::Crate);
        let buckets_w = (map.w + BUCKET - 1) / BUCKET;
        let buckets_h = (map.h + BUCKET - 1) / BUCKET;
        World {
            tick: 0,
            rng,
            max_players,
            players: HashMap::with_capacity(max_players),
            next_player_id: 0,
            bombs: HashMap::with_capacity(max_players * 2),
            bomb_grid: vec![0; n],
            next_bomb_id: 0,
            items: vec![0; n],
            flame_until: vec![0; n],
            flame_owner: vec![0; n],
            explosions: Vec::new(),
            tile_changes: Vec::new(),
            crate_target: (crate_count as f32 * CRATE_REGROW_TARGET) as usize,
            crate_count,
            buckets: vec![Vec::new(); (buckets_w * buckets_h) as usize],
            buckets_w,
            broadcasts: Vec::new(),
            bots: HashMap::new(),
            bot_ids: Vec::new(),
            target_bots: 0,
            bots_created: 0,
            stats: WorldStats::default(),
            snapshot_arenas: ArenaRing::new(SNAPSHOT_ARENA_CAPACITY),
            event_arenas: ArenaRing::new(EVENT_ARENA_CAPACITY),
            scratch: Scratch::default(),
            ai_scratch: ai::AiScratch::new(n),
            map,
        }
    }

    pub fn set_target_bots(&mut self, bots: usize) {
        self.target_bots = bots.min(self.max_players);
        self.maintain_bots();
    }

    pub fn set_tile(&mut self, x: i32, y: i32, t: Tile) {
        let old = self.map.get(x, y);
        if old == t {
            return;
        }
        if old == Tile::Crate {
            self.crate_count -= 1;
        }
        if t == Tile::Crate {
            self.crate_count += 1;
        }
        self.map.set(x, y, t);
        self.tile_changes.push((x, y, t as u8));
    }

    // ---------------------------------------------------------------- players

    pub fn join(&mut self, name: String, link: ClientLink) -> Result<u32, &'static str> {
        if self.players.len() >= self.max_players {
            // Humans take priority: a bot steps out to make room.
            let Some(&bot) = self.bot_ids.first() else {
                return Err("server is full, try again later");
            };
            self.leave(bot);
        }
        let id = self.spawn_player(name, Some(link));
        let p = &self.players[&id];
        let welcome = ServerMsg::Welcome {
            id,
            w: self.map.w,
            h: self.map.h,
            map: self.map.encode_rle(),
            rate: TICK_RATE,
            aoi: AOI_DEFAULT,
            aoi_max: AOI_MAX,
            roster: self.players.values().map(|o| (o.id, o.name.as_str())).collect(),
        };
        if let Some(link) = &p.link {
            let _ = link.events.try_send(welcome.encode());
        }
        Ok(id)
    }

    /// Creates a living player at a safe spot and announces it to everyone.
    fn spawn_player(&mut self, name: String, link: Option<ClientLink>) -> u32 {
        self.next_player_id += 1;
        let id = self.next_player_id;
        let mut p = Player::new(id, name, link);
        let (x, y) = self.find_spawn();
        p.x = x as f32 + 0.5;
        p.y = y as f32 + 0.5;
        p.alive = true;
        p.invulnerable_until = self.tick + SPAWN_SHIELD_TICKS;
        self.broadcasts.push(protocol::encode_pj(self.event_arenas.current(), id, &p.name));
        self.players.insert(id, p);
        self.rebuild_buckets();
        id
    }

    pub fn add_bot(&mut self) -> u32 {
        let name = ai::bot_name(self.bots_created);
        self.bots_created += 1;
        let id = self.spawn_player(name, None);
        let brain = ai::BotBrain::new(&mut self.rng);
        self.bots.insert(id, brain);
        self.bot_ids.push(id); // ids only grow, so this stays sorted
        id
    }

    /// Tops the bot population back up to the target while there's room.
    fn maintain_bots(&mut self) {
        while self.bots.len() < self.target_bots && self.players.len() < self.max_players {
            self.add_bot();
        }
    }

    pub fn leave(&mut self, id: u32) {
        if self.bots.remove(&id).is_some() {
            self.bot_ids.retain(|&b| b != id);
        }
        if self.players.remove(&id).is_some() {
            self.broadcasts.push(protocol::encode_pl(self.event_arenas.current(), id));
        }
    }

    /// Finds an open cell away from bombs, fire and other players, with room
    /// to escape from a first bomb. Carves space as a last resort.
    fn find_spawn(&mut self) -> (i32, i32) {
        for attempt in 0..400 {
            let x = self.rng.between(1, self.map.w - 2);
            let y = self.rng.between(1, self.map.h - 2);
            if self.map.is_solid(x, y) || self.bomb_at(x, y).is_some() {
                continue;
            }
            if self.danger_near(x, y, 4) {
                continue;
            }
            if attempt < 300 && self.players_in_rect(x - 3, y - 3, x + 3, y + 3).any(|p| p.alive) {
                continue;
            }
            if self.open_cells_near(x, y) >= 4 {
                return (x, y);
            }
        }
        // Carve: pick a lane intersection and clear the crates around it.
        let x = self.rng.between(0, (self.map.w - 3) / 2) * 2 + 1;
        let y = self.rng.between(0, (self.map.h - 3) / 2) * 2 + 1;
        for (dx, dy) in [(0, 0), (1, 0), (-1, 0), (0, 1), (0, -1), (2, 0), (0, 2)] {
            let (cx, cy) = (x + dx, y + dy);
            if self.map.get(cx, cy) == Tile::Crate {
                self.set_tile(cx, cy, Tile::Floor);
            }
        }
        (x, y)
    }

    fn danger_near(&self, x: i32, y: i32, r: i32) -> bool {
        for cy in (y - r).max(0)..=(y + r).min(self.map.h - 1) {
            for cx in (x - r).max(0)..=(x + r).min(self.map.w - 1) {
                let i = self.map.idx(cx, cy);
                if self.bomb_grid[i] != 0 || self.flame_until[i] > self.tick {
                    return true;
                }
            }
        }
        false
    }

    /// Counts floor cells reachable from (x, y) within 3 steps. A breadth-
    /// first search over a stack array: at most 25 cells are that close.
    fn open_cells_near(&self, x: i32, y: i32) -> usize {
        let mut seen = [(0i32, 0i32); 25];
        seen[0] = (x, y);
        let (mut len, mut start) = (1, 0);
        for _ in 0..3 {
            let end = len;
            for k in start..end {
                let (cx, cy) = seen[k];
                for &(dx, dy) in &DIRS[1..] {
                    let c = (cx + dx, cy + dy);
                    if !self.map.is_solid(c.0, c.1) && !seen[..len].contains(&c) {
                        seen[len] = c;
                        len += 1;
                    }
                }
            }
            start = end;
        }
        len
    }

    fn kill(&mut self, victim: u32, killer: Option<u32>) {
        let Some(v) = self.players.get_mut(&victim) else { return };
        v.alive = false;
        v.moving = false;
        v.deaths += 1;
        v.respawn_at = self.tick + RESPAWN_TICKS;
        v.killed_by = killer;
        let (vx, vy) = (v.x, v.y);
        let (cx, cy) = v.cell();

        // Lose upgrades; a few of them are scattered for others to grab.
        let mut lost = [Item::ExtraBomb; 32];
        let mut n = 0;
        let mut lose = |item: Item, count: u8| {
            for _ in 0..count {
                lost[n] = item;
                n += 1;
            }
        };
        lose(Item::ExtraBomb, v.max_bombs - player::BASE_BOMBS);
        lose(Item::Range, v.range - player::BASE_RANGE);
        lose(Item::Speed, v.speed_lvl);
        lose(Item::Kick, v.kick as u8);
        lose(Item::Pierce, v.pierce as u8);
        v.reset_stats();
        for _ in 0..ITEMS_DROPPED_ON_DEATH.min(n) {
            let k = self.rng.below(n as u32) as usize;
            let item = lost[k];
            lost[k] = lost[n - 1];
            n -= 1;
            for _ in 0..20 {
                let x = cx + self.rng.between(-3, 3);
                let y = cy + self.rng.between(-3, 3);
                if self.map.in_bounds(x, y) && !self.map.is_solid(x, y) {
                    let i = self.map.idx(x, y);
                    if self.items[i] == 0 && self.bomb_grid[i] == 0 {
                        self.items[i] = item as u8;
                        break;
                    }
                }
            }
        }

        let killer = killer.filter(|k| self.players.contains_key(k));
        self.stats.deaths += 1;
        match killer {
            Some(k) if k == victim => {
                self.stats.suicides += 1;
                self.players.get_mut(&k).unwrap().score -= 1;
            }
            Some(k) => {
                let kp = self.players.get_mut(&k).unwrap();
                kp.score += 1;
                kp.kills += 1;
            }
            None => {}
        }
        self.broadcasts.push(protocol::encode_kill(self.event_arenas.current(), killer, victim, vx, vy));
    }

    /// Copies each client's latest input from its lock-free slot.
    fn read_inputs(&mut self) {
        for p in self.players.values_mut() {
            let Some(link) = &p.link else { continue };
            (p.input_dir, p.input_alt) = link.input.dirs();
            let presses = link.input.bomb_presses();
            if presses != p.bomb_presses {
                p.bomb_presses = presses;
                p.want_bomb = true;
            }
            if let Some((w, h)) = link.input.view() {
                p.set_aoi(w, h);
            }
        }
    }

    /// Gives a power-up's effect to a player.
    fn grant(p: &mut Player, item: Item, tick: u64) {
        match item {
            Item::ExtraBomb => p.max_bombs = (p.max_bombs + 1).min(MAX_BOMBS),
            Item::Range => p.range = (p.range + 1).min(MAX_RANGE),
            Item::Speed => p.speed_lvl = (p.speed_lvl + 1).min(MAX_SPEED_LVL),
            Item::Kick => p.kick = true,
            Item::Shield => p.invulnerable_until = p.invulnerable_until.max(tick + items::SHIELD_TICKS),
            Item::Pierce => p.pierce = true,
            Item::FullFire => p.range = MAX_RANGE,
            Item::Mystery => {}
        }
    }

    /// Applies a picked-up item and tells the player what they got.
    fn pick_up(&mut self, id: u32, item: Item) {
        self.stats.items_picked += 1;
        let tick = self.tick;
        let (code, mystery) = if item == Item::Mystery {
            self.stats.mysteries_opened += 1;
            let outcome = Mystery::open(&mut self.rng);
            let p = self.players.get_mut(&id).unwrap();
            match outcome {
                Mystery::Item(i) => Self::grant(p, i, tick),
                Mystery::Jackpot => {
                    Self::grant(p, Item::ExtraBomb, tick);
                    Self::grant(p, Item::Range, tick);
                    Self::grant(p, Item::Speed, tick);
                }
                Mystery::Slow => p.slow_until = tick + items::SLOW_CURSE_TICKS,
                Mystery::NoBomb => p.nobomb_until = tick + items::NOBOMB_CURSE_TICKS,
            }
            (outcome.code(), true)
        } else {
            Self::grant(self.players.get_mut(&id).unwrap(), item, tick);
            (item as u8, false)
        };
        if let Some(link) = &self.players[&id].link {
            let _ = link.events.try_send(protocol::encode_fx(self.event_arenas.current(), code, mystery));
        }
    }

    fn update_players(&mut self) {
        let mut ids = std::mem::take(&mut self.scratch.ids);
        ids.clear();
        ids.extend(self.players.keys().copied());
        ids.sort_unstable();
        for &id in &ids {
            let p = &self.players[&id];
            if !p.alive {
                if self.tick >= p.respawn_at {
                    let (x, y) = self.find_spawn();
                    let p = self.players.get_mut(&id).unwrap();
                    p.x = x as f32 + 0.5;
                    p.y = y as f32 + 0.5;
                    p.alive = true;
                    p.killed_by = None;
                    p.want_bomb = false;
                    p.invulnerable_until = self.tick + SPAWN_SHIELD_TICKS;
                }
                continue;
            }

            let (dir, alt) = (p.input_dir, p.input_alt);
            let start = (p.x, p.y);
            let start_cell = p.cell();
            let dist = p.speed(self.tick) * DT;
            let (mut x, mut y) = start;
            let mut used = dir;
            {
                let map = &self.map;
                let bomb_grid = &self.bomb_grid;
                // A bomb blocks unless it's in the cell the player stands in,
                // which lets players walk off a bomb they just dropped.
                let blocked =
                    |cx: i32, cy: i32| map.is_solid(cx, cy) || ((cx, cy) != start_cell && bomb_grid[map.idx(cx, cy)] != 0);
                if dir != 0 {
                    step_move(&mut x, &mut y, dir, dist, blocked);
                }
                // Turn buffering: if the newest direction is blocked, keep
                // going the way the still-held older key points until the
                // turn opens up.
                if (x, y) == start && alt != 0 && alt != dir {
                    step_move(&mut x, &mut y, alt, dist, blocked);
                    used = alt;
                }
            }
            let p = self.players.get_mut(&id).unwrap();
            p.moving = (x, y) != start;
            if p.moving {
                p.facing = used;
            } else if dir != 0 {
                p.facing = dir;
            }
            p.x = x;
            p.y = y;
            let (cx, cy) = p.cell();
            let has_kick = p.kick;
            let moving = p.moving;

            // Kick: pressing into an adjacent bomb while standing at the
            // centre of the cell sends it sliding. A player boxed in by bombs
            // may kick even without the power-up, so they're never stuck.
            if dir != 0 && !moving && (has_kick || self.is_trapped(cx, cy)) {
                let (dx, dy) = DIRS[dir as usize];
                if let Some(b) = self.bomb_at(cx + dx, cy + dy) {
                    self.kick_bomb(b, dir);
                }
            }

            let i = self.map.idx(cx, cy);
            if let Some(item) = Item::from_u8(self.items[i]) {
                self.items[i] = 0;
                self.pick_up(id, item);
            }

            if std::mem::take(&mut self.players.get_mut(&id).unwrap().want_bomb) {
                self.place_bomb(id);
            }
        }
        self.scratch.ids = ids;
    }

    /// True when every neighbouring cell is blocked and at least one of
    /// them by a bomb, i.e. the player can't walk away from (x, y).
    fn is_trapped(&self, x: i32, y: i32) -> bool {
        let mut bomb_blocked = false;
        for &(dx, dy) in &DIRS[1..] {
            let (nx, ny) = (x + dx, y + dy);
            if self.bomb_at(nx, ny).is_some() {
                bomb_blocked = true;
            } else if !self.map.is_solid(nx, ny) {
                return false;
            }
        }
        bomb_blocked
    }

    fn apply_flame_damage(&mut self) {
        let mut victims = std::mem::take(&mut self.scratch.victims);
        victims.clear();
        victims.extend(self.players.values().filter(|p| p.alive && p.invulnerable_until <= self.tick).filter_map(|p| {
            let (x, y) = p.cell();
            self.flame_active(x, y).then(|| (p.id, self.flame_owner[self.map.idx(x, y)]))
        }));
        for &(v, k) in &victims {
            self.kill(v, Some(k));
        }
        self.scratch.victims = victims;
    }

    /// Slowly regrows crates in quiet areas so the big map never runs dry,
    /// occasionally leaving a lone secret box instead.
    fn regrow_crates(&mut self) {
        if self.tick % TICK_RATE as u64 != 0 || self.crate_count >= self.crate_target {
            return;
        }
        let attempts = ((self.map.w * self.map.h) / 300).max(4);
        let mut grown = 0;
        let max_grow = (self.crate_target - self.crate_count).min(attempts as usize);
        for _ in 0..attempts {
            if grown >= max_grow {
                break;
            }
            let x = self.rng.between(1, self.map.w - 2);
            let y = self.rng.between(1, self.map.h - 2);
            if self.map.get(x, y) != Tile::Floor {
                continue;
            }
            let i = self.map.idx(x, y);
            if self.items[i] != 0 || self.danger_near(x, y, 1) {
                continue;
            }
            if self.players_in_rect(x - 4, y - 4, x + 4, y + 4).any(|p| p.alive) {
                continue;
            }
            if self.rng.chance(REGROW_MYSTERY_CHANCE) {
                self.items[i] = Item::Mystery as u8;
            } else {
                self.set_tile(x, y, Tile::Crate);
            }
            grown += 1;
        }
    }

    // ------------------------------------------------------- spatial queries

    fn rebuild_buckets(&mut self) {
        for b in &mut self.buckets {
            b.clear();
        }
        for p in self.players.values() {
            let (x, y) = p.cell();
            let bi = ((y / BUCKET) * self.buckets_w + x / BUCKET) as usize;
            if let Some(b) = self.buckets.get_mut(bi) {
                b.push(p.id);
            }
        }
    }

    /// Players whose cell lies inside the inclusive tile rectangle.
    pub fn players_in_rect(&self, x0: i32, y0: i32, x1: i32, y1: i32) -> impl Iterator<Item = &Player> {
        let bx0 = x0.max(0) / BUCKET;
        let by0 = y0.max(0) / BUCKET;
        let bx1 = x1.min(self.map.w - 1) / BUCKET;
        let by1 = y1.min(self.map.h - 1) / BUCKET;
        (by0..=by1)
            .flat_map(move |by| (bx0..=bx1).map(move |bx| (by * self.buckets_w + bx) as usize))
            .flat_map(move |bi| self.buckets[bi].iter())
            .filter_map(move |id| self.players.get(id))
            .filter(move |p| {
                let (x, y) = p.cell();
                x >= x0 && x <= x1 && y >= y0 && y <= y1
            })
    }

    /// Writes one client's snapshot into the arena and returns it as a
    /// zero-copy slice. Arrays are written with back-patched lengths, so no
    /// intermediate lists are built.
    fn encode_snapshot(&self, arena: &mut BytesMut, p: &Player) -> Bytes {
        let (cx, cy) = p.cell();
        let (x0, y0, x1, y1) = aoi_rect(cx, cy, p.aoi);
        let tick = self.tick;
        let mut w = Wire(arena);
        w.map(8).key("t").str("s").key("k").uint(tick);

        w.key("p");
        let at = w.open_arr();
        let mut n = 0;
        for o in self.players_in_rect(x0, y0, x1, y1).filter(|o| o.alive) {
            let flags = o.moving as u8 | ((o.invulnerable_until > tick) as u8) << 1 | ((o.curse(tick).0 != 0) as u8) << 2;
            w.arr(5).uint(o.id as u64).int((o.x * 100.0) as i64).int((o.y * 100.0) as i64).uint(o.facing as u64).uint(flags as u64);
            n += 1;
        }
        w.close_arr(at, n);

        // Bombs and items come from one pass over the visible cells.
        let (bx0, by0, bx1, by1) = (x0.max(0), y0.max(0), x1.min(self.map.w - 1), y1.min(self.map.h - 1));
        w.key("b");
        let at = w.open_arr();
        let mut n = 0;
        for y in by0..=by1 {
            for x in bx0..=bx1 {
                let id = self.bomb_grid[self.map.idx(x, y)];
                if id != 0 {
                    let b = &self.bombs[&id];
                    let fuse = b.explode_at.saturating_sub(tick);
                    w.arr(5).uint(id as u64).int(x as i64).int(y as i64).uint(fuse).uint(b.pierce as u64);
                    n += 1;
                }
            }
        }
        w.close_arr(at, n);

        let reach = MAX_RANGE as i32;
        w.key("e");
        let at = w.open_arr();
        let mut n = 0;
        for e in &self.explosions {
            if e.x >= x0 - reach && e.x <= x1 + reach && e.y >= y0 - reach && e.y <= y1 + reach {
                w.arr(4).int(e.x as i64).int(e.y as i64);
                w.arr(4);
                for a in e.arms {
                    w.uint(a as u64);
                }
                w.uint(e.until - tick);
                n += 1;
            }
        }
        w.close_arr(at, n);

        w.key("i");
        let at = w.open_arr();
        let mut n = 0;
        for y in by0..=by1 {
            for x in bx0..=bx1 {
                let kind = self.items[self.map.idx(x, y)];
                if kind != 0 {
                    w.arr(3).int(x as i64).int(y as i64).uint(kind as u64);
                    n += 1;
                }
            }
        }
        w.close_arr(at, n);

        w.key("tc").arr(self.tile_changes.len());
        for &(x, y, t) in &self.tile_changes {
            w.arr(3).int(x as i64).int(y as i64).uint(t as u64);
        }

        let (curse, curse_t) = p.curse(tick);
        w.key("me").map(14);
        w.key("alive").bool(p.alive);
        w.key("bombs").uint(p.max_bombs as u64);
        w.key("active").uint(p.active_bombs as u64);
        w.key("range").uint(p.range as u64);
        w.key("speed").uint(p.speed_lvl as u64);
        w.key("kick").bool(p.kick);
        w.key("pierce").bool(p.pierce);
        w.key("shield").uint(p.invulnerable_until.saturating_sub(tick));
        w.key("curse").uint(curse as u64);
        w.key("curse_t").uint(curse_t);
        w.key("score").int(p.score as i64);
        w.key("respawn").uint(if p.alive { 0 } else { p.respawn_at.saturating_sub(tick) });
        w.key("killer").opt_uint(p.killed_by);
        w.key("aoi").arr(2).int(p.aoi.0 as i64).int(p.aoi.1 as i64);
        protocol::finish(arena)
    }

    fn encode_leaderboard(&mut self) -> Bytes {
        let mut top = std::mem::take(&mut self.scratch.ids);
        top.clear();
        top.extend(self.players.keys().copied());
        let players = &self.players;
        let key = |id: &u32| {
            let p = &players[id];
            (std::cmp::Reverse(p.score), std::cmp::Reverse(p.kills), p.id)
        };
        let k = top.len().min(10);
        if k > 0 && k < top.len() {
            top.select_nth_unstable_by_key(k - 1, key);
        }
        top.truncate(k);
        top.sort_unstable_by_key(key);
        let entries = top.iter().map(|id| {
            let p = &players[id];
            (p.id, p.name.as_str(), p.score, p.kills, p.deaths)
        });
        let msg = protocol::encode_lb(self.event_arenas.current(), players.len(), entries);
        self.scratch.ids = top;
        msg
    }

    // ------------------------------------------------------------- the tick

    pub fn handle(&mut self, ev: GameEvent) {
        match ev {
            GameEvent::Join { name, link, reply } => {
                let _ = reply.send(self.join(name, link));
            }
            GameEvent::Leave { id } => self.leave(id),
        }
    }

    /// Advances the simulation by one tick (without networking).
    pub fn step(&mut self) {
        self.tick += 1;
        self.tile_changes.clear();
        self.event_arenas.rotate();
        let tick = self.tick;
        self.explosions.retain(|e| e.until > tick);
        self.read_inputs();
        self.update_bots();
        self.update_players();
        self.rebuild_buckets();
        self.update_sliding_bombs();
        self.update_fuses();
        self.apply_flame_damage();
        self.regrow_crates();
        if self.tick % TICK_RATE as u64 == 0 {
            self.maintain_bots();
        }
    }

    /// Sends this tick's broadcasts and publishes each client's snapshot.
    /// Clients whose reliable event queue is full or closed are collected in
    /// `scratch.dropped`.
    pub fn send_updates(&mut self) {
        let mut broadcasts = std::mem::take(&mut self.scratch.broadcasts);
        broadcasts.clear();
        broadcasts.append(&mut self.broadcasts);
        if self.tick % LEADERBOARD_EVERY == 0 {
            let lb = self.encode_leaderboard();
            broadcasts.push(lb);
        }
        let mut ring = std::mem::take(&mut self.snapshot_arenas);
        let arena = ring.rotate();
        let mut dropped = std::mem::take(&mut self.scratch.dropped);
        dropped.clear();
        for p in self.players.values() {
            let Some(link) = &p.link else { continue };
            if !broadcasts.iter().all(|m| link.events.try_send(m.clone()).is_ok()) {
                dropped.push(p.id);
                continue;
            }
            link.snapshot.publish(self.encode_snapshot(arena, p));
        }
        self.snapshot_arenas = ring;
        broadcasts.clear();
        self.scratch.broadcasts = broadcasts;
        self.scratch.dropped = dropped;
    }

    /// Clients that couldn't keep up with reliable events this tick.
    pub fn dropped_clients(&self) -> &[u32] {
        &self.scratch.dropped
    }

    pub fn drop_lagging_clients(&mut self) {
        let dropped = std::mem::take(&mut self.scratch.dropped);
        for &id in &dropped {
            tracing::info!(id, "dropping slow or closed client");
            self.leave(id);
        }
        self.scratch.dropped = dropped;
    }
}

/// Inclusive tile rectangle a player at (cx, cy) receives updates for.
pub fn aoi_rect(cx: i32, cy: i32, (hw, hh): (i32, i32)) -> (i32, i32, i32, i32) {
    (cx - hw, cy - hh, cx + hw, cy + hh)
}

pub async fn run(cfg: Config, mut events: mpsc::Receiver<GameEvent>) {
    let mut world = World::new(&cfg);
    tracing::info!(w = cfg.map_w, h = cfg.map_h, crates = world.crate_count, bots = world.bots.len(), "world generated");
    let mut interval = tokio::time::interval(Duration::from_millis(1000 / TICK_RATE as u64));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    let mut stats_since = Instant::now();
    let (mut ticks, mut busy, mut worst) = (0u32, Duration::ZERO, Duration::ZERO);
    loop {
        interval.tick().await;
        let started = Instant::now();
        loop {
            match events.try_recv() {
                Ok(ev) => world.handle(ev),
                Err(mpsc::error::TryRecvError::Empty) => break,
                Err(mpsc::error::TryRecvError::Disconnected) => return,
            }
        }
        world.step();
        world.send_updates();
        world.drop_lagging_clients();

        let took = started.elapsed();
        ticks += 1;
        busy += took;
        worst = worst.max(took);
        if stats_since.elapsed() >= Duration::from_secs(10) {
            tracing::info!(
                players = world.players.len(),
                bots = world.bots.len(),
                bombs = world.bombs.len(),
                avg_tick_ms = format!("{:.2}", busy.as_secs_f64() * 1000.0 / ticks as f64),
                max_tick_ms = format!("{:.2}", worst.as_secs_f64() * 1000.0),
                "tick stats"
            );
            stats_since = Instant::now();
            (ticks, busy, worst) = (0, Duration::ZERO, Duration::ZERO);
        }
    }
}

/// A client link plus the receiving ends, for tests and benchmarks.
pub fn test_link() -> (ClientLink, mpsc::Receiver<Bytes>) {
    let (events, rx) = mpsc::channel(link::EVENT_QUEUE);
    let link = ClientLink { events, snapshot: Default::default(), input: Default::default() };
    (link, rx)
}

#[cfg(test)]
pub fn test_world(map: Map) -> World {
    World::with_map(map, Rng::new(3), 64)
}

#[cfg(test)]
impl World {
    pub fn spawn_test_player(&mut self, x: f32, y: f32) -> u32 {
        let (link, rx) = test_link();
        std::mem::forget(rx);
        self.next_player_id += 1;
        let id = self.next_player_id;
        let mut p = Player::new(id, format!("p{id}"), Some(link));
        p.x = x;
        p.y = y;
        p.alive = true;
        self.players.insert(id, p);
        self.rebuild_buckets();
        id
    }

    /// Simulates the client holding `dir` (with fallback `alt`).
    fn hold(&mut self, id: u32, dir: u8, alt: u8) {
        self.players[&id].link.as_ref().unwrap().input.set_dirs(dir, alt);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aoi_only_includes_nearby_players() {
        let mut w = test_world(Map::empty(81, 81));
        let me = w.spawn_test_player(10.5, 10.5);
        let near = w.spawn_test_player(20.5, 15.5);
        let far = w.spawn_test_player(60.5, 60.5);
        let (x0, y0, x1, y1) = aoi_rect(10, 10, AOI_DEFAULT);
        let ids: Vec<u32> = w.players_in_rect(x0, y0, x1, y1).map(|p| p.id).collect();
        assert!(ids.contains(&me) && ids.contains(&near));
        assert!(!ids.contains(&far));
        let mut arena = BytesMut::new();
        let snap: serde_json::Value = rmp_serde::from_slice(&w.encode_snapshot(&mut arena, &w.players[&me])).unwrap();
        assert_eq!(snap["t"], "s");
        let seen: Vec<u64> = snap["p"].as_array().unwrap().iter().map(|p| p[0].as_u64().unwrap()).collect();
        assert!(seen.contains(&(me as u64)) && seen.contains(&(near as u64)));
        assert!(!seen.contains(&(far as u64)));
    }

    #[test]
    fn snapshot_has_every_field() {
        let mut map = Map::empty(21, 21);
        map.set(5, 5, Tile::Crate);
        let mut w = test_world(map);
        let me = w.spawn_test_player(3.5, 3.5);
        w.place_bomb(me);
        let i = w.map.idx(3, 5);
        w.items[i] = Item::Mystery as u8;
        w.set_tile(5, 5, Tile::Floor);
        let mut arena = BytesMut::new();
        let snap: serde_json::Value = rmp_serde::from_slice(&w.encode_snapshot(&mut arena, &w.players[&me])).unwrap();
        assert_eq!(snap["k"], 0);
        assert_eq!(snap["p"][0], serde_json::json!([me, 350, 350, 3, 0]));
        assert_eq!(snap["b"][0], serde_json::json!([1, 3, 3, bomb::FUSE_TICKS, 0]));
        assert_eq!(snap["e"], serde_json::json!([]));
        assert_eq!(snap["i"], serde_json::json!([[3, 5, 8]]));
        assert_eq!(snap["tc"], serde_json::json!([[5, 5, 0]]));
        let me_v = &snap["me"];
        assert_eq!(me_v["alive"], true);
        assert_eq!(me_v["active"], 1);
        assert_eq!(me_v["killer"], serde_json::Value::Null);
        assert_eq!(me_v["aoi"], serde_json::json!([AOI_DEFAULT.0, AOI_DEFAULT.1]));
        assert_eq!(me_v.as_object().unwrap().len(), 14);
    }

    #[test]
    fn view_requests_are_clamped() {
        let mut w = test_world(Map::empty(81, 81));
        let me = w.spawn_test_player(40.5, 40.5);
        let input = w.players[&me].link.as_ref().unwrap().input.clone();
        input.set_view(100, 100);
        w.step();
        assert_eq!(w.players[&me].aoi, AOI_MAX);
        input.set_view(1, 1);
        w.step();
        assert_eq!(w.players[&me].aoi, player::AOI_MIN);
        input.set_view(20, 14);
        w.step();
        assert_eq!(w.players[&me].aoi, (20, 14));
    }

    #[test]
    fn turn_buffering_takes_the_turn_when_it_opens() {
        // Corridor along row 1; column 3 opens downwards at (3,2).
        let mut w = test_world(Map::empty(15, 15));
        let id = w.spawn_test_player(1.5, 1.5);
        // At (2,1) the pillar (2,2) blocks the way down. Just right of the
        // cell centre, too little to trigger corner assist.
        w.players.get_mut(&id).unwrap().x = 2.6;
        w.hold(id, 3, 2); // newest: down, still held: right
        w.step();
        assert!(w.players[&id].x > 2.6, "keeps going right while down is blocked");
        for _ in 0..20 {
            w.step();
        }
        let p = &w.players[&id];
        assert_eq!(p.cell().0, 3, "turned down at the first opening");
        assert!(p.y > 2.0, "and went down: y = {}", p.y);
    }

    #[test]
    fn shield_blocks_flames() {
        let mut w = test_world(Map::empty(15, 15));
        let me = w.spawn_test_player(1.5, 1.5);
        let i = w.map.idx(1, 1);
        w.items[i] = Item::Shield as u8;
        w.step(); // picks up the shield
        assert!(w.players[&me].invulnerable_until > w.tick);
        w.place_bomb(me);
        for _ in 0..bomb::FUSE_TICKS + 2 {
            w.step();
        }
        assert!(w.players[&me].alive, "shielded player survives their own bomb");
        assert_eq!(w.stats.deaths, 0);
    }

    #[test]
    fn secret_box_gives_something_and_reports_it() {
        let mut w = test_world(Map::empty(15, 15));
        let (link, mut rx) = test_link();
        let id = w.join("opener".into(), link).unwrap();
        let p = w.players.get_mut(&id).unwrap();
        (p.x, p.y) = (1.5, 1.5);
        let i = w.map.idx(1, 1);
        w.items[i] = Item::Mystery as u8;
        w.step();
        assert_eq!(w.items[i], 0);
        assert_eq!(w.stats.mysteries_opened, 1);
        let mut got_fx = false;
        while let Ok(msg) = rx.try_recv() {
            let v: serde_json::Value = rmp_serde::from_slice(&msg).unwrap();
            if v["t"] == "fx" {
                assert_eq!(v["m"], true);
                got_fx = true;
            }
        }
        assert!(got_fx, "player is told what the box contained");
    }

    #[test]
    fn slow_curse_slows_then_wears_off() {
        let mut w = test_world(Map::empty(15, 15));
        let id = w.spawn_test_player(1.5, 1.5);
        let normal = w.players[&id].speed(w.tick);
        w.players.get_mut(&id).unwrap().slow_until = w.tick + 5;
        assert!(w.players[&id].speed(w.tick) < normal);
        assert_eq!(w.players[&id].curse(w.tick).0, 1);
        assert_eq!(w.players[&id].speed(w.tick + 5), normal);
    }

    #[test]
    fn owner_can_walk_off_own_bomb_but_not_back() {
        let mut w = test_world(Map::empty(15, 15));
        let id = w.spawn_test_player(1.5, 1.5);
        w.place_bomb(id);
        w.hold(id, 2, 0);
        for _ in 0..10 {
            w.step();
        }
        let x = w.players[&id].x;
        assert!(x > 2.0, "walked off the bomb, x = {x}");
        w.hold(id, 4, 0);
        for _ in 0..10 {
            w.step();
        }
        assert!(w.players[&id].x >= 2.5 - 1e-4, "bomb blocks the way back");
    }

    #[test]
    fn flames_kill_and_credit_owner() {
        let mut w = test_world(Map::empty(15, 15));
        let a = w.spawn_test_player(1.5, 1.5);
        let b = w.spawn_test_player(3.5, 1.5);
        w.place_bomb(a);
        w.players.get_mut(&a).unwrap().x = 3.5;
        w.players.get_mut(&a).unwrap().y = 3.5; // hide around the corner
        for _ in 0..bomb::FUSE_TICKS + 1 {
            w.step();
        }
        assert!(!w.players[&b].alive);
        assert!(w.players[&a].alive);
        assert_eq!(w.players[&a].score, 1);
        for _ in 0..RESPAWN_TICKS + 1 {
            w.step();
        }
        assert!(w.players[&b].alive, "respawned");
    }

    #[test]
    fn trapped_player_can_kick_without_power_up() {
        // Player at (3,2): pillars at (2,2)/(4,2), crate above, bomb below.
        let mut map = Map::empty(15, 15);
        map.set(3, 1, Tile::Crate);
        let mut w = test_world(map);
        let other = w.spawn_test_player(3.5, 3.5);
        w.place_bomb(other);
        w.players.get_mut(&other).unwrap().x = 9.5;
        let me = w.spawn_test_player(3.5, 2.5);
        assert!(!w.players[&me].kick);
        w.hold(me, 3, 0);
        w.step();
        let bid = w.bomb_at(3, 3).expect("bomb still in place before sliding");
        assert_eq!(w.bombs[&bid].slide_dir, 3, "trapped player kicked the bomb");
        for _ in 0..10 {
            w.step();
        }
        assert!(w.bomb_at(3, 3).is_none(), "bomb slid away, freeing the player");
    }

    #[test]
    fn free_player_cannot_kick_without_power_up() {
        let mut w = test_world(Map::empty(15, 15));
        let other = w.spawn_test_player(1.5, 2.5);
        w.place_bomb(other);
        w.players.get_mut(&other).unwrap().x = 5.5;
        let me = w.spawn_test_player(1.5, 3.5); // (1,4) below is open
        w.hold(me, 1, 0);
        w.step();
        let bid = w.bomb_at(1, 2).unwrap();
        assert_eq!(w.bombs[&bid].slide_dir, 0);
    }

    #[test]
    fn humans_take_a_bots_place_when_full() {
        let mut w = World::with_map(Map::empty(21, 21), Rng::new(5), 3);
        w.set_target_bots(3);
        assert_eq!((w.players.len(), w.bots.len()), (3, 3));

        let (link, _rx) = test_link();
        assert!(w.join("human".into(), link).is_ok(), "a bot makes room");
        assert_eq!((w.players.len(), w.bots.len()), (3, 2));
        for _ in 0..TICK_RATE * 2 {
            w.step();
        }
        assert_eq!(w.players.len(), 3, "bots don't refill past the cap");

        let (link, _rx2) = test_link();
        let human = w.join("human2".into(), link).unwrap();
        w.leave(human);
        for _ in 0..TICK_RATE {
            w.step();
        }
        assert_eq!(w.bots.len(), 2, "bots refill once there's room");
    }

    #[test]
    fn picking_up_items_upgrades_stats() {
        let mut w = test_world(Map::empty(15, 15));
        let id = w.spawn_test_player(1.5, 1.5);
        let i = w.map.idx(2, 1);
        w.items[i] = Item::Range as u8;
        w.hold(id, 2, 0);
        for _ in 0..5 {
            w.step();
        }
        assert_eq!(w.players[&id].range, player::BASE_RANGE + 1);
        assert_eq!(w.items[i], 0);
    }

    #[test]
    fn slow_clients_skip_snapshots_instead_of_dropping() {
        let mut w = test_world(Map::empty(15, 15));
        let (link, _rx) = test_link();
        let id = w.join("slow".into(), link).unwrap();
        // The client never reads anything; snapshots just keep replacing
        // each other, and only the bounded event queue can overflow.
        for _ in 0..30 {
            w.step();
            w.send_updates();
        }
        assert!(w.dropped_clients().is_empty());
        assert!(w.players.contains_key(&id));
    }
}
