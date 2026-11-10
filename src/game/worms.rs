//! Worms: AI creatures of the worms arena. A worm is a head and a body
//! that follows the head's path, crawling one cell at a time through the
//! lanes. It hunts the nearest player it can sense and anyone touching any
//! part of it (on the ground, unshielded) is eaten, which makes the worm a
//! segment longer.
//!
//! Fire hurts worms: every segment in a blast is destroyed. What's left of
//! the body falls apart into pieces; a piece long enough crawls on as a
//! worm of its own (the part with the old head keeps the worm's id), a
//! shorter one dies. Whoever's fire ends a worm (destroys its head, or
//! leaves it too short) scores for it. Lost worms come back over time.
//!
//! Hunting worms are cunning: they head for where a running player is
//! going rather than where they are, lie in wait when they'll get there
//! first, split up to come at the same player from two sides, lunge at
//! prey a step or two away, remember where prey slipped out of reach, and
//! keep out of blasts about to go off. Idle worms drift towards players.
//! New worms burrow out near the action (never right on top of anyone)
//! and away from other worms.
//!
//! Worms step on whole cells, so their state is tiny: the cells, head first,
//! and the cell the tail just left, which lets clients slide every segment
//! smoothly between steps. Every number worth tuning is in [`WormTuning`].

use std::collections::VecDeque;

use crate::protocol::ev;

use super::ai::{DangerScratch, SAFE};
use super::player::{DIRS, OPPOSITE, Player};
use super::{DT, TICK_RATE, World};

/// Seconds to ticks.
const SEC: u64 = TICK_RATE as u64;

/// Everything about worms worth tuning, in one place.
#[derive(Clone, Debug, PartialEq)]
pub struct WormTuning {
    /// One worm for this many map cells, kept between `min_count` and `max_count`.
    pub cells_per_worm: i32,
    pub min_count: usize,
    pub max_count: usize,
    /// Segments of a newly spawned worm, head included.
    pub length: usize,
    /// A worm stops growing at this many segments.
    pub max_length: usize,
    /// A piece cut off by a blast needs this many segments to live on.
    pub min_length: usize,
    /// Ticks per cell while hunting, and while wandering (slower than a
    /// player's 3.5 cells a second, so running away works).
    pub chase_step_ticks: u64,
    pub wander_step_ticks: u64,
    /// How far (in steps along the lanes) a worm smells a player.
    pub sense_range: u16,
    /// Prey this many steps away gets a lunge: steps of `lunge_step_ticks`.
    pub lunge_range: u16,
    pub lunge_step_ticks: u64,
    /// How many cells ahead of a running player a worm considers cutting
    /// them off.
    pub intercept_cells: i32,
    /// How long a worm keeps going for the cell where prey slipped away.
    pub memory_ticks: u64,
    /// Idle worms drift towards players within this many cells (Chebyshev),
    /// taking the turn that closes in this often at a junction.
    pub roam_range: i32,
    pub roam_bias: f32,
    /// A worm burrows out of the ground for this long: it neither moves
    /// nor bites yet, but fire already hurts it.
    pub emerge_ticks: u64,
    /// After a worm dies, the next one comes no sooner than this; while
    /// worms are missing, one more arrives every `spawn_gap_ticks`.
    pub respawn_ticks: u64,
    pub spawn_gap_ticks: u64,
    /// New worms spawn at least this far (Chebyshev cells) from players,
    /// preferably no farther than `spawn_reach`, out of the best of
    /// `spawn_candidates` spots.
    pub spawn_clearance: i32,
    pub spawn_reach: i32,
    pub spawn_candidates: u32,
    /// Score for ending a worm.
    pub kill_points: i32,
    /// Profile XP for ending a worm.
    pub kill_xp: u64,
}

impl Default for WormTuning {
    fn default() -> Self {
        WormTuning {
            cells_per_worm: 550,
            min_count: 3,
            max_count: 14,
            length: 5,
            max_length: 10,
            min_length: 2,
            chase_step_ticks: 7,
            wander_step_ticks: 10,
            sense_range: 12,
            lunge_range: 2,
            lunge_step_ticks: 4,
            intercept_cells: 6,
            memory_ticks: 4 * SEC,
            roam_range: 28,
            roam_bias: 0.6,
            emerge_ticks: 3 * SEC / 2,
            respawn_ticks: 8 * SEC,
            spawn_gap_ticks: 2 * SEC,
            spawn_clearance: 7,
            spawn_reach: 18,
            spawn_candidates: 24,
            kill_points: 1,
            kill_xp: 5,
        }
    }
}

