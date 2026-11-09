//! The authoritative game simulation. A single task owns the `World` and
//! advances it at a fixed tick rate; connections talk to it via channels.

pub mod bomb;
pub mod items;
pub mod map;
pub mod player;
pub mod rng;

use std::collections::HashMap;
use std::time::{Duration, Instant};

use axum::extract::ws::Utf8Bytes;
use tokio::sync::{mpsc, oneshot};

use crate::protocol::{Me, ServerMsg, TileChange};
use bomb::{Bomb, Explosion};
use items::Item;
use map::{Map, Tile};
use player::{DIRS, MAX_BOMBS, MAX_RANGE, MAX_SPEED_LVL, Player, step_move};
use rng::Rng;

pub const TICK_RATE: u32 = 20;
const DT: f32 = 1.0 / TICK_RATE as f32;
const RESPAWN_TICKS: u64 = 3 * TICK_RATE as u64;
const SPAWN_SHIELD_TICKS: u64 = 2 * TICK_RATE as u64;
/// Half extents of the area each client receives entity updates for. The
/// client sizes its tiles so its viewport always fits inside this box.
pub const AOI_HALF_W: i32 = 16;
pub const AOI_HALF_H: i32 = 12;
const BUCKET: i32 = 8;
const CRATE_DENSITY: f32 = 0.45;
/// Fraction of the initial crate count the map regrows towards.
const CRATE_REGROW_TARGET: f32 = 0.85;
const LEADERBOARD_EVERY: u64 = TICK_RATE as u64;
const ITEMS_DROPPED_ON_DEATH: usize = 3;

pub struct Config {
    pub map_w: i32,
    pub map_h: i32,
    pub max_players: usize,
}

pub enum GameEvent {
    Join { name: String, tx: mpsc::Sender<Utf8Bytes>, reply: oneshot::Sender<Result<u32, &'static str>> },
    Input { id: u32, dir: u8 },
    Bomb { id: u32 },
    Leave { id: u32 },
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
    broadcasts: Vec<Utf8Bytes>,
}

impl World {
    pub fn new(cfg: &Config) -> Self {
        let mut rng = Rng::from_time();
        let map = Map::generate(cfg.map_w, cfg.map_h, CRATE_DENSITY, &mut rng);
        Self::with_map(map, rng, cfg.max_players)
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
            players: HashMap::new(),
            next_player_id: 0,
            bombs: HashMap::new(),
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
            map,
        }
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

    fn join(&mut self, name: String, tx: mpsc::Sender<Utf8Bytes>) -> Result<u32, &'static str> {
        if self.players.len() >= self.max_players {
            return Err("server is full, try again later");
        }
        self.next_player_id += 1;
        let id = self.next_player_id;
        let mut p = Player::new(id, name, tx);
        let (x, y) = self.find_spawn();
        p.x = x as f32 + 0.5;
        p.y = y as f32 + 0.5;
        p.alive = true;
        p.invulnerable_until = self.tick + SPAWN_SHIELD_TICKS;

        let welcome = ServerMsg::Welcome {
            id,
            w: self.map.w,
            h: self.map.h,
            map: self.map.encode_rle(),
            rate: TICK_RATE,
            aoi: (AOI_HALF_W, AOI_HALF_H),
            roster: self
                .players
                .values()
                .map(|o| (o.id, o.name.as_str()))
                .chain(std::iter::once((id, p.name.as_str())))
                .collect(),
        };
        let _ = p.tx.try_send(welcome.to_json().into());
        self.broadcasts.push(ServerMsg::Pj { id, name: &p.name }.to_json().into());
        self.players.insert(id, p);
        self.rebuild_buckets();
        Ok(id)
    }

