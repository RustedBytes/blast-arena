//! Monsters: the creatures of the dungeon arena. Three kinds roam the
//! rooms and corridors and hunt whoever comes near:
//!
//! - **Slimes** ooze slowly, only notice prey close by and never see a
//!   bomb coming.
//! - **Skeletons** take two blasts, see far and march nearly as fast as
//!   a player walks.
//! - **Bats** flutter over crates and bombs, fast but erratic.
//!
//! A monster steps from cell to cell. Anyone on the ground and unshielded
//! sharing its cell is bitten and dies. Fire takes a hit point (then a
//! moment of immunity, so one blast is one hit); whoever's fire lands the
//! last hit scores, and the monster may leave a power-up behind. Monsters
//! keep out of fire to come, rise out of the ground away from players
//! (harmless while they do), and come back over time. Every number worth
//! tuning is in [`MonsterTuning`].

use std::collections::VecDeque;

use crate::protocol::ev;

use super::ai::{DangerScratch, SAFE};
use super::items::Item;
use super::map::Tile;
use super::player::{DIRS, OPPOSITE, Player};
use super::{TICK_RATE, World};

/// Seconds to ticks.
const SEC: u64 = TICK_RATE as u64;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum Kind {
    Slime = 1,
    Skeleton = 2,
    Bat = 3,
}

pub const KINDS: [Kind; 3] = [Kind::Slime, Kind::Skeleton, Kind::Bat];

/// How one kind of monster behaves.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct KindTuning {
    pub hp: u8,
    /// Ticks per cell while roaming, and while hunting (a player walks a
    /// cell in about 5.7 ticks).
    pub wander_step_ticks: u64,
    pub chase_step_ticks: u64,
    /// How far (Chebyshev cells) it notices prey, and how many steps it
    /// will walk round walls to get to them.
    pub sense_range: i32,
    pub path_limit: u16,
    /// Chance per step of a random flutter instead of the planned step.
    pub erratic: f32,
    /// Flies over crates and bombs (never walls).
    pub flies: bool,
    /// Steps out of the way of fire to come (fire burning now stops
    /// every monster).
    pub fears_fire: bool,
    /// Score and profile XP for the last hit.
    pub points: i32,
    pub xp: u64,
    /// Relative share of new monsters.
    pub weight: u32,
}

/// Everything about monsters worth tuning, in one place.
#[derive(Clone, Debug, PartialEq)]
pub struct MonsterTuning {
    /// One monster for this many map cells, kept between `min_count` and `max_count`.
    pub cells_per_monster: i32,
    pub min_count: usize,
    pub max_count: usize,
    pub slime: KindTuning,
    pub skeleton: KindTuning,
    pub bat: KindTuning,
    /// A new monster climbs out of the ground for this long: it neither
    /// moves nor bites yet, but fire already hurts it.
    pub rise_ticks: u64,
    /// Immunity after a hit, longer than a blast burns.
    pub hurt_ticks: u64,
    /// How long a monster keeps going for where its prey got away.
    pub memory_ticks: u64,
    /// After a monster dies the next comes no sooner than this; while
    /// monsters are missing, one more arrives every `spawn_gap_ticks`.
    pub respawn_ticks: u64,
    pub spawn_gap_ticks: u64,
    /// New monsters rise at least this far (Chebyshev cells) from players,
    /// preferably within `spawn_reach` of one.
    pub spawn_clearance: i32,
    pub spawn_reach: i32,
    /// Chance that a slain monster leaves a power-up.
    pub drop_chance: f32,
}

impl Default for MonsterTuning {
    fn default() -> Self {
        MonsterTuning {
            cells_per_monster: 160,
            min_count: 6,
            max_count: 40,
            slime: KindTuning {
                hp: 1,
                wander_step_ticks: 14,
                chase_step_ticks: 9,
                sense_range: 6,
                path_limit: 12,
                erratic: 0.0,
                flies: false,
                fears_fire: false,
                points: 1,
                xp: 3,
                weight: 45,
            },
            skeleton: KindTuning {
                hp: 2,
                wander_step_ticks: 11,
                chase_step_ticks: 7,
                sense_range: 10,
                path_limit: 22,
                erratic: 0.0,
                flies: false,
                fears_fire: true,
                points: 2,
                xp: 6,
                weight: 35,
            },
            bat: KindTuning {
                hp: 1,
                wander_step_ticks: 6,
                chase_step_ticks: 5,
                sense_range: 8,
                path_limit: 14,
                erratic: 0.35,
                flies: true,
                fears_fire: true,
                points: 1,
                xp: 4,
                weight: 20,
            },
            rise_ticks: 3 * SEC / 2,
            hurt_ticks: 16,
            memory_ticks: 3 * SEC,
            respawn_ticks: 5 * SEC,
            spawn_gap_ticks: SEC,
            spawn_clearance: 7,
            spawn_reach: 16,
            drop_chance: 0.3,
        }
    }
}

