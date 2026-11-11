use super::mapgen::MapStyle;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum Tile {
    Floor = 0,
    Wall = 1,
    Crate = 2,
    /// Slippery: you keep sliding until you steer or hit something.
    Ice = 3,
    /// Conveyor belts carry players and bombs (up, right, down, left).
    ConveyorUp = 4,
    ConveyorRight = 5,
    ConveyorDown = 6,
    ConveyorLeft = 7,
    /// Teleporter pad, linked to exactly one other pad.
    Teleport = 8,
    /// Takes two blasts: the first turns it into a normal crate.
    Armored = 9,
    /// A temporary wall from the builder ability: solid to everything
    /// (ghosts too), stops blasts and gas, and crumbles in a blast.
    Built = 10,
}

impl Tile {
    #[must_use]
    pub fn from_u8(v: u8) -> Tile {
        match v {
            1 => Tile::Wall,
            2 => Tile::Crate,
            3 => Tile::Ice,
            4 => Tile::ConveyorUp,
            5 => Tile::ConveyorRight,
            6 => Tile::ConveyorDown,
            7 => Tile::ConveyorLeft,
            8 => Tile::Teleport,
            9 => Tile::Armored,
            10 => Tile::Built,
            _ => Tile::Floor,
        }
    }

    /// Direction code (1 up .. 4 left) a conveyor pushes in, or 0.
    #[must_use]
    pub fn conveyor_dir(self) -> u8 {
        match self {
            Tile::ConveyorUp => 1,
            Tile::ConveyorRight => 2,
            Tile::ConveyorDown => 3,
            Tile::ConveyorLeft => 4,
            _ => 0,
        }
    }

    #[must_use]
    pub fn is_breakable(self) -> bool {
        matches!(self, Tile::Crate | Tile::Armored)
    }
}

/// Map regions with their own look and features. The discriminants are
/// the region codes the browser uses.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Biome {
    Grass,
    /// Ice patches.
    Snow,
    /// Conveyor belts.
    Desert,
    /// Armored crates.
    Volcano,
    /// Dungeon flagstones and brick (the dungeon arena).
    Crypt,
}

/// A biome region centre, as fractions of the map size; a cell belongs to
/// the nearest centre. The welcome message sends these to the browser.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct BiomeSeed {
    pub x: f32,
    pub y: f32,
    pub biome: Biome,
}

/// The classic region layout, used by `Map::empty` (and by the browser when
/// a server sends no regions).
const DEFAULT_BIOMES: [(f32, f32, Biome); 5] = [
    (0.5, 0.5, Biome::Grass),
    (0.2, 0.2, Biome::Snow),
    (0.8, 0.2, Biome::Desert),
    (0.2, 0.8, Biome::Volcano),
    (0.8, 0.8, Biome::Grass),
];
/// Maps smaller than this get a single region: several would be too cramped.
pub const MIN_BIOME_SIZE: i32 = 41;

/// The static part of the world: walls, pillars, crates and special floors.
pub struct Map {
    pub w: i32,
    pub h: i32,
    tiles: Vec<Tile>,
    /// Linked teleporter pads.
    pub teleports: Vec<((i32, i32), (i32, i32))>,
    /// Region centres; no centres means the whole map is grass.
    pub biomes: Vec<BiomeSeed>,
    /// How the generator built this map (for logs and tests).
    pub style: MapStyle,
}

impl Map {
    /// Border walls and the classic pillar grid, with the classic regions.
    #[must_use]
    pub fn empty(w: i32, h: i32) -> Self {
        let biomes = if w < MIN_BIOME_SIZE || h < MIN_BIOME_SIZE {
            Vec::new()
        } else {
            DEFAULT_BIOMES.iter().map(|&(x, y, biome)| BiomeSeed { x, y, biome }).collect()
        };
        let mut map = Map {
            w,
            h,
            tiles: vec![Tile::Floor; (w * h) as usize],
            teleports: Vec::new(),
            biomes,
            style: MapStyle::default(),
        };
        for y in 0..h {
            for x in 0..w {
                if map.is_pillar_pos(x, y) {
                    map.set(x, y, Tile::Wall);
                }
            }
        }
        map
    }