    fn leave(&mut self, id: u32) {
        if self.players.remove(&id).is_some() {
            self.broadcasts.push(ServerMsg::Pl { id }.to_json().into());
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
            if self.open_cells_near(x, y, 3) >= 4 {
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

    /// Counts floor cells reachable from (x, y) within `depth` steps.
    fn open_cells_near(&self, x: i32, y: i32, depth: i32) -> usize {
        let mut seen = vec![(x, y)];
        let mut frontier = vec![(x, y)];
        for _ in 0..depth {
            let mut next = Vec::new();
            for (cx, cy) in frontier {
                for &(dx, dy) in &DIRS[1..] {
                    let c = (cx + dx, cy + dy);
                    if !self.map.is_solid(c.0, c.1) && !seen.contains(&c) {
                        seen.push(c);
                        next.push(c);
                    }
                }
            }
            frontier = next;
        }
        seen.len()
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
        let mut lost = Vec::new();
        lost.extend(std::iter::repeat_n(Item::ExtraBomb, (v.max_bombs - player::BASE_BOMBS) as usize));
        lost.extend(std::iter::repeat_n(Item::Range, (v.range - player::BASE_RANGE) as usize));
        lost.extend(std::iter::repeat_n(Item::Speed, v.speed_lvl as usize));
        if v.kick {
            lost.push(Item::Kick);
        }
        v.reset_stats();
        for _ in 0..ITEMS_DROPPED_ON_DEATH.min(lost.len()) {
            let k = self.rng.below(lost.len() as u32) as usize;
            let item = lost.swap_remove(k);
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
        match killer {
            Some(k) if k == victim => {
                self.players.get_mut(&k).unwrap().score -= 1;
            }
            Some(k) => {
                let kp = self.players.get_mut(&k).unwrap();
                kp.score += 1;
                kp.kills += 1;
            }
            None => {}
        }
        self.broadcasts.push(ServerMsg::Kill { k: killer, v: victim, x: vx, y: vy }.to_json().into());
    }

    fn update_players(&mut self) {
        let ids: Vec<u32> = self.players.keys().copied().collect();
        for id in ids {
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

            let dir = p.input_dir;
            let (mut x, mut y) = (p.x, p.y);
            let start_cell = p.cell();
            let dist = p.speed() * DT;
            if dir != 0 {
                let map = &self.map;
                let bomb_grid = &self.bomb_grid;
                // A bomb blocks unless it's in the cell the player stands in,
                // which lets players walk off a bomb they just dropped.
                step_move(&mut x, &mut y, dir, dist, |cx, cy| {
                    map.is_solid(cx, cy) || ((cx, cy) != start_cell && bomb_grid[map.idx(cx, cy)] != 0)
                });
            }
            let p = self.players.get_mut(&id).unwrap();
            p.moving = (x, y) != (p.x, p.y);
            if dir != 0 {
                p.facing = dir;
            }
            p.x = x;
            p.y = y;
            let (cx, cy) = p.cell();
            let has_kick = p.kick;

            // Kick: pressing into an adjacent bomb while standing at the
            // centre of the cell sends it sliding. A player boxed in by bombs
            // may kick even without the power-up, so they're never stuck.
            if dir != 0 && !p.moving && (has_kick || self.is_trapped(cx, cy)) {
                let (dx, dy) = DIRS[dir as usize];
                if let Some(b) = self.bomb_at(cx + dx, cy + dy) {
                    self.kick_bomb(b, dir);
                }
            }

            // Pick up items.
            let i = self.map.idx(cx, cy);
            if let Some(item) = Item::from_u8(self.items[i]) {
                self.items[i] = 0;
                let p = self.players.get_mut(&id).unwrap();
                match item {
                    Item::ExtraBomb => p.max_bombs = (p.max_bombs + 1).min(MAX_BOMBS),
                    Item::Range => p.range = (p.range + 1).min(MAX_RANGE),
                    Item::Speed => p.speed_lvl = (p.speed_lvl + 1).min(MAX_SPEED_LVL),
                    Item::Kick => p.kick = true,
                }
            }

            if std::mem::take(&mut self.players.get_mut(&id).unwrap().want_bomb) {
                self.place_bomb(id);
            }
        }
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
        let victims: Vec<(u32, u32)> = self
            .players
            .values()
            .filter(|p| p.alive && p.invulnerable_until <= self.tick)
            .filter_map(|p| {
                let (x, y) = p.cell();
                self.flame_active(x, y).then(|| (p.id, self.flame_owner[self.map.idx(x, y)]))
            })
            .collect();
        for (v, k) in victims {
            self.kill(v, Some(k));
        }
    }

    /// Slowly regrows crates in quiet areas so the big map never runs dry.
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
            self.set_tile(x, y, Tile::Crate);
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

    fn snapshot_for(&self, p: &Player) -> String {
        let (cx, cy) = p.cell();
        let (x0, y0, x1, y1) = aoi_rect(cx, cy);
        let players = self
            .players_in_rect(x0, y0, x1, y1)
            .filter(|o| o.alive)
            .map(|o| {
                let flags = o.moving as u8 | ((o.invulnerable_until > self.tick) as u8) << 1;
                (o.id, (o.x * 100.0) as i32, (o.y * 100.0) as i32, o.facing, flags)
            })
            .collect();

        let mut bombs = Vec::new();
        let mut items = Vec::new();
        for y in y0.max(0)..=y1.min(self.map.h - 1) {
            for x in x0.max(0)..=x1.min(self.map.w - 1) {
                let i = self.map.idx(x, y);
                if self.bomb_grid[i] != 0 {
                    let b = &self.bombs[&self.bomb_grid[i]];
                    bombs.push((b.id, x, y, b.explode_at.saturating_sub(self.tick) as u16));
                }
                if self.items[i] != 0 {
                    items.push((x, y, self.items[i]));
                }
            }
        }

        let reach = MAX_RANGE as i32;
        let explosions = self
            .explosions
            .iter()
            .filter(|e| e.x >= x0 - reach && e.x <= x1 + reach && e.y >= y0 - reach && e.y <= y1 + reach)
            .map(|e| (e.x, e.y, e.arms, (e.until - self.tick) as u8))
            .collect();

        ServerMsg::Snapshot {
            k: self.tick,
            p: players,
            b: bombs,
            e: explosions,
            i: items,
            tc: &self.tile_changes,
            me: Me {
                alive: p.alive,
                bombs: p.max_bombs,
                active: p.active_bombs,
                range: p.range,
                speed: p.speed_lvl,
                kick: p.kick,
                score: p.score,
                respawn: if p.alive { 0 } else { p.respawn_at.saturating_sub(self.tick) as u32 },
                killer: p.killed_by,
            },
        }
        .to_json()
    }

    fn leaderboard(&self) -> String {
        let mut top: Vec<&Player> = self.players.values().collect();
        top.sort_by(|a, b| b.score.cmp(&a.score).then(b.kills.cmp(&a.kills)).then(a.id.cmp(&b.id)));
        ServerMsg::Lb {
            n: self.players.len(),
            top: top.iter().take(10).map(|p| (p.id, p.name.as_str(), p.score, p.kills, p.deaths)).collect(),
        }
        .to_json()
    }

    // ------------------------------------------------------------- the tick

    pub fn handle(&mut self, ev: GameEvent) {
        match ev {
            GameEvent::Join { name, tx, reply } => {
                let _ = reply.send(self.join(name, tx));
            }
            GameEvent::Input { id, dir } => {
                if let Some(p) = self.players.get_mut(&id) {
                    p.input_dir = dir.min(4);
                }
            }
            GameEvent::Bomb { id } => {
                if let Some(p) = self.players.get_mut(&id) {
                    p.want_bomb = true;
                }
            }
            GameEvent::Leave { id } => self.leave(id),
        }
    }

    /// Advances the simulation by one tick (without networking).
    pub fn step(&mut self) {
        self.tick += 1;
        self.tile_changes.clear();
        self.explosions.retain(|e| e.until > self.tick);
        self.update_players();
        self.rebuild_buckets();
        self.update_sliding_bombs();
        self.update_fuses();
        self.apply_flame_damage();
        self.regrow_crates();
    }

    /// Sends this tick's broadcasts and per-client snapshots. Returns the ids
    /// of clients whose outgoing queue is full or closed.
    fn send_updates(&mut self) -> Vec<u32> {
        let mut broadcasts = std::mem::take(&mut self.broadcasts);
        if self.tick % LEADERBOARD_EVERY == 0 {
            broadcasts.push(self.leaderboard().into());
        }
        let mut dropped = Vec::new();
        for p in self.players.values() {
            let mut ok = broadcasts.iter().all(|m| p.tx.try_send(m.clone()).is_ok());
            ok = ok && p.tx.try_send(self.snapshot_for(p).into()).is_ok();
            if !ok {
                dropped.push(p.id);
            }
        }
        dropped
    }
}

/// Inclusive tile rectangle a player at (cx, cy) receives updates for.
pub fn aoi_rect(cx: i32, cy: i32) -> (i32, i32, i32, i32) {
    (cx - AOI_HALF_W, cy - AOI_HALF_H, cx + AOI_HALF_W, cy + AOI_HALF_H)
}

pub async fn run(cfg: Config, mut events: mpsc::Receiver<GameEvent>) {
    let mut world = World::new(&cfg);
    tracing::info!(w = cfg.map_w, h = cfg.map_h, crates = world.crate_count, "world generated");
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
        for id in world.send_updates() {
            tracing::info!(id, "dropping slow or closed client");
            world.leave(id);
        }

        let took = started.elapsed();
        ticks += 1;
        busy += took;
        worst = worst.max(took);
        if stats_since.elapsed() >= Duration::from_secs(10) {
            tracing::info!(
                players = world.players.len(),
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

#[cfg(test)]
pub fn test_world(map: Map) -> World {
    World::with_map(map, Rng::new(3), 64)
}

#[cfg(test)]
impl World {
    pub fn spawn_test_player(&mut self, x: f32, y: f32) -> u32 {
        let (tx, rx) = mpsc::channel(1024);
        std::mem::forget(rx);
        self.next_player_id += 1;
        let id = self.next_player_id;
        let mut p = Player::new(id, format!("p{id}"), tx);
        p.x = x;
        p.y = y;
        p.alive = true;
        self.players.insert(id, p);
        self.rebuild_buckets();
        id
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
        let (x0, y0, x1, y1) = aoi_rect(10, 10);
        let ids: Vec<u32> = w.players_in_rect(x0, y0, x1, y1).map(|p| p.id).collect();
        assert!(ids.contains(&me) && ids.contains(&near));
        assert!(!ids.contains(&far));
        let snap = w.snapshot_for(&w.players[&me]);
        assert!(!snap.contains(&format!("[{far},")));
    }

    #[test]
    fn owner_can_walk_off_own_bomb_but_not_back() {
        let mut w = test_world(Map::empty(15, 15));
        let id = w.spawn_test_player(1.5, 1.5);
        w.place_bomb(id);
        w.players.get_mut(&id).unwrap().input_dir = 2;
        for _ in 0..10 {
            w.step();
        }
        let x = w.players[&id].x;
        assert!(x > 2.0, "walked off the bomb, x = {x}");
        w.players.get_mut(&id).unwrap().input_dir = 4;
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
        w.players.get_mut(&me).unwrap().input_dir = 3;
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
        w.players.get_mut(&me).unwrap().input_dir = 1;
        w.step();
        let bid = w.bomb_at(1, 2).unwrap();
        assert_eq!(w.bombs[&bid].slide_dir, 0);
    }

    #[test]
    fn picking_up_items_upgrades_stats() {
        let mut w = test_world(Map::empty(15, 15));
        let id = w.spawn_test_player(1.5, 1.5);
        let i = w.map.idx(2, 1);
        w.items[i] = Item::Range as u8;
        w.players.get_mut(&id).unwrap().input_dir = 2;
        for _ in 0..5 {
            w.step();
        }
        assert_eq!(w.players[&id].range, player::BASE_RANGE + 1);
        assert_eq!(w.items[i], 0);
    }
}
