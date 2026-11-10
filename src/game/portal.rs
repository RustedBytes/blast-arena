//! Portal pairs: the player places two linked portals; stepping onto one
//! (or a bomb sliding onto one) comes out of the other, keeping its
//! direction. Blasts and gas never pass through.
//!
//! Placement: the farthest free cell up to `placementRange` ahead (the
//! line stops at anything solid), or the player's own cell. The first
//! portal waits, inactive, for its partner; a charge and the cooldown are
//! spent only once the pair is complete.
//!
//! Loops are impossible: after a trip an object is locked out of portals
//! until it has left the exit cell *and* its teleport cooldown is over, an
//! object makes at most one trip per tick, and a blocked exit simply
//! refuses the trip (no random fallback cell, no cooldown).

use super::abilities::{Audience, ab, reject};
use super::map::Tile;
use super::player::DIRS;
use super::{TELEPORT_COOLDOWN_TICKS, World};

pub struct Portal {
    pub id: u32,
    pub owner: u32,
    pub x: i32,
    pub y: i32,
    /// The linked portal's id, 0 while it waits for one.
    pub partner: u32,
    pub until: u64,
}

impl Portal {
    #[must_use]
    pub fn active(&self) -> bool {
        self.partner != 0
    }
}

impl World {
    #[must_use]
    pub fn portal_at(&self, x: i32, y: i32) -> Option<usize> {
        self.portals.iter().position(|p| (p.x, p.y) == (x, y))
    }

    /// `owner`'s first portal, waiting for its partner.
    #[must_use]
    pub fn pending_portal(&self, owner: u32) -> Option<usize> {
        self.portals.iter().position(|p| p.owner == owner && !p.active())
    }

    /// Plain ground with nothing on it: no bomb, portal, pad or belt.
    fn portal_cell_free(&self, x: i32, y: i32) -> bool {
        self.map.in_bounds(x, y)
            && matches!(self.map.get(x, y), Tile::Floor | Tile::Ice)
            && self.bomb_at(x, y).is_none()
            && self.portal_at(x, y).is_none()
    }

    fn portal_target(&self, id: u32) -> Option<(i32, i32)> {
        let p = &self.players[&id];
        let (cx, cy) = p.cell();
        let (dx, dy) = DIRS[p.facing as usize];
        let mut best = self.portal_cell_free(cx, cy).then_some((cx, cy));
        for k in 1..=i32::from(self.tuning.raw.portal_pair.placement_range) {
            let (x, y) = (cx + dx * k, cy + dy * k);
            if self.map.is_solid(x, y) || !self.map.in_bounds(x, y) {
                break;
            }
            if self.portal_cell_free(x, y) {
                best = Some((x, y));
            }
        }
        best
    }

    /// `activate`: the first press places a waiting portal (`Ok(false)`:
    /// free so far), the second completes the pair (`Ok(true)`: a charge).
    pub(super) fn place_portal(&mut self, id: u32) -> Result<bool, i64> {
        let pending = self.pending_portal(id);
        if pending.is_none() {
            let pairs = self.portals.iter().filter(|p| p.owner == id && p.active()).count() / 2;
            if pairs >= usize::from(self.tuning.raw.portal_pair.max_active_pairs) {
                return Err(reject::LIMIT);
            }
        }
        let (x, y) = self.portal_target(id).ok_or(reject::BLOCKED)?;
        let pid = self.next_object_id();
        match pending {
            None => {
                let until = self.tick + self.tuning.portal_timeout;
                self.portals.push(Portal { id: pid, owner: id, x, y, partner: 0, until });
                self.ability_event(ab::PORTAL_CREATED, Audience::Near(x, y), &[i64::from(pid), i64::from(id), i64::from(x), i64::from(y)]);
                Ok(false)
            }
            Some(k) => {
                let until = self.tick + self.tuning.portal_ticks;
                let first = &mut self.portals[k];
                (first.partner, first.until) = (pid, until);
                let (fid, fx, fy) = (first.id, first.x, first.y);
                self.portals.push(Portal { id: pid, owner: id, x, y, partner: fid, until });
                // Whoever stands on a portal as it opens has to step off first.
                for p in self.players.values_mut() {
                    let c = p.cell();
                    if c == (x, y) || c == (fx, fy) {
                        p.portal_lock = Some(c);
                    }
                }
                self.stats.portal_pairs += 1;
                self.ability_event(ab::PORTAL_CREATED, Audience::Near(x, y), &[i64::from(pid), i64::from(id), i64::from(x), i64::from(y)]);
                self.ability_event(ab::PORTAL_LINKED, Audience::Near(x, y), &[i64::from(fid), i64::from(pid), i64::from(id), i64::from(x), i64::from(y)]);
                Ok(true)
            }
        }
    }

    /// `WAITING_SECOND → CANCELLED`.
    pub(super) fn cancel_pending_portal(&mut self, owner: u32) {
        if let Some(k) = self.pending_portal(owner) {
            self.remove_portal(k);
        }
    }