impl MonsterTuning {
    #[must_use]
    pub fn of(&self, kind: Kind) -> &KindTuning {
        match kind {
            Kind::Slime => &self.slime,
            Kind::Skeleton => &self.skeleton,
            Kind::Bat => &self.bat,
        }
    }
}

/// Snapshot flags of a monster (see `protocol::snap`).
pub mod flag {
    /// Hunting a player.
    pub const CHASING: u8 = 1;
    /// Still rising out of the ground.
    pub const RISING: u8 = 2;
    /// Just hit (immune for a moment).
    pub const HURT: u8 = 4;
}

/// What a monster event ([`ev::MONSTER`]) reports.
pub mod news {
    /// A monster bit a player: (x, y, victim id + 1, kind).
    pub const BIT: i64 = 1;
    /// A monster was slain: (x, y, killer id + 1, kind).
    pub const SLAIN: i64 = 2;
    /// A monster was hit and lives on: (x, y, hitter id + 1, kind).
    pub const HIT: i64 = 3;
}

pub struct Monster {
    pub id: u32,
    pub kind: Kind,
    pub cell: (i32, i32),
    /// The cell it stepped from (its cell when it last stood still).
    pub from: (i32, i32),
    /// Direction of the last step (see `DIRS`).
    pub dir: u8,
    pub last_step: u64,
    pub next_step: u64,
    /// Ticks per cell of the current pace.
    pub step_ticks: u64,
    pub hp: u8,
    pub hurt_until: u64,
    pub rise_until: u64,
    pub chasing: bool,
    /// Whose fire hit it last.
    pub last_hitter: u32,
    /// Where its prey was last seen, until when it keeps looking there.
    pub memory: Option<((i32, i32), u64)>,
}

impl Monster {
    #[must_use]
    pub fn rising(&self, tick: u64) -> bool {
        self.rise_until > tick
    }
}

/// The monsters of an arena and the buffers their thinking reuses.
#[derive(Default)]
pub struct Monsters {
    pub enabled: bool,
    pub tuning: MonsterTuning,
    pub list: Vec<Monster>,
    pub next_spawn: u64,
    /// Monsters per cell.
    pub occupied: Vec<u8>,
    seen: Vec<u32>,
    first: Vec<u8>,
    generation: u32,
    queue: VecDeque<((i32, i32), u16)>,
    /// Ticks until fire per cell, refreshed at most once a tick.
    danger: DangerScratch,
    danger_tick: Option<u64>,
    victims: Vec<(u32, usize)>,
}

impl Monsters {
    #[must_use]
    pub fn new(cells: usize) -> Self {
        Monsters { occupied: vec![0; cells], seen: vec![0; cells], first: vec![0; cells], ..Monsters::default() }
    }
}

/// Upper bound on cells one path search visits.
const SEARCH_LIMIT: usize = 600;

impl World {
    #[must_use]
    pub fn monsters_on(&self) -> bool {
        self.monsters.enabled
    }

    /// How many monsters this arena keeps.
    #[must_use]
    pub fn monster_target(&self) -> usize {
        let t = &self.monsters.tuning;
        ((self.map.w * self.map.h / t.cells_per_monster.max(1)) as usize).clamp(t.min_count, t.max_count.max(t.min_count))
    }

    /// Turns monsters on and fills the dungeon with them.
    pub fn enable_monsters(&mut self) {
        self.monsters.enabled = true;
        for _ in 0..self.monster_target() {
            self.spawn_monster();
        }
        self.monsters.next_spawn = self.tick + self.monsters.tuning.spawn_gap_ticks;
    }

    /// Whether a monster is within `r` cells (Chebyshev) of (x, y).
    #[must_use]
    pub fn monster_near(&self, x: i32, y: i32, r: i32) -> bool {
        self.monsters.list.iter().any(|m| (m.cell.0 - x).abs() <= r && (m.cell.1 - y).abs() <= r)
    }