/// Snapshot flags of a worm (see `protocol::snap`).
pub mod flag {
    /// Hunting a player.
    pub const CHASING: u8 = 1;
    /// Still burrowing out of the ground.
    pub const EMERGING: u8 = 2;
    /// Out of the client's view: only the head is sent, for the minimap.
    pub const FAR: u8 = 4;
    /// Lunging at prey a step or two away.
    pub const LUNGE: u8 = 8;
    /// Lying in wait for prey running its way.
    pub const LURK: u8 = 16;
}

/// What a worm event ([`ev::WORM`]) reports.
pub mod news {
    /// A worm ate a player: (x, y, victim id + 1).
    pub const ATE: i64 = 1;
    /// A worm was killed: (x, y, killer id + 1).
    pub const KILLED: i64 = 2;
    /// A blast cut a worm in two: (x, y, cutter id + 1).
    pub const CUT: i64 = 3;
}

pub struct Worm {
    pub id: u32,
    /// Cells, head first. Neighbouring segments are on neighbouring cells
    /// or on the same cell (a worm still uncoiling from its burrow).
    pub body: VecDeque<(i32, i32)>,
    /// The cell the tail left on the last step.
    pub trail: (i32, i32),
    /// Direction of the last step (see `DIRS`).
    pub dir: u8,
    pub last_step: u64,
    pub next_step: u64,
    /// Ticks per cell of the current pace.
    pub step_ticks: u64,
    pub chasing: bool,
    pub lunging: bool,
    /// Holding still in ambush.
    pub lurking: bool,
    /// Who it hunts (0: nobody) and the cell it's making for, which other
    /// worms after the same prey avoid, so they come from another side.
    pub prey: u32,
    pub target: (i32, i32),
    /// Where its prey was last smelt, until when it keeps looking there.
    pub memory: Option<((i32, i32), u64)>,
    /// Steps in a row it couldn't move.
    pub stuck: u8,
    pub emerge_until: u64,
}

impl Worm {
    #[must_use]
    pub fn head(&self) -> (i32, i32) {
        self.body[0]
    }

    #[must_use]
    pub fn covers(&self, x: i32, y: i32) -> bool {
        self.body.iter().any(|&c| c == (x, y))
    }

    #[must_use]
    pub fn emerging(&self, tick: u64) -> bool {
        self.emerge_until > tick
    }
}

/// The worms of an arena and the buffers their thinking reuses.
#[derive(Default)]
pub struct Worms {
    pub enabled: bool,
    pub tuning: WormTuning,
    pub list: Vec<Worm>,
    pub next_spawn: u64,
    /// Segments per cell, all worms together.
    pub occupied: Vec<u8>,
    seen: Vec<u32>,
    /// Per cell, for cells seen by the current search: steps from the
    /// head, and the first step on the way.
    dist: Vec<u16>,
    first: Vec<u8>,
    generation: u32,
    /// Breadth-first search queue.
    queue: Vec<(i32, i32)>,
    /// Prey in range: (id, cell, running direction or 0, ticks per cell).
    prey: Vec<(u32, (i32, i32), u8, f32)>,
    /// Ticks until fire per cell, refreshed once a tick when a worm thinks.
    danger: DangerScratch,
    danger_tick: Option<u64>,
    victims: Vec<(u32, usize)>,
    hit: Vec<bool>,
}

impl Worms {
    #[must_use]
    pub fn new(cells: usize) -> Self {
        Worms { occupied: vec![0; cells], seen: vec![0; cells], dist: vec![0; cells], first: vec![0; cells], ..Worms::default() }
    }
}

/// Upper bound on cells one hunting search visits.
const SEARCH_LIMIT: usize = 500;
/// Steps a worm stays stuck before it turns round (tail first).
const STUCK_TURN: u8 = 3;

impl World {
    #[must_use]
    pub fn worms_on(&self) -> bool {
        self.worms.enabled
    }

    /// How many worms this arena keeps.
    #[must_use]
    pub fn worm_target(&self) -> usize {
        let t = &self.worms.tuning;
        ((self.map.w * self.map.h / t.cells_per_worm.max(1)) as usize).clamp(t.min_count, t.max_count.max(t.min_count))
    }

