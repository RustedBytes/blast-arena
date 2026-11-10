//! Sticky bombs: thrown a couple of cells ahead, they stick to the first
//! player they touch (in flight, or later on the ground) and ride along
//! until the fuse runs out. The bomb's owner never changes. The carrier
//! can shake it off by holding the detach key; the fuse keeps running.
//!
//! While attached the bomb is off the bomb grid (it doesn't block anyone
//! and can't be kicked or punched); its position follows the carrier's
//! cell every tick, through portals too, and the blast is centred where
//! the carrier stands when it goes off.

use super::abilities::{Audience, ab};
use super::bomb::BombKind;
use super::player::{DIRS, Player};
use super::World;

/// How far from the carrier a shaken-off bomb may land.
const DROP_RADIUS: i32 = 2;

impl World {
    /// Whether `owner`'s sticky bomb may stick to `p`: an enemy (a teammate
    /// only with friendly fire on), never the owner, someone on the ground,
    /// with room for another bomb.
    fn can_stick_to(&self, owner: u32, p: &Player) -> bool {
        if p.id == owner || !p.alive || p.jump_left > 0 {
            return false;
        }
        let ally = self.players.get(&owner).is_some_and(|o| o.team != 0 && o.team == p.team);
        if ally && !self.tuning.raw.sticky_bomb.friendly_fire {
            return false;
        }
        let max = usize::from(self.tuning.raw.sticky_bomb.max_attached_per_target);
        self.stuck_on(p.id) < max
    }

    /// Sticky bombs attached to player `id`.
    #[must_use]
    pub fn stuck_on(&self, id: u32) -> usize {
        self.sticky.iter().filter(|b| self.bombs.get(b).is_some_and(|b| b.attached == id)).count()
    }

    /// Who in cell (x, y) a bomb of `owner` would stick to (lowest id first).
    fn sticky_target_in(&self, owner: u32, x: i32, y: i32) -> Option<u32> {
        self.players_in_rect(x, y, x, y).filter(|o| o.cell() == (x, y) && self.can_stick_to(owner, o)).map(|o| o.id).min()
    }

    /// Throws a sticky bomb up to `throwRange` cells ahead: it sticks to the
    /// first player in its path, or lands on the last free cell before
    /// anything solid or another bomb (at the thrower's feet if there's no
    /// room ahead).
    pub(super) fn throw_sticky(&mut self, owner: u32, kind: BombKind) -> bool {
        let p = &self.players[&owner];
        let (x, y) = p.cell();
        let (dx, dy) = DIRS[p.facing as usize];
        let mut landing = self.bomb_at(x, y).is_none().then_some((x, y));
        let mut target = None;
        for k in 1..=i32::from(self.tuning.raw.sticky_bomb.throw_range) {
            let c = (x + dx * k, y + dy * k);
            if self.map.is_solid(c.0, c.1) || self.bomb_at(c.0, c.1).is_some() {
                break;
            }
            landing = Some(c);
            if let Some(t) = self.sticky_target_in(owner, c.0, c.1) {
                target = Some(t);
                break;
            }
        }
        let Some(at) = landing else { return false };
        if !self.place_bomb_at(owner, at, kind) {
            return false;
        }
        let bid = self.bomb_at(at.0, at.1).unwrap();
        self.sticky.push(bid);
        if let Some(t) = target {
            self.attach(bid, t);
        }
        true
    }

    /// `FLYING/PLACED → ATTACHED`.
    pub(super) fn attach(&mut self, bid: u32, target: u32) {
        let Some(b) = self.bombs.get_mut(&bid) else { return };
        let i = self.map.idx(b.x, b.y);
        if self.bomb_grid[i] == bid {
            self.bomb_grid[i] = 0;
        }
        (b.attached, b.slide_dir) = (target, 0);
        let (owner, tp) = (b.owner, &self.players[&target]);
        let (x, y) = tp.cell();
        let b = self.bombs.get_mut(&bid).unwrap();
        (b.x, b.y) = (x, y);
        self.stats.sticky_attached += 1;
        self.ability_event(ab::STICKY_ATTACHED, Audience::Near(x, y), &[i64::from(bid), i64::from(target), i64::from(owner), i64::from(x), i64::from(y)]);
    }

