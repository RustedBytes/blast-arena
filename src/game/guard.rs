//! The vault and its Warden. Every arena built by `World::new` has one
//! vault near the middle: a walled room with a gate in each side, its floor
//! laid with power-ups that restock over time. The Warden guards it: a big,
//! tough enemy that stays near the vault (it never chases farther than
//! `leash_margin` beyond the walls) and fights anyone who comes close.
//!
//! Skills, all telegraphed to clients through the snapshot flags:
//! - **Slam**: next to an intruder, it winds up, then crushes everyone on
//!   the ground within `slam_radius` (jumping over the shockwave dodges it).
//! - **Charge**: an intruder lined up with it in a clear lane gets a
//!   wind-up, then a charge along the lane at a cell a tick.
//! - **Lob**: an intruder farther off gets a bomb dropped on their cell.
//! - **Stone skin**: the first time it falls to half health, it's
//!   immune for a while.
//! - **Enraged**: on its last few hit points it moves faster and its skills
//!   come back sooner, and its lobs come in threes.
//!
//! Touching it crushes you. Only players' fire hurts it, one hit per blast
//! (`hurt_ticks` of immunity after each), so it takes `max_hp` blasts to
//! bring down; whoever lands the last one scores `kill_points`. It comes
//! back `respawn_ticks` later, and the vault is restocked in full.

use std::collections::VecDeque;

use crate::protocol::ev;

use super::ai::{DangerScratch, SAFE};
use super::bomb::BombKind;
use super::items::Item;
use super::map::Tile;
use super::player::{DIRS, Player};
use super::{TICK_RATE, World};

const SEC: u64 = TICK_RATE as u64;

/// Everything about the vault and its Warden worth tuning.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GuardTuning {
    pub max_hp: u8,
    /// Ticks per cell, and while enraged.
    pub step_ticks: u64,
    pub enraged_step_ticks: u64,
    /// Intruders this many cells beyond the vault walls get attacked; the
    /// Warden follows them no farther than `leash_margin` beyond the walls.
    pub aggro_margin: i32,
    pub leash_margin: i32,
    /// Immunity after a hit, so one blast is one hit.
    pub hurt_ticks: u64,
    pub slam_windup: u64,
    pub slam_radius: i32,
    pub slam_cooldown: u64,
    /// Lobs reach intruders this far (Chebyshev cells).
    pub lob_min: i32,
    pub lob_max: i32,
    pub lob_fuse: u64,
    pub lob_range: u8,
    pub lob_cooldown: u64,
    pub charge_windup: u64,
    pub charge_cells: i32,
    pub charge_cooldown: u64,
    pub skin_ticks: u64,
    /// Enraged at this many hit points or fewer.
    pub enrage_hp: u8,
    pub respawn_ticks: u64,
    /// One more empty loot cell is restocked this often.
    pub restock_ticks: u64,
    pub kill_points: i32,
    pub kill_xp: u64,
}

impl Default for GuardTuning {
    fn default() -> Self {
        GuardTuning {
            max_hp: 8,
            step_ticks: 6,
            enraged_step_ticks: 5,
            aggro_margin: 3,
            leash_margin: 6,
            hurt_ticks: 16,
            slam_windup: 14,
            slam_radius: 2,
            slam_cooldown: 50,
            lob_min: 3,
            lob_max: 9,
            lob_fuse: 45,
            lob_range: 2,
            lob_cooldown: 70,
            charge_windup: 12,
            charge_cells: 7,
            charge_cooldown: 110,
            skin_ticks: 4 * SEC,
            enrage_hp: 3,
            respawn_ticks: 60 * SEC,
            restock_ticks: 8 * SEC,
            kill_points: 5,
            kill_xp: 40,
        }
    }
}

/// Snapshot flags of the Warden (see `protocol::snap`).
pub mod flag {
    /// An intruder is in reach: it's fighting.
    pub const HUNTING: u8 = 1;
    /// Winding up a slam (lands in `skill` ticks).
    pub const SLAM: u8 = 2;
    /// Winding up a charge along `skill_dir` (starts in `skill` ticks).
    pub const CHARGE_WINDUP: u8 = 4;
    /// Charging along `skill_dir`.
    pub const CHARGING: u8 = 8;
    /// Stone skin: immune.
    pub const SKIN: u8 = 16;
    pub const ENRAGED: u8 = 32;
    /// Just hit (immune for a moment).
    pub const HURT: u8 = 64;
}

