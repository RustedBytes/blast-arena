//! Builder: a temporary wall in front of the player.
//!
//! A wall is a map tile (`Tile::Built`), so movement, blasts, gas, client
//! prediction and the AI all treat it as solid with no special cases. It
//! remembers the tile it covers and puts it back when it's destroyed or
//! expires. Walls outlive their builder.

use super::abilities::{Audience, ab, reject};
use super::map::Tile;
use super::player::DIRS;
use super::World;

/// A wall standing on the map.
pub struct Wall {
    pub id: u32,
    pub owner: u32,
    pub x: i32,
    pub y: i32,
    /// The tile underneath, restored when the wall goes.
    pub under: Tile,
    pub health: u8,
    pub until: u64,
}

impl World {
    /// The cell the builder targets: `placementRange` cells ahead.
    fn wall_target(&self, id: u32) -> (i32, i32) {
        let p = &self.players[&id];
        let (cx, cy) = p.cell();
        let (dx, dy) = DIRS[p.facing as usize];
        let r = i32::from(self.tuning.raw.builder.placement_range);
        (cx + dx * r, cy + dy * r)
    }

    /// Why a wall can't go on (x, y), if it can't: off the map or not plain
    /// ground (floor or ice: pillars, crates, pads and belts are out), a
    /// bomb, portal or item on it, a player or flag base touching it.
    pub(super) fn wall_blocked(&self, x: i32, y: i32) -> Option<i64> {
        if !self.map.in_bounds(x, y) || !matches!(self.map.get(x, y), Tile::Floor | Tile::Ice) {
            return Some(reject::BLOCKED);
        }
        let i = self.map.idx(x, y);
        if self.bomb_grid[i] != 0 || self.items[i] != 0 || self.portal_at(x, y).is_some() {
            return Some(reject::BLOCKED);
        }
        if self.events.flags.iter().any(|f| f.base == (x, y)) && self.events.ctf {
            return Some(reject::BLOCKED);
        }
        // Never inside anyone: a player overlapping the cell at all blocks it.
        let (fx, fy) = (x as f32 + 0.5, y as f32 + 0.5);
        if self.players_in_rect(x - 1, y - 1, x + 1, y + 1).any(|o| o.alive && (o.x - fx).abs() < 0.95 && (o.y - fy).abs() < 0.95) {
            return Some(reject::BLOCKED);
        }
        None
    }

    /// `activate`: builds a wall. `Ok(true)` spends a charge.
    pub(super) fn place_wall(&mut self, id: u32) -> Result<bool, i64> {
        let (x, y) = self.wall_target(id);
        if let Some(reason) = self.wall_blocked(x, y) {
            return Err(reason);
        }
        let max = usize::from(self.tuning.raw.builder.max_active_walls);
        if self.walls.iter().filter(|w| w.owner == id).count() >= max {
            return Err(reject::LIMIT);
        }
        let under = self.map.get(x, y);
        // Ice under a wall is still temporary ice: it melts back to floor.
        let under = if under == Tile::Ice && self.frozen.iter().any(|f| (f.0, f.1) == (x, y)) { Tile::Floor } else { under };
        self.frozen.retain(|f| (f.0, f.1) != (x, y));
        let wid = self.next_object_id();
        let until = self.tick + self.tuning.wall_ticks;
        let health = self.tuning.raw.builder.wall_health;
        self.walls.push(Wall { id: wid, owner: id, x, y, under, health, until });
        self.set_tile(x, y, Tile::Built);
        let ticks = self.tuning.wall_ticks as i64;
        self.ability_event(ab::WALL_CREATED, Audience::Near(x, y), &[i64::from(wid), i64::from(id), i64::from(x), i64::from(y), ticks]);
        Ok(true)
    }

    /// A blast reached the wall at (x, y): it loses a point of health and
    /// crumbles at zero. Returns whether it's gone.
    /// An atomic blast (`vaporize`) flattens it whatever its health.
    pub(super) fn damage_wall(&mut self, x: i32, y: i32, vaporize: bool) -> bool {
        let Some(k) = self.walls.iter().position(|w| (w.x, w.y) == (x, y)) else {
            // A wall tile without a record (shouldn't happen): just clear it.
            self.set_tile(x, y, Tile::Floor);
            return true;
        };
        self.walls[k].health = if vaporize { 0 } else { self.walls[k].health.saturating_sub(1) };
        if self.walls[k].health > 0 {
            return false;
        }
        self.remove_wall(k, true);
        true
    }

    /// Takes wall `k` off the map, restoring the ground under it.
    fn remove_wall(&mut self, k: usize, destroyed: bool) {
        let w = self.walls.swap_remove(k);
        if self.map.get(w.x, w.y) == Tile::Built {
            self.set_tile(w.x, w.y, w.under);
        }
        self.ability_event(ab::WALL_REMOVED, Audience::Near(w.x, w.y), &[i64::from(w.id), i64::from(w.x), i64::from(w.y), i64::from(destroyed)]);
    }

    /// Walls crumble when their time is up. A wall something else replaced
    /// (sudden death's stone) is forgotten quietly.
    pub(super) fn update_walls(&mut self) {
        let tick = self.tick;
        let mut k = 0;
        while k < self.walls.len() {
            let w = &self.walls[k];
            if self.map.get(w.x, w.y) != Tile::Built {
                self.walls.swap_remove(k);
            } else if w.until <= tick {
                self.remove_wall(k, false);
            } else {
                k += 1;
            }
        }
    }

    pub(super) fn clear_walls(&mut self) {
        while !self.walls.is_empty() {
            self.remove_wall(self.walls.len() - 1, false);
        }
    }
}
