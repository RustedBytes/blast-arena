//! The authoritative game simulation. A single task owns a `World` (one per
//! arena) and advances it at a fixed tick rate. Clients feed it through
//! lock-free input slots and get snapshots encoded into a reusable arena,
//! so a steady-state tick performs no heap allocation.

pub mod ai;
pub mod bomb;
pub mod items;
pub mod link;
pub mod map;
pub mod player;
pub mod rng;

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::Ordering::Relaxed;
use std::time::{Duration, Instant};

use bytes::{Bytes, BytesMut};
use tokio::sync::{mpsc, oneshot};

use crate::db::{self, Db, Profile};
use crate::metrics::ArenaStats;
use crate::protocol::{self, ArenaRing, ProfileView, ServerMsg, TileChange, Wire};
use bomb::{Bomb, Explosion};
use items::{Item, Mystery};
use link::ClientLink;
use map::{Map, Tile};
use player::{AOI_DEFAULT, AOI_MAX, DIRS, MAX_BOMBS, MAX_RANGE, MAX_SPEED_LVL, OPPOSITE, Player, step_move};
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
/// Conveyor belt speed in tiles per second.
const CONVEYOR_SPEED: f32 = 1.6;
const TELEPORT_COOLDOWN_TICKS: u64 = TICK_RATE as u64;
/// Standing on a hill this long earns a point.
const HILL_POINT_TICKS: u32 = 3 * TICK_RATE;
/// Score needed before the leader gets a bounty on their head.
const BOUNTY_MIN_SCORE: i32 = 5;
const BOUNTY_BONUS: i32 = 2;
/// Kill counts announced to everyone.
const STREAKS: [u32; 4] = [3, 5, 8, 12];
const EMOTE_COOLDOWN_TICKS: u64 = 15;
/// Emote shown automatically over a player's head after a kill.
pub const EMOTE_COOL: u8 = 7;
/// How long a disconnected player's progress is kept for them.
const PARK_TICKS: u64 = 30 * TICK_RATE as u64;
const PROFILE_FLUSH_TICKS: u64 = 10 * TICK_RATE as u64;
const XP_KILL: u64 = 10;
const XP_BOUNTY: u64 = 20;
const XP_HILL: u64 = 2;
const XP_MVP: u64 = 50;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    /// Free-for-all.
    Ffa,
    /// Red versus blue; no friendly fire.
    Teams,
}

impl Mode {
    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Ffa => "ffa",
            Mode::Teams => "teams",
        }
    }

    pub fn parse(s: &str) -> Option<Mode> {
        match s {
            "ffa" => Some(Mode::Ffa),
            "teams" => Some(Mode::Teams),
            _ => None,
        }
    }
}

#[derive(Clone)]
pub struct Config {
    pub name: String,
    pub mode: Mode,
    pub map_w: i32,
    pub map_h: i32,
    pub max_players: usize,
    /// AI bots kept in the arena; they make room for humans when full.
    pub bots: usize,
    pub round_secs: u32,
}

impl Default for Config {
    fn default() -> Self {
        Config { name: "Main".into(), mode: Mode::Ffa, map_w: 81, map_h: 81, max_players: 256, bots: 10, round_secs: 300 }
    }
}

/// Everything a client says when joining.
pub struct JoinRequest {
    pub name: String,
    pub token: Option<String>,
    pub hat: u8,
    pub trail: u8,
    /// Spawn next to this player (a friend's invite link), if present.
    pub near: u32,
    pub profile: Option<Profile>,
}

/// Rare events from connections. Input doesn't go through here: it's read
/// from each client's `InputSlot` every tick.
pub enum GameEvent {
    Join { req: JoinRequest, link: ClientLink, reply: oneshot::Sender<Result<u32, &'static str>> },
    Leave { id: u32 },
}

/// A disconnected player's progress, kept a little while for a reconnect.
struct Parked {
    expires: u64,
    team: u8,
    score: i32,
    kills: u32,
    deaths: u32,
    streak: u32,
    max_bombs: u8,
    range: u8,
    speed_lvl: u8,
    flags: [bool; 5],
}

/// A player as a client sees it: id, x*100, y*100, facing, flags.
type PlayerEntry = (u32, i32, i32, u8, u8);
/// A bomb as a client sees it: id, x, y, detonation tick (0 = remote), flags.
type BombEntry = (u32, i32, i32, u64, u8);
const SNAP_HISTORY: usize = 32;

/// What recent snapshots told one client, so the next one can be a delta
/// against whichever snapshot the client confirms it received. The lists
/// keep their capacity, so recording a snapshot doesn't allocate.
pub struct SnapHistory {
    ticks: [u64; SNAP_HISTORY],
    players: [Vec<PlayerEntry>; SNAP_HISTORY],
    bombs: [Vec<BombEntry>; SNAP_HISTORY],
}

impl Default for SnapHistory {
    fn default() -> Self {
        Self::new()
    }
}

impl SnapHistory {
    /// Pre-sized for a busy view, so recording rarely has to grow a list.
    fn new() -> Self {
        SnapHistory {
            ticks: [0; SNAP_HISTORY],
            players: std::array::from_fn(|_| Vec::with_capacity(96)),
            bombs: std::array::from_fn(|_| Vec::with_capacity(64)),
        }
    }

    /// Slot holding the snapshot for `tick`, if it's still remembered.
    fn slot_for(&self, tick: u64) -> Option<usize> {
        let s = (tick % SNAP_HISTORY as u64) as usize;
        (tick != 0 && self.ticks[s] == tick).then_some(s)
    }

    fn record(&mut self, tick: u64, players: &[PlayerEntry], bombs: &[BombEntry]) {
        let s = (tick % SNAP_HISTORY as u64) as usize;
        self.ticks[s] = tick;
        self.players[s].clear();
        self.players[s].extend_from_slice(players);
        self.bombs[s].clear();
        self.bombs[s].extend_from_slice(bombs);
    }
}

/// Per-snapshot working lists.
#[derive(Default)]
struct DeltaScratch {
    players: Vec<PlayerEntry>,
    bombs: Vec<BombEntry>,
}

trait Keyed: Copy + PartialEq {
    fn key(&self) -> u32;
}
impl Keyed for PlayerEntry {
    fn key(&self) -> u32 {
        self.0
    }
}
impl Keyed for BombEntry {
    fn key(&self) -> u32 {
        self.0
    }
}

/// Writes `changed`: entries of `cur` that are new or differ from `base`,
/// then `removed`: ids in `base` that are gone from `cur`. Both lists are
/// sorted by id, so this is a single merge pass.
fn write_delta<E: Keyed>(w: &mut Wire<'_>, changed: &str, removed: &str, cur: &[E], base: &[E], write: impl Fn(&mut Wire<'_>, &E)) {
    w.key(changed);
    let at = w.open_arr();
    let (mut n, mut j) = (0, 0);
    for e in cur {
        while j < base.len() && base[j].key() < e.key() {
            j += 1;
        }
        if j < base.len() && base[j] == *e {
            continue;
        }
        write(w, e);
        n += 1;
    }
    w.close_arr(at, n);
    w.key(removed);
    let at = w.open_arr();
    let (mut n, mut i) = (0, 0);
    for b in base {
        while i < cur.len() && cur[i].key() < b.key() {
            i += 1;
        }
        if i >= cur.len() || cur[i].key() != b.key() {
            w.uint(b.key() as u64);
            n += 1;
        }
    }
    w.close_arr(at, n);
}