/// What a Warden event ([`ev::GUARD`]) reports: (what, x, y, player id + 1).
pub mod news {
    /// It crushed a player (the kill message follows).
    pub const CRUSHED: i64 = 1;
    /// It was brought down, by the player given (0: nobody).
    pub const KILLED: i64 = 2;
    /// It's back on guard.
    pub const BACK: i64 = 3;
    /// A slam landed here.
    pub const SLAM: i64 = 4;
    /// It lobbed a bomb at this cell.
    pub const LOB: i64 = 5;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Skill {
    None,
    /// Winding up a slam.
    Slam,
    /// Winding up a charge in this direction.
    Charge(u8),
    /// Charging: direction, cells left.
    Charging(u8, i32),
}

pub struct Warden {
    pub id: u32,
    pub cell: (i32, i32),
    /// The cell it last stepped from (clients slide between the two).
    pub from: (i32, i32),
    pub dir: u8,
    pub last_step: u64,
    pub next_step: u64,
    pub step_ticks: u64,
    pub hp: u8,
    pub hurt_until: u64,
    pub skin_until: u64,
    pub skin_used: bool,
    pub skill: Skill,
    /// When the wound-up skill goes off.
    pub skill_at: u64,
    pub slam_ready: u64,
    pub lob_ready: u64,
    pub charge_ready: u64,
    pub hunting: bool,
    /// The player whose fire hit it last.
    pub last_hitter: u32,
}

impl Warden {
    #[must_use]
    pub fn enraged(&self, t: &GuardTuning) -> bool {
        self.hp <= t.enrage_hp
    }
}

/// The vault: walls from (x0, y0) to (x1, y1) inclusive, gates in the
/// middle of each side, loot laid on a grid inside.
pub struct Vault {
    pub x0: i32,
    pub y0: i32,
    pub x1: i32,
    pub y1: i32,
    pub loot: Vec<(i32, i32)>,
    /// The middle, where the Warden stands guard.
    pub home: (i32, i32),
}

impl Vault {
    /// Within the walls' rectangle grown by `m` cells.
    #[must_use]
    pub fn covers(&self, x: i32, y: i32, m: i32) -> bool {
        x >= self.x0 - m && x <= self.x1 + m && y >= self.y0 - m && y <= self.y1 + m
    }
}

#[derive(Default)]
pub struct Guard {
    pub tuning: GuardTuning,
    pub vault: Option<Vault>,
    pub warden: Option<Warden>,
    pub respawn_at: u64,
    pub next_restock: u64,
    danger: DangerScratch,
    danger_tick: Option<u64>,
    seen: Vec<u32>,
    first: Vec<u8>,
    generation: u32,
    queue: VecDeque<(i32, i32)>,
}

/// What the vault is stocked with, and how often each turns up.
const LOOT: [(Item, u32); 19] = [
    (Item::ExtraBomb, 10),
    (Item::Range, 10),
    (Item::Speed, 8),
    (Item::FullFire, 4),
    (Item::Kick, 5),
    (Item::Remote, 4),
    (Item::Pierce, 5),
    (Item::Shield, 6),
    (Item::LineBomb, 4),
    (Item::Punch, 4),
    (Item::Rocket, 4),
    (Item::Drone, 3),
    (Item::Swarm, 2),
    (Item::Dash, 4),
    (Item::PortalPair, 3),
    (Item::Builder, 3),
    (Item::Clone, 3),
    (Item::Nuke, 2),
    (Item::Mystery, 4),
];

impl World {
    /// Whether (x, y) is within the vault's walls grown by `m` cells.
    #[must_use]
    pub fn in_vault(&self, x: i32, y: i32, m: i32) -> bool {
        self.guard.vault.as_ref().is_some_and(|v| v.covers(x, y, m))
    }