    /// Turns worms on and fills the arena with them.
    pub fn enable_worms(&mut self) {
        self.worms.enabled = true;
        for _ in 0..self.worm_target() {
            self.spawn_worm();
        }
        self.worms.next_spawn = self.tick + self.worms.tuning.spawn_gap_ticks;
    }

    /// Whether any worm segment is within `r` cells (Chebyshev) of (x, y).
    #[must_use]
    pub fn worm_near(&self, x: i32, y: i32, r: i32) -> bool {
        self.worms.list.iter().flat_map(|w| w.body.iter()).any(|&(wx, wy)| (wx - x).abs() <= r && (wy - y).abs() <= r)
    }

    /// Adds a worm, coiled up in one cell and burrowing out, at `cell`.
    pub fn add_worm(&mut self, cell: (i32, i32), length: usize) -> u32 {
        let id = self.next_object_id();
        let t = &self.worms.tuning;
        let body: VecDeque<_> = std::iter::repeat_n(cell, length.max(1)).collect();
        let worm = Worm {
            id,
            body,
            trail: cell,
            dir: 1 + self.rng.below(4) as u8,
            last_step: self.tick,
            next_step: self.tick + t.emerge_ticks,
            step_ticks: t.wander_step_ticks,
            chasing: false,
            lunging: false,
            lurking: false,
            prey: 0,
            target: cell,
            memory: None,
            stuck: 0,
            emerge_until: self.tick + t.emerge_ticks,
        };
        let i = self.map.idx(cell.0, cell.1);
        self.worms.occupied[i] = self.worms.occupied[i].saturating_add(worm.body.len() as u8);
        self.worms.list.push(worm);
        id
    }

    /// A worm burrows out somewhere open and safe: never within
    /// `spawn_clearance` of a player, but preferably within `spawn_reach`
    /// of one (where the game is), on a lane it can leave both ways, and
    /// away from other worms. The best of `spawn_candidates` valid spots
    /// wins. Gives up quietly (to try again later) on a crowded map.
    pub(super) fn spawn_worm(&mut self) -> bool {
        let t = &self.worms.tuning;
        let (clear, reach, wanted) = (t.spawn_clearance, t.spawn_reach.max(t.spawn_clearance + 1), t.spawn_candidates.max(1));
        let mut best: Option<((i32, i32), i32)> = None;
        let mut found = 0;
        for attempt in 0..400 {
            if found >= wanted {
                break;
            }
            // Half the tries look around a random player, so a spot within
            // reach turns up even on a huge map; the rest anywhere.
            let around = (attempt % 2 == 0).then(|| self.random_player_cell()).flatten();
            let (x, y) = match around {
                Some((px, py)) => (
                    self.rng.between((px - reach).max(1), (px + reach).min(self.map.w - 2)),
                    self.rng.between((py - reach).max(1), (py + reach).min(self.map.h - 2)),
                ),
                None => (self.rng.between(1, self.map.w - 2), self.rng.between(1, self.map.h - 2)),
            };
            // Late attempts settle for less room around the burrow.
            let clear = if attempt < 250 { clear } else { clear / 2 };
            if self.map.is_solid(x, y)
                || self.bomb_at(x, y).is_some()
                || self.worms.occupied[self.map.idx(x, y)] != 0
                || self.sudden_death_unsafe(x, y)
                || self.danger_near(x, y, 2)
                || self.in_nuke_zone(x, y)
                || self.worm_near(x, y, 2)
                || self.players_in_rect(x - clear, y - clear, x + clear, y + clear).any(|p| p.alive)
                || self.map.open_cells_near(x, y) < 5
            {
                continue;
            }
            found += 1;
            let score = self.spawn_score(x, y, reach);
            if best.is_none_or(|(_, s)| score > s) {
                best = Some(((x, y), score));
            }
        }
        let Some((cell, _)) = best else { return false };
        let length = self.worms.tuning.length;
        self.add_worm(cell, length);
        true
    }

    /// How good a burrow (x, y) is: near players but not too near (the
    /// clearance is checked already), far from other worms, with ways out.
    fn spawn_score(&self, x: i32, y: i32, reach: i32) -> i32 {
        let cheb = |a: (i32, i32)| (a.0 - x).abs().max((a.1 - y).abs());
        let player = self.players.values().filter(|p| p.alive).map(|p| cheb(p.cell())).min();
        let worm = self.worms.list.iter().map(|w| cheb(w.head())).min().unwrap_or(99).min(20);
        let exits = (1..=4).filter(|&d| !self.map.is_solid(x + DIRS[d].0, y + DIRS[d].1)).count() as i32;
        // In reach of the nearest player scores best; farther off, less the farther.
        let near = match player {
            Some(d) if d <= reach => 40,
            Some(d) => 40 - (4 * (d - reach)).min(40),
            None => 0,
        };
        near + worm * 2 + exits.min(3) * 4 + self.rng_jitter(x, y)
    }