    #[must_use]
    pub fn teleport_partner(&self, x: i32, y: i32) -> Option<(i32, i32)> {
        self.teleports.iter().find_map(|&(a, b)| {
            if a == (x, y) {
                Some(b)
            } else if b == (x, y) {
                Some(a)
            } else {
                None
            }
        })
    }

    #[must_use]
    pub fn biome(&self, x: i32, y: i32) -> Biome {
        let (fx, fy) = (x as f32 / self.w as f32, y as f32 / self.h as f32);
        let mut best = (f32::MAX, Biome::Grass);
        for s in &self.biomes {
            let d = (fx - s.x).powi(2) + (fy - s.y).powi(2);
            if d < best.0 {
                best = (d, s.biome);
            }
        }
        best.1
    }

    /// Border walls plus the classic grid of pillars on even coordinates.
    #[must_use]
    pub fn is_pillar_pos(&self, x: i32, y: i32) -> bool {
        x == 0 || y == 0 || x == self.w - 1 || y == self.h - 1 || (x % 2 == 0 && y % 2 == 0)
    }

    #[must_use]
    pub fn in_bounds(&self, x: i32, y: i32) -> bool {
        x >= 0 && y >= 0 && x < self.w && y < self.h
    }

    #[must_use]
    pub fn idx(&self, x: i32, y: i32) -> usize {
        (y * self.w + x) as usize
    }

    #[must_use]
    pub fn get(&self, x: i32, y: i32) -> Tile {
        if self.in_bounds(x, y) { self.tiles[self.idx(x, y)] } else { Tile::Wall }
    }

    pub fn set(&mut self, x: i32, y: i32, t: Tile) {
        let i = self.idx(x, y);
        self.tiles[i] = t;
    }

    /// Walls, built walls and crates of either kind block movement and blasts.
    #[must_use]
    pub fn is_solid(&self, x: i32, y: i32) -> bool {
        matches!(self.get(x, y), Tile::Wall | Tile::Crate | Tile::Armored | Tile::Built)
    }

    #[must_use]
    pub fn count(&self, t: Tile) -> usize {
        self.tiles.iter().filter(|&&v| v == t).count()
    }

    /// Counts non-solid cells reachable from (x, y) within 3 steps, the
    /// start included. A breadth-first search over a stack array: at most
    /// 25 cells are that close.
    #[must_use]
    pub fn open_cells_near(&self, x: i32, y: i32) -> usize {
        let mut seen = [(0i32, 0i32); 25];
        seen[0] = (x, y);
        let (mut len, mut start) = (1, 0);
        for _ in 0..3 {
            let end = len;
            for k in start..end {
                let (cx, cy) = seen[k];
                for (dx, dy) in [(0, -1), (1, 0), (0, 1), (-1, 0)] {
                    let c = (cx + dx, cy + dy);
                    if !self.is_solid(c.0, c.1) && !seen[..len].contains(&c) {
                        seen[len] = c;
                        len += 1;
                    }
                }
            }
            start = end;
        }
        len
    }

    /// An open cell (not a pad) with room to dodge a first bomb: the same
    /// map test the server applies when it spawns a player.
    #[must_use]
    pub fn is_spawn_spot(&self, x: i32, y: i32) -> bool {
        !self.is_solid(x, y) && self.get(x, y) != Tile::Teleport && self.open_cells_near(x, y) >= 4
    }

    /// True when every non-wall cell can reach every other one. Crates count
    /// as passable (they can be blasted), so this finds pockets sealed off
    /// by walls alone.
    #[must_use]
    pub fn is_connected(&self) -> bool {
        let Some(start) = self.tiles.iter().position(|&t| t != Tile::Wall) else {
            return true;
        };
        let mut seen = vec![false; self.tiles.len()];
        let mut stack = vec![start];
        seen[start] = true;
        let mut reached = 1;
        while let Some(i) = stack.pop() {
            let (x, y) = (i as i32 % self.w, i as i32 / self.w);
            for (dx, dy) in [(0, -1), (1, 0), (0, 1), (-1, 0)] {
                let (nx, ny) = (x + dx, y + dy);
                if self.get(nx, ny) == Tile::Wall {
                    continue;
                }
                let j = self.idx(nx, ny);
                if !seen[j] {
                    seen[j] = true;
                    reached += 1;
                    stack.push(j);
                }
            }
        }
        reached == self.tiles.len() - self.count(Tile::Wall)
    }