    /// Builds the vault as near the middle of the map as it fits (no
    /// teleporter pads in the way), clears a lane round it so every gate
    /// leads somewhere, stocks it and posts the Warden.
    pub(super) fn carve_vault(&mut self) {
        let s = if self.map.w.min(self.map.h) >= 41 { 9 } else { 7 };
        if self.map.w < s + 8 || self.map.h < s + 8 {
            return;
        }
        let (cx, cy) = (self.map.w / 2, self.map.h / 2);
        let fits = |w: &World, x0: i32, y0: i32| {
            x0 >= 3 && y0 >= 3 && x0 + s + 2 < w.map.w && y0 + s + 2 < w.map.h
                && (y0 - 1..=y0 + s).all(|y| (x0 - 1..=x0 + s).all(|x| w.map.get(x, y) != Tile::Teleport))
        };
        let mut spot = None;
        'find: for r in 0..=self.map.w.min(self.map.h) / 4 {
            for dy in -r..=r {
                for dx in -r..=r {
                    if dx.abs().max(dy.abs()) == r && fits(self, cx + dx - s / 2, cy + dy - s / 2) {
                        spot = Some((cx + dx - s / 2, cy + dy - s / 2));
                        break 'find;
                    }
                }
            }
        }
        let Some((x0, y0)) = spot else { return };
        let (x1, y1) = (x0 + s - 1, y0 + s - 1);
        let (mx, my) = (i32::midpoint(x0, x1), i32::midpoint(y0, y1));
        for y in y0 - 1..=y1 + 1 {
            for x in x0 - 1..=x1 + 1 {
                let outside = x < x0 || x > x1 || y < y0 || y > y1;
                let ring = x == x0 || x == x1 || y == y0 || y == y1;
                let gate = (x == mx && (y == y0 || y == y1)) || (y == my && (x == x0 || x == x1));
                self.set_tile(x, y, if !outside && ring && !gate { Tile::Wall } else { Tile::Floor });
                self.set_item(x, y, 0);
            }
        }
        let n = s - 2;
        let loot = (0..n)
            .flat_map(|j| (0..n).map(move |i| (i, j)))
            .filter(|&(i, j)| i % 2 == 0 && j % 2 == 0 && (i, j) != (n / 2, n / 2))
            .map(|(i, j)| (x0 + 1 + i, y0 + 1 + j))
            .collect();
        self.guard.vault = Some(Vault { x0, y0, x1, y1, loot, home: (mx, my) });
        let cells = (self.map.w * self.map.h) as usize;
        (self.guard.seen, self.guard.first) = (vec![0; cells], vec![0; cells]);
        self.stock_vault(true);
        self.spawn_warden();
        tracing::info!(x0, y0, size = s, "vault built");
    }

    fn random_loot(&mut self) -> Item {
        let total: u32 = LOOT.iter().map(|l| l.1).sum();
        let mut roll = self.rng.below(total);
        for &(item, weight) in &LOOT {
            if roll < weight {
                return item;
            }
            roll -= weight;
        }
        Item::ExtraBomb
    }

    /// Lays loot on empty loot cells: all of them, or just one.
    pub(super) fn stock_vault(&mut self, all: bool) {
        let Some(v) = &self.guard.vault else { return };
        let empty: Vec<(i32, i32)> = v.loot.iter().copied().filter(|&(x, y)| self.items[self.map.idx(x, y)] == 0 && self.map.get(x, y) == Tile::Floor).collect();
        let take = if all { empty.len() } else { empty.len().min(1) };
        let start = if empty.is_empty() { 0 } else { self.rng.below(empty.len() as u32) as usize };
        for k in 0..take {
            let (x, y) = empty[(start + k) % empty.len()];
            let item = self.random_loot();
            self.set_item(x, y, item as u8);
        }
    }

    fn spawn_warden(&mut self) {
        let Some(home) = self.guard.vault.as_ref().map(|v| v.home) else { return };
        let id = self.next_object_id();
        let (tick, t) = (self.tick, self.guard.tuning);
        self.guard.warden = Some(Warden {
            id,
            cell: home,
            from: home,
            dir: 3,
            last_step: tick,
            next_step: tick + SEC,
            step_ticks: t.step_ticks,
            hp: t.max_hp,
            hurt_until: 0,
            skin_until: 0,
            skin_used: false,
            skill: Skill::None,
            skill_at: 0,
            slam_ready: tick + SEC,
            lob_ready: tick + SEC,
            charge_ready: tick + SEC,
            hunting: false,
            last_hitter: 0,
        });
    }

