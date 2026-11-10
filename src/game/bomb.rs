use super::World;
use super::items::Item;
use super::map::Tile;
use super::player::{DIRS, Player};

pub const FUSE_TICKS: u64 = 50; // 2.5 s at 20 Hz
pub const FLAME_TICKS: u64 = 10; // 0.5 s
/// A kicked bomb advances one cell every this many ticks.
pub const SLIDE_TICKS: u64 = 3;
/// Conveyors move a resting bomb one cell every this many ticks.
pub const CONVEYOR_TICKS: u64 = 8;
/// A remote bomb still goes off on its own after this long.
pub const REMOTE_SAFETY_TICKS: u64 = 200;
/// How far a punched bomb flies before looking for a landing spot.
pub const PUNCH_DISTANCE: i32 = 3;
/// Longest line a line bomb lays.
const MAX_LINE: i32 = 8;
const RAIN_BOMBS: usize = 6;
const RAIN_FUSE_TICKS: u64 = 40;
/// Atomic bomb: blast radius in cells (a disc, not a cross), fuse, how long
/// each cell burns once the shockwave reaches it, and how long clients get
/// to show the mushroom cloud.
pub const NUKE_RADIUS: u8 = 6;
pub const NUKE_FUSE_TICKS: u64 = 70; // 3.5 s
pub const NUKE_FLAME_TICKS: u64 = 16;
pub const NUKE_SHOW_TICKS: u64 = 60; // 3 s
/// The shockwave expands this many cells per tick.
pub const NUKE_WAVE_SPEED: f32 = 1.0;

#[allow(clippy::struct_excessive_bools, reason = "independent kinds of bomb a power-up can make")]
pub struct Bomb {
    pub id: u32,
    pub owner: u32,
    pub x: i32,
    pub y: i32,
    pub range: u8,
    /// Blast goes through crates (the owner had the pierce power-up).
    pub pierce: bool,
    /// Waits for the owner's action key (or the safety timer).
    pub remote: bool,
    /// An atomic bomb: a disc of fire of `NUKE_RADIUS` that walls don't stop.
    pub nuke: bool,
    /// The blast leaves ice on the floor (freeze power-up).
    pub freeze: bool,
    /// A rocket: slides every tick and blows up when it hits something.
    pub rocket: bool,
    /// Counts towards the owner's bomb limit (gadget bombs don't).
    pub counted: bool,
    pub explode_at: u64,
    /// Direction code of a kicked bomb, 0 when resting.
    pub slide_dir: u8,
    pub next_slide: u64,
}

/// What a newly placed bomb is like.
#[derive(Clone, Copy)]
#[allow(clippy::struct_excessive_bools, reason = "independent kinds of bomb a power-up can make")]
pub struct BombKind {
    pub range: u8,
    pub pierce: bool,
    pub remote: bool,
    pub nuke: bool,
    pub freeze: bool,
    pub rocket: bool,
    /// Counts towards the owner's bomb limit.
    pub counted: bool,
    /// Ticks until it explodes (remote bombs use their safety timer instead).
    pub fuse: u64,
}

impl BombKind {
    /// A bomb as `p` would drop it: an atomic bomb (on its own long fuse,
    /// never remote) while they carry one, otherwise a normal one.
    #[must_use]
    pub fn of(p: &Player) -> Self {
        if p.nukes > 0 {
            let base = Self::plain(NUKE_RADIUS, NUKE_FUSE_TICKS);
            return Self { pierce: true, nuke: true, ..base };
        }
        Self { pierce: p.pierce, remote: p.remote, freeze: p.freeze, ..Self::plain(p.range, FUSE_TICKS) }
    }

    /// A plain bomb (bomb rain, tests).
    #[must_use]
    pub fn plain(range: u8, fuse: u64) -> Self {
        Self { range, pierce: false, remote: false, nuke: false, freeze: false, rocket: false, counted: true, fuse }
    }

    /// A bomb from a gadget (drone, mine, rocket): not counted towards the
    /// owner's bomb limit.
    #[must_use]
    pub fn gadget(range: u8, fuse: u64) -> Self {
        Self { counted: false, ..Self::plain(range, fuse) }
    }
}

/// The shape of a bomb's blast: a cross of `range` (through crates with
/// `pierce`), or an atomic disc.
#[derive(Clone, Copy)]
pub struct Blast {
    pub range: u8,
    pub pierce: bool,
    pub nuke: bool,
}