    /// The cell of a random living player, if any.
    fn random_player_cell(&mut self) -> Option<(i32, i32)> {
        let n = self.players.values().filter(|p| p.alive).count();
        if n == 0 {
            return None;
        }
        let k = self.rng.below(n as u32) as usize;
        self.players.values().filter(|p| p.alive).nth(k).map(Player::cell)
    }

    /// A little deterministic noise so equal spots aren't always picked
    /// in scan order.
    fn rng_jitter(&self, x: i32, y: i32) -> i32 {
        let h = (x as u32).wrapping_mul(73_856_093) ^ (y as u32).wrapping_mul(19_349_663) ^ (self.tick as u32).wrapping_mul(83_492_791);
        (h % 5) as i32
    }

    /// The worm step of the tick: blasts cut and kill worms, missing worms
    /// come back, worms crawl, and anyone touching one is eaten. Runs after
    /// the flame damage, so this tick's fire counts.
    pub(super) fn update_worms(&mut self) {
        if !self.worms.enabled {
            return;
        }
        self.burn_worms();
        let target = self.worm_target();
        if self.worms.list.len() < target && self.tick >= self.worms.next_spawn {
            if self.spawn_worm() {
                self.worms.next_spawn = self.tick + self.worms.tuning.spawn_gap_ticks;
            } else {
                self.worms.next_spawn = self.tick + SEC;
            }
        }
        for k in 0..self.worms.list.len() {
            if self.worms.list[k].next_step <= self.tick {
                self.step_worm(k);
            }
        }
        self.worm_bites();
    }

    /// Segments in fire burn away; the rest falls into pieces.
    fn burn_worms(&mut self) {
        let min_length = self.worms.tuning.min_length.max(1);
        let mut k = 0;
        while k < self.worms.list.len() {
            let mut hit = std::mem::take(&mut self.worms.hit);
            hit.clear();
            hit.extend(self.worms.list[k].body.iter().map(|&(x, y)| self.flame_active(x, y)));
            let Some(first) = hit.iter().position(|&h| h) else {
                self.worms.hit = hit;
                k += 1;
                continue;
            };
            let worm = self.worms.list.swap_remove(k);
            for &(x, y) in &worm.body {
                let i = self.map.idx(x, y);
                self.worms.occupied[i] = self.worms.occupied[i].saturating_sub(1);
            }
            let (fx, fy) = worm.body[first];
            let owner = self.flame_owner[self.map.idx(fx, fy)];
            let killer = self.players.contains_key(&owner).then_some(owner);
            // Unburnt runs of segments, in head-to-tail order.
            let mut runs: Vec<VecDeque<(i32, i32)>> = Vec::new();
            let mut run = VecDeque::new();
            for (s, &c) in worm.body.iter().enumerate() {
                if hit[s] {
                    if !run.is_empty() {
                        runs.push(std::mem::take(&mut run));
                    }
                } else {
                    run.push_back(c);
                }
            }
            if !run.is_empty() {
                runs.push(run);
            }
            self.worms.hit = hit;
            let head_lives = first > 0 && runs.first().is_some_and(|r| r.len() >= min_length);
            let mut pieces = 0;
            let mut kept = 0;
            for (n, body) in runs.into_iter().enumerate() {
                if body.len() < min_length {
                    continue;
                }
                let id = if n == 0 && head_lives { worm.id } else { self.next_object_id() };
                if id != worm.id {
                    pieces += 1;
                }
                for &(x, y) in &body {
                    let i = self.map.idx(x, y);
                    self.worms.occupied[i] = self.worms.occupied[i].saturating_add(1);
                }
                let tail = *body.back().unwrap();
                // Cut-off pieces are dazed for a moment before they crawl on.
                let next_step = if id == worm.id { worm.next_step } else { self.tick + self.worms.tuning.wander_step_ticks };
                let dir = dir_of(body.get(1).copied(), body[0]).unwrap_or(worm.dir);
                self.worms.list.insert(k, Worm { id, body, trail: tail, dir, next_step, stuck: 0, chasing: false, lunging: false, lurking: false, prey: 0, memory: None, ..worm });
                kept += 1;
            }
            if head_lives {
                if pieces > 0 {
                    self.broadcast_event(ev::WORM, &[news::CUT, i64::from(fx), i64::from(fy), killer.map_or(0, |k| i64::from(k) + 1)]);
                }
            } else {
                self.worm_killed(worm.head(), killer);
                self.worms.next_spawn = self.worms.next_spawn.max(self.tick + self.worms.tuning.respawn_ticks);
            }
            // The worms put back at `k` were checked already: none is still in fire.
            k += kept;
        }
    }