    /// Removes portal `k` and its partner. Objects standing on them stay put.
    fn remove_portal(&mut self, k: usize) {
        let p = self.portals.swap_remove(k);
        self.ability_event(ab::PORTAL_DESTROYED, Audience::Near(p.x, p.y), &[i64::from(p.id), i64::from(p.x), i64::from(p.y)]);
        if p.partner != 0
            && let Some(j) = self.portals.iter().position(|q| q.id == p.partner)
        {
            self.remove_portal(j);
        }
    }

    pub(super) fn remove_portals_of(&mut self, owner: u32) {
        while let Some(k) = self.portals.iter().position(|p| p.owner == owner) {
            self.remove_portal(k);
        }
    }

    pub(super) fn clear_portals(&mut self) {
        while !self.portals.is_empty() {
            self.remove_portal(self.portals.len() - 1);
        }
    }

    /// Pairs (and lone waiting portals) expire; a portal whose cell turned
    /// solid (sudden death's stone) takes its partner with it.
    pub(super) fn update_portals(&mut self) {
        let tick = self.tick;
        while let Some(k) = self.portals.iter().position(|p| p.until <= tick || self.map.is_solid(p.x, p.y)) {
            self.remove_portal(k);
        }
    }

    /// Where an object entering an active portal at (x, y) comes out.
    fn portal_exit(&self, x: i32, y: i32) -> Option<(i32, i32)> {
        let p = &self.portals[self.portal_at(x, y)?];
        if !p.active() {
            return None;
        }
        let q = self.portals.iter().find(|q| q.id == p.partner)?;
        Some((q.x, q.y))
    }

    /// Nothing in the way at the exit: not solid, no bomb, nobody standing
    /// there (so simultaneous trips never stack players).
    fn exit_free(&self, x: i32, y: i32, who: u32) -> bool {
        !self.map.is_solid(x, y) && self.bomb_at(x, y).is_none() && !self.players_in_rect(x, y, x, y).any(|o| o.alive && o.id != who && o.cell() == (x, y))
    }

    /// A player entering a portal: steps 1–7 of the trip. `anywhere` lets a
    /// dashing player through without reaching the cell centre. Returns
    /// whether they went through.
    pub(super) fn portal_entry(&mut self, id: u32, anywhere: bool) -> bool {
        let tick = self.tick;
        let p = self.players.get_mut(&id).unwrap();
        let cell = p.cell();
        if let Some(lock) = p.portal_lock {
            if lock == cell {
                return false;
            }
            p.portal_lock = None;
        }
        if p.portal_ready_at > tick || self.portals.is_empty() {
            return false;
        }
        let p = &self.players[&id];
        let near_centre = (p.x - (cell.0 as f32 + 0.5)).abs() + (p.y - (cell.1 as f32 + 0.5)).abs() < 0.35;
        if !(anywhere || near_centre) {
            return false;
        }
        let Some((tx, ty)) = self.portal_exit(cell.0, cell.1) else { return false };
        if !self.exit_free(tx, ty, id) || self.in_nuke_zone(tx, ty) {
            return false; // blocked (or in a nuke's red zone): stay, no cooldown, no other exit
        }
        let cd = self.tuning.teleport_cooldown;
        let p = self.players.get_mut(&id).unwrap();
        (p.x, p.y) = (tx as f32 + 0.5, ty as f32 + 0.5);
        p.portal_lock = Some((tx, ty));
        p.portal_ready_at = tick + cd;
        // No hopping straight on to a map teleporter pad either.
        p.teleport_ready_at = p.teleport_ready_at.max(tick + TELEPORT_COOLDOWN_TICKS.min(cd));
        self.rebuild_buckets();
        self.stats.teleports += 1;
        self.ability_event(ab::TELEPORTED, Audience::Near(cell.0, cell.1), &[0, i64::from(id), i64::from(cell.0), i64::from(cell.1), i64::from(tx), i64::from(ty)]);
        true
    }

    /// A bomb that just slid onto (x, y): through the portal there, if any,
    /// keeping its owner, fuse and direction.
    pub(super) fn bomb_portal(&mut self, bid: u32) {
        let (x, y, ready) = {
            let b = &self.bombs[&bid];
            (b.x, b.y, b.portal_ready_at)
        };
        if ready > self.tick || self.portals.is_empty() {
            return;
        }
        let Some((tx, ty)) = self.portal_exit(x, y) else { return };
        if !self.exit_free(tx, ty, 0) {
            return;
        }
        let (oi, ni) = (self.map.idx(x, y), self.map.idx(tx, ty));
        self.bomb_grid[oi] = 0;
        self.bomb_grid[ni] = bid;
        let cd = self.tuning.teleport_cooldown;
        let b = self.bombs.get_mut(&bid).unwrap();
        (b.x, b.y, b.portal_ready_at) = (tx, ty, self.tick + cd);
        self.stats.teleports += 1;
        self.ability_event(ab::TELEPORTED, Audience::Near(x, y), &[1, i64::from(bid), i64::from(x), i64::from(y), i64::from(tx), i64::from(ty)]);
    }
}
