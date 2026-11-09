use super::rng::Rng;

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
}

impl Tile {
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
            _ => Tile::Floor,
        }
    }

    /// Direction code (1 up .. 4 left) a conveyor pushes in, or 0.
    pub fn conveyor_dir(self) -> u8 {
        match self {
            Tile::ConveyorUp => 1,
            Tile::ConveyorRight => 2,
            Tile::ConveyorDown => 3,
            Tile::ConveyorLeft => 4,
            _ => 0,
        }
    }

    pub fn is_breakable(self) -> bool {
        matches!(self, Tile::Crate | Tile::Armored)
    }
}

/// Map regions with their own look and features.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Biome {
    Grass,
    /// Ice patches.
    Snow,
    /// Conveyor belts.
    Desert,
    /// Armored crates.
    Volcano,
}

/// Biome region centres as fractions of the map size; a cell belongs to
/// the nearest one. The browser client uses the same table.
const BIOME_SEEDS: [(f32, f32, Biome); 5] = [
    (0.5, 0.5, Biome::Grass),
    (0.2, 0.2, Biome::Snow),
    (0.8, 0.2, Biome::Desert),
    (0.2, 0.8, Biome::Volcano),
    (0.8, 0.8, Biome::Grass),
];
/// Maps smaller than this are all grass: regions would be too cramped.
const MIN_BIOME_SIZE: i32 = 41;

/// The static part of the world: walls, pillars, crates and special floors.
pub struct Map {
    pub w: i32,
    pub h: i32,
    tiles: Vec<Tile>,
    /// Linked teleporter pads.
    pub teleports: Vec<((i32, i32), (i32, i32))>,
}

impl Map {
    pub fn empty(w: i32, h: i32) -> Self {
        let mut map = Map { w, h, tiles: vec![Tile::Floor; (w * h) as usize], teleports: Vec::new() };
        for y in 0..h {
            for x in 0..w {
                if map.is_pillar_pos(x, y) {
                    map.set(x, y, Tile::Wall);
                }
            }
        }
        map
    }

    pub fn generate(w: i32, h: i32, crate_density: f32, rng: &mut Rng) -> Self {
        let mut map = Self::empty(w, h);
        for y in 0..h {
            for x in 0..w {
                if map.get(x, y) != Tile::Floor {
                    continue;
                }
                let biome = map.biome(x, y);
                if biome == Biome::Snow && rng.chance(0.3) {
                    map.set(x, y, Tile::Ice);
                } else if rng.chance(crate_density) {
                    let armored = biome == Biome::Volcano && rng.chance(0.4);
                    map.set(x, y, if armored { Tile::Armored } else { Tile::Crate });
                }
            }
        }
        map.add_conveyors(rng);
        map.add_teleports(rng);
        map
    }

    /// Short conveyor strips along the open lanes of the desert.
    fn add_conveyors(&mut self, rng: &mut Rng) {
        for lane in (1..self.h - 1).step_by(2) {
            let mut x = 1;
            while x < self.w - 6 {
                if self.biome(x, lane) == Biome::Desert && rng.chance(0.12) {
                    let len = rng.between(3, 5);
                    let t = if rng.chance(0.5) { Tile::ConveyorRight } else { Tile::ConveyorLeft };
                    for k in 0..len {
                        self.set(x + k, lane, t);
                    }
                    x += len + 4;
                } else {
                    x += 1;
                }
            }
        }
        for lane in (1..self.w - 1).step_by(2) {
            let mut y = 1;
            while y < self.h - 6 {
                let free = (0..5).all(|k| self.get(lane, y + k).conveyor_dir() == 0);
                if free && self.biome(lane, y) == Biome::Desert && rng.chance(0.06) {
                    let len = rng.between(3, 5);
                    let t = if rng.chance(0.5) { Tile::ConveyorDown } else { Tile::ConveyorUp };
                    for k in 0..len {
                        self.set(lane, y + k, t);
                    }
                    y += len + 4;
                } else {
                    y += 1;
                }
            }
        }
    }

    /// A few linked pad pairs, placed far apart, on lane intersections.
    fn add_teleports(&mut self, rng: &mut Rng) {
        let pairs = ((self.w * self.h) / 1800).clamp(1, 4);
        let pick = |rng: &mut Rng, map: &Map| {
            let x = rng.between(0, (map.w - 3) / 2) * 2 + 1;
            let y = rng.between(0, (map.h - 3) / 2) * 2 + 1;
            (x, y)
        };
        for _ in 0..pairs {
            let a = pick(rng, self);
            let mut b = pick(rng, self);
            for _ in 0..20 {
                if (a.0 - b.0).abs() + (a.1 - b.1).abs() >= self.w / 2 {
                    break;
                }
                b = pick(rng, self);
            }
            if a == b || self.get(a.0, a.1) == Tile::Teleport || self.get(b.0, b.1) == Tile::Teleport {
                continue;
            }
            self.set(a.0, a.1, Tile::Teleport);
            self.set(b.0, b.1, Tile::Teleport);
            self.teleports.push((a, b));
        }
    }

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