    /// The Warden's part of the tick, after the fire's: restocking, coming
    /// back, getting hurt, thinking, and crushing whoever it touches.
    pub(super) fn update_guard(&mut self) {
        if self.guard.vault.is_none() {
            return;
        }
        let (tick, t) = (self.tick, self.guard.tuning);
        if tick >= self.guard.next_restock {
            self.stock_vault(false);
            self.guard.next_restock = tick + t.restock_ticks;
        }
        let Some(cell) = self.guard.warden.as_ref().map(|w| w.cell) else {
            let home = self.guard.vault.as_ref().unwrap().home;
            let clear = !self.map.is_solid(home.0, home.1) && !self.players_in_rect(home.0 - 1, home.1 - 1, home.0 + 1, home.1 + 1).any(|p| p.alive);
            if tick >= self.guard.respawn_at && clear {
                self.spawn_warden();
                self.stock_vault(true);
                self.broadcast_event(ev::GUARD, &[news::BACK, i64::from(home.0), i64::from(home.1), 0]);
            }
            return;
        };
        // Sudden death's stone took its ground: gone, no points for anyone.
        if self.map.is_solid(cell.0, cell.1) {
            self.guard.warden = None;
            self.guard.respawn_at = tick + t.respawn_ticks;
            return;
        }
        if self.hurt_warden() {
            return;
        }
        self.warden_think();
        self.warden_crush();
    }

    /// Player fire on its cell takes a hit point (not while immune). Returns
    /// whether that killed it.
    fn hurt_warden(&mut self) -> bool {
        let (tick, t) = (self.tick, self.guard.tuning);
        let w = self.guard.warden.as_ref().unwrap();
        let (x, y) = w.cell;
        let owner = self.flame_owner[self.map.idx(x, y)];
        if !self.flame_active(x, y) || owner == 0 || tick < w.hurt_until || tick < w.skin_until {
            return false;
        }
        let w = self.guard.warden.as_mut().unwrap();
        w.hp = w.hp.saturating_sub(1);
        w.hurt_until = tick + t.hurt_ticks;
        w.last_hitter = owner;
        if w.hp > 0 {
            if !w.skin_used && w.hp <= t.max_hp / 2 {
                w.skin_used = true;
                w.skin_until = tick + t.skin_ticks;
            }
            return false;
        }
        self.warden_killed();
        true
    }

    fn warden_killed(&mut self) {
        let t = self.guard.tuning;
        let w = self.guard.warden.take().unwrap();
        self.guard.respawn_at = self.tick + t.respawn_ticks;
        self.stats.wardens_killed += 1;
        let killer = self.players.contains_key(&w.last_hitter).then_some(w.last_hitter);
        if let Some(p) = killer.and_then(|k| self.players.get_mut(&k)) {
            p.score += t.kill_points;
            if let Some(prof) = &mut p.profile {
                prof.xp += t.kill_xp;
                p.profile_dirty = true;
            }
        }
        let (x, y) = w.cell;
        self.broadcast_event(ev::GUARD, &[news::KILLED, i64::from(x), i64::from(y), killer.map_or(0, |k| i64::from(k) + 1)]);
    }

    /// Players it can fight: alive, unshielded, near enough the vault.
    fn warden_prey(&self, p: &Player) -> bool {
        let m = self.guard.tuning.aggro_margin;
        let (x, y) = p.cell();
        p.alive && p.invulnerable_until <= self.tick && self.in_vault(x, y, m)
    }