pub struct Explosion {
    pub x: i32,
    pub y: i32,
    /// Arm lengths: up, right, down, left (all 0 for an atomic blast).
    pub arms: [u8; 4],
    /// Radius of an atomic blast, 0 for a normal one.
    pub nuke: u8,
    pub until: u64,
}

impl World {
    #[must_use]
    pub fn bomb_at(&self, x: i32, y: i32) -> Option<u32> {
        if !self.map.in_bounds(x, y) {
            return None;
        }
        match self.bomb_grid[self.map.idx(x, y)] {
            0 => None,
            id => Some(id),
        }
    }

    #[must_use]
    pub fn flame_active(&self, x: i32, y: i32) -> bool {
        if !self.map.in_bounds(x, y) {
            return false;
        }
        let i = self.map.idx(x, y);
        self.flame_from[i] <= self.tick && self.flame_until[i] > self.tick
    }

    /// The bomb button: drops a bomb where the player stands, or, with the
    /// line-bomb power-up while standing on their own bomb, lays the rest of
    /// their bombs in a line ahead.
    pub fn place_bomb(&mut self, owner: u32) -> bool {
        let Some(p) = self.players.get(&owner) else { return false };
        if !p.can_bomb(self.tick) {
            return false;
        }
        let (x, y) = p.cell();
        let (kind, line, facing) = (BombKind::of(p), p.line, p.facing);
        if let Some(b) = self.bomb_at(x, y) {
            if line && self.bombs[&b].owner == owner {
                return self.line_bombs(owner, x, y, facing);
            }
            return false;
        }
        self.place_bomb_at(owner, (x, y), kind)
    }

    /// Places a bomb at a free cell. `owner` 0 means nobody (bomb rain).
    pub fn place_bomb_at(&mut self, owner: u32, (x, y): (i32, i32), kind: BombKind) -> bool {
        if self.map.is_solid(x, y) || self.bomb_at(x, y).is_some() {
            return false;
        }
        self.next_bomb_id = self.next_bomb_id.wrapping_add(1).max(1);
        let id = self.next_bomb_id;
        let BombKind { range, pierce, remote, nuke, freeze, rocket, counted, fuse } = kind;
        let explode_at = self.tick + if remote { REMOTE_SAFETY_TICKS } else { fuse };
        let bomb = Bomb { id, owner, x, y, range, pierce, remote, nuke, freeze, rocket, counted, explode_at, slide_dir: 0, next_slide: 0 };
        self.bombs.insert(id, bomb);
        let i = self.map.idx(x, y);
        self.bomb_grid[i] = id;
        if let Some(p) = self.players.get_mut(&owner).filter(|_| counted) {
            p.active_bombs += 1;
            if nuke {
                p.nukes = p.nukes.saturating_sub(1);
            }
        }
        true
    }

    /// Lays the owner's remaining bombs in consecutive free cells ahead.
    fn line_bombs(&mut self, owner: u32, x: i32, y: i32, dir: u8) -> bool {
        let (dx, dy) = DIRS[dir as usize];
        let mut placed = false;
        for k in 1..=MAX_LINE {
            let p = &self.players[&owner];
            if !p.can_bomb(self.tick) {
                break;
            }
            let kind = BombKind::of(p);
            if !self.place_bomb_at(owner, (x + dx * k, y + dy * k), kind) {
                break;
            }
            placed = true;
        }
        placed
    }

    /// The action key: detonates the player's remote bombs if they have any
    /// out, otherwise punches the bomb in front of them (with the power-up).
    pub fn act(&mut self, id: u32) {
        let Some(p) = self.players.get(&id) else { return };
        if !p.alive {
            return;
        }
        let tick = self.tick;
        let mut detonated = false;
        for b in self.bombs.values_mut() {
            if b.owner == id && b.remote && !b.nuke {
                b.explode_at = tick;
                detonated = true;
            }
        }
        if detonated || !p.punch {
            return;
        }
        let (cx, cy) = p.cell();
        let dir = p.facing;
        let (dx, dy) = DIRS[dir as usize];
        if let Some(b) = self.bomb_at(cx + dx, cy + dy) {
            self.punch_bomb(b, dir);
        }
    }