    /// A worm died at `at`: points for whoever's fire did it.
    fn worm_killed(&mut self, at: (i32, i32), killer: Option<u32>) {
        self.stats.worms_killed += 1;
        let (points, xp) = (self.worms.tuning.kill_points, self.worms.tuning.kill_xp);
        if let Some(p) = killer.and_then(|k| self.players.get_mut(&k)) {
            p.score += points;
            if let Some(prof) = &mut p.profile {
                prof.xp += xp;
                p.profile_dirty = true;
            }
        }
        self.broadcast_event(ev::WORM, &[news::KILLED, i64::from(at.0), i64::from(at.1), killer.map_or(0, |k| i64::from(k) + 1)]);
    }

    /// Whether a worm may crawl into (x, y).
    pub(super) fn worm_can_enter(&self, x: i32, y: i32) -> bool {
        self.map.in_bounds(x, y)
            && !self.map.is_solid(x, y)
            && self.bomb_at(x, y).is_none()
            && !self.flame_active(x, y)
            && self.worms.occupied[self.map.idx(x, y)] == 0
    }

    /// Players a hungry worm goes for: alive, on the ground and unshielded.
    fn is_prey(&self, p: &Player) -> bool {
        p.alive && p.invulnerable_until <= self.tick
    }

    /// The danger map, at most once a tick.
    fn refresh_worm_danger(&mut self) {
        if self.worms.danger_tick == Some(self.tick) {
            return;
        }
        let mut sc = std::mem::take(&mut self.worms.danger);
        self.refresh_danger(&mut sc);
        self.worms.danger = sc;
        self.worms.danger_tick = Some(self.tick);
    }

    /// Ticks until fire reaches (x, y) (`SAFE`: never).
    fn fire_eta(&self, x: i32, y: i32) -> u16 {
        self.worms.danger.danger.get(self.map.idx(x, y)).copied().unwrap_or(SAFE)
    }

    /// Whether a worm `len` long, reaching (x, y) `steps` steps from now
    /// at `step_ticks` a step, would still have some of its body there
    /// when fire comes.
    fn worm_risky(&self, x: i32, y: i32, steps: u16, len: usize, step_ticks: u64) -> bool {
        let d = self.fire_eta(x, y);
        d != SAFE && u64::from(d) <= (u64::from(steps) + len as u64 + 1) * step_ticks
    }

    /// Breadth-first search from `head` over cells a worm may crawl into
    /// (and prey cells), up to `range` steps, filling `dist` and `first`
    /// for every cell it reaches; cells it would be caught in fire at are
    /// left out.
    fn worm_search(&mut self, head: (i32, i32), range: u16, len: usize, step_ticks: u64) {
        let mut queue = std::mem::take(&mut self.worms.queue);
        let mut seen = std::mem::take(&mut self.worms.seen);
        self.worms.generation = self.worms.generation.wrapping_add(1);
        if self.worms.generation == 0 {
            seen.fill(0);
            self.worms.generation = 1;
        }
        let g = self.worms.generation;
        queue.clear();
        let hi = self.map.idx(head.0, head.1);
        seen[hi] = g;
        self.worms.dist[hi] = 0;
        self.worms.first[hi] = 0;
        queue.push(head);
        let mut i = 0;
        while i < queue.len() && queue.len() < SEARCH_LIMIT {
            let cell = queue[i];
            i += 1;
            let ci = self.map.idx(cell.0, cell.1);
            let dist = self.worms.dist[ci];
            if dist >= range || (dist > 0 && self.worms.prey.iter().any(|q| q.1 == cell)) {
                continue; // no crawling on through a player
            }
            for d in 1..=4u8 {
                let c = (cell.0 + DIRS[d as usize].0, cell.1 + DIRS[d as usize].1);
                if !self.map.in_bounds(c.0, c.1) {
                    continue;
                }
                let ni = self.map.idx(c.0, c.1);
                if seen[ni] == g {
                    continue;
                }
                // Players stand where worms may go; the prey's own cell is fine.
                let prey_cell = self.worms.prey.iter().any(|q| q.1 == c) && !self.map.is_solid(c.0, c.1) && self.bomb_at(c.0, c.1).is_none();
                if !(prey_cell || self.worm_can_enter(c.0, c.1)) || self.worm_risky(c.0, c.1, dist + 1, len, step_ticks) {
                    continue;
                }
                seen[ni] = g;
                self.worms.dist[ni] = dist + 1;
                self.worms.first[ni] = if dist == 0 { d } else { self.worms.first[ci] };
                queue.push(c);
            }
        }
        self.worms.queue = queue;
        self.worms.seen = seen;
    }