/// Buffers reused every tick so the hot path doesn't allocate.
#[derive(Default)]
struct Scratch {
    delta: DeltaScratch,
    ids: Vec<u32>,
    bomb_ids: Vec<u32>,
    chain: Vec<u32>,
    blast: Vec<(usize, u8, i32, i32)>,
    drops: Vec<(i32, i32, Item)>,
    victims: Vec<(u32, u32)>,
    broadcasts: Vec<Bytes>,
    dropped: Vec<u32>,
    emotes: Vec<(u32, u8)>,
}

pub struct World {
    pub name: String,
    pub mode: Mode,
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
    /// Tile and item changes made during the current tick, sent to everyone.
    pub tile_changes: Vec<TileChange>,
    pub item_changes: Vec<(i32, i32, u8)>,
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
    /// Lock-free counters read by the lobby, dashboard and /metrics.
    pub live: Arc<ArenaStats>,
    db: Option<Db>,
    /// Centres of the 3x3 king-of-the-hill zones.
    pub hills: Vec<(i32, i32)>,
    round_ticks: u64,
    pub round_end: u64,
    parked: HashMap<String, Parked>,
    /// Per-client record of recent snapshots, for delta encoding.
    histories: HashMap<u32, SnapHistory>,
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
    pub rounds: u64,
}

impl World {
    pub fn new(cfg: &Config, live: Arc<ArenaStats>, db: Option<Db>) -> Self {
        let mut rng = Rng::from_time();
        let map = Map::generate(cfg.map_w, cfg.map_h, CRATE_DENSITY, &mut rng);
        let mut world = Self::with_map(map, rng, cfg.max_players);
        world.name = cfg.name.clone();
        world.mode = cfg.mode;
        world.live = live;
        world.db = db;
        world.round_ticks = cfg.round_secs as u64 * TICK_RATE as u64;
        world.round_end = world.round_ticks;
        world.place_hills();
        world.set_target_bots(cfg.bots);
        world
    }

    pub fn with_map(map: Map, rng: Rng, max_players: usize) -> Self {
        let n = (map.w * map.h) as usize;
        let crate_count = map.count(Tile::Crate) + map.count(Tile::Armored);
        let buckets_w = (map.w + BUCKET - 1) / BUCKET;
        let buckets_h = (map.h + BUCKET - 1) / BUCKET;
        let round_ticks = Config::default().round_secs as u64 * TICK_RATE as u64;
        World {
            name: "Test".into(),
            mode: Mode::Ffa,
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
            item_changes: Vec::new(),
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
            live: Arc::default(),
            db: None,
            hills: Vec::new(),
            round_ticks,
            round_end: round_ticks,
            parked: HashMap::new(),
            histories: HashMap::new(),
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
        if old.is_breakable() {
            self.crate_count -= 1;
        }
        if t.is_breakable() {
            self.crate_count += 1;
        }
        self.map.set(x, y, t);
        self.tile_changes.push((x, y, t as u8));
    }

    /// Changes the item on a cell (0 removes it) and records the change for
    /// the reliable world-delta stream.
    pub fn set_item(&mut self, x: i32, y: i32, kind: u8) {
        let i = self.map.idx(x, y);
        if self.items[i] != kind {
            self.items[i] = kind;
            self.item_changes.push((x, y, kind));
        }
    }

    // ---------------------------------------------------------------- players

    pub fn join(&mut self, req: JoinRequest, link: ClientLink) -> Result<u32, &'static str> {
        if self.players.len() >= self.max_players {
            // Humans take priority: a bot steps out to make room.
            let Some(&bot) = self.bot_ids.first() else {
                return Err("server is full, try again later");
            };
            self.leave(bot);
        }
        let parked = req.token.as_ref().and_then(|t| self.parked.remove(t)).filter(|p| p.expires > self.tick);
        let team = parked.as_ref().map(|p| p.team).unwrap_or_else(|| self.team_for_new());
        let (hat, trail) = match &req.profile {
            Some(p) => (p.allowed_hat(req.hat), p.allowed_trail(req.trail)),
            None => (0, 0),
        };
        let near = self.players.get(&req.near).filter(|p| p.alive).map(|p| p.cell());
        let id = self.spawn_player(req.name, Some(link), team, hat, trail, near);
        let resumed = parked.is_some();
        let p = self.players.get_mut(&id).unwrap();
        p.token = req.token;
        p.profile = req.profile;
        if let Some(pk) = parked {
            (p.score, p.kills, p.deaths, p.streak) = (pk.score, pk.kills, pk.deaths, pk.streak);
            (p.max_bombs, p.range, p.speed_lvl) = (pk.max_bombs, pk.range, pk.speed_lvl);
            [p.kick, p.pierce, p.remote, p.line, p.punch] = pk.flags;
        }
        if let Some(prof) = &mut p.profile {
            prof.games += 1;
            p.profile_dirty = true;
        }

        let p = &self.players[&id];
        let mut items = Vec::new();
        for y in 0..self.map.h {
            for x in 0..self.map.w {
                let k = self.items[self.map.idx(x, y)];
                if k != 0 {
                    items.push((x, y, k));
                }
            }
        }
        let welcome = ServerMsg::Welcome {
            id,
            w: self.map.w,
            h: self.map.h,
            map: self.map.encode_rle(),
            items,
            rate: TICK_RATE,
            aoi: AOI_DEFAULT,
            aoi_max: AOI_MAX,
            roster: self.players.values().map(|o| (o.id, o.name.as_str(), o.team, o.hat, o.trail)).collect(),
            arena: &self.name,
            mode: self.mode.as_str(),
            team: p.team,
            hills: self.hills.clone(),
            round: self.round_secs_left(),
            resumed,
            profile: p.profile.as_ref().map(profile_view),
        };
        if let Some(link) = &p.link {
            let _ = link.events.try_send(welcome.encode());
        }
        Ok(id)
    }

    /// The team with fewer players, in team mode.
    fn team_for_new(&self) -> u8 {
        if self.mode != Mode::Teams {
            return 0;
        }
        let red = self.players.values().filter(|p| p.team == 1).count();
        let blue = self.players.values().filter(|p| p.team == 2).count();
        if red <= blue { 1 } else { 2 }
    }

    /// Creates a living player at a safe spot and announces it to everyone.
    fn spawn_player(&mut self, name: String, link: Option<ClientLink>, team: u8, hat: u8, trail: u8, near: Option<(i32, i32)>) -> u32 {
        self.next_player_id += 1;
        let id = self.next_player_id;
        let mut p = Player::new(id, name, link);
        (p.team, p.hat, p.trail) = (team, hat, trail);
        let (x, y) = match near {
            Some((nx, ny)) => self.find_spawn_near(nx, ny),
            None => self.find_spawn(),
        };
        p.x = x as f32 + 0.5;
        p.y = y as f32 + 0.5;
        p.alive = true;
        p.invulnerable_until = self.tick + SPAWN_SHIELD_TICKS;
        self.broadcasts.push(protocol::encode_pj(self.event_arenas.current(), id, &p.name, team, hat, trail));
        self.players.insert(id, p);
        self.rebuild_buckets();
        id
    }