    /// Throws a bomb over obstacles: it lands `PUNCH_DISTANCE` cells away, or
    /// further on if that cell is taken. Bombs can't leave the map.
    ///
    /// # Panics
    /// If `id` is not a live bomb.
    pub fn punch_bomb(&mut self, id: u32, dir: u8) -> bool {
        let (x, y) = {
            let b = &self.bombs[&id];
            (b.x, b.y)
        };
        let (dx, dy) = DIRS[dir as usize];
        for k in PUNCH_DISTANCE..PUNCH_DISTANCE + 6 {
            let (nx, ny) = (x + dx * k, y + dy * k);
            if !self.map.in_bounds(nx, ny) {
                return false;
            }
            if !self.map.is_solid(nx, ny) && self.bomb_at(nx, ny).is_none() {
                let (oi, ni) = (self.map.idx(x, y), self.map.idx(nx, ny));
                self.bomb_grid[oi] = 0;
                self.bomb_grid[ni] = id;
                let b = self.bombs.get_mut(&id).unwrap();
                (b.x, b.y, b.slide_dir) = (nx, ny, 0);
                return true;
            }
        }
        false
    }

    /// Bomb rain from a secret box: ownerless bombs around (x, y).
    pub fn bomb_rain(&mut self, x: i32, y: i32) {
        let mut placed = 0;
        for _ in 0..40 {
            if placed >= RAIN_BOMBS {
                break;
            }
            let (bx, by) = (x + self.rng.between(-4, 4), y + self.rng.between(-4, 4));
            if (bx, by) == (x, y) || !self.map.in_bounds(bx, by) {
                continue;
            }
            let fuse = RAIN_FUSE_TICKS + u64::from(self.rng.below(20));
            if self.place_bomb_at(0, (bx, by), BombKind::plain(2, fuse)) {
                placed += 1;
            }
        }
    }

    /// Starts a bomb sliding away from the player who kicked it.
    pub fn kick_bomb(&mut self, id: u32, dir: u8) {
        if let Some(b) = self.bombs.get_mut(&id)
            && b.slide_dir == 0 {
                b.slide_dir = dir;
                b.next_slide = self.tick + 1;
            }
    }

    fn cell_blocks_slide(&self, x: i32, y: i32) -> bool {
        self.map.is_solid(x, y)
            || self.bomb_at(x, y).is_some()
            || self.players_in_rect(x, y, x, y).any(|p| p.alive && p.cell() == (x, y))
    }

    /// Moves kicked bombs, and resting bombs that sit on conveyor belts.
    ///
    /// # Panics
    /// Never: it only touches bombs it has just collected from the map.
    pub fn update_sliding_bombs(&mut self) {
        let mut sliding = std::mem::take(&mut self.scratch.bomb_ids);
        sliding.clear();
        let map = &self.map;
        sliding.extend(
            self.bombs
                .values()
                .filter(|b| b.next_slide <= self.tick && (b.slide_dir != 0 || map.get(b.x, b.y).conveyor_dir() != 0))
                .map(|b| b.id),
        );
        for &id in &sliding {
            let (x, y, kicked) = {
                let b = &self.bombs[&id];
                (b.x, b.y, b.slide_dir)
            };
            let dir = if kicked != 0 { kicked } else { self.map.get(x, y).conveyor_dir() };
            let (dx, dy) = DIRS[dir as usize];
            let (nx, ny) = (x + dx, y + dy);
            if self.cell_blocks_slide(nx, ny) {
                let tick = self.tick;
                let b = self.bombs.get_mut(&id).unwrap();
                if b.rocket {
                    // A rocket blows up on impact.
                    b.explode_at = tick;
                    continue;
                }
                b.slide_dir = 0;
                b.next_slide = self.tick + CONVEYOR_TICKS;
                continue;
            }
            let (oi, ni) = (self.map.idx(x, y), self.map.idx(nx, ny));
            self.bomb_grid[oi] = 0;
            self.bomb_grid[ni] = id;
            let b = self.bombs.get_mut(&id).unwrap();
            b.x = nx;
            b.y = ny;
            b.next_slide = self.tick + if b.rocket { 1 } else if kicked != 0 { SLIDE_TICKS } else { CONVEYOR_TICKS };
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
            if let Some(owner) = self.players.get_mut(&b.owner).filter(|_| b.counted) {
                owner.active_bombs = owner.active_bombs.saturating_sub(1);
            }
            if b.nuke {
                self.detonate_nuke(&b, &mut queue);
                continue;
            }
            self.set_flame(b.x, b.y, b.owner, self.tick, flame_until);

            cells.clear();
            self.trace_blast(b.x, b.y, b.range, true, b.pierce, |arm, r, x, y| cells.push((arm, r, x, y)));
            let mut arms = [0u8; 4];
            for &(arm, r, x, y) in &cells {
                arms[arm] = r;
                self.set_flame(x, y, b.owner, self.tick, flame_until);
                match self.map.get(x, y) {
                    Tile::Crate => {
                        self.set_tile(x, y, Tile::Floor);
                        self.stats.crates_destroyed += 1;
                        if let Some(item) = Item::crate_drop(&mut self.rng) {
                            drops.push((x, y, item));
                        }
                    }
                    // Armor absorbs one blast and leaves a normal crate.
                    Tile::Armored => self.set_tile(x, y, Tile::Crate),
                    _ => {
                        if let Some(other) = self.bomb_at(x, y) {
                            queue.push(other);
                        } else {
                            self.set_item(x, y, 0);
                        }
                    }
                }
            }
            self.explosions.push(Explosion { x: b.x, y: b.y, arms, nuke: 0, until: flame_until });
            if b.freeze {
                self.freeze_cell(b.x, b.y);
                for &(_, _, x, y) in &cells {
                    self.freeze_cell(x, y);
                }
            }
        }

        // Items revealed by crates appear only after the whole chain resolved,
        // so a chained blast can't instantly destroy them.
        for &(x, y, item) in &drops {
            self.set_item(x, y, item as u8);
        }
        self.scratch.chain = queue;
        self.scratch.drops = drops;
        self.scratch.blast = cells;
    }

