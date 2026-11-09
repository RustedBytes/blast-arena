use super::rng::Rng;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum Tile {
    Floor = 0,
    Wall = 1,
    Crate = 2,
}

/// The static part of the world: walls, pillars and destructible crates.
pub struct Map {
    pub w: i32,
    pub h: i32,
    tiles: Vec<Tile>,
}

impl Map {
    pub fn empty(w: i32, h: i32) -> Self {
        let mut map = Map { w, h, tiles: vec![Tile::Floor; (w * h) as usize] };
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
                if map.get(x, y) == Tile::Floor && rng.chance(crate_density) {
                    map.set(x, y, Tile::Crate);
                }
            }
        }
        map
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

    pub fn is_solid(&self, x: i32, y: i32) -> bool {
        self.get(x, y) != Tile::Floor
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
}