    pub fn biome(&self, x: i32, y: i32) -> Biome {
        if self.w < MIN_BIOME_SIZE || self.h < MIN_BIOME_SIZE {
            return Biome::Grass;
        }
        let (fx, fy) = (x as f32 / self.w as f32, y as f32 / self.h as f32);
        let mut best = (f32::MAX, Biome::Grass);
        for &(sx, sy, b) in &BIOME_SEEDS {
            let d = (fx - sx).powi(2) + (fy - sy).powi(2);
            if d < best.0 {
                best = (d, b);
            }
        }
        best.1
    }

    /// Border walls plus the classic grid of pillars on even coordinates.
    pub fn is_pillar_pos(&self, x: i32, y: i32) -> bool {
        x == 0 || y == 0 || x == self.w - 1 || y == self.h - 1 || (x % 2 == 0 && y % 2 == 0)
    }

    pub fn in_bounds(&self, x: i32, y: i32) -> bool {
        x >= 0 && y >= 0 && x < self.w && y < self.h
    }

    pub fn idx(&self, x: i32, y: i32) -> usize {
        (y * self.w + x) as usize
    }

    pub fn get(&self, x: i32, y: i32) -> Tile {
        if self.in_bounds(x, y) { self.tiles[self.idx(x, y)] } else { Tile::Wall }
    }

    pub fn set(&mut self, x: i32, y: i32, t: Tile) {
        let i = self.idx(x, y);
        self.tiles[i] = t;
    }

    /// Walls and crates of either kind block movement and blasts.
    pub fn is_solid(&self, x: i32, y: i32) -> bool {
        matches!(self.get(x, y), Tile::Wall | Tile::Crate | Tile::Armored)
    }

    pub fn count(&self, t: Tile) -> usize {
        self.tiles.iter().filter(|&&v| v == t).count()
    }

    /// Run-length encoding of the tile grid as `(tile, run)` pairs, row-major.
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
    fn border_and_pillars_are_walls() {
        let mut rng = Rng::new(1);
        let m = Map::generate(15, 13, 0.5, &mut rng);
        for x in 0..15 {
            assert_eq!(m.get(x, 0), Tile::Wall);
            assert_eq!(m.get(x, 12), Tile::Wall);
        }
        assert_eq!(m.get(2, 2), Tile::Wall);
        assert_ne!(m.get(1, 1), Tile::Wall);
        assert_eq!(m.get(-1, 3), Tile::Wall);
    }

    #[test]
    fn rle_roundtrip_length() {
        let mut rng = Rng::new(7);
        let m = Map::generate(21, 21, 0.45, &mut rng);
        let total: u32 = m.encode_rle().iter().map(|&(_, n)| n).sum();
        assert_eq!(total, 21 * 21);
    }

    #[test]
    fn big_maps_have_every_feature() {
        let mut rng = Rng::new(3);
        let m = Map::generate(81, 81, 0.45, &mut rng);
        assert!(m.count(Tile::Ice) > 20, "snow region has ice");
        assert!(m.count(Tile::Armored) > 20, "volcano region has armored crates");
        let conveyors = (4..=7).map(|t| m.count(Tile::from_u8(t))).sum::<usize>();
        assert!(conveyors > 10, "desert region has conveyors");
        assert!(!m.teleports.is_empty());
        for &(a, b) in &m.teleports {
            assert_eq!(m.get(a.0, a.1), Tile::Teleport);
            assert_eq!(m.teleport_partner(a.0, a.1), Some(b));
            assert_eq!(m.teleport_partner(b.0, b.1), Some(a));
        }
        assert_eq!(m.biome(10, 10), Biome::Snow);
        assert_eq!(m.biome(70, 10), Biome::Desert);
        assert_eq!(m.biome(10, 70), Biome::Volcano);
        assert_eq!(m.biome(40, 40), Biome::Grass);
    }

    #[test]
    fn small_maps_stay_plain() {
        let mut rng = Rng::new(3);
        let m = Map::generate(21, 21, 0.45, &mut rng);
        assert_eq!(m.count(Tile::Ice) + m.count(Tile::Armored), 0);
    }
}