    /// An atomic blast: a shockwave of fire expands over a disc of
    /// `NUKE_RADIUS`, one cell per tick. Nothing shelters from it: the fire
    /// reaches cells behind pillars, vaporizes crates (armored ones too, and
    /// with nothing left to drop) and items, and sets off every bomb in
    /// reach when the wave gets there.
    fn detonate_nuke(&mut self, b: &Bomb, queue: &mut Vec<u32>) {
        let tick = self.tick;
        self.stats.nukes += 1;
        let mut cells = std::mem::take(&mut self.scratch.nuke_cells);
        cells.clear();
        self.nuke_cells(b.x, b.y, NUKE_RADIUS, |x, y, delay| cells.push((x, y, delay)));
        for &(x, y, delay) in &cells {
            let from = tick + u64::from(delay);
            self.set_flame(x, y, b.owner, from, from + NUKE_FLAME_TICKS);
            match self.map.get(x, y) {
                Tile::Crate | Tile::Armored => {
                    self.set_tile(x, y, Tile::Floor);
                    self.stats.crates_destroyed += 1;
                }
                _ => {
                    self.set_item(x, y, 0);
                    if let Some(other) = self.bomb_at(x, y) {
                        if delay == 0 {
                            queue.push(other);
                        } else if let Some(o) = self.bombs.get_mut(&other) {
                            // It goes off when the wave arrives.
                            o.remote = false;
                            o.explode_at = o.explode_at.min(from);
                        }
                    }
                }
            }
        }
        self.scratch.nuke_cells = cells;
        self.explosions.push(Explosion { x: b.x, y: b.y, arms: [0; 4], nuke: NUKE_RADIUS, until: tick + NUKE_SHOW_TICKS });
    }

    /// Cells of an atomic blast of `radius` centred at (x, y), the centre
    /// included, with the ticks the shockwave takes to reach each:
    /// `f(x, y, delay)`. A round disc; walls themselves never burn.
    pub fn nuke_cells(&self, x: i32, y: i32, radius: u8, mut f: impl FnMut(i32, i32, u16)) {
        let r = i32::from(radius);
        for dy in -r..=r {
            for dx in -r..=r {
                let d2 = dx * dx + dy * dy;
                if d2 > r * r + r {
                    continue;
                }
                let (cx, cy) = (x + dx, y + dy);
                if !self.map.in_bounds(cx, cy) || self.map.get(cx, cy) == Tile::Wall {
                    continue;
                }
                f(cx, cy, ((d2 as f32).sqrt() / NUKE_WAVE_SPEED) as u16);
            }
        }
    }