    fn warden_think(&mut self) {
        let (tick, t) = (self.tick, self.guard.tuning);
        let w = self.guard.warden.as_ref().unwrap();
        let enraged = w.enraged(&t);
        let cd = |c: u64| if enraged { c * 3 / 5 } else { c };
        let (cell, skill, skill_at) = (w.cell, w.skill, w.skill_at);
        match skill {
            Skill::Slam if tick >= skill_at => {
                self.warden_slam();
                let w = self.guard.warden.as_mut().unwrap();
                (w.skill, w.slam_ready, w.next_step) = (Skill::None, tick + cd(t.slam_cooldown), tick + w.step_ticks);
                return;
            }
            Skill::Charge(d) if tick >= skill_at => {
                self.guard.warden.as_mut().unwrap().skill = Skill::Charging(d, t.charge_cells);
                self.warden_charge();
                return;
            }
            Skill::Charging(..) => {
                self.warden_charge();
                return;
            }
            Skill::Slam | Skill::Charge(_) => return, // still winding up
            Skill::None => {}
        }
        if tick < w.next_step {
            return;
        }
        // The nearest intruder.
        let target = self
            .players
            .values()
            .filter(|p| self.warden_prey(p))
            .map(|p| (cheb(p.cell(), cell), p.id, p.cell()))
            .min();
        let w = self.guard.warden.as_mut().unwrap();
        w.hunting = target.is_some();
        w.step_ticks = if enraged { t.enraged_step_ticks } else { t.step_ticks };
        let goal = if let Some((d, _, at)) = target {
            if d <= 1 && tick >= w.slam_ready {
                (w.skill, w.skill_at) = (Skill::Slam, tick + t.slam_windup);
                return;
            }
            let lane = lane_dir(cell, at).filter(|_| (2..=t.charge_cells).contains(&d));
            if let Some(dir) = lane
                && tick >= w.charge_ready
                && self.lane_clear(cell, at, dir)
            {
                let w = self.guard.warden.as_mut().unwrap();
                (w.skill, w.skill_at, w.dir) = (Skill::Charge(dir), tick + t.charge_windup, dir);
                return;
            }
            let w = self.guard.warden.as_ref().unwrap();
            if (t.lob_min..=t.lob_max).contains(&d) && tick >= w.lob_ready {
                self.warden_lob(at, enraged);
                self.guard.warden.as_mut().unwrap().lob_ready = tick + cd(t.lob_cooldown);
            }
            at
        } else {
            self.guard.vault.as_ref().unwrap().home
        };
        let step = self.warden_path(cell, goal);
        let w = self.guard.warden.as_mut().unwrap();
        w.next_step = tick + w.step_ticks;
        if let Some(d) = step {
            let next = (cell.0 + DIRS[d as usize].0, cell.1 + DIRS[d as usize].1);
            (w.from, w.cell, w.dir, w.last_step) = (cell, next, d, tick);
        } else {
            w.from = cell;
        }
    }

    /// Whether a charge from `from` along `dir` reaches `to` with nothing
    /// solid or no bomb in between.
    fn lane_clear(&self, from: (i32, i32), to: (i32, i32), dir: u8) -> bool {
        let (dx, dy) = DIRS[dir as usize];
        let mut c = from;
        while c != to {
            c = (c.0 + dx, c.1 + dy);
            if self.map.is_solid(c.0, c.1) || self.bomb_at(c.0, c.1).is_some() {
                return false;
            }
        }
        true
    }

    /// The shockwave: everyone on the ground within `slam_radius` is crushed.
    fn warden_slam(&mut self) {
        let r = self.guard.tuning.slam_radius;
        let (x, y) = self.guard.warden.as_ref().unwrap().cell;
        self.broadcast_event(ev::GUARD, &[news::SLAM, i64::from(x), i64::from(y), 0]);
        let tick = self.tick;
        let mut hit: Vec<u32> = self
            .players_in_rect(x - r, y - r, x + r, y + r)
            .filter(|p| p.alive && p.jump_left == 0 && p.invulnerable_until <= tick)
            .map(|p| p.id)
            .collect();
        hit.sort_unstable();
        for id in hit {
            self.warden_crushes(id);
        }
    }

    /// One cell of a charge a tick, until the lane ends, the charge runs
    /// out or it would leave its leash.
    fn warden_charge(&mut self) {
        let (tick, t) = (self.tick, self.guard.tuning);
        let w = self.guard.warden.as_ref().unwrap();
        let Skill::Charging(d, left) = w.skill else { return };
        let next = (w.cell.0 + DIRS[d as usize].0, w.cell.1 + DIRS[d as usize].1);
        let open = left > 0 && !self.map.is_solid(next.0, next.1) && self.bomb_at(next.0, next.1).is_none() && self.in_vault(next.0, next.1, t.leash_margin);
        let enraged = w.enraged(&t);
        let w = self.guard.warden.as_mut().unwrap();
        if open {
            (w.from, w.cell, w.dir, w.last_step) = (w.cell, next, d, tick);
            (w.skill, w.step_ticks, w.next_step) = (Skill::Charging(d, left - 1), 1, tick + 1);
        } else {
            let cooldown = if enraged { t.charge_cooldown * 3 / 5 } else { t.charge_cooldown };
            w.from = w.cell;
            (w.skill, w.charge_ready, w.next_step) = (Skill::None, tick + cooldown, tick + t.step_ticks);
        }
    }

