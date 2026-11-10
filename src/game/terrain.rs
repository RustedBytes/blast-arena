//! Tiles and items: changes are recorded for the reliable world-delta stream, and crates slowly regrow.

use super::items::Item;
use super::map::Tile;
use super::{REGROW_MYSTERY_CHANCE, TICK_RATE, World};

impl World {
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

    /// Slowly regrows crates in quiet areas so the big map never runs dry,
    /// occasionally leaving a lone secret box instead.
    pub(super) fn regrow_crates(&mut self) {
        if !self.tick.is_multiple_of(u64::from(TICK_RATE)) || self.crate_count >= self.crate_target {
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
            if self.map.get(x, y) != Tile::Floor || self.in_hill(x, y) || self.in_vault(x, y, 1) {
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
}
