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
//! Worms step on whole cells, so their state is tiny: the cells, head first,
//! and the cell the tail just left, which lets clients slide every segment
//! smoothly between steps. Every number worth tuning is in [`WormTuning`].

use std::collections::VecDeque;

use crate::protocol::ev;

use super::player::{DIRS, OPPOSITE};
use super::{TICK_RATE, World};

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
    /// A worm burrows out of the ground for this long: it neither moves
    /// nor bites yet, but fire already hurts it.
    pub emerge_ticks: u64,
    /// After a worm dies, the next one comes no sooner than this; while
    /// worms are missing, one more arrives every `spawn_gap_ticks`.
    pub respawn_ticks: u64,
    pub spawn_gap_ticks: u64,
    /// New worms spawn at least this far (Chebyshev cells) from players.
    pub spawn_clearance: i32,
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
            emerge_ticks: SEC,
            respawn_ticks: 8 * SEC,
            spawn_gap_ticks: 2 * SEC,
            spawn_clearance: 7,
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
    generation: u32,
    /// Breadth-first search nodes: (cell, index of the first step).
    queue: Vec<((i32, i32), u8, u16)>,
    prey: Vec<(i32, i32)>,
    victims: Vec<(u32, usize)>,
    hit: Vec<bool>,
}

impl Worms {
    #[must_use]
    pub fn new(cells: usize) -> Self {
        Worms { occupied: vec![0; cells], seen: vec![0; cells], ..Worms::default() }
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
            stuck: 0,
            emerge_until: self.tick + t.emerge_ticks,
        };
        let i = self.map.idx(cell.0, cell.1);
        self.worms.occupied[i] = self.worms.occupied[i].saturating_add(worm.body.len() as u8);
        self.worms.list.push(worm);
        id
    }

    /// A worm comes out of the ground somewhere open, away from players,
    /// bombs and fire. Gives up quietly (to try again later) on a crowded map.
    pub(super) fn spawn_worm(&mut self) -> bool {
        let clear = self.worms.tuning.spawn_clearance;
        for attempt in 0..300 {
            let x = self.rng.between(1, self.map.w - 2);
            let y = self.rng.between(1, self.map.h - 2);
            // Late attempts settle for less room around the burrow.
            let clear = if attempt < 200 { clear } else { clear / 2 };
            if self.map.is_solid(x, y)
                || self.bomb_at(x, y).is_some()
                || self.worms.occupied[self.map.idx(x, y)] != 0
                || self.sudden_death_unsafe(x, y)
                || self.danger_near(x, y, 2)
                || self.worm_near(x, y, 2)
                || self.players_in_rect(x - clear, y - clear, x + clear, y + clear).any(|p| p.alive)
                || self.map.open_cells_near(x, y) < 5
            {
                continue;
            }
            let length = self.worms.tuning.length;
            self.add_worm((x, y), length);
            return true;
        }
        false
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
                self.worms.list.insert(k, Worm { id, body, trail: tail, dir, next_step, stuck: 0, chasing: false, ..worm });
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
    fn is_prey(&self, p: &super::player::Player) -> bool {
        p.alive && p.invulnerable_until <= self.tick
    }

    /// The first step towards the nearest prey within smelling range, by a
    /// breadth-first search along the lanes.
    fn hunt(&mut self, head: (i32, i32)) -> Option<u8> {
        let range = self.worms.tuning.sense_range;
        let r = i32::from(range);
        let mut prey = std::mem::take(&mut self.worms.prey);
        prey.clear();
        prey.extend(self.players_in_rect(head.0 - r, head.1 - r, head.0 + r, head.1 + r).filter(|p| self.is_prey(p)).map(super::player::Player::cell));
        let found = if prey.is_empty() { None } else { self.search_prey(head, range, &prey) };
        self.worms.prey = prey;
        found
    }

    fn search_prey(&mut self, head: (i32, i32), range: u16, prey: &[(i32, i32)]) -> Option<u8> {
        let mut queue = std::mem::take(&mut self.worms.queue);
        let mut seen = std::mem::take(&mut self.worms.seen);
        self.worms.generation = self.worms.generation.wrapping_add(1);
        if self.worms.generation == 0 {
            seen.fill(0);
            self.worms.generation = 1;
        }
        let g = self.worms.generation;
        queue.clear();
        seen[self.map.idx(head.0, head.1)] = g;
        // Prey right next to the head (or even under it) is a step away.
        for d in 1..=4u8 {
            let (dx, dy) = DIRS[d as usize];
            let c = (head.0 + dx, head.1 + dy);
            if prey.contains(&c) && self.map.in_bounds(c.0, c.1) && !self.map.is_solid(c.0, c.1) && self.bomb_at(c.0, c.1).is_none() {
                self.worms.queue = queue;
                self.worms.seen = seen;
                return Some(d);
            }
            if self.worm_can_enter(c.0, c.1) {
                seen[self.map.idx(c.0, c.1)] = g;
                queue.push((c, d, 1));
            }
        }
        let mut found = None;
        let mut i = 0;
        while i < queue.len() && queue.len() < SEARCH_LIMIT {
            let (cell, first, dist) = queue[i];
            i += 1;
            if prey.contains(&cell) {
                found = Some(first);
                break;
            }
            if dist >= range {
                continue;
            }
            for &(dx, dy) in &DIRS[1..] {
                let c = (cell.0 + dx, cell.1 + dy);
                if !self.map.in_bounds(c.0, c.1) {
                    continue;
                }
                let ci = self.map.idx(c.0, c.1);
                // Players stand where worms may go; the prey's own cell is fine.
                if seen[ci] != g && (self.worm_can_enter(c.0, c.1) || prey.contains(&c) && !self.map.is_solid(c.0, c.1)) {
                    seen[ci] = g;
                    queue.push((c, first, dist + 1));
                }
            }
        }
        self.worms.queue = queue;
        self.worms.seen = seen;
        found
    }

    /// A wandering worm keeps going, turns at junctions now and then, and
    /// turns when it must. Never straight back into its own neck.
    fn wander(&mut self, (hx, hy): (i32, i32), ahead: u8) -> Option<u8> {
        let open: [bool; 5] = std::array::from_fn(|d| d != 0 && self.worm_can_enter(hx + DIRS[d].0, hy + DIRS[d].1));
        let straight = open[ahead as usize];
        let mut turns = [0u8; 4];
        let mut n = 0;
        for d in 1..=4u8 {
            if d != ahead && d != OPPOSITE[ahead as usize] && open[d as usize] {
                turns[n] = d;
                n += 1;
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
        let head = self.worms.list[k].head();
        let hunt = self.hunt(head);
        let chasing = hunt.is_some();
        let dir = match hunt {
            Some(d) => Some(d),
            None => self.wander(head, self.worms.list[k].dir),
        };
        let t = &self.worms.tuning;
        let step_ticks = if chasing { t.chase_step_ticks } else { t.wander_step_ticks };
        let w = &mut self.worms.list[k];
        w.chasing = chasing;
        w.step_ticks = step_ticks;
        w.next_step = tick + step_ticks;
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