    /// Adds a monster of `kind`, rising out of the ground at `cell`.
    pub fn add_monster(&mut self, kind: Kind, cell: (i32, i32)) -> u32 {
        let id = self.next_object_id();
        let t = &self.monsters.tuning;
        let k = t.of(kind);
        let m = Monster {
            id,
            kind,
            cell,
            from: cell,
            dir: 1 + self.rng.below(4) as u8,
            last_step: self.tick,
            next_step: self.tick + t.rise_ticks,
            step_ticks: k.wander_step_ticks,
            hp: k.hp,
            hurt_until: 0,
            rise_until: self.tick + t.rise_ticks,
            chasing: false,
            last_hitter: 0,
            memory: None,
        };
        let i = self.map.idx(cell.0, cell.1);
        self.monsters.occupied[i] = self.monsters.occupied[i].saturating_add(1);
        self.monsters.list.push(m);
        id
    }

    fn random_kind(&mut self) -> Kind {
        let t = &self.monsters.tuning;
        let total: u32 = KINDS.iter().map(|&k| t.of(k).weight).sum();
        let mut roll = self.rng.below(total.max(1));
        for k in KINDS {
            let w = self.monsters.tuning.of(k).weight;
            if roll < w {
                return k;
            }
            roll -= w;
        }
        Kind::Slime
    }

    /// A monster rises somewhere open and safe: never within
    /// `spawn_clearance` of a living player, preferably within
    /// `spawn_reach` of one (where the game is), and away from other
    /// monsters. Gives up quietly (to try again later) on a crowded map.
    pub(super) fn spawn_monster(&mut self) -> bool {
        let t = &self.monsters.tuning;
        let (clear, reach) = (t.spawn_clearance, t.spawn_reach.max(t.spawn_clearance + 1));
        let mut best: Option<((i32, i32), i32)> = None;
        let mut found = 0;
        for attempt in 0..300 {
            if found >= 16 {
                break;
            }
            let around = (attempt % 2 == 0).then(|| self.random_living_cell()).flatten();
            let (x, y) = match around {
                Some((px, py)) => (
                    self.rng.between((px - reach).max(1), (px + reach).min(self.map.w - 2)),
                    self.rng.between((py - reach).max(1), (py + reach).min(self.map.h - 2)),
                ),
                None => (self.rng.between(1, self.map.w - 2), self.rng.between(1, self.map.h - 2)),
            };
            let clear = if attempt < 200 { clear } else { clear / 2 };
            if self.map.is_solid(x, y)
                || self.map.get(x, y) == Tile::Teleport
                || self.bomb_at(x, y).is_some()
                || self.sudden_death_unsafe(x, y)
                || self.danger_near(x, y, 2)
                || self.in_nuke_zone(x, y)
                || self.monster_near(x, y, 1)
                || self.in_vault(x, y, 2)
                || self.players_in_rect(x - clear, y - clear, x + clear, y + clear).any(|p| p.alive)
            {
                continue;
            }
            found += 1;
            let cheb = |a: (i32, i32)| (a.0 - x).abs().max((a.1 - y).abs());
            let player = self.players.values().filter(|p| p.alive).map(|p| cheb(p.cell())).min();
            let crowd = self.monsters.list.iter().map(|m| cheb(m.cell)).min().unwrap_or(12).min(12);
            let near = match player {
                Some(d) if d <= reach => 30,
                Some(d) => 30 - (3 * (d - reach)).min(30),
                None => 0,
            };
            let score = near + crowd * 2 + (self.rng.below(5) as i32);
            if best.is_none_or(|(_, s)| score > s) {
                best = Some(((x, y), score));
            }
        }
        let Some((cell, _)) = best else { return false };
        let kind = self.random_kind();
        self.add_monster(kind, cell);
        true
    }

    /// The cell of a random living player, if any.
    fn random_living_cell(&mut self) -> Option<(i32, i32)> {
        let n = self.players.values().filter(|p| p.alive).count();
        if n == 0 {
            return None;
        }
        let k = self.rng.below(n as u32) as usize;
        self.players.values().filter(|p| p.alive).nth(k).map(Player::cell)
    }

    /// The monster step of the tick: fire hurts and slays, missing
    /// monsters come back, monsters move, and they bite whoever they
    /// touch. Runs after the flame damage, so this tick's fire counts.
    pub(super) fn update_monsters(&mut self) {
        if !self.monsters.enabled {
            return;
        }
        self.hurt_monsters();
        let target = self.monster_target();
        if self.monsters.list.len() < target && self.tick >= self.monsters.next_spawn {
            let gap = if self.spawn_monster() { self.monsters.tuning.spawn_gap_ticks } else { SEC };
            self.monsters.next_spawn = self.tick + gap;
        }
        for k in 0..self.monsters.list.len() {
            if self.monsters.list[k].next_step <= self.tick {
                self.step_monster(k);
            }
        }
        self.monster_bites();
    }