    /// A bomb on the intruder's cell (enraged: and on two cells by it).
    fn warden_lob(&mut self, at: (i32, i32), enraged: bool) {
        let t = self.guard.tuning;
        let kind = BombKind::plain(t.lob_range, t.lob_fuse);
        if self.place_bomb_at(0, at, kind) {
            self.broadcast_event(ev::GUARD, &[news::LOB, i64::from(at.0), i64::from(at.1), 0]);
        }
        if enraged {
            let mut extra = 0;
            for d in 1..=4u8 {
                let c = (at.0 + DIRS[d as usize].0 * 2, at.1 + DIRS[d as usize].1 * 2);
                if extra < 2 && self.map.in_bounds(c.0, c.1) && self.place_bomb_at(0, c, BombKind::plain(t.lob_range, t.lob_fuse + 6)) {
                    extra += 1;
                }
            }
        }
    }

    /// Crushes whoever stands on its cell.
    fn warden_crush(&mut self) {
        let Some(w) = &self.guard.warden else { return };
        let (x, y) = w.cell;
        let tick = self.tick;
        let mut hit: Vec<u32> = self
            .players_in_rect(x, y, x, y)
            .filter(|p| p.alive && p.jump_left == 0 && p.invulnerable_until <= tick && p.cell() == (x, y))
            .map(|p| p.id)
            .collect();
        hit.sort_unstable();
        for id in hit {
            self.warden_crushes(id);
        }
    }

    fn warden_crushes(&mut self, id: u32) {
        let (x, y) = self.players[&id].cell();
        self.stats.warden_crushes += 1;
        // The news goes first, so clients know what the kill was.
        self.broadcast_event(ev::GUARD, &[news::CRUSHED, i64::from(x), i64::from(y), i64::from(id) + 1]);
        self.kill(id, None);
    }

    /// The first step from `from` towards `goal`, within the leash, around
    /// walls, bombs and fire (now or soon).
    fn warden_path(&mut self, from: (i32, i32), goal: (i32, i32)) -> Option<u8> {
        if from == goal {
            return None;
        }
        if self.guard.danger_tick != Some(self.tick) {
            let mut sc = std::mem::take(&mut self.guard.danger);
            self.refresh_danger(&mut sc);
            self.guard.danger = sc;
            self.guard.danger_tick = Some(self.tick);
        }
        let t = self.guard.tuning;
        let soon = (t.step_ticks * 3) as u16;
        let mut queue = std::mem::take(&mut self.guard.queue);
        let mut seen = std::mem::take(&mut self.guard.seen);
        let mut first = std::mem::take(&mut self.guard.first);
        self.guard.generation = self.guard.generation.wrapping_add(1);
        if self.guard.generation == 0 {
            seen.fill(0);
            self.guard.generation = 1;
        }
        let g = self.guard.generation;
        queue.clear();
        queue.push_back(from);
        seen[self.map.idx(from.0, from.1)] = g;
        let mut found = None;
        while let Some(c) = queue.pop_front() {
            if c == goal {
                found = Some(first[self.map.idx(c.0, c.1)]);
                break;
            }
            for d in 1..=4u8 {
                let n = (c.0 + DIRS[d as usize].0, c.1 + DIRS[d as usize].1);
                if !self.map.in_bounds(n.0, n.1) || !self.in_vault(n.0, n.1, t.leash_margin) {
                    continue;
                }
                let i = self.map.idx(n.0, n.1);
                let danger = self.guard.danger.danger.get(i).copied().unwrap_or(SAFE);
                if seen[i] == g || self.map.is_solid(n.0, n.1) || self.bomb_at(n.0, n.1).is_some() || (danger != SAFE && danger <= soon) {
                    continue;
                }
                seen[i] = g;
                first[i] = if c == from { d } else { first[self.map.idx(c.0, c.1)] };
                queue.push_back(n);
            }
        }
        self.guard.queue = queue;
        self.guard.seen = seen;
        self.guard.first = first;
        found
    }
}

fn cheb(a: (i32, i32), b: (i32, i32)) -> i32 {
    (a.0 - b.0).abs().max((a.1 - b.1).abs())
}

/// The direction from `a` to `b` if they share a row or column.
fn lane_dir(a: (i32, i32), b: (i32, i32)) -> Option<u8> {
    match (b.0 - a.0, b.1 - a.1) {
        (0, dy) if dy < 0 => Some(1),
        (dx, 0) if dx > 0 => Some(2),
        (0, dy) if dy > 0 => Some(3),
        (dx, 0) if dx < 0 => Some(4),
        _ => None,
    }
}