    /// `ATTACHED → DETACHED`: the bomb drops to the nearest free cell around
    /// (x, y), fuse untouched. With nowhere to land it goes off right away.
    fn detach(&mut self, bid: u32, x: i32, y: i32) {
        let Some(target) = self.bombs.get(&bid).map(|b| b.attached) else { return };
        let mut spot = None;
        'search: for r in 0..=DROP_RADIUS {
            for dy in -r..=r {
                for dx in -r..=r {
                    if dx.abs() + dy.abs() != r {
                        continue;
                    }
                    let (cx, cy) = (x + dx, y + dy);
                    if self.map.in_bounds(cx, cy) && !self.map.is_solid(cx, cy) && self.bomb_at(cx, cy).is_none() {
                        spot = Some((cx, cy));
                        break 'search;
                    }
                }
            }
        }
        let tick = self.tick;
        let b = self.bombs.get_mut(&bid).unwrap();
        b.attached = 0;
        let (fx, fy) = if let Some((cx, cy)) = spot {
            (b.x, b.y) = (cx, cy);
            let i = self.map.idx(cx, cy);
            self.bomb_grid[i] = bid;
            (cx, cy)
        } else {
            (b.x, b.y) = (x, y);
            b.explode_at = tick;
            (x, y)
        };
        if let Some(t) = self.players.get_mut(&target) {
            t.detach_ticks = 0;
        }
        self.ability_event(ab::STICKY_DETACHED, Audience::Near(fx, fy), &[i64::from(bid), i64::from(target), i64::from(fx), i64::from(fy)]);
    }

    /// A kicked sticky bomb that runs into a player sticks to them.
    pub(super) fn sticky_hit(&mut self, bid: u32, x: i32, y: i32) -> bool {
        let owner = self.bombs[&bid].owner;
        match self.sticky_target_in(owner, x, y) {
            Some(t) => {
                self.attach(bid, t);
                true
            }
            None => false,
        }
    }

    /// Attached bombs follow their carrier (or fall off when the carrier
    /// dies or leaves); bombs on the ground stick to whoever walks into
    /// them; carriers holding the detach key shake one off. Runs after
    /// movement and before the fuses.
    pub(super) fn update_sticky(&mut self) {
        let bombs = &self.bombs;
        self.sticky.retain(|b| bombs.contains_key(b));
        self.sticky.sort_unstable();
        let mut ids = std::mem::take(&mut self.scratch.sticky_ids);
        ids.clear();
        ids.extend_from_slice(&self.sticky);
        let detach_ticks = self.tuning.detach_ticks;
        let tick = self.tick;
        for &bid in &ids {
            let b = &self.bombs[&bid];
            let (owner, bx, by, carrier) = (b.owner, b.x, b.y, b.attached);
            if carrier != 0 {
                let Some(t) = self.players.get(&carrier).filter(|t| t.alive) else {
                    // The carrier died or left: it stays where they last were.
                    self.detach(bid, bx, by);
                    continue;
                };
                let (x, y) = t.cell();
                let holding = t.input_detach && t.stunned_until <= tick;
                let b = self.bombs.get_mut(&bid).unwrap();
                (b.x, b.y) = (x, y);
                let t = self.players.get_mut(&carrier).unwrap();
                if holding {
                    t.detach_ticks += 1;
                    if u64::from(t.detach_ticks) >= detach_ticks {
                        self.detach(bid, x, y);
                    }
                } else {
                    t.detach_ticks = 0;
                }
                continue;
            }
            // On the ground: a player in its cell, or walking into it from
            // a neighbouring cell's centre, picks it up.
            let mut hit = self.sticky_target_in(owner, bx, by);
            if hit.is_none() {
                hit = self
                    .players_in_rect(bx - 1, by - 1, bx + 1, by + 1)
                    .filter(|o| {
                        let (ox, oy) = o.cell();
                        let (dx, dy) = DIRS[o.input_dir as usize];
                        let pushing = (ox + dx, oy + dy) == (bx, by) && (dx != 0 || dy != 0);
                        let close = (o.x - (bx as f32 + 0.5)).abs() + (o.y - (by as f32 + 0.5)).abs() <= 1.05;
                        pushing && close && self.can_stick_to(owner, o)
                    })
                    .map(|o| o.id)
                    .min();
            }
            if let Some(t) = hit {
                self.attach(bid, t);
            }
        }
        self.scratch.sticky_ids = ids;
        // Nothing attached any more: the detach progress starts over.
        for p in self.players.values_mut() {
            if p.detach_ticks > 0 && !p.input_detach {
                p.detach_ticks = 0;
            }
        }
    }
}