    /// Every cell a bomb's fire reaches, excluding its own cell, with the
    /// ticks after detonation it catches fire: the cross of `trace_blast`
    /// (all at once), or an atomic disc (as the shockwave arrives).
    pub fn blast_footprint(&self, (x, y): (i32, i32), blast: Blast, items_block: bool, mut f: impl FnMut(i32, i32, u16)) {
        let Blast { range, pierce, nuke } = blast;
        if nuke {
            self.nuke_cells(x, y, NUKE_RADIUS, |cx, cy, d| {
                if (cx, cy) != (x, y) {
                    f(cx, cy, d);
                }
            });
        } else {
            self.trace_blast(x, y, range, items_block, pierce, |_, _, cx, cy| f(cx, cy, 0));
        }
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
            for r in 1..=i32::from(range) {
                let (cx, cy) = (x + dx * r, y + dy * r);
                match self.map.get(cx, cy) {
                    Tile::Wall => break,
                    Tile::Crate | Tile::Armored => {
                        f(arm, r as u8, cx, cy);
                        if !pierce {
                            break;
                        }
                    }
                    _ => {
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

    /// Fire in a cell from tick `from` until `until`. Overlapping fire
    /// merges into one continuous window; the newest blast owns the cell.
    pub(super) fn set_flame(&mut self, x: i32, y: i32, owner: u32, from: u64, until: u64) {
        let i = self.map.idx(x, y);
        if self.flame_until[i] > self.tick {
            self.flame_from[i] = self.flame_from[i].min(from);
            self.flame_until[i] = self.flame_until[i].max(until);
        } else {
            self.flame_from[i] = from;
            self.flame_until[i] = until;
        }
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

    #[test]
    fn armored_crate_takes_two_blasts() {
        let mut map = Map::empty(15, 15);
        map.set(3, 1, Tile::Armored);
        let mut w = test_world(map);
        let id = w.spawn_test_player(1.5, 1.5);
        w.place_bomb(id);
        w.explode(w.bomb_at(1, 1).unwrap());
        assert_eq!(w.map.get(3, 1), Tile::Crate, "first blast strips the armor");
        w.tick += 20;
        w.place_bomb(id);
        w.explode(w.bomb_at(1, 1).unwrap());
        assert_eq!(w.map.get(3, 1), Tile::Floor, "second blast destroys it");
    }

    #[test]
    fn remote_bombs_wait_for_the_action_key() {
        let mut w = test_world(Map::empty(15, 15));
        let id = w.spawn_test_player(1.5, 1.5);
        w.players.get_mut(&id).unwrap().remote = true;
        w.place_bomb(id);
        w.tick += FUSE_TICKS + 5;
        w.update_fuses();
        assert_eq!(w.bombs.len(), 1, "a remote bomb ignores the normal fuse");
        w.act(id);
        w.update_fuses();
        assert!(w.bombs.is_empty(), "the action key detonates it");
    }

    #[test]
    fn line_bomb_lays_remaining_bombs_ahead() {
        let mut w = test_world(Map::empty(15, 15));
        let id = w.spawn_test_player(1.5, 1.5);
        let p = w.players.get_mut(&id).unwrap();
        (p.line, p.max_bombs, p.facing) = (true, 4, 2);
        assert!(w.place_bomb(id));
        assert!(w.place_bomb(id), "pressing again on the bomb lays a line");
        let cells: Vec<_> = (1..=4).map(|x| w.bomb_at(x, 1).is_some()).collect();
        assert_eq!(cells, [true, true, true, true]);
        assert_eq!(w.players[&id].active_bombs, 4);
    }

    #[test]
    fn punched_bomb_flies_over_obstacles() {
        let mut map = Map::empty(15, 15);
        map.set(3, 1, Tile::Crate);
        let mut w = test_world(map);
        let other = w.spawn_test_player(2.5, 1.5);
        w.place_bomb(other);
        w.players.get_mut(&other).unwrap().x = 9.5;
        let me = w.spawn_test_player(1.5, 1.5);
        let p = w.players.get_mut(&me).unwrap();
        (p.punch, p.facing) = (true, 2);
        w.act(me);
        assert!(w.bomb_at(2, 1).is_none());
        assert!(w.bomb_at(5, 1).is_some(), "lands three cells on, past the crate");
    }

    /// A world with a player at (7, 7) carrying an atomic bomb.
    fn nuke_world() -> (World, u32) {
        let mut w = test_world(Map::empty(21, 21));
        let id = w.spawn_test_player(7.5, 7.5);
        World::grant(w.players.get_mut(&id).unwrap(), Item::Nuke, 0);
        (w, id)
    }

    #[test]
    fn nuke_power_up_arms_the_next_bomb_only() {
        let (mut w, id) = nuke_world();
        assert_eq!(w.players[&id].nukes, 1);
        w.players.get_mut(&id).unwrap().max_bombs = 2;
        assert!(w.place_bomb(id));
        let b = &w.bombs[&w.bomb_at(7, 7).unwrap()];
        assert!(b.nuke && !b.remote);
        assert_eq!(b.explode_at, w.tick + NUKE_FUSE_TICKS);
        assert_eq!(w.players[&id].nukes, 0, "the charge is used up");
        w.players.get_mut(&id).unwrap().x = 9.5;
        assert!(w.place_bomb(id));
        assert!(!w.bombs[&w.bomb_at(9, 7).unwrap()].nuke, "the next bomb is normal again");
    }

    #[test]
    fn nuke_vaporizes_a_disc_through_cover() {
        let mut map = Map::empty(21, 21);
        map.set(11, 11, Tile::Armored); // diagonal: no cross-shaped blast gets here
        map.set(7, 13, Tile::Crate); // 6 cells away: inside the disc
        map.set(7, 15, Tile::Crate); // 8 cells away: outside
        let mut w = test_world(map);
        let id = w.spawn_test_player(7.5, 7.5);
        World::grant(w.players.get_mut(&id).unwrap(), Item::Nuke, 0);
        w.set_item(9, 9, Item::Range as u8);
        w.place_bomb(id);
        w.explode(w.bomb_at(7, 7).unwrap());
        assert_eq!(w.map.get(11, 11), Tile::Floor, "armor is no protection");
        assert_eq!(w.map.get(7, 13), Tile::Floor);
        assert_eq!(w.map.get(7, 15), Tile::Crate, "beyond the radius");
        assert_eq!(w.map.get(8, 8), Tile::Wall, "pillars stand");
        assert_eq!(w.items[w.map.idx(9, 9)], 0, "items vaporized");
        assert!(w.items.iter().all(|&i| i == 0), "vaporized crates drop nothing");
        let e = &w.explosions[0];
        assert_eq!((e.nuke, e.arms), (NUKE_RADIUS, [0; 4]));
    }

    #[test]
    fn nuke_shockwave_expands_and_kills() {
        let (mut w, id) = nuke_world();
        let far = w.spawn_test_player(12.5, 7.5); // 5 cells east
        w.place_bomb(id);
        w.players.get_mut(&id).unwrap().invulnerable_until = u64::MAX;
        w.explode(w.bomb_at(7, 7).unwrap());
        assert!(w.flame_active(7, 7), "ground zero burns at once");
        assert!(!w.flame_active(8, 7), "neighbours a tick later");
        assert!(!w.flame_active(12, 7), "the wave hasn't arrived yet");
        w.apply_flame_damage();
        assert!(w.players[&far].alive);
        w.tick += 5;
        assert!(w.flame_active(12, 7));
        assert!(w.flame_active(9, 9), "behind the pillar at (8, 8) too");
        w.apply_flame_damage();
        assert!(!w.players[&far].alive, "caught by the shockwave");
        w.tick += NUKE_FLAME_TICKS + 1;
        assert!(!w.flame_active(7, 7), "the fire dies down");
    }

    #[test]
    fn nuke_sets_off_bombs_as_the_wave_arrives() {
        let (mut w, id) = nuke_world();
        let other = w.spawn_test_player(11.5, 7.5); // 4 cells east
        w.place_bomb(other);
        w.place_bomb(id);
        let t = w.tick;
        w.explode(w.bomb_at(7, 7).unwrap());
        let b = &w.bombs[&w.bomb_at(11, 7).unwrap()];
        assert_eq!(b.explode_at, t + 4);
    }

    #[test]
    fn danger_map_sees_the_atomic_disc() {
        let (mut w, id) = nuke_world();
        w.place_bomb(id);
        let d = w.danger_map();
        assert_eq!(d[w.map.idx(7, 7)], NUKE_FUSE_TICKS as u16);
        assert_eq!(d[w.map.idx(12, 7)], NUKE_FUSE_TICKS as u16 + 5, "the wave takes 5 ticks to get there");
        assert_eq!(d[w.map.idx(11, 11)], NUKE_FUSE_TICKS as u16 + 5, "diagonals burn too");
        assert_eq!(d[w.map.idx(7, 15)], crate::game::ai::SAFE);
    }

    #[test]
    fn conveyors_carry_resting_bombs() {
        let mut map = Map::empty(15, 15);
        for x in 1..6 {
            map.set(x, 1, Tile::ConveyorRight);
        }
        let mut w = test_world(map);
        let id = w.spawn_test_player(1.5, 1.5);
        w.place_bomb(id);
        w.players.get_mut(&id).unwrap().y = 3.5;
        for _ in 0..=CONVEYOR_TICKS * 2 {
            w.tick += 1;
            w.update_sliding_bombs();
        }
        assert!(w.bomb_at(4, 1).is_some(), "carried three cells");
    }
}
