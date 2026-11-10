//! Player movement: turns, ice, conveyors, teleporters, bomb kicks and
//! jumps over stone pillars.

use super::items::Item;
use super::map::Tile;
use super::player::{DIRS, JUMP_CELLS, JUMP_COOLDOWN_TICKS, JUMP_LANE_SLACK, JUMP_TICKS, Player, step_move};
use super::{CONVEYOR_SPEED, DT, SPAWN_SHIELD_TICKS, TELEPORT_COOLDOWN_TICKS, World};

impl World {
    pub(super) fn update_players(&mut self) {
        let mut ids = std::mem::take(&mut self.scratch.ids);
        ids.clear();
        ids.extend(self.players.keys().copied());
        ids.sort_unstable();
        for &id in &ids {
            let p = &self.players[&id];
            if !p.alive {
                if self.tick >= p.respawn_at {
                    let (x, y) = self.find_spawn();
                    let p = self.players.get_mut(&id).unwrap();
                    p.x = x as f32 + 0.5;
                    p.y = y as f32 + 0.5;
                    p.alive = true;
                    p.killed_by = None;
                    (p.jump_dir, p.jump_left) = (0, 0);
                    p.want_bomb = false;
                    p.invulnerable_until = self.tick + SPAWN_SHIELD_TICKS;
                }
                continue;
            }

            // A hop over a pillar takes the whole tick: no walking, and while
            // airborne nothing else happens (a bomb pressed mid-air drops on
            // landing).
            let jumped = self.update_jump(id);
            let p = &self.players[&id];
            if p.jump_left > 0 {
                continue;
            }
            let (mut dir, alt) = if jumped { (0, 0) } else { (p.input_dir, p.input_alt) };
            let start = (p.x, p.y);
            let start_cell = p.cell();
            let on = self.map.get(start_cell.0, start_cell.1);
            let dist = p.speed(self.tick) * DT;
            // On ice you can't stop: letting go keeps you sliding until you
            // steer, hit something or reach the end of the ice.
            if !jumped && dir == 0 && on == Tile::Ice && p.moving && p.slide_dir != 0 {
                dir = p.slide_dir;
            }
            let ghost = p.ghost(self.tick);
            let (mut x, mut y) = start;
            let mut used = dir;
            {
                let map = &self.map;
                let bomb_grid = &self.bomb_grid;
                // A bomb blocks unless it's in the cell the player stands in,
                // which lets players walk off a bomb they just dropped. Ghosts
                // pass through crates.
                let blocked = |cx: i32, cy: i32| {
                    let t = map.get(cx, cy);
                    (t == Tile::Wall || (!ghost && t.is_breakable()))
                        || ((cx, cy) != start_cell && bomb_grid[map.idx(cx, cy)] != 0)
                };
                if dir != 0 {
                    step_move(&mut x, &mut y, dir, dist, blocked);
                }
                // Turn buffering: if the newest direction is blocked, keep
                // going the way the still-held older key points until the
                // turn opens up.
                if (x, y) == start && alt != 0 && alt != dir {
                    step_move(&mut x, &mut y, alt, dist, blocked);
                    used = alt;
                }
                // Conveyors carry whoever stands on them.
                let belt = on.conveyor_dir();
                if belt != 0 && !jumped {
                    step_move(&mut x, &mut y, belt, CONVEYOR_SPEED * DT, blocked);
                }
            }
            let p = self.players.get_mut(&id).unwrap();
            let walked = (x, y) != start;
            p.moving = walked;
            if walked && used != 0 {
                p.facing = used;
                p.slide_dir = used;
            } else if dir != 0 {
                p.facing = dir;
            }
            p.x = x;
            p.y = y;
            let (mut cx, mut cy) = p.cell();

            // Teleporters: stepping onto a pad's centre moves you to its twin.
            if self.map.get(cx, cy) == Tile::Teleport && p.teleport_ready_at <= self.tick {
                let near_centre = (p.x - (cx as f32 + 0.5)).abs() + (p.y - (cy as f32 + 0.5)).abs() < 0.35;
                if let (true, Some((tx, ty))) = (near_centre, self.map.teleport_partner(cx, cy)) {
                    p.x = tx as f32 + 0.5;
                    p.y = ty as f32 + 0.5;
                    p.teleport_ready_at = self.tick + TELEPORT_COOLDOWN_TICKS;
                    (cx, cy) = (tx, ty);
                }
            }
            let has_kick = p.kick;
            let moving = p.moving;
            let want_act = std::mem::take(&mut p.want_act);

            // Kick: pressing into an adjacent bomb while standing at the
            // centre of the cell sends it sliding. A player boxed in by bombs
            // may kick even without the power-up, so they're never stuck.
            if dir != 0 && !moving && (has_kick || self.is_trapped(cx, cy)) {
                let (dx, dy) = DIRS[dir as usize];
                if let Some(b) = self.bomb_at(cx + dx, cy + dy) {
                    self.kick_bomb(b, dir);
                }
            }

            let i = self.map.idx(cx, cy);
            if let Some(item) = Item::from_u8(self.items[i]) {
                self.set_item(cx, cy, 0);
                self.pick_up(id, item);
            }

            if want_act {
                self.act(id);
            }
            if std::mem::take(&mut self.players.get_mut(&id).unwrap().want_bomb) {
                self.place_bomb(id);
            }
        }
        self.scratch.ids = ids;
    }