    pub fn add_bot(&mut self) -> u32 {
        let name = ai::bot_name(self.bots_created);
        let hat = (self.bots_created % 7) as u8;
        self.bots_created += 1;
        let team = self.team_for_new();
        let id = self.spawn_player(name, None, team, hat, 0, None);
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
        self.histories.remove(&id);
        if self.bots.remove(&id).is_some() {
            self.bot_ids.retain(|&b| b != id);
        }
        let Some(p) = self.players.remove(&id) else { return };
        self.broadcasts.push(protocol::encode_pl(self.event_arenas.current(), id));
        if let (Some(db), Some(profile)) = (&self.db, &p.profile) {
            db.save(profile.clone());
        }
        if let Some(token) = p.token {
            self.parked.insert(
                token,
                Parked {
                    expires: self.tick + PARK_TICKS,
                    team: p.team,
                    score: p.score,
                    kills: p.kills,
                    deaths: p.deaths,
                    streak: p.streak,
                    max_bombs: p.max_bombs,
                    range: p.range,
                    speed_lvl: p.speed_lvl,
                    flags: [p.kick, p.pierce, p.remote, p.line, p.punch],
                },
            );
        }
    }

    /// Finds an open cell away from bombs, fire and other players, with room
    /// to escape from a first bomb. Carves space as a last resort.
    fn find_spawn(&mut self) -> (i32, i32) {
        for attempt in 0..400 {
            let x = self.rng.between(1, self.map.w - 2);
            let y = self.rng.between(1, self.map.h - 2);
            if self.spawn_ok(x, y, attempt < 300) {
                return (x, y);
            }
        }
        self.carve_spawn()
    }

    /// Like `find_spawn`, but close to a friend.
    fn find_spawn_near(&mut self, nx: i32, ny: i32) -> (i32, i32) {
        for _ in 0..200 {
            let x = nx + self.rng.between(-5, 5);
            let y = ny + self.rng.between(-5, 5);
            if self.map.in_bounds(x, y) && self.spawn_ok(x, y, false) {
                return (x, y);
            }
        }
        self.find_spawn()
    }

    fn spawn_ok(&self, x: i32, y: i32, avoid_players: bool) -> bool {
        if self.map.is_solid(x, y) || self.bomb_at(x, y).is_some() || self.map.get(x, y) == Tile::Teleport {
            return false;
        }
        if self.danger_near(x, y, 4) {
            return false;
        }
        if avoid_players && self.players_in_rect(x - 3, y - 3, x + 3, y + 3).any(|p| p.alive) {
            return false;
        }
        self.open_cells_near(x, y) >= 4
    }