    /// Steps from the head to (x, y) found by the last search, if any.
    fn searched(&self, x: i32, y: i32) -> Option<(u16, u8)> {
        if !self.map.in_bounds(x, y) {
            return None;
        }
        let i = self.map.idx(x, y);
        (self.worms.seen[i] == self.worms.generation).then(|| (self.worms.dist[i], self.worms.first[i]))
    }

    /// Prey within smelling range of worm `k`'s head: who, where, which way
    /// they're running and how fast.
    fn smell_prey(&mut self, head: (i32, i32)) {
        let r = i32::from(self.worms.tuning.sense_range);
        let mut prey = std::mem::take(&mut self.worms.prey);
        prey.clear();
        let (weather, gas) = (self.weather_slow(), self.tuning.raw.gas_bomb.movement_multiplier);
        for p in self.players_in_rect(head.0 - r, head.1 - r, head.0 + r, head.1 + r) {
            if !self.is_prey(p) {
                continue;
            }
            let running = if p.moving && p.input_dir != 0 { p.facing } else { 0 };
            let per_cell = 1.0 / (p.move_speed(self.tick, weather, gas) * DT).max(0.01);
            prey.push((p.id, p.cell(), running, per_cell));
        }
        self.worms.prey = prey;
    }

    /// Worm `k`'s hunt: which prey, which cell to make for, and the first
    /// step there (0: wait where it is). For every prey in range it weighs
    /// the prey's cell and the cells ahead of a running prey, by when the
    /// two would meet there; a cell it gets to first is an ambush. A cell
    /// another worm already makes for, for the same prey, counts as taken.
    fn plan_hunt(&mut self, k: usize, step_ticks: u64) -> Option<(u8, u32, (i32, i32))> {
        let me = self.worms.list[k].id;
        let lookahead = self.worms.tuning.intercept_cells;
        let mut best: Option<(f32, u8, u32, (i32, i32))> = None;
        for q in 0..self.worms.prey.len() {
            let (pid, cell, running, per_cell) = self.worms.prey[q];
            let consider = |c: (i32, i32), pt: f32, best: &mut Option<(f32, u8, u32, (i32, i32))>| {
                let Some((dist, first)) = self.searched(c.0, c.1) else { return };
                let wt = f32::from(dist) * step_ticks as f32;
                // Getting there first means meeting when the prey arrives;
                // getting there late is worth much less.
                let mut score = if wt <= pt { pt } else { wt + 2.0 * (wt - pt) };
                let taken = self.worms.list.iter().any(|o| o.id != me && o.prey == pid && o.target == c && !o.emerging(self.tick));
                if taken {
                    score += 6.0 * step_ticks as f32;
                }
                if best.is_none_or(|b| score < b.0) {
                    *best = Some((score, first, pid, c));
                }
            };
            consider(cell, 0.0, &mut best);
            if running != 0 {
                let (dx, dy) = DIRS[running as usize];
                for n in 1..=lookahead {
                    let c = (cell.0 + dx * n, cell.1 + dy * n);
                    if !self.map.in_bounds(c.0, c.1) || self.map.is_solid(c.0, c.1) || self.bomb_at(c.0, c.1).is_some() {
                        break;
                    }
                    consider(c, n as f32 * per_cell, &mut best);
                }
            }
        }
        best.map(|(_, first, pid, c)| (first, pid, c))
    }

    /// A worm in the path of fire (or about to be) gets out: the open
    /// neighbour that burns latest, ideally never.
    fn flee(&self, head: (i32, i32), len: usize, step_ticks: u64) -> Option<u8> {
        if !self.worm_risky(head.0, head.1, 0, len, step_ticks) {
            return None;
        }
        (1..=4u8)
            .filter(|&d| self.worm_can_enter(head.0 + DIRS[d as usize].0, head.1 + DIRS[d as usize].1))
            .max_by_key(|&d| self.fire_eta(head.0 + DIRS[d as usize].0, head.1 + DIRS[d as usize].1))
    }