    fn remove_monster(&mut self, k: usize) -> Monster {
        let m = self.monsters.list.swap_remove(k);
        let i = self.map.idx(m.cell.0, m.cell.1);
        self.monsters.occupied[i] = self.monsters.occupied[i].saturating_sub(1);
        m
    }

    /// Fire on a monster's cell takes a hit point (not while immune);
    /// sudden death's stone buries monsters without points for anyone.
    fn hurt_monsters(&mut self) {
        let tick = self.tick;
        let hurt_ticks = self.monsters.tuning.hurt_ticks;
        let mut k = 0;
        while k < self.monsters.list.len() {
            let (x, y) = self.monsters.list[k].cell;
            if self.map.get(x, y) == Tile::Wall {
                self.remove_monster(k);
                continue;
            }
            let m = &self.monsters.list[k];
            if !self.flame_active(x, y) || tick < m.hurt_until {
                k += 1;
                continue;
            }
            let owner = self.flame_owner[self.map.idx(x, y)];
            let hitter = if self.players.contains_key(&owner) { owner } else { 0 };
            let m = &mut self.monsters.list[k];
            m.hp = m.hp.saturating_sub(1);
            m.hurt_until = tick + hurt_ticks;
            if hitter != 0 {
                m.last_hitter = hitter;
            }
            let kind = m.kind as i64;
            if m.hp > 0 {
                // Staggered: it waits a step before moving on.
                m.next_step = m.next_step.max(tick + m.step_ticks);
                self.broadcast_event(ev::MONSTER, &[news::HIT, i64::from(x), i64::from(y), i64::from(hitter), kind]);
                k += 1;
                continue;
            }
            let m = self.remove_monster(k);
            self.monster_slain(&m);
        }
    }

    /// A monster died: points for whoever's fire did it, maybe a power-up.
    fn monster_slain(&mut self, monster: &Monster) {
        self.stats.monsters_killed += 1;
        let reward = *self.monsters.tuning.of(monster.kind);
        let killer = (monster.last_hitter != 0 && self.players.contains_key(&monster.last_hitter)).then_some(monster.last_hitter);
        if let Some(p) = killer.and_then(|id| self.players.get_mut(&id)) {
            p.score += reward.points;
            if let Some(prof) = &mut p.profile {
                prof.xp += reward.xp;
                p.profile_dirty = true;
            }
        }
        let (x, y) = monster.cell;
        self.broadcast_event(ev::MONSTER, &[news::SLAIN, i64::from(x), i64::from(y), killer.map_or(0, |id| i64::from(id) + 1), monster.kind as i64]);
        let i = self.map.idx(x, y);
        if killer.is_some() && !self.map.is_solid(x, y) && self.items[i] == 0 && self.bomb_at(x, y).is_none() && self.rng.chance(self.monsters.tuning.drop_chance) {
            let tuning = &self.tuning;
            let item = (0..4).map(|_| Item::random(&mut self.rng)).find(|&it| tuning.item_enabled(it)).unwrap_or(Item::ExtraBomb);
            self.set_item(x, y, item as u8);
        }
        self.monsters.next_spawn = self.monsters.next_spawn.max(self.tick + self.monsters.tuning.respawn_ticks);
    }

    /// Whether a monster of `kind` may step into (x, y).
    pub(super) fn monster_can_enter(&self, kind: Kind, x: i32, y: i32) -> bool {
        if !self.map.in_bounds(x, y) || self.flame_active(x, y) || self.monsters.occupied[self.map.idx(x, y)] != 0 || self.in_vault(x, y, 0) {
            return false;
        }
        if self.monsters.tuning.of(kind).flies {
            !matches!(self.map.get(x, y), Tile::Wall | Tile::Built)
        } else {
            !self.map.is_solid(x, y) && self.bomb_at(x, y).is_none()
        }
    }

    /// Players a monster goes for: alive and unshielded.
    fn monster_prey(&self, p: &Player) -> bool {
        p.alive && p.invulnerable_until <= self.tick
    }

    fn refresh_monster_danger(&mut self) {
        if self.monsters.danger_tick == Some(self.tick) {
            return;
        }
        let mut sc = std::mem::take(&mut self.monsters.danger);
        self.refresh_danger(&mut sc);
        self.monsters.danger = sc;
        self.monsters.danger_tick = Some(self.tick);
    }