    /// Picks a lane intersection and clears the crates around it.
    fn carve_spawn(&mut self) -> (i32, i32) {
        let x = self.rng.between(0, (self.map.w - 3) / 2) * 2 + 1;
        let y = self.rng.between(0, (self.map.h - 3) / 2) * 2 + 1;
        for (dx, dy) in [(0, 0), (1, 0), (-1, 0), (0, 1), (0, -1), (2, 0), (0, 2)] {
            let (cx, cy) = (x + dx, y + dy);
            if self.map.get(cx, cy).is_breakable() {
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
        v.streak = 0;
        v.respawn_at = self.tick + RESPAWN_TICKS;
        v.killed_by = killer;
        let had_bounty = std::mem::take(&mut v.bounty);
        if let Some(prof) = &mut v.profile {
            prof.deaths += 1;
            v.profile_dirty = true;
        }
        let (vx, vy) = (v.x, v.y);
        let (cx, cy) = v.cell();

        // Lose upgrades; a few of them are scattered for others to grab.
        let mut lost = [Item::ExtraBomb; 40];
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
        lose(Item::Remote, v.remote as u8);
        lose(Item::LineBomb, v.line as u8);
        lose(Item::Punch, v.punch as u8);
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
                        self.set_item(x, y, item as u8);
                        break;
                    }
                }
            }
        }

        let killer = killer.filter(|k| self.players.contains_key(k));
        self.stats.deaths += 1;
        self.live.deaths.fetch_add(1, Relaxed);
        match killer {
            Some(k) if k == victim => {
                self.stats.suicides += 1;
                self.players.get_mut(&k).unwrap().score -= 1;
            }
            Some(k) => {
                let kp = self.players.get_mut(&k).unwrap();
                kp.score += 1 + if had_bounty { BOUNTY_BONUS } else { 0 };
                kp.kills += 1;
                kp.streak += 1;
                let streak = kp.streak;
                if let Some(prof) = &mut kp.profile {
                    prof.kills += 1;
                    prof.xp += XP_KILL + if had_bounty { XP_BOUNTY } else { 0 };
                    prof.best_streak = prof.best_streak.max(streak as u64);
                    kp.profile_dirty = true;
                }
                if STREAKS.contains(&streak) {
                    self.broadcasts.push(protocol::encode_streak(self.event_arenas.current(), k, streak));
                }
                self.scratch.emotes.push((k, EMOTE_COOL));
            }
            None => {}
        }
        self.broadcasts.push(protocol::encode_kill(self.event_arenas.current(), killer, victim, vx, vy, had_bounty));
    }

    /// Copies each client's latest input from its lock-free slot.
    fn read_inputs(&mut self) {
        let tick = self.tick;
        for p in self.players.values_mut() {
            let Some(link) = &p.link else { continue };
            let (d, s, seq) = link.input.dirs();
            let reversed = p.reversed_until > tick;
            (p.input_dir, p.input_alt, p.input_seq) =
                if reversed { (OPPOSITE[d as usize], OPPOSITE[s as usize], seq) } else { (d, s, seq) };
            let presses = link.input.bomb_presses();
            if presses != p.bomb_presses {
                p.bomb_presses = presses;
                p.want_bomb = true;
            }
            let acts = link.input.act_presses();
            if acts != p.act_presses {
                p.act_presses = acts;
                p.want_act = true;
            }
            let (count, e) = link.input.latest_emote();
            if count != p.emote_seq {
                p.emote_seq = count;
                if tick >= p.next_emote_at {
                    p.next_emote_at = tick + EMOTE_COOLDOWN_TICKS;
                    self.scratch.emotes.push((p.id, e));
                }
            }
            p.snap_ack = link.input.ack();
            if let Some((w, h)) = link.input.view() {
                p.set_aoi(w, h);
            }
        }
    }

    /// Shows queued emotes to the players near each emitter.
    fn send_emotes(&mut self) {
        let mut emotes = std::mem::take(&mut self.scratch.emotes);
        for &(id, e) in &emotes {
            let Some(p) = self.players.get(&id) else { continue };
            let msg = protocol::encode_emote(self.event_arenas.current(), id, e);
            let (cx, cy) = p.cell();
            let (hw, hh) = AOI_MAX;
            for o in self.players_in_rect(cx - hw, cy - hh, cx + hw, cy + hh) {
                if let Some(link) = &o.link {
                    let _ = link.events.try_send(msg.clone());
                }
            }
        }
        emotes.clear();
        self.scratch.emotes = emotes;
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
            Item::Remote => p.remote = true,
            Item::LineBomb => p.line = true,
            Item::Punch => p.punch = true,
            Item::Ghost => p.ghost_until = p.ghost_until.max(tick + items::GHOST_TICKS),
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
                Mystery::Reversed => p.reversed_until = tick + items::REVERSE_CURSE_TICKS,
                Mystery::BombRain => {
                    let (x, y) = p.cell();
                    self.bomb_rain(x, y);
                }
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

            let (mut dir, alt) = (p.input_dir, p.input_alt);
            let start = (p.x, p.y);
            let start_cell = p.cell();
            let on = self.map.get(start_cell.0, start_cell.1);
            let dist = p.speed(self.tick) * DT;
            // On ice you can't stop: letting go keeps you sliding until you
            // steer, hit something or reach the end of the ice.
            if dir == 0 && on == Tile::Ice && p.moving && p.slide_dir != 0 {
                dir = p.slide_dir;
            }
            let ghost = p.ghost(self.tick);
            let (mut x, mut y) = start;
            let mut used = dir;
            {
                let map = &self.map;
                let bomb_grid = &self.bomb_grid;
                // A bomb blocks unless it's in the cell the player stands in,
                // which lets players walk off a bomb they just dropped. Ghosts
                // pass through crates.
                let blocked = |cx: i32, cy: i32| {
                    let t = map.get(cx, cy);
                    (t == Tile::Wall || (!ghost && t.is_breakable()))
                        || ((cx, cy) != start_cell && bomb_grid[map.idx(cx, cy)] != 0)
                };
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
                // Conveyors carry whoever stands on them.
                let belt = on.conveyor_dir();
                if belt != 0 {
                    step_move(&mut x, &mut y, belt, CONVEYOR_SPEED * DT, blocked);
                }
            }
            let p = self.players.get_mut(&id).unwrap();
            let walked = (x, y) != start;
            p.moving = walked;
            if walked && used != 0 {
                p.facing = used;
                p.slide_dir = used;
            } else if dir != 0 {
                p.facing = dir;
            }
            p.x = x;
            p.y = y;
            let (mut cx, mut cy) = p.cell();

            // Teleporters: stepping onto a pad's centre moves you to its twin.
            if self.map.get(cx, cy) == Tile::Teleport && p.teleport_ready_at <= self.tick {
                let near_centre = (p.x - (cx as f32 + 0.5)).abs() + (p.y - (cy as f32 + 0.5)).abs() < 0.35;
                if let (true, Some((tx, ty))) = (near_centre, self.map.teleport_partner(cx, cy)) {
                    p.x = tx as f32 + 0.5;
                    p.y = ty as f32 + 0.5;
                    p.teleport_ready_at = self.tick + TELEPORT_COOLDOWN_TICKS;
                    (cx, cy) = (tx, ty);
                }
            }
            let has_kick = p.kick;
            let moving = p.moving;
            let want_act = std::mem::take(&mut p.want_act);

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
                self.set_item(cx, cy, 0);
                self.pick_up(id, item);
            }

            if want_act {
                self.act(id);
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
            if !self.flame_active(x, y) {
                return None;
            }
            let owner = self.flame_owner[self.map.idx(x, y)];
            // No friendly fire in team mode (your own bombs still hurt).
            let friendly = self.players.get(&owner).is_some_and(|o| !o.can_hurt(p));
            (!friendly).then_some((p.id, owner))
        }));
        for &(v, k) in &victims {
            self.kill(v, Some(k));
        }
        self.scratch.victims = victims;
    }

    /// Slowly regrows crates in quiet areas so the big map never runs dry,
    /// occasionally leaving a lone secret box instead.
    fn regrow_crates(&mut self) {
        if !self.tick.is_multiple_of(TICK_RATE as u64) || self.crate_count >= self.crate_target {
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
            if self.map.get(x, y) != Tile::Floor || self.in_hill(x, y) {
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
                self.set_item(x, y, Item::Mystery as u8);
            } else {
                self.set_tile(x, y, Tile::Crate);
            }
            grown += 1;
        }
    }

    // ------------------------------------------------- rounds, hills, bounty

    fn round_secs_left(&self) -> u32 {
        (self.round_end.saturating_sub(self.tick) / TICK_RATE as u64) as u32
    }

    pub fn in_hill(&self, x: i32, y: i32) -> bool {
        self.hills.iter().any(|&(hx, hy)| (x - hx).abs() <= 1 && (y - hy).abs() <= 1)
    }

    /// Moves the king-of-the-hill zones to new spots, clearing crates so
    /// they can be stood on.
    fn place_hills(&mut self) {
        let n = ((self.map.w * self.map.h) / 1600).clamp(1, 6) as usize;
        self.hills.clear();
        for _ in 0..n * 10 {
            if self.hills.len() >= n {
                break;
            }
            let x = self.rng.between(1, (self.map.w - 3) / 2) * 2 + 1;
            let y = self.rng.between(1, (self.map.h - 3) / 2) * 2 + 1;
            if x + 1 >= self.map.w - 1 || y + 1 >= self.map.h - 1 {
                continue;
            }
            let far = self.hills.iter().all(|&(hx, hy)| (hx - x).abs() + (hy - y).abs() > self.map.w / 4);
            if !far {
                continue;
            }
            for cy in y - 1..=y + 1 {
                for cx in x - 1..=x + 1 {
                    if self.map.get(cx, cy).is_breakable() {
                        self.set_tile(cx, cy, Tile::Floor);
                    }
                }
            }
            self.hills.push((x, y));
        }
    }

    /// Players on a hill earn a point every few seconds.
    fn update_hills(&mut self) {
        for p in self.players.values_mut() {
            if !p.alive {
                continue;
            }
            let (x, y) = p.cell();
            if !self.hills.iter().any(|&(hx, hy)| (x - hx).abs() <= 1 && (y - hy).abs() <= 1) {
                p.hill_ticks = 0;
                continue;
            }
            p.hill_ticks += 1;
            if p.hill_ticks >= HILL_POINT_TICKS {
                p.hill_ticks = 0;
                p.score += 1;
                if let Some(prof) = &mut p.profile {
                    prof.xp += XP_HILL;
                    p.profile_dirty = true;
                }
            }
        }
    }

    /// The highest scorer (if clearly ahead) carries a bounty.
    fn update_bounty(&mut self) {
        let leader = self.players.values().filter(|p| p.score >= BOUNTY_MIN_SCORE).max_by_key(|p| (p.score, std::cmp::Reverse(p.id))).map(|p| p.id);
        for p in self.players.values_mut() {
            p.bounty = Some(p.id) == leader;
        }
    }

    fn team_scores(&self) -> (i32, i32) {
        let mut s = (0, 0);
        for p in self.players.values() {
            match p.team {
                1 => s.0 += p.score,
                2 => s.1 += p.score,
                _ => {}
            }
        }
        s
    }

    /// Ends the round: announces the MVPs, rewards them, resets scores and
    /// moves the hills.
    fn end_round(&mut self) {
        self.stats.rounds += 1;
        let mut ranked: Vec<&Player> = self.players.values().collect();
        ranked.sort_by_key(|p| (std::cmp::Reverse(p.score), std::cmp::Reverse(p.kills), p.id));
        let mvp_id = ranked.first().filter(|p| p.score > 0).map(|p| p.id);
        let teams = self.team_scores();
        let winner = match self.mode {
            Mode::Teams if teams.0 > teams.1 => 1,
            Mode::Teams if teams.1 > teams.0 => 2,
            _ => 0,
        };
        let top = ranked.iter().take(3).map(|p| (p.id, p.name.as_str(), p.score, p.kills));
        let round_secs = (self.round_ticks / TICK_RATE as u64) as u32;
        let msg = protocol::encode_round(self.event_arenas.current(), top, teams, winner, round_secs);
        self.broadcasts.push(msg);

        for p in self.players.values_mut() {
            let won = Some(p.id) == mvp_id || (winner != 0 && p.team == winner);
            if let Some(prof) = &mut p.profile {
                if Some(p.id) == mvp_id {
                    prof.wins += 1;
                    prof.xp += XP_MVP;
                } else if won {
                    prof.xp += XP_MVP / 2;
                }
                p.profile_dirty = true;
            }
            (p.score, p.kills, p.deaths, p.streak, p.bounty) = (0, 0, 0, 0, false);
        }
        self.round_end = self.tick + self.round_ticks;
        self.place_hills();
        let hills = protocol::encode_hills(self.event_arenas.current(), &self.hills);
        self.broadcasts.push(hills);
    }

    /// Saves changed profiles now and then (and forgets stale parked players).
    fn flush_profiles(&mut self) {
        let tick = self.tick;
        self.parked.retain(|_, p| p.expires > tick);
        let Some(db) = &self.db else { return };
        for p in self.players.values_mut() {
            if p.profile_dirty {
                if let Some(prof) = &p.profile {
                    db.save(prof.clone());
                }
                p.profile_dirty = false;
            }
        }
    }

    fn publish_live_stats(&self, tick_avg: Duration, tick_max: Duration) {
        let humans = self.players.values().filter(|p| !p.is_bot()).count() as u32;
        let live = &self.live;
        live.players.store(self.players.len() as u32, Relaxed);
        live.humans.store(humans, Relaxed);
        live.bots.store(self.bots.len() as u32, Relaxed);
        live.bombs.store(self.bombs.len() as u32, Relaxed);
        live.round_secs.store(self.round_secs_left(), Relaxed);
        live.tick_avg_us.store(tick_avg.as_micros() as u32, Relaxed);
        live.tick_max_us.store(tick_max.as_micros() as u32, Relaxed);
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
    /// zero-copy slice. Snapshots carry only moving things (players, bombs,
    /// flames); tiles and items arrive through the reliable `w` stream.
    /// Arrays are written with back-patched lengths, so no intermediate
    /// lists are built.
    fn encode_snapshot(&self, arena: &mut BytesMut, p: &Player, hist: &mut SnapHistory, cur: &mut DeltaScratch) -> Bytes {
        let tick = self.tick;
        // While dead, watch whoever got you.
        let spectating = (!p.alive).then_some(p.killed_by).flatten().and_then(|k| self.players.get(&k)).filter(|k| k.alive && k.id != p.id);
        let (cx, cy) = spectating.map_or(p.cell(), |k| k.cell());
        let (x0, y0, x1, y1) = aoi_rect(cx, cy, p.aoi);

        // What the client should see now, sorted by id for diffing.
        cur.players.clear();
        cur.players.extend(self.players_in_rect(x0, y0, x1, y1).filter(|o| o.alive).map(|o| {
            let flags = o.moving as u8
                | ((o.invulnerable_until > tick) as u8) << 1
                | ((o.curse(tick).0 != 0) as u8) << 2
                | (o.ghost(tick) as u8) << 3
                | (o.bounty as u8) << 4;
            (o.id, (o.x * 100.0) as i32, (o.y * 100.0) as i32, o.facing, flags)
        }));
        cur.players.sort_unstable_by_key(|e| e.0);
        cur.bombs.clear();
        let (bx0, by0, bx1, by1) = (x0.max(0), y0.max(0), x1.min(self.map.w - 1), y1.min(self.map.h - 1));
        for y in by0..=by1 {
            for x in bx0..=bx1 {
                let id = self.bomb_grid[self.map.idx(x, y)];
                if id != 0 {
                    let b = &self.bombs[&id];
                    // The absolute detonation tick never changes, so a resting
                    // bomb is identical from one snapshot to the next.
                    let at = if b.remote { 0 } else { b.explode_at };
                    cur.bombs.push((id, x, y, at, b.pierce as u8 | (b.remote as u8) << 1));
                }
            }
        }
        cur.bombs.sort_unstable_by_key(|e| e.0);

        // Delta against the newest snapshot the client confirmed, if we
        // still remember it; otherwise a full snapshot.
        let base = hist.slot_for(p.snap_ack as u64);
        let mut w = Wire(arena);
        w.map(9).key("t").str("s").key("k").uint(tick).key("bk").uint(base.map_or(0, |s| hist.ticks[s]));
        let (bp, bb): (&[PlayerEntry], &[BombEntry]) = match base {
            Some(s) => (&hist.players[s], &hist.bombs[s]),
            None => (&[], &[]),
        };
        write_delta(&mut w, "p", "pr", &cur.players, bp, |w, e| {
            w.arr(5).uint(e.0 as u64).int(e.1 as i64).int(e.2 as i64).uint(e.3 as u64).uint(e.4 as u64);
        });
        write_delta(&mut w, "b", "br", &cur.bombs, bb, |w, e| {
            w.arr(5).uint(e.0 as u64).int(e.1 as i64).int(e.2 as i64).uint(e.3).uint(e.4 as u64);
        });
        hist.record(tick, &cur.players, &cur.bombs);

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

        let (curse, curse_t) = p.curse(tick);
        // Positional (see protocol::ME_FIELDS): this block goes out every tick,
        // so key names would be most of its size.
        w.key("me").arr(protocol::ME_FIELDS.len());
        w.bool(p.alive);
        w.uint(p.max_bombs as u64);
        w.uint(p.active_bombs as u64);
        w.uint(p.range as u64);
        w.uint(p.speed_lvl as u64);
        w.bool(p.kick);
        w.bool(p.pierce);
        w.bool(p.remote);
        w.bool(p.line);
        w.bool(p.punch);
        w.uint(p.ghost_until.saturating_sub(tick));
        w.uint(p.invulnerable_until.saturating_sub(tick));
        w.uint(curse as u64);
        w.uint(curse_t);
        w.int(p.score as i64);
        w.uint(if p.alive { 0 } else { p.respawn_at.saturating_sub(tick) });
        w.opt_uint(p.killed_by);
        w.arr(2).int(p.aoi.0 as i64).int(p.aoi.1 as i64);
        w.uint(p.input_seq as u64);
        w.uint(p.team as u64);
        w.uint(p.streak as u64);
        w.opt_uint(spectating.map(|k| k.id));
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
        let teams = self.team_scores();
        let secs = self.round_secs_left();
        let msg = protocol::encode_lb(self.event_arenas.current(), players.len(), entries, teams, secs);
        self.scratch.ids = top;
        msg
    }

    // ------------------------------------------------------------- the tick

    pub fn handle(&mut self, ev: GameEvent) {
        match ev {
            GameEvent::Join { req, link, reply } => {
                let _ = reply.send(self.join(req, link));
            }
            GameEvent::Leave { id } => self.leave(id),
        }
    }

    /// Advances the simulation by one tick (without networking).
    pub fn step(&mut self) {
        self.tick += 1;
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
        self.update_hills();
        self.regrow_crates();
        if self.tick.is_multiple_of(TICK_RATE as u64) {
            self.maintain_bots();
            self.update_bounty();
        }
        if self.tick >= self.round_end {
            self.end_round();
        }
        if self.tick.is_multiple_of(PROFILE_FLUSH_TICKS) {
            self.flush_profiles();
        }
    }

    /// Sends this tick's broadcasts (including the world delta) and
    /// publishes each client's snapshot. Clients whose reliable event queue
    /// is full or closed are collected in `scratch.dropped`.
    pub fn send_updates(&mut self) {
        self.send_emotes();
        let mut broadcasts = std::mem::take(&mut self.scratch.broadcasts);
        broadcasts.clear();
        broadcasts.append(&mut self.broadcasts);
        if !self.tile_changes.is_empty() || !self.item_changes.is_empty() {
            let w = protocol::encode_world(self.event_arenas.current(), &self.tile_changes, &self.item_changes);
            broadcasts.push(w);
        }
        self.tile_changes.clear();
        self.item_changes.clear();
        if self.tick.is_multiple_of(LEADERBOARD_EVERY) {
            let lb = self.encode_leaderboard();
            broadcasts.push(lb);
        }
        let mut ring = std::mem::take(&mut self.snapshot_arenas);
        let mut histories = std::mem::take(&mut self.histories);
        let mut delta = std::mem::take(&mut self.scratch.delta);
        let arena = ring.rotate();
        let mut dropped = std::mem::take(&mut self.scratch.dropped);
        dropped.clear();
        for p in self.players.values() {
            let Some(link) = &p.link else { continue };
            if !broadcasts.iter().all(|m| link.events.try_send(m.clone()).is_ok()) {
                dropped.push(p.id);
                continue;
            }
            let hist = histories.entry(p.id).or_default();
            link.snapshot.publish(self.encode_snapshot(arena, p, hist, &mut delta));
        }
        self.snapshot_arenas = ring;
        self.histories = histories;
        self.scratch.delta = delta;
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

    /// Saves every profile (on shutdown).
    pub fn save_all(&mut self) {
        for p in self.players.values_mut() {
            p.profile_dirty = true;
        }
        self.flush_profiles();
    }
}

fn profile_view(p: &Profile) -> ProfileView {
    let level = p.level();
    ProfileView {
        level,
        xp: p.xp,
        next_xp: db::xp_for_level(level + 1),
        kills: p.kills,
        deaths: p.deaths,
        wins: p.wins,
        best_streak: p.best_streak,
    }
}

/// Inclusive tile rectangle a player at (cx, cy) receives updates for.
pub fn aoi_rect(cx: i32, cy: i32, (hw, hh): (i32, i32)) -> (i32, i32, i32, i32) {
    (cx - hw, cy - hh, cx + hw, cy + hh)
}

pub async fn run(cfg: Config, mut events: mpsc::Receiver<GameEvent>, live: Arc<ArenaStats>, db: Option<Db>) {
    let mut world = World::new(&cfg, live, db);
    tracing::info!(arena = %cfg.name, mode = cfg.mode.as_str(), w = cfg.map_w, h = cfg.map_h, bots = world.bots.len(), "arena ready");
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
                Err(mpsc::error::TryRecvError::Disconnected) => {
                    world.save_all();
                    return;
                }
            }
        }
        world.step();
        world.send_updates();
        world.drop_lagging_clients();

        let took = started.elapsed();
        ticks += 1;
        busy += took;
        worst = worst.max(took);
        if world.tick.is_multiple_of(TICK_RATE as u64) {
            world.publish_live_stats(busy / ticks.max(1), worst);
        }
        if stats_since.elapsed() >= Duration::from_secs(10) {
            tracing::info!(
                arena = %world.name,
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

/// A join request with just a name (tests, benchmarks).
pub fn plain_join(name: &str) -> JoinRequest {
    JoinRequest { name: name.into(), token: None, hat: 0, trail: 0, near: 0, profile: None }
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
        self.players[&id].link.as_ref().unwrap().input.set_dirs(dir, alt, 0);
    }

    /// A full (non-delta) snapshot for player `id`, decoded.
    fn full_snapshot(&self, id: u32) -> serde_json::Value {
        let mut arena = BytesMut::new();
        let (mut hist, mut scratch) = (SnapHistory::default(), DeltaScratch::default());
        rmp_serde::from_slice(&self.encode_snapshot(&mut arena, &self.players[&id], &mut hist, &mut scratch)).unwrap()
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
        let snap: serde_json::Value = w.full_snapshot(me);
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
        w.set_item(3, 5, Item::Mystery as u8);
        w.set_tile(5, 5, Tile::Floor);
        let snap: serde_json::Value = w.full_snapshot(me);
        assert_eq!(snap["k"], 0);
        assert_eq!(snap["p"][0], serde_json::json!([me, 350, 350, 3, 0]));
        assert_eq!(snap["b"][0], serde_json::json!([1, 3, 3, bomb::FUSE_TICKS, 0]));
        assert_eq!(snap["e"], serde_json::json!([]));
        assert!(snap.get("i").is_none() && snap.get("tc").is_none(), "static changes go through the world stream");
        assert_eq!(w.item_changes, vec![(3, 5, 8)]);
        assert_eq!(w.tile_changes, vec![(5, 5, 0)]);
        assert_eq!(snap["me"].as_array().unwrap().len(), protocol::ME_FIELDS.len());
        let me_v = &me_obj(&snap);
        assert_eq!(me_v["alive"], true);
        assert_eq!(me_v["active"], 1);
        assert_eq!(me_v["killer"], serde_json::Value::Null);
        assert_eq!(me_v["aoi"], serde_json::json!([AOI_DEFAULT.0, AOI_DEFAULT.1]));
        assert_eq!(me_v["ack"], 0);
        assert_eq!(me_v["spec"], serde_json::Value::Null);
        assert_eq!(me_v.as_object().unwrap().len(), 22, "every field named");
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
        let id = w.join(plain_join("opener"), link).unwrap();
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
        assert!(w.join(plain_join("human"), link).is_ok(), "a bot makes room");
        assert_eq!((w.players.len(), w.bots.len()), (3, 2));
        for _ in 0..TICK_RATE * 2 {
            w.step();
        }
        assert_eq!(w.players.len(), 3, "bots don't refill past the cap");

        let (link, _rx2) = test_link();
        let human = w.join(plain_join("human2"), link).unwrap();
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
        let id = w.join(plain_join("slow"), link).unwrap();
        // The client never reads anything; snapshots just keep replacing
        // each other, and only the bounded event queue can overflow.
        for _ in 0..30 {
            w.step();
            w.send_updates();
        }
        assert!(w.dropped_clients().is_empty());
        assert!(w.players.contains_key(&id));
    }

    /// The positional `me` array of a snapshot as a named object.
    fn me_obj(snap: &serde_json::Value) -> serde_json::Value {
        let values = snap["me"].as_array().unwrap();
        protocol::ME_FIELDS.iter().zip(values).map(|(k, v)| (k.to_string(), v.clone())).collect::<serde_json::Map<_, _>>().into()
    }

    /// Messages a client received, decoded.
    fn drain(rx: &mut mpsc::Receiver<Bytes>) -> Vec<serde_json::Value> {
        let mut out = Vec::new();
        while let Ok(m) = rx.try_recv() {
            out.push(rmp_serde::from_slice(&m).unwrap());
        }
        out
    }

    fn joined(w: &mut World, name: &str) -> (u32, mpsc::Receiver<Bytes>) {
        let (link, rx) = test_link();
        let id = w.join(plain_join(name), link).unwrap();
        (id, rx)
    }

    #[test]
    fn rounds_end_with_mvp_and_reset_scores() {
        let mut w = test_world(Map::empty(31, 31));
        w.round_ticks = 40;
        w.round_end = 40;
        let (a, mut rx) = joined(&mut w, "a");
        w.players.get_mut(&a).unwrap().score = 7;
        for _ in 0..40 {
            w.step();
            w.send_updates();
        }
        let msgs = drain(&mut rx);
        let round = msgs.iter().find(|m| m["t"] == "round").expect("round message");
        assert_eq!(round["mvp"][0][0], a);
        assert_eq!(round["mvp"][0][2], 7);
        assert_eq!(w.players[&a].score, 0, "scores reset for the next round");
        assert!(msgs.iter().any(|m| m["t"] == "hills"), "hills move");
        assert_eq!(w.round_end, 80);
    }

    #[test]
    fn teams_have_no_friendly_fire() {
        let mut w = test_world(Map::empty(15, 15));
        w.mode = Mode::Teams;
        let a = w.spawn_test_player(1.5, 1.5);
        let mate = w.spawn_test_player(3.5, 1.5);
        let foe = w.spawn_test_player(1.5, 3.5);
        w.players.get_mut(&a).unwrap().team = 1;
        w.players.get_mut(&mate).unwrap().team = 1;
        w.players.get_mut(&foe).unwrap().team = 2;
        w.place_bomb(a);
        w.players.get_mut(&a).unwrap().x = 5.5;
        w.players.get_mut(&a).unwrap().y = 5.5;
        for _ in 0..bomb::FUSE_TICKS + 1 {
            w.step();
        }
        assert!(w.players[&mate].alive, "teammate survives");
        assert!(!w.players[&foe].alive, "opponent does not");
        assert_eq!(w.team_scores(), (1, 0));
    }

    #[test]
    fn standing_on_a_hill_scores() {
        let mut w = test_world(Map::empty(15, 15));
        w.hills = vec![(5, 5)];
        let id = w.spawn_test_player(5.5, 5.5);
        for _ in 0..HILL_POINT_TICKS {
            w.step();
        }
        assert_eq!(w.players[&id].score, 1);
    }

    #[test]
    fn bounty_pays_extra_and_streaks_are_announced() {
        let mut w = test_world(Map::empty(21, 21));
        let (hunter, mut rx) = joined(&mut w, "hunter");
        let mut victims = Vec::new();
        for i in 0..3 {
            victims.push(w.spawn_test_player(10.5, 3.5 + 2.0 * i as f32));
        }
        let leader = victims[0];
        w.players.get_mut(&leader).unwrap().score = BOUNTY_MIN_SCORE;
        w.update_bounty();
        assert!(w.players[&leader].bounty);
        for &v in &victims {
            w.kill(v, Some(hunter));
        }
        w.send_updates();
        assert_eq!(w.players[&hunter].score, 3 + BOUNTY_BONUS, "bounty kill pays extra");
        let msgs = drain(&mut rx);
        assert!(msgs.iter().any(|m| m["t"] == "streak" && m["n"] == 3));
        assert!(msgs.iter().any(|m| m["t"] == "kill" && m["b"] == true));
        assert!(msgs.iter().any(|m| m["t"] == "emote" && m["id"] == hunter), "auto emote after a kill");
    }

    #[test]
    fn reconnecting_restores_progress() {
        let mut w = test_world(Map::empty(21, 21));
        let (link, _rx) = test_link();
        let req = JoinRequest { token: Some("token-resume-1".into()), ..plain_join("ann") };
        let id = w.join(req, link).unwrap();
        let p = w.players.get_mut(&id).unwrap();
        (p.score, p.range, p.kick) = (4, 5, true);
        w.leave(id);
        let (link, mut rx) = test_link();
        let req = JoinRequest { token: Some("token-resume-1".into()), ..plain_join("ann") };
        let id2 = w.join(req, link).unwrap();
        let p = &w.players[&id2];
        assert_eq!((p.score, p.range, p.kick), (4, 5, true));
        let welcome = drain(&mut rx).into_iter().find(|m| m["t"] == "welcome").unwrap();
        assert_eq!(welcome["resumed"], true);
    }

    #[test]
    fn teleporters_move_you_to_the_twin_pad() {
        let mut map = Map::empty(21, 21);
        map.set(3, 1, Tile::Teleport);
        map.set(15, 15, Tile::Teleport);
        map.teleports.push(((3, 1), (15, 15)));
        let mut w = test_world(map);
        let id = w.spawn_test_player(2.5, 1.5);
        w.hold(id, 2, 0);
        for _ in 0..8 {
            w.step();
        }
        let p = &w.players[&id];
        assert!(p.cell().1 >= 15, "teleported, now at {:?}", p.cell());
    }

    #[test]
    fn ice_keeps_you_sliding_until_you_hit_something() {
        let mut map = Map::empty(15, 15);
        for x in 1..8 {
            map.set(x, 1, Tile::Ice);
        }
        map.set(8, 1, Tile::Crate);
        let mut w = test_world(map);
        let id = w.spawn_test_player(1.5, 1.5);
        w.hold(id, 2, 0);
        w.step();
        w.step();
        w.hold(id, 0, 0);
        for _ in 0..60 {
            w.step();
        }
        let x = w.players[&id].x;
        assert!((x - 7.5).abs() < 1e-3, "slid all the way to the crate, x = {x}");
        // Steering still works on ice.
        w.hold(id, 4, 0);
        w.step();
        assert!(w.players[&id].x < 7.5);
    }

    #[test]
    fn ghosts_walk_through_crates() {
        let mut map = Map::empty(15, 15);
        map.set(2, 1, Tile::Crate);
        let mut w = test_world(map);
        let id = w.spawn_test_player(1.5, 1.5);
        w.players.get_mut(&id).unwrap().ghost_until = 1000;
        w.hold(id, 2, 0);
        for _ in 0..12 {
            w.step();
        }
        assert!(w.players[&id].x > 3.0, "passed the crate");
    }

    #[test]
    fn reversed_controls_flip_directions() {
        let mut w = test_world(Map::empty(15, 15));
        let id = w.spawn_test_player(3.5, 1.5);
        w.players.get_mut(&id).unwrap().reversed_until = 1000;
        w.hold(id, 2, 0);
        for _ in 0..4 {
            w.step();
        }
        assert!(w.players[&id].x < 3.5, "pressing right moved left");
    }

    #[test]
    fn emotes_reach_nearby_players_only() {
        let mut w = test_world(Map::empty(81, 81));
        let (a, _rxa) = joined(&mut w, "a");
        let (b, mut rxb) = joined(&mut w, "b");
        let (c, mut rxc) = joined(&mut w, "c");
        w.players.get_mut(&a).unwrap().x = 10.5;
        w.players.get_mut(&b).unwrap().x = 12.5;
        w.players.get_mut(&c).unwrap().x = 70.5;
        for id in [a, b, c] {
            w.players.get_mut(&id).unwrap().y = 10.5;
        }
        w.rebuild_buckets();
        w.players[&a].link.as_ref().unwrap().input.emote(2);
        w.step();
        w.send_updates();
        assert!(drain(&mut rxb).iter().any(|m| m["t"] == "emote" && m["e"] == 2));
        assert!(!drain(&mut rxc).iter().any(|m| m["t"] == "emote"));
    }

    #[test]
    fn dead_players_watch_their_killer() {
        let mut w = test_world(Map::empty(81, 81));
        let me = w.spawn_test_player(5.5, 5.5);
        let killer = w.spawn_test_player(60.5, 60.5);
        w.kill(me, Some(killer));
        let snap: serde_json::Value = w.full_snapshot(me);
        assert_eq!(me_obj(&snap)["spec"], killer);
        let ids: Vec<u64> = snap["p"].as_array().unwrap().iter().map(|p| p[0].as_u64().unwrap()).collect();
        assert!(ids.contains(&(killer as u64)), "the killer is in view");
    }

    #[test]
    fn world_changes_are_sent_reliably() {
        let mut w = test_world(Map::empty(15, 15));
        let (_, mut rx) = joined(&mut w, "a");
        w.set_tile(3, 3, Tile::Crate);
        w.set_item(5, 5, Item::Ghost as u8);
        w.send_updates();
        let msgs = drain(&mut rx);
        let delta = msgs.iter().find(|m| m["t"] == "w").expect("world delta");
        assert_eq!(delta["tc"], serde_json::json!([[3, 3, 2]]));
        assert_eq!(delta["ic"], serde_json::json!([[5, 5, 12]]));
    }

    #[test]
    fn input_sequence_is_echoed_for_prediction() {
        let mut w = test_world(Map::empty(15, 15));
        let id = w.spawn_test_player(1.5, 1.5);
        w.players[&id].link.as_ref().unwrap().input.set_dirs(2, 0, 4242);
        w.step();
        let snap: serde_json::Value = w.full_snapshot(id);
        assert_eq!(me_obj(&snap)["ack"], 4242);
    }

    /// Applies a delta list (`changed`, `removed`) to a client-side id map,
    /// exactly as the browser does.
    fn apply_delta(state: &mut std::collections::BTreeMap<u64, serde_json::Value>, changed: &serde_json::Value, removed: &serde_json::Value) {
        for id in removed.as_array().unwrap() {
            state.remove(&id.as_u64().unwrap());
        }
        for e in changed.as_array().unwrap() {
            state.insert(e[0].as_u64().unwrap(), e.clone());
        }
    }

    #[test]
    fn delta_snapshots_rebuild_the_full_picture() {
        let mut rng = Rng::new(21);
        let map = Map::generate(41, 41, 0.45, &mut rng);
        let mut w = World::with_map(map, rng, 64);
        w.set_target_bots(12);
        let (me, _rx) = joined(&mut w, "viewer");
        w.players.get_mut(&me).unwrap().set_aoi(26, 18); // see most of the map
        let input = w.players[&me].link.as_ref().unwrap().input.clone();
        let snapshot = w.players[&me].link.as_ref().unwrap().snapshot.clone();
        // Client-side state, keyed by tick: (players, bombs).
        type View = std::collections::BTreeMap<u64, serde_json::Value>;
        let mut decoded: HashMap<u64, (View, View)> = HashMap::new();
        let (mut delta_bytes, mut full_bytes, mut deltas) = (0usize, 0usize, 0);
        for t in 0..400 {
            w.step();
            w.send_updates();
            let msg = snapshot.take().expect("a snapshot every tick");
            let snap: serde_json::Value = rmp_serde::from_slice(&msg).unwrap();
            let k = snap["k"].as_u64().unwrap();
            let bk = snap["bk"].as_u64().unwrap();
            let (mut players, mut bombs) = if bk == 0 { Default::default() } else { decoded[&bk].clone() };
            if bk != 0 {
                deltas += 1;
            }
            apply_delta(&mut players, &snap["p"], &snap["pr"]);
            apply_delta(&mut bombs, &snap["b"], &snap["br"]);
            // Compare with what a full snapshot would have said.
            let full = w.full_snapshot(me);
            let as_map = |v: &serde_json::Value| -> View { v.as_array().unwrap().iter().map(|e| (e[0].as_u64().unwrap(), e.clone())).collect() };
            assert_eq!(players, as_map(&full["p"]), "players differ at tick {k}");
            assert_eq!(bombs, as_map(&full["b"]), "bombs differ at tick {k}");
            delta_bytes += msg.len();
            full_bytes += rmp_serde::to_vec_named(&full).unwrap().len();
            decoded.insert(k, (players, bombs));
            // Like a real client: acknowledge now and then, sometimes late.
            if t % 3 != 2 {
                input.set_ack(k as u32);
            }
        }
        assert!(deltas > 300, "most snapshots are deltas: {deltas}");
        eprintln!("delta snapshots: {delta_bytes} bytes vs {full_bytes} full");
        assert!(delta_bytes < full_bytes, "deltas are smaller");
    }

    #[test]
    fn snapshots_fall_back_to_full_without_a_known_ack() {
        let mut w = test_world(Map::empty(15, 15));
        let (me, _rx) = joined(&mut w, "a");
        let link = w.players[&me].link.as_ref().unwrap();
        let (input, snapshot) = (link.input.clone(), link.snapshot.clone());
        input.set_ack(999_999); // a tick the server never sent
        w.step();
        w.send_updates();
        let snap: serde_json::Value = rmp_serde::from_slice(&snapshot.take().unwrap()).unwrap();
        assert_eq!(snap["bk"], 0, "full snapshot");
        assert_eq!(snap["p"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn invite_links_spawn_you_next_to_your_friend() {
        let mut w = test_world(Map::empty(81, 81));
        let friend = w.spawn_test_player(60.5, 60.5);
        for _ in 0..5 {
            let (link, _rx) = test_link();
            let id = w.join(JoinRequest { near: friend, ..plain_join("pal") }, link).unwrap();
            let (x, y) = w.players[&id].cell();
            assert!((x - 60).abs() <= 5 && (y - 60).abs() <= 5, "spawned at ({x},{y})");
        }
    }

    #[test]
    fn teams_are_balanced_on_join() {
        let mut w = test_world(Map::empty(41, 41));
        w.mode = Mode::Teams;
        let teams: Vec<u8> = (0..6).map(|i| {
            let (id, _rx) = joined(&mut w, &format!("p{i}"));
            w.players[&id].team
        }).collect();
        assert_eq!(teams.iter().filter(|&&t| t == 1).count(), 3);
        assert_eq!(teams.iter().filter(|&&t| t == 2).count(), 3);
    }
}