    /// A wandering worm keeps going, turns at junctions now and then, and
    /// turns when it must; it tends to take the turn towards the nearest
    /// player within `roam_range`, and keeps out of fire to come. Never
    /// straight back into its own neck.
    fn wander(&mut self, (hx, hy): (i32, i32), ahead: u8, len: usize) -> Option<u8> {
        let step_ticks = self.worms.tuning.wander_step_ticks;
        let open: [bool; 5] =
            std::array::from_fn(|d| d != 0 && self.worm_can_enter(hx + DIRS[d].0, hy + DIRS[d].1) && !self.worm_risky(hx + DIRS[d].0, hy + DIRS[d].1, 1, len, step_ticks));
        let straight = open[ahead as usize];
        let mut turns = [0u8; 4];
        let mut n = 0;
        for d in 1..=4u8 {
            if d != ahead && d != OPPOSITE[ahead as usize] && open[d as usize] {
                turns[n] = d;
                n += 1;
            }
        }
        // The scent of the nearest player farther off.
        let r = self.worms.tuning.roam_range;
        let scent = self
            .players_in_rect(hx - r, hy - r, hx + r, hy + r)
            .filter(|p| self.is_prey(p))
            .map(Player::cell)
            .min_by_key(|&(x, y)| (x - hx).abs() + (y - hy).abs());
        if let Some((px, py)) = scent
            && (n > 0 || straight)
            && self.rng.chance(self.worms.tuning.roam_bias)
        {
            let closer = |d: u8| ((hx + DIRS[d as usize].0 - px).abs() + (hy + DIRS[d as usize].1 - py).abs(), d);
            let pick = turns[..n].iter().copied().chain(straight.then_some(ahead)).min_by_key(|&d| closer(d));
            if pick.is_some() {
                return pick;
            }
        }
        if straight && (n == 0 || !self.rng.chance(0.3)) {
            return Some(ahead);
        }
        if n > 0 {
            return Some(turns[self.rng.below(n as u32) as usize]);
        }
        let back = OPPOSITE[ahead as usize];
        (back != 0 && open[back as usize]).then_some(back)
    }

