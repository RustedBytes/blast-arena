use super::World;
use super::items::Item;
use super::map::Tile;
use super::player::DIRS;

pub const FUSE_TICKS: u64 = 50; // 2.5 s at 20 Hz
pub const FLAME_TICKS: u64 = 10; // 0.5 s
/// A kicked bomb advances one cell every this many ticks.
pub const SLIDE_TICKS: u64 = 3;

pub struct Bomb {
    pub id: u32,
    pub owner: u32,
    pub x: i32,
    pub y: i32,
    pub range: u8,
    /// Blast goes through crates (the owner had the pierce power-up).
    pub pierce: bool,
    pub explode_at: u64,
    /// Direction code of a kicked bomb, 0 when resting.
    pub slide_dir: u8,
    pub next_slide: u64,
}

pub struct Explosion {
    pub x: i32,
    pub y: i32,
    /// Arm lengths: up, right, down, left.
    pub arms: [u8; 4],
    pub until: u64,
}

impl World {
    pub fn bomb_at(&self, x: i32, y: i32) -> Option<u32> {
        if !self.map.in_bounds(x, y) {
            return None;
        }
        match self.bomb_grid[self.map.idx(x, y)] {
            0 => None,
            id => Some(id),
        }
    }

    pub fn flame_active(&self, x: i32, y: i32) -> bool {
        self.map.in_bounds(x, y) && self.flame_until[self.map.idx(x, y)] > self.tick
    }

    pub fn place_bomb(&mut self, owner: u32) -> bool {
        let Some(p) = self.players.get(&owner) else { return false };
        if !p.can_bomb(self.tick) {
            return false;
        }
        let (x, y) = p.cell();
        let (range, pierce) = (p.range, p.pierce);
        if self.map.is_solid(x, y) || self.bomb_at(x, y).is_some() {
            return false;
        }
        self.next_bomb_id = self.next_bomb_id.wrapping_add(1).max(1);
        let id = self.next_bomb_id;
        let explode_at = self.tick + FUSE_TICKS;
        self.bombs.insert(id, Bomb { id, owner, x, y, range, pierce, explode_at, slide_dir: 0, next_slide: 0 });
        let i = self.map.idx(x, y);
        self.bomb_grid[i] = id;
        if let Some(p) = self.players.get_mut(&owner) {
            p.active_bombs += 1;
        }
        true
    }

    /// Starts a bomb sliding away from the player who kicked it.
    pub fn kick_bomb(&mut self, id: u32, dir: u8) {
        if let Some(b) = self.bombs.get_mut(&id) {
            if b.slide_dir == 0 {
                b.slide_dir = dir;
                b.next_slide = self.tick + 1;
            }
        }
    }

    fn cell_blocks_slide(&self, x: i32, y: i32) -> bool {
        self.map.is_solid(x, y)
            || self.bomb_at(x, y).is_some()
            || self.players_in_rect(x, y, x, y).any(|p| p.alive && p.cell() == (x, y))
    }

    pub fn update_sliding_bombs(&mut self) {
        let mut sliding = std::mem::take(&mut self.scratch.bomb_ids);
        sliding.clear();
        sliding.extend(self.bombs.values().filter(|b| b.slide_dir != 0 && b.next_slide <= self.tick).map(|b| b.id));
        for &id in &sliding {
            let (x, y, dir) = {
                let b = &self.bombs[&id];
                (b.x, b.y, b.slide_dir)
            };
            let (dx, dy) = DIRS[dir as usize];
            let (nx, ny) = (x + dx, y + dy);
            if self.cell_blocks_slide(nx, ny) {
                self.bombs.get_mut(&id).unwrap().slide_dir = 0;
                continue;
            }
            let (oi, ni) = (self.map.idx(x, y), self.map.idx(nx, ny));
            self.bomb_grid[oi] = 0;
            self.bomb_grid[ni] = id;
            let b = self.bombs.get_mut(&id).unwrap();
            b.x = nx;
            b.y = ny;
            b.next_slide = self.tick + SLIDE_TICKS;
        }
        self.scratch.bomb_ids = sliding;
    }

    /// Detonates every bomb whose fuse ran out or that sits in fire.
    pub fn update_fuses(&mut self) {
        let mut due = std::mem::take(&mut self.scratch.bomb_ids);
        due.clear();
        due.extend(self.bombs.values().filter(|b| b.explode_at <= self.tick || self.flame_active(b.x, b.y)).map(|b| b.id));
        for &id in &due {
            self.explode(id);
        }
        self.scratch.bomb_ids = due;
    }

