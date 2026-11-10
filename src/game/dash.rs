//! Dash: a short burst of speed in a straight line. It can't pass walls,
//! bombs or the map edge, gives no invulnerability (unless configured),
//! keeps its direction, and may go through one portal.
//!
//! The dash is swept: each tick's distance is split into sub-steps shorter
//! than half a cell, and every cell it enters is checked for fire, gas,
//! items and portals, so moving fast never skips past anything.

use super::abilities::{Audience, ab};
use super::items::Item;
use super::map::Tile;
use super::player::step_move;
use super::World;

/// Longest sub-step (`step_move` needs < 0.5 to never skip a cell centre).
const SUB_STEP: f32 = 0.45;

impl World {
    /// `activate`: starts a dash in the held direction (or the one faced).
    #[allow(clippy::unnecessary_wraps, reason = "same signature as the other abilities' activation")]
    pub(super) fn start_dash(&mut self, id: u32) -> Result<bool, i64> {
        let ticks = self.tuning.dash_ticks.min(255) as u8;
        let invulnerable = self.tuning.raw.dash.invulnerable;
        let tick = self.tick;
        let p = self.players.get_mut(&id).unwrap();
        let dir = if p.input_dir != 0 { p.input_dir } else { p.facing.max(1) };
        (p.dash_dir, p.dash_left, p.dash_portal, p.facing) = (dir, ticks, false, dir);
        if invulnerable {
            p.invulnerable_until = p.invulnerable_until.max(tick + u64::from(ticks));
        }
        let (x, y) = p.cell();
        self.stats.dashes += 1;
        self.ability_event(ab::DASH_STARTED, Audience::Near(x, y), &[i64::from(id), i64::from(dir), i64::from(x), i64::from(y)]);
        Ok(true)
    }

    /// One tick of a dash. Returns false if the player died on the way.
    pub(super) fn dash_step(&mut self, id: u32) -> bool {
        let dist = self.tuning.dash_step;
        let parts = (dist / SUB_STEP).ceil().max(1.0) as u32;
        let sub = dist / parts as f32;
        let mut ended = false;
        for _ in 0..parts {
            let me = &self.players[&id];
            let (dir, ghost) = (me.dash_dir, me.ghost(self.tick));
            let (sx, sy) = (me.x, me.y);
            let start_cell = me.cell();
            let (mut nx, mut ny) = (sx, sy);
            {
                let map = &self.map;
                let bomb_grid = &self.bomb_grid;
                let blocked = |cx: i32, cy: i32| {
                    let t = map.get(cx, cy);
                    t == Tile::Wall || t == Tile::Built || (!ghost && t.is_breakable()) || ((cx, cy) != start_cell && bomb_grid[map.idx(cx, cy)] != 0)
                };
                step_move(&mut nx, &mut ny, dir, sub, blocked);
            }
            if (nx, ny) == (sx, sy) {
                ended = true; // ran into something
                break;
            }
            let me = self.players.get_mut(&id).unwrap();
            (me.x, me.y, me.moving) = (nx, ny, true);
            let cell = me.cell();
            if cell == start_cell {
                continue;
            }
            // Entered a new cell: fire hurts as usual, gas clings, items
            // are picked up, and a portal may take the dash elsewhere.
            if let Some(owner) = self.flame_threat(id, cell.0, cell.1) {
                self.kill(id, Some(owner));
                return false;
            }
            self.gas_touch(id, cell.0, cell.1);
            let idx = self.map.idx(cell.0, cell.1);
            if let Some(item) = Item::from_u8(self.items[idx]) {
                self.set_item(cell.0, cell.1, 0);
                self.pick_up(id, item);
            }
            if !self.players[&id].dash_portal && self.portal_entry(id, true) {
                let me = self.players.get_mut(&id).unwrap();
                me.dash_portal = true;
                let exit = me.cell();
                if let Some(owner) = self.flame_threat(id, exit.0, exit.1) {
                    self.kill(id, Some(owner));
                    return false;
                }
            }
        }
        let p = self.players.get_mut(&id).unwrap();
        p.dash_left = if ended { 0 } else { p.dash_left.saturating_sub(1) };
        if p.dash_left == 0 {
            p.dash_portal = false;
            let (x, y) = p.cell();
            self.ability_event(ab::DASH_ENDED, Audience::Near(x, y), &[i64::from(id), i64::from(x), i64::from(y)]);
        }
        true
    }
}