    /// How many spawn spots a map of this size must offer.
    #[must_use]
    pub fn spawn_target(w: i32, h: i32) -> usize {
        ((w * h) / 200).max(4) as usize
    }

    /// Checks the guarantees every playable map keeps: a solid border,
    /// open lane crossings (cells with two odd coordinates, used for hills,
    /// pads and emergency spawns), no wall-sealed pockets, teleport pads in
    /// linked pairs and enough safe spawn spots.
    ///
    /// # Errors
    /// Describes the first broken guarantee.
    pub fn validate(&self) -> Result<(), String> {
        for x in 0..self.w {
            for y in [0, self.h - 1] {
                if self.get(x, y) != Tile::Wall {
                    return Err(format!("border gap at ({x}, {y})"));
                }
            }
        }
        for y in 0..self.h {
            for x in [0, self.w - 1] {
                if self.get(x, y) != Tile::Wall {
                    return Err(format!("border gap at ({x}, {y})"));
                }
            }
        }
        for y in (1..self.h - 1).step_by(2) {
            for x in (1..self.w - 1).step_by(2) {
                if self.get(x, y) == Tile::Wall {
                    return Err(format!("lane crossing ({x}, {y}) is a wall"));
                }
            }
        }
        if !self.is_connected() {
            return Err("some open cells are walled off".into());
        }
        let mut pads = Vec::new();
        for &(a, b) in &self.teleports {
            if a == b {
                return Err(format!("teleport {a:?} is linked to itself"));
            }
            for p in [a, b] {
                if self.get(p.0, p.1) != Tile::Teleport {
                    return Err(format!("teleport {p:?} has no pad"));
                }
                if pads.contains(&p) {
                    return Err(format!("teleport {p:?} is in two pairs"));
                }
                pads.push(p);
            }
        }
        if pads.len() != self.count(Tile::Teleport) {
            return Err("a teleport pad has no partner".into());
        }
        let mut spots = 0;
        for y in 1..self.h - 1 {
            for x in 1..self.w - 1 {
                if self.is_spawn_spot(x, y) {
                    spots += 1;
                }
            }
        }
        let need = Self::spawn_target(self.w, self.h);
        if spots < need {
            return Err(format!("only {spots} spawn spots, need {need}"));
        }
        Ok(())
    }

    /// Run-length encoding of the tile grid as `(tile, run)` pairs, row-major.
    #[must_use]
    pub fn encode_rle(&self) -> Vec<(u8, u32)> {
        let mut out: Vec<(u8, u32)> = Vec::new();
        for &t in &self.tiles {
            match out.last_mut() {
                Some((v, n)) if *v == t as u8 => *n += 1,
                _ => out.push((t as u8, 1)),
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_map_is_the_classic_grid() {
        let m = Map::empty(15, 13);
        for x in 0..15 {
            assert_eq!(m.get(x, 0), Tile::Wall);
            assert_eq!(m.get(x, 12), Tile::Wall);
        }
        assert_eq!(m.get(2, 2), Tile::Wall);
        assert_ne!(m.get(1, 1), Tile::Wall);
        assert_eq!(m.get(-1, 3), Tile::Wall);
        assert_eq!(m.validate(), Ok(()));
    }

    #[test]
    fn empty_maps_use_the_classic_regions() {
        let m = Map::empty(81, 81);
        assert_eq!(m.biome(10, 10), Biome::Snow);
        assert_eq!(m.biome(70, 10), Biome::Desert);
        assert_eq!(m.biome(10, 70), Biome::Volcano);
        assert_eq!(m.biome(40, 40), Biome::Grass);
        assert_eq!(Map::empty(21, 21).biome(5, 5), Biome::Grass);
    }

    #[test]
    fn validate_catches_broken_maps() {
        let mut m = Map::empty(15, 15);
        m.set(0, 5, Tile::Floor);
        assert!(m.validate().unwrap_err().contains("border"));

        let mut m = Map::empty(15, 15);
        // Seal (1, 1) off with walls.
        m.set(2, 1, Tile::Wall);
        m.set(1, 2, Tile::Wall);
        assert!(m.validate().unwrap_err().contains("walled off"));

        let mut m = Map::empty(15, 15);
        m.set(3, 3, Tile::Teleport);
        assert!(m.validate().unwrap_err().contains("partner"));
    }
}