    /// Starts a jump if the jump key is held and one is possible, and moves
    /// a jumping player along the hop. Returns whether this tick was spent
    /// jumping (the player may have just landed).
    fn update_jump(&mut self, id: u32) -> bool {
        let tick = self.tick;
        let p = &self.players[&id];
        if p.jump_left == 0 {
            if !p.input_jump || tick < p.jump_ready_at {
                return false;
            }
            let dir = if p.input_dir != 0 { p.input_dir } else { p.facing };
            if self.jump_landing(p, dir).is_none() {
                return false;
            }
            let (cx, cy) = p.cell();
            let p = self.players.get_mut(&id).unwrap();
            // Take off from the centre of the cell.
            (p.x, p.y) = (cx as f32 + 0.5, cy as f32 + 0.5);
            (p.jump_dir, p.jump_left, p.facing) = (dir, JUMP_TICKS, dir);
        }
        let p = self.players.get_mut(&id).unwrap();
        let (dx, dy) = DIRS[p.jump_dir as usize];
        let step = JUMP_CELLS / f32::from(JUMP_TICKS);
        p.x += dx as f32 * step;
        p.y += dy as f32 * step;
        p.jump_left -= 1;
        p.moving = true;
        if p.jump_left == 0 {
            // Land exactly on the centre of the cell behind the pillar.
            (p.x, p.y) = (p.x.floor() + 0.5, p.y.floor() + 0.5);
            p.jump_dir = 0;
            p.moving = false;
            p.jump_ready_at = tick + JUMP_COOLDOWN_TICKS;
        }
        true
    }

    /// Where a jump from `p`'s cell towards `dir` lands: over a stone pillar
    /// right next to the player into a free cell (no crate, pillar or bomb)
    /// on the map. `None` if there's no such jump, or the player is too far
    /// off the lane.
    #[must_use]
    pub fn jump_landing(&self, p: &Player, dir: u8) -> Option<(i32, i32)> {
        if !(1..=4).contains(&dir) {
            return None;
        }
        let (dx, dy) = DIRS[dir as usize];
        let (cx, cy) = p.cell();
        let off = if dx != 0 { p.y - (cy as f32 + 0.5) } else { p.x - (cx as f32 + 0.5) };
        if off.abs() > JUMP_LANE_SLACK {
            return None;
        }
        let (wx, wy) = (cx + dx, cy + dy);
        let (lx, ly) = (cx + 2 * dx, cy + 2 * dy);
        let over_stone = self.map.in_bounds(wx, wy) && self.map.get(wx, wy) == Tile::Wall;
        let free = self.map.in_bounds(lx, ly) && !self.map.is_solid(lx, ly) && self.bomb_at(lx, ly).is_none();
        (over_stone && free).then_some((lx, ly))
    }

    /// True when every neighbouring cell is blocked and at least one of
    /// them by a bomb, i.e. the player can't walk away from (x, y).
    pub(super) fn is_trapped(&self, x: i32, y: i32) -> bool {
        let mut bomb_blocked = false;
        for &(dx, dy) in &DIRS[1..] {
            let (nx, ny) = (x + dx, y + dy);
            if self.bomb_at(nx, ny).is_some() {
                bomb_blocked = true;
            } else if !self.map.is_solid(nx, ny) {
                return false;
            }
        }
        bomb_blocked
    }
}
