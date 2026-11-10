//! Gas bombs: instead of fire, a cross-shaped cloud that slows everyone
//! inside it. Fire touching a cloud ignites it, once: everyone in the cloud
//! is hurt by a single simultaneous fire event, and the cloud is gone.
//!
//! The cloud's cells are fixed when the gas is released (walls built or
//! blown up later don't reshape it), which keeps every client's picture
//! identical without re-sending it.

use super::abilities::{Audience, ab};
use super::bomb::{Bomb, Explosion};
use super::player::{BASE_RANGE, DIRS};
use super::World;

/// How long the flash of an ignition is shown (it hurts only once).
pub const IGNITION_SHOW_TICKS: u64 = 6;

pub struct GasCloud {
    pub id: u32,
    pub owner: u32,
    pub team: u8,
    pub x: i32,
    pub y: i32,
    /// Arm lengths: up, right, down, left.
    pub arms: [u8; 4],
    /// Every cell, the centre first.
    pub cells: Vec<(i32, i32)>,
    /// Released in this tick; it can't ignite before the next one.
    pub born: u64,
    pub until: u64,
}

impl GasCloud {
    #[must_use]
    pub fn covers(&self, x: i32, y: i32) -> bool {
        (x == self.x && (y - self.y).abs() <= i32::from(self.arms[if y < self.y { 0 } else { 2 }]))
            || (y == self.y && (x - self.x).abs() <= i32::from(self.arms[if x > self.x { 1 } else { 3 }]))
    }
}

impl World {
    /// The radius of the next gas bomb of `owner`.
    pub(super) fn gas_radius(&self, owner: u32) -> u8 {
        let g = &self.tuning.raw.gas_bomb;
        let bonus = self.players.get(&owner).map_or(0, |p| p.range.saturating_sub(BASE_RANGE)).min(g.range_bonus);
        g.radius + bonus
    }

    /// A gas bomb goes off: the gas spreads in a cross, stopping in front
    /// of anything solid. A player keeps at most `maxActiveClouds` clouds:
    /// the oldest one clears for a new one.
    pub(super) fn release_gas(&mut self, b: &Bomb) {
        let mut cells = vec![(b.x, b.y)];
        let mut arms = [0u8; 4];
        for (arm, len) in arms.iter_mut().enumerate() {
            let (dx, dy) = DIRS[arm + 1];
            for r in 1..=i32::from(b.range) {
                let (cx, cy) = (b.x + dx * r, b.y + dy * r);
                if self.map.is_solid(cx, cy) {
                    break;
                }
                cells.push((cx, cy));
                *len = r as u8;
            }
        }
        let max = usize::from(self.tuning.raw.gas_bomb.max_active_clouds);
        while self.gas.iter().filter(|c| c.owner == b.owner).count() >= max {
            let k = self.gas.iter().position(|c| c.owner == b.owner).unwrap();
            self.expire_gas(k);
        }
        let id = self.next_object_id();
        let team = self.players.get(&b.owner).map_or(0, |p| p.team);
        let until = self.tick + self.tuning.gas_ticks;
        self.gas.push(GasCloud { id, owner: b.owner, team, x: b.x, y: b.y, arms, cells, born: self.tick, until });
        let ticks = self.tuning.gas_ticks as i64;
        self.ability_event(ab::GAS_CREATED, Audience::Near(b.x, b.y), &[i64::from(id), i64::from(b.owner), i64::from(b.x), i64::from(b.y), ticks]);
    }

    fn expire_gas(&mut self, k: usize) {
        let c = self.gas.remove(k);
        self.ability_event(ab::GAS_EXPIRED, Audience::Near(c.x, c.y), &[i64::from(c.id), i64::from(c.x), i64::from(c.y)]);
    }

    /// Clouds expire, catch fire, and slow whoever is inside. Runs after
    /// the fuses, so this tick's blasts can ignite them.
    pub(super) fn update_gas(&mut self) {
        let tick = self.tick;
        let mut k = 0;
        while k < self.gas.len() {
            let c = &self.gas[k];
            if c.until <= tick {
                self.expire_gas(k);
                continue;
            }
            // Released this tick: it can't catch fire until the next one.
            if c.born < tick && c.cells.iter().any(|&(x, y)| self.flame_active(x, y)) {
                self.ignite(k);
                continue;
            }
            k += 1;
        }

        // Inside a cloud: slowed, refreshed every tick, wearing off a little
        // after leaving. Overlapping clouds don't add up.
        let until = tick + self.tuning.gas_linger;
        let mut gassed = std::mem::take(&mut self.scratch.gassed);
        gassed.clear();
        for c in &self.gas {
            let r = i32::from(*c.arms.iter().max().unwrap_or(&0));
            for p in self.players_in_rect(c.x - r, c.y - r, c.x + r, c.y + r) {
                let (x, y) = p.cell();
                if p.alive && p.jump_left == 0 && c.covers(x, y) {
                    gassed.push(p.id);
                }
            }
        }
        for &id in &gassed {
            if let Some(p) = self.players.get_mut(&id) {
                p.gassed_until = p.gassed_until.max(until);
            }
        }
        gassed.clear();
        self.scratch.gassed = gassed;
    }

    /// A player passing through (x, y) mid-dash breathes the gas there.
    pub(super) fn gas_touch(&mut self, id: u32, x: i32, y: i32) {
        if self.gas.iter().any(|c| c.covers(x, y)) {
            let until = self.tick + self.tuning.gas_linger;
            let p = self.players.get_mut(&id).unwrap();
            p.gassed_until = p.gassed_until.max(until);
        }
    }

    /// Cloud `k` catches fire: one damage event over all its cells at once,
    /// hurting each player in it at most once, then the gas is gone. The
    /// fire doesn't spread past the cloud or linger, so it can't set off a
    /// chain.
    fn ignite(&mut self, index: usize) {
        let c = self.gas.remove(index);
        let friendly_fire = self.tuning.raw.gas_bomb.friendly_fire;
        let mut victims = std::mem::take(&mut self.scratch.victims);
        victims.clear();
        let reach = i32::from(*c.arms.iter().max().unwrap_or(&0));
        let owner = self.players.get(&c.owner);
        for p in self.players_in_rect(c.x - reach, c.y - reach, c.x + reach, c.y + reach) {
            let (px, py) = p.cell();
            if !p.alive || p.jump_left > 0 || p.invulnerable_until > self.tick || !c.covers(px, py) {
                continue;
            }
            let ally = c.team != 0 && p.team == c.team && p.id != c.owner;
            if ally && !friendly_fire {
                continue;
            }
            if owner.is_some_and(|o| !o.can_hurt(p)) && !(ally && friendly_fire) {
                continue;
            }
            victims.push((p.id, c.owner));
        }
        victims.sort_unstable();
        victims.dedup_by_key(|v| v.0);
        for &(v, killer) in &victims {
            self.kill(v, Some(killer));
        }
        victims.clear();
        self.scratch.victims = victims;
        self.stats.gas_ignitions += 1;
        // Clients show the burst as a blast of the cloud's shape.
        self.explosions.push(Explosion { x: c.x, y: c.y, arms: c.arms, nuke: 0, until: self.tick + IGNITION_SHOW_TICKS });
        self.ability_event(ab::GAS_IGNITED, Audience::Near(c.x, c.y), &[i64::from(c.id), i64::from(c.x), i64::from(c.y)]);
    }

    pub(super) fn clear_gas(&mut self) {
        while !self.gas.is_empty() {
            self.expire_gas(self.gas.len() - 1);
        }
    }
}