    /// Detonates a bomb and, transitively, every bomb its blast reaches.
    pub fn explode(&mut self, first: u32) {
        let mut queue = std::mem::take(&mut self.scratch.chain);
        let mut drops = std::mem::take(&mut self.scratch.drops);
        let mut cells = std::mem::take(&mut self.scratch.blast);
        queue.clear();
        drops.clear();
        queue.push(first);
        let flame_until = self.tick + FLAME_TICKS;

        while let Some(id) = queue.pop() {
            let Some(b) = self.bombs.remove(&id) else { continue };
            let ci = self.map.idx(b.x, b.y);
            self.bomb_grid[ci] = 0;
            if let Some(owner) = self.players.get_mut(&b.owner) {
                owner.active_bombs = owner.active_bombs.saturating_sub(1);
            }
            self.set_flame(b.x, b.y, b.owner, flame_until);

            cells.clear();
            self.trace_blast(b.x, b.y, b.range, true, b.pierce, |arm, r, x, y| cells.push((arm, r, x, y)));
            let mut arms = [0u8; 4];
            for &(arm, r, x, y) in &cells {
                arms[arm] = r;
                self.set_flame(x, y, b.owner, flame_until);
                if self.map.get(x, y) == Tile::Crate {
                    self.set_tile(x, y, Tile::Floor);
                    self.stats.crates_destroyed += 1;
                    if let Some(item) = Item::crate_drop(&mut self.rng) {
                        drops.push((x, y, item));
                    }
                } else if let Some(other) = self.bomb_at(x, y) {
                    queue.push(other);
                } else {
                    let i = self.map.idx(x, y);
                    self.items[i] = 0;
                }
            }
            self.explosions.push(Explosion { x: b.x, y: b.y, arms, until: flame_until });
        }

        // Items revealed by crates appear only after the whole chain resolved,
        // so a chained blast can't instantly destroy them.
        for &(x, y, item) in &drops {
            let i = self.map.idx(x, y);
            self.items[i] = item as u8;
        }
        self.scratch.chain = queue;
        self.scratch.drops = drops;
        self.scratch.blast = cells;
    }

    /// Walks the four arms of a blast centred at (x, y), calling
    /// `f(arm, distance, x, y)` for each cell the fire reaches. Walls stop an
    /// arm before their cell. A crate stops it on its cell unless `pierce`;
    /// another bomb always does, and so does an item when `items_block` (the
    /// AI passes false to stay pessimistic, since items may be picked up
    /// before the bomb goes off).
    pub fn trace_blast(&self, x: i32, y: i32, range: u8, items_block: bool, pierce: bool, mut f: impl FnMut(usize, u8, i32, i32)) {
        for arm in 0..4 {
            let (dx, dy) = DIRS[arm + 1];
            for r in 1..=range as i32 {
                let (cx, cy) = (x + dx * r, y + dy * r);
                match self.map.get(cx, cy) {
                    Tile::Wall => break,
                    Tile::Crate => {
                        f(arm, r as u8, cx, cy);
                        if !pierce {
                            break;
                        }
                    }
                    Tile::Floor => {
                        f(arm, r as u8, cx, cy);
                        let i = self.map.idx(cx, cy);
                        if self.bomb_grid[i] != 0 || (items_block && self.items[i] != 0) {
                            break;
                        }
                    }
                }
            }
        }
    }