    /// Ticks until fire reaches (x, y) (`SAFE`: never).
    fn monster_fire_eta(&self, x: i32, y: i32) -> u16 {
        self.monsters.danger.danger.get(self.map.idx(x, y)).copied().unwrap_or(SAFE)
    }

    /// Whether standing on (x, y), reached `steps` steps from now, would
    /// leave it in fire before it could step on.
    fn monster_risky(&self, kind: Kind, x: i32, y: i32, steps: u16, step_ticks: u64) -> bool {
        if !self.monsters.tuning.of(kind).fears_fire {
            return false;
        }
        let d = self.monster_fire_eta(x, y);
        d != SAFE && u64::from(d) <= (u64::from(steps) + 1) * step_ticks + 2
    }

    /// The first step of the shortest safe way from `from` to `goal`,
    /// at most `limit` steps long.
    fn monster_path(&mut self, kind: Kind, from: (i32, i32), goal: (i32, i32), limit: u16, step_ticks: u64) -> Option<u8> {
        if from == goal {
            return None;
        }
        let mut queue = std::mem::take(&mut self.monsters.queue);
        let mut seen = std::mem::take(&mut self.monsters.seen);
        let mut first = std::mem::take(&mut self.monsters.first);
        self.monsters.generation = self.monsters.generation.wrapping_add(1);
        if self.monsters.generation == 0 {
            seen.fill(0);
            self.monsters.generation = 1;
        }
        let g = self.monsters.generation;
        queue.clear();
        queue.push_back((from, 0));
        seen[self.map.idx(from.0, from.1)] = g;
        let mut found = None;
        let mut visited = 0;
        while let Some((c, dist)) = queue.pop_front() {
            if c == goal {
                found = Some(first[self.map.idx(c.0, c.1)]);
                break;
            }
            visited += 1;
            if dist >= limit || visited > SEARCH_LIMIT {
                continue;
            }
            for d in 1..=4u8 {
                let n = (c.0 + DIRS[d as usize].0, c.1 + DIRS[d as usize].1);
                if !self.map.in_bounds(n.0, n.1) {
                    continue;
                }
                let i = self.map.idx(n.0, n.1);
                if seen[i] == g || !(n == goal || self.monster_can_enter(kind, n.0, n.1)) || self.monster_risky(kind, n.0, n.1, dist + 1, step_ticks) {
                    continue;
                }
                seen[i] = g;
                first[i] = if c == from { d } else { first[self.map.idx(c.0, c.1)] };
                queue.push_back((n, dist + 1));
            }
        }
        self.monsters.queue = queue;
        self.monsters.seen = seen;
        self.monsters.first = first;
        found
    }

    /// The nearest prey it can sense, by straight-line distance.
    fn sense_prey(&self, at: (i32, i32), r: i32) -> Option<(i32, i32)> {
        self.players_in_rect(at.0 - r, at.1 - r, at.0 + r, at.1 + r)
            .filter(|p| self.monster_prey(p))
            .map(Player::cell)
            .min_by_key(|&(x, y)| (x - at.0).abs() + (y - at.1).abs())
    }

    /// A roaming monster keeps going, turns now and then, and turns when
    /// it must; never into fire to come, and back only if boxed in.
    fn monster_wander(&mut self, kind: Kind, (x, y): (i32, i32), ahead: u8, step_ticks: u64) -> Option<u8> {
        let open: [bool; 5] =
            std::array::from_fn(|d| d != 0 && self.monster_can_enter(kind, x + DIRS[d].0, y + DIRS[d].1) && !self.monster_risky(kind, x + DIRS[d].0, y + DIRS[d].1, 1, step_ticks));
        let straight = ahead != 0 && open[ahead as usize];
        let mut turns = [0u8; 4];
        let mut n = 0;
        for d in 1..=4u8 {
            if d != ahead && d != OPPOSITE[ahead as usize] && open[d as usize] {
                turns[n] = d;
                n += 1;
            }
        }
        if straight && (n == 0 || !self.rng.chance(0.25)) {
            return Some(ahead);
        }
        if n > 0 {
            return Some(turns[self.rng.below(n as u32) as usize]);
        }
        let back = OPPOSITE[ahead as usize];
        (back != 0 && open[back as usize]).then_some(back)
    }