    fn step_worm(&mut self, k: usize) {
        let tick = self.tick;
        self.refresh_worm_danger();
        let (head, len, facing) = {
            let w = &self.worms.list[k];
            (w.head(), w.body.len(), w.dir)
        };
        let t = &self.worms.tuning;
        let (chase, lunge, range, lunge_range) = (t.chase_step_ticks, t.lunge_step_ticks, t.sense_range, t.lunge_range);
        self.smell_prey(head);
        // Fire first: a worm about to burn gets out of the way, unless prey
        // is right there to bite.
        let adjacent = self.worms.prey.iter().find_map(|q| (1..=4u8).find(|&d| (head.0 + DIRS[d as usize].0, head.1 + DIRS[d as usize].1) == q.1));
        let fleeing = if adjacent.is_none() { self.flee(head, len, chase) } else { None };
        let mut plan = None;
        if fleeing.is_none() && (!self.worms.prey.is_empty() || self.worms.list[k].memory.is_some()) {
            self.worm_search(head, range, len, chase);
            plan = self.plan_hunt(k, chase);
            if plan.is_none() {
                // Lost the scent: go and look where the prey was last.
                let w = &self.worms.list[k];
                if let Some((cell, until)) = w.memory {
                    let back = (until > tick && cell != head).then(|| self.searched(cell.0, cell.1)).flatten();
                    match back {
                        Some((_, first)) => plan = Some((first, 0, cell)),
                        None => self.worms.list[k].memory = None,
                    }
                }
            }
        }
        let memory_ticks = self.worms.tuning.memory_ticks;
        let (dir, chasing, lunging, lurking, prey, target) = match (fleeing, adjacent, plan) {
            (Some(d), _, _) => (Some(d), false, false, false, 0, head),
            (None, Some(d), _) => (Some(d), true, true, false, self.worms.list[k].prey, head),
            (None, None, Some((first, pid, cell))) => {
                let close = self.worms.prey.iter().find(|q| q.0 == pid).and_then(|q| self.searched(q.1.0, q.1.1)).is_some_and(|(d, _)| d <= lunge_range);
                if let Some(q) = self.worms.prey.iter().find(|q| q.0 == pid) {
                    self.worms.list[k].memory = Some((q.1, tick + memory_ticks));
                }
                (if first == 0 { None } else { Some(first) }, true, close, first == 0, pid, cell)
            }
            (None, None, None) => (self.wander(head, facing, len), false, false, false, 0, head),
        };
        let wander = self.worms.tuning.wander_step_ticks;
        let step_ticks = if lunging { lunge } else if chasing || fleeing.is_some() { chase } else { wander };
        let w = &mut self.worms.list[k];
        (w.chasing, w.lunging, w.lurking, w.prey, w.target) = (chasing, lunging, lurking, prey, target);
        w.step_ticks = step_ticks;
        w.next_step = tick + step_ticks;
        if lurking {
            // Lying in wait: still, and not stuck.
            w.stuck = 0;
            w.trail = *w.body.back().unwrap();
            return;
        }
        let next = dir.map(|d| (d, (head.0 + DIRS[d as usize].0, head.1 + DIRS[d as usize].1)));
        let Some((d, cell)) = next.filter(|&(_, c)| self.map.in_bounds(c.0, c.1) && !self.map.is_solid(c.0, c.1)) else {
            let w = &mut self.worms.list[k];
            w.stuck = w.stuck.saturating_add(1);
            w.trail = *w.body.back().unwrap();
            if w.stuck >= STUCK_TURN {
                // Boxed in: turn round and crawl off tail first.
                let body: VecDeque<_> = w.body.iter().rev().copied().collect();
                w.dir = dir_of(body.get(1).copied(), body[0]).unwrap_or(OPPOSITE[w.dir as usize]);
                w.trail = *body.back().unwrap();
                w.body = body;
                w.stuck = 0;
            }
            return;
        };
        let w = &mut self.worms.list[k];
        w.stuck = 0;
        w.dir = d;
        w.last_step = tick;
        w.body.push_front(cell);
        let tail = w.body.pop_back().unwrap();
        w.trail = tail;
        let (ci, ti) = (self.map.idx(cell.0, cell.1), self.map.idx(tail.0, tail.1));
        self.worms.occupied[ci] = self.worms.occupied[ci].saturating_add(1);
        self.worms.occupied[ti] = self.worms.occupied[ti].saturating_sub(1);
    }

    /// Anyone on the ground and unshielded touching a worm is eaten; the
    /// worm grows a segment per meal.
    pub(super) fn worm_bites(&mut self) {
        let tick = self.tick;
        let mut victims = std::mem::take(&mut self.worms.victims);
        victims.clear();
        for (k, w) in self.worms.list.iter().enumerate() {
            if w.emerging(tick) {
                continue;
            }
            let (mut x0, mut y0, mut x1, mut y1) = (i32::MAX, i32::MAX, i32::MIN, i32::MIN);
            for &(x, y) in &w.body {
                (x0, y0, x1, y1) = (x0.min(x), y0.min(y), x1.max(x), y1.max(y));
            }
            for p in self.players_in_rect(x0, y0, x1, y1) {
                let (px, py) = p.cell();
                if p.alive && p.jump_left == 0 && p.invulnerable_until <= tick && w.covers(px, py) {
                    victims.push((p.id, k));
                }
            }
        }
        victims.sort_unstable();
        victims.dedup_by_key(|v| v.0);
        let max_length = self.worms.tuning.max_length;
        for &(id, k) in &victims {
            let (x, y) = self.players[&id].cell();
            self.stats.worm_bites += 1;
            // The news goes first, so clients know what the kill was.
            self.broadcast_event(ev::WORM, &[news::ATE, i64::from(x), i64::from(y), i64::from(id) + 1]);
            self.kill(id, None);
            let w = &mut self.worms.list[k];
            if w.body.len() < max_length {
                let tail = *w.body.back().unwrap();
                w.body.push_back(tail);
                let i = self.map.idx(tail.0, tail.1);
                self.worms.occupied[i] = self.worms.occupied[i].saturating_add(1);
            }
        }
        victims.clear();
        self.worms.victims = victims;
    }
}

/// Direction from `from` to the neighbouring `to`, if they are neighbours.
fn dir_of(from: Option<(i32, i32)>, to: (i32, i32)) -> Option<u8> {
    let from = from?;
    (1..=4u8).find(|&d| (from.0 + DIRS[d as usize].0, from.1 + DIRS[d as usize].1) == to)
}