    fn set_flame(&mut self, x: i32, y: i32, owner: u32, until: u64) {
        let i = self.map.idx(x, y);
        self.flame_until[i] = until;
        self.flame_owner[i] = owner;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::map::Map;
    use crate::game::test_world;

    #[test]
    fn blast_stops_at_pillar() {
        // The pillar at (2,2) blocks a blast travelling down column 2.
        let mut w = test_world(Map::empty(15, 15));
        let id = w.spawn_test_player(2.5, 1.5);
        w.players.get_mut(&id).unwrap().range = 5;
        assert!(w.place_bomb(id));
        let bid = w.bomb_at(2, 1).unwrap();
        w.explode(bid);
        assert!(!w.flame_active(2, 2), "pillar must stop the blast");
        assert!(w.flame_active(6, 1));
        assert!(!w.flame_active(8, 1), "range is 5");
        // The up arm is the border wall, so its length is 0.
        assert_eq!(w.explosions[0].arms[0], 0);
    }

    #[test]
    fn crate_absorbs_blast() {
        let mut map = Map::empty(15, 15);
        map.set(3, 1, Tile::Crate);
        let mut w = test_world(map);
        let id = w.spawn_test_player(1.5, 1.5);
        w.players.get_mut(&id).unwrap().range = 5;
        w.place_bomb(id);
        w.explode(w.bomb_at(1, 1).unwrap());
        assert_eq!(w.map.get(3, 1), Tile::Floor, "crate destroyed");
        assert!(w.flame_active(3, 1));
        assert!(!w.flame_active(4, 1), "crate absorbs the rest of the blast");
        assert_eq!(w.tile_changes, vec![(3, 1, Tile::Floor as u8)]);
    }

    #[test]
    fn pierce_blast_goes_through_crates() {
        let mut map = Map::empty(15, 15);
        map.set(3, 1, Tile::Crate);
        map.set(5, 1, Tile::Crate);
        let mut w = test_world(map);
        let id = w.spawn_test_player(1.5, 1.5);
        let p = w.players.get_mut(&id).unwrap();
        p.range = 5;
        p.pierce = true;
        w.place_bomb(id);
        w.explode(w.bomb_at(1, 1).unwrap());
        assert_eq!(w.map.get(3, 1), Tile::Floor);
        assert_eq!(w.map.get(5, 1), Tile::Floor, "second crate destroyed too");
        assert!(w.flame_active(6, 1), "blast continues past both crates");
        assert!(!w.flame_active(7, 1), "but not beyond its range");
    }

    #[test]
    fn chain_reaction() {
        let mut w = test_world(Map::empty(15, 15));
        let a = w.spawn_test_player(1.5, 1.5);
        let b = w.spawn_test_player(3.5, 1.5);
        w.place_bomb(a);
        w.place_bomb(b);
        let first = w.bomb_at(1, 1).unwrap();
        w.explode(first);
        assert!(w.bombs.is_empty(), "second bomb should be chained");
        assert_eq!(w.explosions.len(), 2);
        assert!(w.flame_active(5, 1));
        assert_eq!(w.players[&a].active_bombs, 0);
        assert_eq!(w.players[&b].active_bombs, 0);
    }

    #[test]
    fn blast_destroys_item_and_stops() {
        let mut w = test_world(Map::empty(15, 15));
        let i = w.map.idx(2, 1);
        w.items[i] = Item::Range as u8;
        let id = w.spawn_test_player(1.5, 1.5);
        w.players.get_mut(&id).unwrap().range = 4;
        w.place_bomb(id);
        w.explode(w.bomb_at(1, 1).unwrap());
        assert_eq!(w.items[i], 0);
        assert!(!w.flame_active(3, 1));
    }

    #[test]
    fn bomb_limit_respected() {
        let mut w = test_world(Map::empty(15, 15));
        let id = w.spawn_test_player(1.5, 1.5);
        assert!(w.place_bomb(id));
        w.players.get_mut(&id).unwrap().x = 3.5;
        assert!(!w.place_bomb(id), "only one bomb at base stats");
    }

    #[test]
    fn nobomb_curse_blocks_bombs() {
        let mut w = test_world(Map::empty(15, 15));
        let id = w.spawn_test_player(1.5, 1.5);
        w.players.get_mut(&id).unwrap().nobomb_until = w.tick + 10;
        assert!(!w.place_bomb(id));
        w.tick += 10;
        assert!(w.place_bomb(id), "curse wears off");
    }

    #[test]
    fn kicked_bomb_slides_until_blocked() {
        let mut map = Map::empty(15, 15);
        map.set(5, 1, Tile::Crate);
        let mut w = test_world(map);
        let id = w.spawn_test_player(1.5, 1.5);
        w.place_bomb(id);
        let bid = w.bomb_at(1, 1).unwrap();
        w.kick_bomb(bid, 2);
        for _ in 0..30 {
            w.tick += 1;
            w.update_sliding_bombs();
        }
        assert_eq!(w.bomb_at(4, 1), Some(bid));
        assert_eq!(w.bombs[&bid].slide_dir, 0);
    }
}