    fn step_monster(&mut self, k: usize) {
        let tick = self.tick;
        self.refresh_monster_danger();
        let (kind, cell, facing) = {
            let m = &self.monsters.list[k];
            (m.kind, m.cell, m.dir)
        };
        let kt = *self.monsters.tuning.of(kind);
        let memory_ticks = self.monsters.tuning.memory_ticks;
        let prey = self.sense_prey(cell, kt.sense_range);
        // Fire first: get out of the way of a blast about to go off, to the
        // neighbour that burns latest.
        let fleeing = if self.monster_risky(kind, cell.0, cell.1, 0, kt.chase_step_ticks) {
            (1..=4u8)
                .filter(|&d| self.monster_can_enter(kind, cell.0 + DIRS[d as usize].0, cell.1 + DIRS[d as usize].1))
                .max_by_key(|&d| self.monster_fire_eta(cell.0 + DIRS[d as usize].0, cell.1 + DIRS[d as usize].1))
        } else {
            None
        };
        let mut chasing = false;
        let mut dir = fleeing;
        if fleeing.is_none() {
            let goal = match prey {
                Some(c) => {
                    self.monsters.list[k].memory = Some((c, tick + memory_ticks));
                    Some(c)
                }
                None => match self.monsters.list[k].memory {
                    Some((c, until)) if until > tick && c != cell => Some(c),
                    _ => {
                        self.monsters.list[k].memory = None;
                        None
                    }
                },
            };
            if let Some(goal) = goal {
                dir = self.monster_path(kind, cell, goal, kt.path_limit, kt.chase_step_ticks);
                chasing = dir.is_some();
                if dir.is_none() && prey.is_none() {
                    self.monsters.list[k].memory = None;
                }
            }
            if dir.is_none() {
                dir = self.monster_wander(kind, cell, facing, kt.wander_step_ticks);
            }
            // Bats flit about: now and then a random way instead.
            if kt.erratic > 0.0 && self.rng.chance(kt.erratic) {
                let d = 1 + self.rng.below(4) as u8;
                let (nx, ny) = (cell.0 + DIRS[d as usize].0, cell.1 + DIRS[d as usize].1);
                if self.monster_can_enter(kind, nx, ny) && !self.monster_risky(kind, nx, ny, 1, kt.chase_step_ticks) {
                    dir = Some(d);
                }
            }
        }
        let step_ticks = if chasing || fleeing.is_some() { kt.chase_step_ticks } else { kt.wander_step_ticks };
        let next = dir.map(|d| (d, (cell.0 + DIRS[d as usize].0, cell.1 + DIRS[d as usize].1)));
        let m = &mut self.monsters.list[k];
        m.chasing = chasing;
        m.step_ticks = step_ticks;
        m.next_step = tick + step_ticks;
        m.from = cell;
        let Some((d, to)) = next.filter(|&(_, c)| self.monster_can_enter(kind, c.0, c.1)) else {
            // Nowhere to go: wait a little and look again.
            let m = &mut self.monsters.list[k];
            m.next_step = tick + step_ticks.min(6);
            return;
        };
        let (ci, ti) = (self.map.idx(cell.0, cell.1), self.map.idx(to.0, to.1));
        self.monsters.occupied[ci] = self.monsters.occupied[ci].saturating_sub(1);
        self.monsters.occupied[ti] = self.monsters.occupied[ti].saturating_add(1);
        let m = &mut self.monsters.list[k];
        m.dir = d;
        m.cell = to;
        m.last_step = tick;
    }

    /// Anyone on the ground and unshielded on a monster's cell is bitten.
    pub(super) fn monster_bites(&mut self) {
        let tick = self.tick;
        let mut victims = std::mem::take(&mut self.monsters.victims);
        victims.clear();
        for (k, m) in self.monsters.list.iter().enumerate() {
            if m.rising(tick) {
                continue;
            }
            let (x, y) = m.cell;
            for p in self.players_in_rect(x, y, x, y) {
                if p.alive && p.jump_left == 0 && p.invulnerable_until <= tick && p.cell() == (x, y) {
                    victims.push((p.id, k));
                }
            }
        }
        victims.sort_unstable();
        victims.dedup_by_key(|v| v.0);
        for &(id, k) in &victims {
            let (x, y) = self.players[&id].cell();
            let kind = self.monsters.list[k].kind as i64;
            self.stats.monster_bites += 1;
            // The news goes first, so clients know what the kill was.
            self.broadcast_event(ev::MONSTER, &[news::BIT, i64::from(x), i64::from(y), i64::from(id) + 1, kind]);
            self.kill(id, None);
        }
        victims.clear();
        self.monsters.victims = victims;
    }
}
