//! Random arena layouts. Each seed rolls a style (pillar pattern, symmetry,
//! crate cover, region layout and how much ice, armour, conveyor belt and
//! teleporting there is) and builds a map from it, so every server start
//! gets a different arena while a pinned `--map-seed` replays one exactly.
//!
//! [`Map::generate`] builds a few candidates in the rolled style and keeps
//! the one with the best [`MapQuality`]: spawn points spread over the whole
//! arena, cover balanced between its quarters and few dead ends.
//!
//! Whatever the dice say, a generated map keeps the guarantees that
//! [`Map::validate`] checks: a solid border, open lane crossings, no
//! pockets sealed off by walls, teleport pads in linked pairs and plenty of
//! safe spawn spots.

use super::map::{Biome, BiomeSeed, MIN_BIOME_SIZE, Map, Tile};
use super::rng::Rng;

/// Battle royale maps have a crate-free road every this many cells.
const ROAD_EVERY: i32 = 8;
/// How many layouts `generate` and `generate_open` build before keeping
/// the best one.
const CANDIDATES: usize = 3;

/// Which interior pillar slots (cells with two even coordinates) are walls.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, Default)]
pub enum Pillars {
    /// Every slot: the classic grid.
    #[default]
    Classic,
    /// Every other slot in a diagonal checkerboard, plus a few extras.
    Checker,
    /// A random share of the slots.
    Scattered,
    /// The full grid with many pillars joined into wall segments and rooms.
    Rooms,
    /// The full grid with a few large open plazas cut out of it.
    Plazas,
    /// The full grid with the gaps between pillars walled into a winding
    /// maze, then opened up again in places so it has loops.
    Maze,
    /// The full grid with concentric walled rings around the centre, each
    /// with a few gates.
    Rings,
}

/// How the wall layout repeats across the map.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum Symmetry {
    #[default]
    None,
    /// Left half mirrored onto the right.
    Mirror,
    /// Mirrored both ways.
    Quad,
    /// Turned 180° about the centre.
    Rotate,
}

impl Symmetry {
    /// The cells that must match (x, y), itself included (maybe repeated).
    fn images(self, w: i32, h: i32, x: i32, y: i32) -> [(i32, i32); 4] {
        let (mx, my) = (w - 1 - x, h - 1 - y);
        match self {
            Symmetry::None => [(x, y); 4],
            Symmetry::Mirror => [(x, y), (mx, y), (x, y), (mx, y)],
            Symmetry::Quad => [(x, y), (mx, y), (x, my), (mx, my)],
            Symmetry::Rotate => [(x, y), (mx, my), (x, y), (mx, my)],
        }
    }
}

/// The dice rolled for one map.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct MapStyle {
    pub pillars: Pillars,
    pub symmetry: Symmetry,
    /// Average chance that an open cell starts with a crate.
    pub crate_density: f32,
    /// How much the crate chance swings between thickets and clearings.
    pub crate_variation: f32,
    /// Chance that a snow cell is ice.
    pub ice: f32,
    /// Chance that a volcano crate is armored.
    pub armored: f32,
    /// Multiplier on how often desert lanes get conveyor belts.
    pub conveyors: f32,
    pub teleport_pairs: usize,
}

impl Default for MapStyle {
    /// The settings of the old fixed generator.
    fn default() -> Self {
        MapStyle {
            pillars: Pillars::Classic,
            symmetry: Symmetry::None,
            crate_density: 0.45,
            crate_variation: 0.0,
            ice: 0.3,
            armored: 0.4,
            conveyors: 1.0,
            teleport_pairs: 0,
        }
    }
}

impl MapStyle {
    /// Rolls a style for a `w` x `h` map around a base crate density.
    pub fn roll(w: i32, h: i32, crate_density: f32, rng: &mut Rng) -> Self {
        let pillars = match rng.below(7) {
            0 => Pillars::Classic,
            1 => Pillars::Checker,
            2 => Pillars::Scattered,
            3 => Pillars::Rooms,
            4 => Pillars::Plazas,
            5 => Pillars::Maze,
            _ => Pillars::Rings,
        };
        // Mirroring keeps the pillar grid aligned only on odd sizes.
        let symmetry = if w % 2 == 0 || h % 2 == 0 {
            Symmetry::None
        } else {
            match rng.below(4) {
                0 => Symmetry::None,
                1 => Symmetry::Mirror,
                2 => Symmetry::Quad,
                _ => Symmetry::Rotate,
            }
        };
        let base_pairs = ((w * h) / 1800).clamp(1, 4);
        // Maze corridors are cover already: fewer crates keep them moving.
        let corridors = if pillars == Pillars::Maze { 0.75 } else { 1.0 };
        MapStyle {
            pillars,
            symmetry,
            crate_density: (crate_density * corridors * rng.range(0.75, 1.3)).clamp(0.2, 0.65),
            crate_variation: rng.range(0.05, 0.25),
            ice: rng.range(0.15, 0.4),
            armored: rng.range(0.25, 0.6),
            conveyors: rng.range(0.5, 1.8),
            teleport_pairs: rng.between(base_pairs - 1, base_pairs + 1).max(1) as usize,
        }
    }
}

impl Map {
    /// A random map: rolls a [`MapStyle`] around `crate_density`, builds a
    /// few layouts in it and keeps the best. The same seed always gives
    /// the same map.
    pub fn generate(w: i32, h: i32, crate_density: f32, rng: &mut Rng) -> Self {
        let style = MapStyle::roll(w, h, crate_density, rng);
        Self::best_of(rng, |rng| Self::generate_with(w, h, style, rng))
    }

    /// Builds `CANDIDATES` maps, each from its own seed drawn from `rng`,
    /// and returns the one with the highest quality score.
    fn best_of(rng: &mut Rng, build: impl Fn(&mut Rng) -> Map) -> Map {
        let mut best: Option<(f32, Map)> = None;
        for _ in 0..CANDIDATES {
            let map = build(&mut Rng::new(rng.next_u64()));
            let score = map.quality().score;
            if best.as_ref().is_none_or(|(b, _)| score > *b) {
                best = Some((score, map));
            }
        }
        best.expect("at least one candidate").1
    }

    /// Builds a map in the given style.
    pub fn generate_with(w: i32, h: i32, style: MapStyle, rng: &mut Rng) -> Self {
        let mut map = Map::empty(w, h);
        map.style = style;
        map.biomes = roll_biomes(w, h, rng);
        map.place_pillars(rng);
        map.build_walls(rng);
        map.fill(rng);
        map.add_conveyors(rng);
        map.add_teleports(rng);
        map.carve_spawn_pockets(rng);
        debug_assert_eq!(map.validate(), Ok(()));
        map
    }

    /// An open, well-connected map for the battle royale arena: an open
    /// pillar style, fewer crates, a grid of crate-free roads every
    /// `ROAD_EVERY` cells, and no pocket that can't be walked out of (see
    /// [`Map::connect_everything`]), so a player can always run for the
    /// safe zone.
    pub fn generate_open(w: i32, h: i32, rng: &mut Rng) -> Self {
        let mut style = MapStyle::roll(w, h, 0.28, rng);
        style.pillars = match rng.below(3) {
            0 => Pillars::Classic,
            1 => Pillars::Scattered,
            _ => Pillars::Plazas,
        };
        style.crate_density = style.crate_density.min(0.32);
        style.armored = style.armored.min(0.2);
        Self::best_of(rng, |rng| {
            let mut map = Self::generate_with(w, h, style, rng);
            map.clear_roads();
            map.connect_everything();
            map
        })
    }

    /// A dungeon for the dungeon arena: rooms of open floor joined by
    /// narrow, winding corridors, all in crypt stone. Rooms sit on the lane
    /// grid with their pillars cleared out; the rest of the map is walled
    /// into a maze between them, with a few loops so fights don't stall in
    /// dead ends, and every room gets more than one door. Crates are thick
    /// in the rooms and rare in the corridors.
    pub fn generate_dungeon(w: i32, h: i32, rng: &mut Rng) -> Self {
        let mut style = MapStyle::roll(w, h, 0.3, rng);
        style.pillars = Pillars::Maze;
        style.symmetry = Symmetry::None;
        style.crate_density = rng.range(0.3, 0.42);
        style.armored = rng.range(0.1, 0.25);
        style.ice = 0.0;
        style.conveyors = 0.0;
        style.teleport_pairs = ((w * h) / 2500).clamp(1, 3) as usize;
        Self::best_of(rng, |rng| Self::build_dungeon(w, h, style, rng))
    }

    fn build_dungeon(w: i32, h: i32, style: MapStyle, rng: &mut Rng) -> Self {
        let mut map = Map::empty(w, h);
        map.style = style;
        map.biomes = vec![BiomeSeed { x: 0.5, y: 0.5, biome: Biome::Crypt }];
        let rooms = map.place_rooms(rng);
        let in_room = |x: i32, y: i32| rooms.iter().any(|&(x0, y0, x1, y1)| x >= x0 && x <= x1 && y >= y0 && y <= y1);
        // Wall every gap outside the rooms, clear the pillars inside them.
        map.wall_gaps(rng, |_, x, y| !in_room(x, y));
        for y in 1..h - 1 {
            for x in 1..w - 1 {
                if in_room(x, y) {
                    map.set(x, y, Tile::Floor);
                }
            }
        }
        map.connect_gaps(rng);
        let loops = rng.range(0.06, 0.12);
        map.open_gaps(rng, loops);
        // A second (and sometimes third) door for every room.
        for &(x0, y0, x1, y1) in &rooms {
            let mut doors: Vec<(i32, i32)> = Vec::new();
            for x in (x0..=x1).step_by(2) {
                doors.extend([(x, y0 - 1), (x, y1 + 1)]);
            }
            for y in (y0..=y1).step_by(2) {
                doors.extend([(x0 - 1, y), (x1 + 1, y)]);
            }
            doors.retain(|&(x, y)| map.get(x, y) == Tile::Wall && map.gap_sides(x, y).is_some());
            for _ in 0..rng.between(1, 2) {
                if doors.is_empty() {
                    break;
                }
                let (x, y) = doors.swap_remove(rng.below(doors.len() as u32) as usize);
                map.set(x, y, Tile::Floor);
            }
        }
        for y in 1..h - 1 {
            for x in 1..w - 1 {
                if map.get(x, y) != Tile::Floor {
                    continue;
                }
                let chance = if in_room(x, y) { style.crate_density } else { 0.1 };
                if rng.chance(chance) {
                    map.set(x, y, if rng.chance(style.armored) { Tile::Armored } else { Tile::Crate });
                }
            }
        }
        map.add_teleports(rng);
        map.carve_spawn_pockets(rng);
        debug_assert_eq!(map.validate(), Ok(()));
        map
    }

    /// Rooms on the lane grid, as inclusive interiors (x0, y0, x1, y1) with
    /// odd corners, at least a corridor apart. About half the map ends up
    /// in rooms.
    fn place_rooms(&self, rng: &mut Rng) -> Vec<(i32, i32, i32, i32)> {
        let (w, h) = (self.w, self.h);
        let mut rooms: Vec<(i32, i32, i32, i32)> = Vec::new();
        let (lanes_x, lanes_y) = ((w - 1) / 2, (h - 1) / 2);
        let big = (w.min(h) / 12).clamp(3, 5);
        let mut area = 0;
        let want = (w - 2) * (h - 2) / 2;
        for _ in 0..400 {
            if area >= want {
                break;
            }
            // Sizes in lanes: a room k lanes wide is 2k - 1 cells.
            let (kw, kh) = (rng.between(2, big), rng.between(2, big));
            if kw >= lanes_x - 1 || kh >= lanes_y - 1 {
                continue;
            }
            let (lx, ly) = (rng.between(0, lanes_x - kw), rng.between(0, lanes_y - kh));
            let (x0, y0) = (2 * lx + 1, 2 * ly + 1);
            let (x1, y1) = (x0 + 2 * kw - 2, y0 + 2 * kh - 2);
            if x1 > w - 2 || y1 > h - 2 {
                continue;
            }
            // A corridor's width (two cells) between rooms.
            if rooms.iter().any(|&(a0, b0, a1, b1)| x0 <= a1 + 2 && x1 + 2 >= a0 && y0 <= b1 + 2 && y1 + 2 >= b0) {
                continue;
            }
            area += (x1 - x0 + 1) * (y1 - y0 + 1);
            rooms.push((x0, y0, x1, y1));
        }
        rooms
    }

    /// Clears crates along every `ROAD_EVERY`-th row and column (odd lanes,
    /// so the pillar grid stays intact).
    fn clear_roads(&mut self) {
        for y in 1..self.h - 1 {
            for x in 1..self.w - 1 {
                if (x % ROAD_EVERY == 1 || y % ROAD_EVERY == 1) && self.get(x, y).is_breakable() {
                    self.set(x, y, Tile::Floor);
                }
            }
        }
    }

    /// Makes every walkable cell reachable on foot from every other one:
    /// each enclosed pocket gets the cheapest way out carved to the main
    /// area (through crates first, through pillars only if it must). The
    /// map border always stays.
    pub fn connect_everything(&mut self) {
        let (w, h) = (self.w, self.h);
        let open = |m: &Map, x: i32, y: i32| !m.is_solid(x, y);
        let idx = |x: i32, y: i32| (y * w + x) as usize;
        let mut reached = vec![false; (w * h) as usize];
        // Start from the walkable cell nearest the centre.
        let mut start = None;
        'find: for r in 0..w.max(h) {
            for dy in -r..=r {
                for dx in -r..=r {
                    let (x, y) = (w / 2 + dx, h / 2 + dy);
                    if self.in_bounds(x, y) && open(self, x, y) {
                        start = Some((x, y));
                        break 'find;
                    }
                }
            }
        }
        let Some(start) = start else { return };
        let flood = |m: &Map, reached: &mut Vec<bool>, from: (i32, i32)| {
            let mut stack = vec![from];
            reached[idx(from.0, from.1)] = true;
            while let Some((x, y)) = stack.pop() {
                for (dx, dy) in [(0, -1), (1, 0), (0, 1), (-1, 0)] {
                    let (nx, ny) = (x + dx, y + dy);
                    if m.in_bounds(nx, ny) && !reached[idx(nx, ny)] && open(m, nx, ny) {
                        reached[idx(nx, ny)] = true;
                        stack.push((nx, ny));
                    }
                }
            }
        };
        flood(self, &mut reached, start);
        for y in 1..h - 1 {
            for x in 1..w - 1 {
                if reached[idx(x, y)] || !open(self, x, y) {
                    continue;
                }
                // A pocket: cheapest path (Dijkstra, small costs) to the
                // reached area through the interior.
                let cost = |t: Tile| match t {
                    Tile::Wall => 8u32,
                    Tile::Crate | Tile::Armored => 2,
                    _ => 1,
                };
                let mut dist = vec![u32::MAX; (w * h) as usize];
                let mut prev = vec![usize::MAX; (w * h) as usize];
                let mut heap = std::collections::BinaryHeap::new();
                dist[idx(x, y)] = 0;
                heap.push(std::cmp::Reverse((0u32, x, y)));
                let mut goal = None;
                while let Some(std::cmp::Reverse((d, cx, cy))) = heap.pop() {
                    if d > dist[idx(cx, cy)] {
                        continue;
                    }
                    if reached[idx(cx, cy)] {
                        goal = Some((cx, cy));
                        break;
                    }
                    for (dx, dy) in [(0, -1), (1, 0), (0, 1), (-1, 0)] {
                        let (nx, ny) = (cx + dx, cy + dy);
                        if nx < 1 || ny < 1 || nx >= w - 1 || ny >= h - 1 {
                            continue;
                        }
                        let nd = d + cost(self.get(nx, ny));
                        if nd < dist[idx(nx, ny)] {
                            dist[idx(nx, ny)] = nd;
                            prev[idx(nx, ny)] = idx(cx, cy);
                            heap.push(std::cmp::Reverse((nd, nx, ny)));
                        }
                    }
                }
                let Some((gx, gy)) = goal else { continue };
                let mut k = prev[idx(gx, gy)];
                while k != usize::MAX {
                    let (px, py) = ((k as i32) % w, (k as i32) / w);
                    if self.is_solid(px, py) {
                        self.set(px, py, Tile::Floor);
                    }
                    k = prev[k];
                }
                flood(self, &mut reached, (x, y));
            }
        }
    }

    /// Re-decides every interior pillar slot according to the style.
    fn place_pillars(&mut self, rng: &mut Rng) {
        let (w, h, style) = (self.w, self.h, self.style);
        let keep = rng.range(0.45, 0.8);
        let mut plazas = Vec::new();
        if style.pillars == Pillars::Plazas {
            for _ in 0..rng.between(2, 3 + (w * h) / 1500) {
                let (rw, rh) = (rng.between(4, (w / 4).max(5)), rng.between(4, (h / 4).max(5)));
                let (x0, y0) = (rng.between(1, (w - rw - 1).max(1)), rng.between(1, (h - rh - 1).max(1)));
                plazas.push((x0, y0, x0 + rw, y0 + rh));
            }
        }
        // One decision per symmetry orbit, made for its smallest member.
        let mut decided: Vec<Option<bool>> = vec![None; self.tiles_len()];
        for y in (2..h - 1).step_by(2) {
            for x in (2..w - 1).step_by(2) {
                let images = style.symmetry.images(w, h, x, y);
                let (cx, cy) = images.into_iter().min_by_key(|&(ix, iy)| (iy, ix)).unwrap_or((x, y));
                let i = self.idx(cx, cy);
                let wall = *decided[i].get_or_insert_with(|| match style.pillars {
                    Pillars::Classic | Pillars::Rooms | Pillars::Maze | Pillars::Rings => true,
                    Pillars::Checker => (cx / 2 + cy / 2) % 2 == 0 || rng.chance(0.15),
                    Pillars::Scattered => rng.chance(keep),
                    Pillars::Plazas => !plazas.iter().any(|&(x0, y0, x1, y1)| (x0..=x1).contains(&cx) && (y0..=y1).contains(&cy)),
                });
                self.set(x, y, if wall { Tile::Wall } else { Tile::Floor });
            }
        }
    }

    /// Turns the pillar grid into the style's wall layout.
    fn build_walls(&mut self, rng: &mut Rng) {
        let (w, h) = (self.w, self.h);
        match self.style.pillars {
            Pillars::Maze => {
                // Wall every gap, grow a random spanning tree back through
                // them, then reopen a share so the maze has loops and
                // fights don't stall in long dead ends.
                self.wall_gaps(rng, |_, _, _| true);
                self.connect_gaps(rng);
                let loops = rng.range(0.3, 0.5);
                self.open_gaps(rng, loops);
            }
            Pillars::Rings => {
                let (cx, cy) = (w / 2, h / 2);
                let step = rng.between(3, 4) * 2;
                let max_r = cx.min(cy) - 2;
                let solid = rng.range(0.75, 0.9);
                self.wall_gaps(rng, |rng, x, y| {
                    let r = (x - cx).abs().max((y - cy).abs());
                    r % step == 0 && r > 0 && r <= max_r && rng.chance(solid)
                });
                self.connect_gaps(rng);
                self.open_gaps(rng, 0.05);
                self.join_pillars(rng);
            }
            _ => self.join_pillars(rng),
        }
    }

    /// The two cells a pillar gap (a cell with exactly one odd coordinate)
    /// separates, when it is an interior gap between two interior cells.
    fn gap_sides(&self, x: i32, y: i32) -> Option<[(i32, i32); 2]> {
        if (x + y) % 2 == 0 || x < 1 || y < 1 || x > self.w - 2 || y > self.h - 2 {
            return None;
        }
        let sides = if x % 2 == 1 { [(x, y - 1), (x, y + 1)] } else { [(x - 1, y), (x + 1, y)] };
        let inside = |(sx, sy): (i32, i32)| sx >= 1 && sy >= 1 && sx <= self.w - 2 && sy <= self.h - 2;
        (inside(sides[0]) && inside(sides[1])).then_some(sides)
    }

    /// The smallest member of the symmetry orbit of (x, y).
    fn orbit_rep(&self, x: i32, y: i32) -> (i32, i32) {
        self.style.symmetry.images(self.w, self.h, x, y).into_iter().min_by_key(|&(ix, iy)| (iy, ix)).unwrap_or((x, y))
    }

    /// Sets (x, y) and all its symmetric images to `t`.
    fn set_orbit(&mut self, x: i32, y: i32, t: Tile) {
        for (ix, iy) in self.style.symmetry.images(self.w, self.h, x, y) {
            self.set(ix, iy, t);
        }
    }

    /// Walls the interior gaps `pick` chooses, one decision per symmetry
    /// orbit. May seal pockets off: follow with [`Map::connect_gaps`].
    fn wall_gaps(&mut self, rng: &mut Rng, mut pick: impl FnMut(&mut Rng, i32, i32) -> bool) {
        for y in 1..self.h - 1 {
            for x in 1..self.w - 1 {
                if self.gap_sides(x, y).is_none() || self.orbit_rep(x, y) != (x, y) {
                    continue;
                }
                if pick(rng, x, y) {
                    self.set_orbit(x, y, Tile::Wall);
                }
            }
        }
    }

    /// Reopens walled gaps (and their images) with chance `p`.
    fn open_gaps(&mut self, rng: &mut Rng, p: f32) {
        for y in 1..self.h - 1 {
            for x in 1..self.w - 1 {
                if self.get(x, y) == Tile::Wall && self.gap_sides(x, y).is_some() && self.orbit_rep(x, y) == (x, y) && rng.chance(p) {
                    self.set_orbit(x, y, Tile::Floor);
                }
            }
        }
    }

    /// Reconnects every open cell by reopening walled gaps, picked at random
    /// from the edge of the area reached so far (randomized Prim's), so a
    /// fully walled grid becomes a perfect maze.
    fn connect_gaps(&mut self, rng: &mut Rng) {
        let mut reached = vec![false; self.tiles_len()];
        let mut frontier = Vec::new();
        // Lane crossings are never walls, so (1, 1) is open.
        self.flood_walls(&mut reached, &mut frontier, (1, 1));
        while !frontier.is_empty() {
            let (gx, gy) = frontier.swap_remove(rng.below(frontier.len() as u32) as usize);
            let Some(sides) = self.gap_sides(gx, gy) else { continue };
            if self.get(gx, gy) != Tile::Wall || sides.iter().all(|&(sx, sy)| reached[self.idx(sx, sy)]) {
                continue;
            }
            self.set_orbit(gx, gy, Tile::Floor);
            for (ix, iy) in self.style.symmetry.images(self.w, self.h, gx, gy) {
                let touches = self.gap_sides(ix, iy).is_some_and(|s| s.iter().any(|&(sx, sy)| reached[self.idx(sx, sy)]));
                if touches && !reached[self.idx(ix, iy)] {
                    self.flood_walls(&mut reached, &mut frontier, (ix, iy));
                }
            }
        }
    }

    /// Marks the non-wall cells reachable from `from`, collecting the walled
    /// gaps on the way as candidates to open.
    fn flood_walls(&self, reached: &mut [bool], frontier: &mut Vec<(i32, i32)>, from: (i32, i32)) {
        reached[self.idx(from.0, from.1)] = true;
        let mut stack = vec![from];
        while let Some((x, y)) = stack.pop() {
            for (dx, dy) in [(0, -1), (1, 0), (0, 1), (-1, 0)] {
                let (nx, ny) = (x + dx, y + dy);
                if !self.in_bounds(nx, ny) {
                    continue;
                }
                let i = self.idx(nx, ny);
                if self.get(nx, ny) == Tile::Wall {
                    if self.gap_sides(nx, ny).is_some() {
                        frontier.push((nx, ny));
                    }
                } else if !reached[i] {
                    reached[i] = true;
                    stack.push((nx, ny));
                }
            }
        }
    }

    /// Joins neighbouring pillars into wall segments, keeping each one only
    /// if no open cell gets sealed off.
    fn join_pillars(&mut self, rng: &mut Rng) {
        let (w, h) = (self.w, self.h);
        let tries = match self.style.pillars {
            Pillars::Classic | Pillars::Maze => 0,
            Pillars::Rooms => (w * h) / 25,
            Pillars::Rings => (w * h) / 300,
            _ => (w * h) / 150,
        };
        let even = |rng: &mut Rng, n: i32| rng.between(1, (n - 3) / 2) * 2;
        let odd = |rng: &mut Rng, n: i32| rng.between(0, (n - 3) / 2) * 2 + 1;
        let mut added = Vec::with_capacity(4);
        for _ in 0..tries {
            // A gap between two pillar slots, horizontal or vertical.
            let ((x, y), ends) = if rng.chance(0.5) {
                let (x, y) = (odd(rng, w), even(rng, h));
                ((x, y), [(x - 1, y), (x + 1, y)])
            } else {
                let (x, y) = (even(rng, w), odd(rng, h));
                ((x, y), [(x, y - 1), (x, y + 1)])
            };
            if ends.iter().any(|&(ex, ey)| self.get(ex, ey) != Tile::Wall) {
                continue;
            }
            added.clear();
            for (ix, iy) in self.style.symmetry.images(w, h, x, y) {
                if self.get(ix, iy) != Tile::Wall {
                    self.set(ix, iy, Tile::Wall);
                    added.push((ix, iy));
                }
            }
            if !added.is_empty() && !self.is_connected() {
                for &(ix, iy) in &added {
                    self.set(ix, iy, Tile::Floor);
                }
            }
        }
    }

    /// Crates (thicker in some places, sparse in others), ice on snow and
    /// armored crates in the volcano. Crates follow the wall symmetry, so
    /// mirrored maps are fair; ice and armour follow the regions.
    fn fill(&mut self, rng: &mut Rng) {
        let style = self.style;
        // Two octaves of value noise: broad thickets and clearings, with
        // smaller clumps inside them.
        let broad = ValueNoise::new(self.w, self.h, 9, rng);
        let clumps = ValueNoise::new(self.w, self.h, 4, rng);
        let mut crate_at: Vec<Option<bool>> = vec![None; self.tiles_len()];
        for y in 0..self.h {
            for x in 0..self.w {
                if self.get(x, y) != Tile::Floor {
                    continue;
                }
                let (rx, ry) = self.orbit_rep(x, y);
                let ri = self.idx(rx, ry);
                let has_crate = *crate_at[ri].get_or_insert_with(|| {
                    let n = 0.7 * broad.at(rx, ry) + 0.3 * clumps.at(rx, ry);
                    rng.chance(style.crate_density + style.crate_variation * 1.6 * n)
                });
                let biome = self.biome(x, y);
                if biome == Biome::Snow && rng.chance(style.ice) {
                    self.set(x, y, Tile::Ice);
                } else if has_crate {
                    let armored = biome == Biome::Volcano && rng.chance(style.armored);
                    self.set(x, y, if armored { Tile::Armored } else { Tile::Crate });
                }
            }
        }
    }

    /// Short conveyor strips along the open lanes of the desert.
    fn add_conveyors(&mut self, rng: &mut Rng) {
        let f = self.style.conveyors;
        for lane in (1..self.h - 1).step_by(2) {
            let mut x = 1;
            while x < self.w - 6 {
                let len = rng.between(3, 5);
                if rng.chance(0.12 * f) && self.belt_fits((x..x + len).map(|cx| (cx, lane))) {
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
                let len = rng.between(3, 5);
                // One spare cell so a vertical strip never runs into a horizontal one.
                if rng.chance(0.06 * f) && self.belt_fits((y..=y + len).map(|cy| (lane, cy))) {
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

    /// True when a belt can run over these cells: desert, no wall, no belt.
    fn belt_fits(&self, mut cells: impl Iterator<Item = (i32, i32)>) -> bool {
        cells.all(|(x, y)| self.biome(x, y) == Biome::Desert && self.get(x, y) != Tile::Wall && self.get(x, y).conveyor_dir() == 0)
    }

    /// Linked pad pairs, placed far apart, on lane crossings.
    fn add_teleports(&mut self, rng: &mut Rng) {
        let pick = |rng: &mut Rng, map: &Map| {
            for _ in 0..20 {
                let x = rng.between(0, (map.w - 3) / 2) * 2 + 1;
                let y = rng.between(0, (map.h - 3) / 2) * 2 + 1;
                if map.get(x, y).conveyor_dir() == 0 && map.get(x, y) != Tile::Teleport {
                    return Some((x, y));
                }
            }
            None
        };
        for _ in 0..self.style.teleport_pairs {
            let Some(a) = pick(rng, self) else { continue };
            let Some(mut b) = pick(rng, self) else { continue };
            for _ in 0..20 {
                if (a.0 - b.0).abs() + (a.1 - b.1).abs() >= self.w / 2 {
                    break;
                }
                b = pick(rng, self).unwrap_or(b);
            }
            if a == b {
                continue;
            }
            for (px, py) in [a, b] {
                self.set(px, py, Tile::Teleport);
                // A pad buried in crates is useless: clear its neighbours.
                for (dx, dy) in [(0, -1), (1, 0), (0, 1), (-1, 0)] {
                    if self.get(px + dx, py + dy).is_breakable() {
                        self.set(px + dx, py + dy, Tile::Floor);
                    }
                }
            }
            self.teleports.push((a, b));
        }
    }

    /// Clears crates around lane crossings until the map has enough safe
    /// places to spawn. Each pocket (and its symmetric images) goes on the
    /// best of a handful of random crossings: the one farthest from the
    /// pockets made so far, so spawns spread over the whole arena instead
    /// of clumping.
    fn carve_spawn_pockets(&mut self, rng: &mut Rng) {
        let want = Map::spawn_target(self.w, self.h);
        let lane = |rng: &mut Rng, map: &Map| (rng.between(0, (map.w - 3) / 2) * 2 + 1, rng.between(0, (map.h - 3) / 2) * 2 + 1);
        let mut pockets: Vec<(i32, i32)> = Vec::with_capacity(want);
        for _ in 0..want * 50 {
            if pockets.len() >= want {
                break;
            }
            let mut best = (-1, (1, 1));
            for _ in 0..16 {
                let (x, y) = lane(rng, self);
                if self.get(x, y) == Tile::Teleport {
                    continue;
                }
                let gap = pockets.iter().map(|&(px, py)| (px - x).pow(2) + (py - y).pow(2)).min().unwrap_or(i32::MAX);
                if gap > best.0 {
                    best = (gap, (x, y));
                }
            }
            if best.0 < 0 {
                continue;
            }
            // Carved at every symmetric image, so mirrored maps stay fair.
            for (x, y) in self.style.symmetry.images(self.w, self.h, best.1.0, best.1.1) {
                if pockets.contains(&(x, y)) || self.get(x, y) == Tile::Teleport {
                    continue;
                }
                for dy in -2..=2i32 {
                    for dx in -2..=2i32 {
                        if dx.abs() + dy.abs() <= 2 && self.get(x + dx, y + dy).is_breakable() {
                            self.set(x + dx, y + dy, Tile::Floor);
                        }
                    }
                }
                if self.is_spawn_spot(x, y) {
                    pockets.push((x, y));
                }
            }
        }
    }

    /// Measures how playable the map is; see [`MapQuality`].
    #[must_use]
    pub fn quality(&self) -> MapQuality {
        let (w, h) = (self.w, self.h);
        let mut open = 0usize;
        let mut breakable = 0usize;
        let mut dead_ends = 0usize;
        let mut quarter = [(0usize, 0usize); 4];
        let mut dist = vec![u32::MAX; self.tiles_len()];
        let mut queue = std::collections::VecDeque::new();
        let mut spawn_spots = 0;
        for y in 1..h - 1 {
            for x in 1..w - 1 {
                let t = self.get(x, y);
                if t == Tile::Wall {
                    continue;
                }
                open += 1;
                let q = usize::from(x * 2 >= w) + 2 * usize::from(y * 2 >= h);
                quarter[q].0 += 1;
                if t.is_breakable() {
                    breakable += 1;
                    quarter[q].1 += 1;
                }
                let walls = [(0, -1), (1, 0), (0, 1), (-1, 0)].iter().filter(|&&(dx, dy)| self.get(x + dx, y + dy) == Tile::Wall).count();
                if walls >= 3 {
                    dead_ends += 1;
                }
                if self.is_spawn_spot(x, y) {
                    spawn_spots += 1;
                    dist[self.idx(x, y)] = 0;
                    queue.push_back((x, y));
                }
            }
        }
        // Steps (through anything but walls) from each cell to the nearest
        // spawn spot: how far a part of the arena is from the action.
        while let Some((x, y)) = queue.pop_front() {
            let d = dist[self.idx(x, y)];
            for (dx, dy) in [(0, -1), (1, 0), (0, 1), (-1, 0)] {
                let (nx, ny) = (x + dx, y + dy);
                if self.get(nx, ny) != Tile::Wall && dist[self.idx(nx, ny)] == u32::MAX {
                    dist[self.idx(nx, ny)] = d + 1;
                    queue.push_back((nx, ny));
                }
            }
        }
        let spawn_reach = dist.iter().filter(|&&d| d != u32::MAX).max().copied().unwrap_or(0);
        let shares: Vec<f32> = quarter.iter().filter(|q| q.0 > 0).map(|&(o, b)| b as f32 / o as f32).collect();
        let balance = shares.iter().copied().fold(f32::MIN, f32::max) - shares.iter().copied().fold(f32::MAX, f32::min);
        let open_f = open.max(1) as f32;
        let crates = breakable as f32 / open_f;
        // Higher is better. Each term is roughly 0..1 on typical maps.
        let reach_norm = spawn_reach as f32 / (w + h) as f32 * 4.0;
        let dead_norm = dead_ends as f32 / open_f * 8.0;
        let score = -reach_norm - 2.0 * balance.max(0.0) - dead_norm;
        MapQuality { open: open_f / ((w - 2) * (h - 2)) as f32, crates, dead_ends, spawn_spots, spawn_reach, balance, score }
    }

    fn tiles_len(&self) -> usize {
        (self.w * self.h) as usize
    }
}

/// How playable a generated map is. `generate` builds several candidates
/// and keeps the one with the highest `score`.
#[derive(Clone, Copy, PartialEq, Debug)]
pub struct MapQuality {
    /// Share of the interior that isn't wall.
    pub open: f32,
    /// Share of the open cells that hold a crate.
    pub crates: f32,
    /// Open cells with walls on three sides.
    pub dead_ends: usize,
    /// Cells a player can safely spawn on.
    pub spawn_spots: usize,
    /// The most steps any open cell is from the nearest spawn spot.
    pub spawn_reach: u32,
    /// Spread of the crate share between the four quarters (0 = even).
    pub balance: f32,
    /// Overall score; higher is better.
    pub score: f32,
}

impl std::fmt::Display for MapQuality {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "score {:.2}: open {:.0}%, crates {:.0}%, dead ends {}, spawn spots {}, spawn reach {}, quarter spread {:.2}",
            self.score,
            self.open * 100.0,
            self.crates * 100.0,
            self.dead_ends,
            self.spawn_spots,
            self.spawn_reach,
            self.balance
        )
    }
}

/// Smooth 2D value noise in -1..1: random values on a coarse lattice,
/// blended with a smoothstep so there are no visible grid lines.
struct ValueNoise {
    cell: i32,
    gw: i32,
    grid: Vec<f32>,
}

impl ValueNoise {
    fn new(w: i32, h: i32, cell: i32, rng: &mut Rng) -> Self {
        let (gw, gh) = (w / cell + 2, h / cell + 2);
        ValueNoise { cell, gw, grid: (0..gw * gh).map(|_| rng.range(-1.0, 1.0)).collect() }
    }

    fn at(&self, x: i32, y: i32) -> f32 {
        let smooth = |t: f32| t * t * (3.0 - 2.0 * t);
        let (gx, gy) = (x / self.cell, y / self.cell);
        let fx = smooth((x % self.cell) as f32 / self.cell as f32);
        let fy = smooth((y % self.cell) as f32 / self.cell as f32);
        let v = |i: i32, j: i32| self.grid[(j * self.gw + i) as usize];
        let top = v(gx, gy) + (v(gx + 1, gy) - v(gx, gy)) * fx;
        let bottom = v(gx, gy + 1) + (v(gx + 1, gy + 1) - v(gx, gy + 1)) * fx;
        top + (bottom - top) * fy
    }
}

/// Region centres: a single theme on small maps; on big ones four to seven
/// spread-out regions that include every biome at least once.
fn roll_biomes(w: i32, h: i32, rng: &mut Rng) -> Vec<BiomeSeed> {
    let any = |rng: &mut Rng| match rng.below(5) {
        0 | 1 => Biome::Grass,
        2 => Biome::Snow,
        3 => Biome::Desert,
        _ => Biome::Volcano,
    };
    if w < MIN_BIOME_SIZE || h < MIN_BIOME_SIZE {
        return vec![BiomeSeed { x: 0.5, y: 0.5, biome: any(rng) }];
    }
    let mut kinds = vec![Biome::Grass, Biome::Snow, Biome::Desert, Biome::Volcano];
    for _ in 0..rng.between(0, 3) {
        kinds.push(any(rng));
    }
    for i in (1..kinds.len()).rev() {
        kinds.swap(i, rng.below(i as u32 + 1) as usize);
    }
    let mut seeds: Vec<BiomeSeed> = Vec::with_capacity(kinds.len());
    for biome in kinds {
        let mut best = (0.0f32, 0.5f32, 0.5f32);
        // Best of a few candidates: the one farthest from the others.
        for _ in 0..12 {
            let (x, y) = (rng.range(0.1, 0.9), rng.range(0.1, 0.9));
            let gap = seeds.iter().map(|s| (s.x - x).powi(2) + (s.y - y).powi(2)).fold(f32::MAX, f32::min);
            if gap > best.0 {
                best = (gap, x, y);
            }
        }
        seeds.push(BiomeSeed { x: best.1, y: best.2, biome });
    }
    seeds
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(size: i32, seed: u64) -> Map {
        Map::generate(size, size, 0.45, &mut Rng::new(seed))
    }

    #[test]
    fn open_maps_have_roads_and_no_closed_pockets() {
        for seed in 0..40 {
            let m = Map::generate_open(81, 81, &mut Rng::new(seed));
            assert_eq!(m.validate(), Ok(()), "seed {seed}");
            // Every walkable cell is reachable from every other on foot.
            let walk = |x: i32, y: i32| !m.is_solid(x, y);
            let start = (1..80).flat_map(|y| (1..80).map(move |x| (x, y))).find(|&(x, y)| walk(x, y)).unwrap();
            let mut seen = vec![false; 81 * 81];
            let mut stack = vec![start];
            seen[(start.1 * 81 + start.0) as usize] = true;
            while let Some((x, y)) = stack.pop() {
                for (dx, dy) in [(0, -1), (1, 0), (0, 1), (-1, 0)] {
                    let (nx, ny) = (x + dx, y + dy);
                    let i = (ny * 81 + nx) as usize;
                    if m.in_bounds(nx, ny) && !seen[i] && walk(nx, ny) {
                        seen[i] = true;
                        stack.push((nx, ny));
                    }
                }
            }
            for y in 0..81 {
                for x in 0..81 {
                    assert!(!walk(x, y) || seen[(y * 81 + x) as usize], "seed {seed}: ({x}, {y}) is shut in");
                }
            }
            // The roads are clear.
            for x in 1..80 {
                assert!(!m.get(x, 9).is_breakable(), "seed {seed}: crate on the road at ({x}, 9)");
            }
        }
    }

    #[test]
    fn same_seed_same_map() {
        for seed in [1, 42, 9_000_001] {
            let (a, b) = (map(81, seed), map(81, seed));
            assert_eq!(a.encode_rle(), b.encode_rle());
            assert_eq!(a.teleports, b.teleports);
            assert_eq!(a.biomes, b.biomes);
        }
    }

    #[test]
    fn different_seeds_differ() {
        let maps: Vec<Map> = (0..8).map(|s| map(81, s)).collect();
        for (i, a) in maps.iter().enumerate() {
            for b in &maps[i + 1..] {
                assert_ne!(a.encode_rle(), b.encode_rle());
                assert_ne!(a.biomes, b.biomes);
            }
        }
        // Not just different crates: the structure varies too.
        let walls: std::collections::HashSet<usize> = maps.iter().map(|m| m.count(Tile::Wall)).collect();
        assert!(walls.len() >= 4, "wall layouts vary: {walls:?}");
        let patterns: std::collections::HashSet<_> = (0..40).map(|s| map(41, s).style.pillars).collect();
        assert_eq!(patterns.len(), 7, "every pillar pattern shows up");
    }

    #[test]
    fn every_generated_map_is_valid() {
        for size in [15, 21, 31, 41, 61, 81] {
            for seed in 0..40 {
                let m = map(size, seed);
                if let Err(e) = m.validate() {
                    panic!("size {size}, seed {seed} ({:?}): {e}", m.style);
                }
            }
        }
    }

    #[test]
    fn every_style_is_valid() {
        for pillars in [Pillars::Classic, Pillars::Checker, Pillars::Scattered, Pillars::Rooms, Pillars::Plazas, Pillars::Maze, Pillars::Rings] {
            for symmetry in [Symmetry::None, Symmetry::Mirror, Symmetry::Quad, Symmetry::Rotate] {
                for seed in 0..4 {
                    let style = MapStyle { pillars, symmetry, crate_density: 0.65, teleport_pairs: 5, ..MapStyle::default() };
                    let m = Map::generate_with(61, 61, style, &mut Rng::new(seed));
                    assert_eq!(m.validate(), Ok(()), "{pillars:?} {symmetry:?} seed {seed}");
                }
            }
        }
    }

    #[test]
    fn symmetric_styles_mirror_the_walls() {
        let style = MapStyle { pillars: Pillars::Rooms, symmetry: Symmetry::Quad, ..MapStyle::default() };
        let m = Map::generate_with(41, 41, style, &mut Rng::new(5));
        for y in 0..41 {
            for x in 0..41 {
                let wall = m.get(x, y) == Tile::Wall;
                assert_eq!(wall, m.get(40 - x, y) == Tile::Wall);
                assert_eq!(wall, m.get(x, 40 - y) == Tile::Wall);
            }
        }
        // Rooms really join pillars into longer walls.
        let joined = (1..40).step_by(2).flat_map(|y| (2..40).step_by(2).map(move |x| (x, y))).filter(|&(x, y)| m.get(x, y) == Tile::Wall).count();
        assert!(joined > 20, "{joined} wall segments");
    }

    #[test]
    fn mazes_and_rings_build_long_walls() {
        for (pillars, min_joined) in [(Pillars::Maze, 150), (Pillars::Rings, 40)] {
            for size in [21, 41, 40, 81] {
                for seed in 0..6 {
                    let symmetry = if size % 2 == 1 { Symmetry::Quad } else { Symmetry::None };
                    let style = MapStyle { pillars, symmetry, ..MapStyle::default() };
                    let m = Map::generate_with(size, size, style, &mut Rng::new(seed));
                    assert_eq!(m.validate(), Ok(()), "{pillars:?} size {size} seed {seed}");
                    if size == 81 {
                        let joined = (1..size - 1)
                            .flat_map(|y| (1..size - 1).map(move |x| (x, y)))
                            .filter(|&(x, y)| (x + y) % 2 == 1 && m.get(x, y) == Tile::Wall)
                            .count();
                        assert!(joined >= min_joined, "{pillars:?} seed {seed}: only {joined} joined walls");
                    }
                }
            }
        }
    }

    #[test]
    fn symmetric_styles_mirror_the_crates() {
        let style = MapStyle { pillars: Pillars::Classic, symmetry: Symmetry::Mirror, ice: 0.0, armored: 0.0, conveyors: 0.0, teleport_pairs: 0, ..MapStyle::default() };
        let m = Map::generate_with(41, 41, style, &mut Rng::new(11));
        for y in 0..41 {
            for x in 0..41 {
                assert_eq!(m.get(x, y), m.get(40 - x, y), "({x}, {y})");
            }
        }
    }

    #[test]
    fn teleport_pads_are_not_buried() {
        for seed in 0..20 {
            let m = map(61, seed);
            for &(a, b) in &m.teleports {
                for (px, py) in [a, b] {
                    for (dx, dy) in [(0, -1), (1, 0), (0, 1), (-1, 0)] {
                        assert!(!m.get(px + dx, py + dy).is_breakable(), "seed {seed}: crate next to pad ({px}, {py})");
                    }
                }
            }
        }
    }

    #[test]
    fn spawn_spots_cover_the_arena() {
        for seed in 0..20 {
            let q = map(81, seed).quality();
            assert!(q.spawn_reach <= 16, "seed {seed}: {q}");
        }
    }

    #[test]
    fn the_best_candidate_wins() {
        // `generate` keeps the best of its candidates, so on average it
        // scores at least as well as a single build of the same style.
        let (mut picked, mut single) = (0.0, 0.0);
        for seed in 0..20 {
            let mut rng = Rng::new(seed);
            let m = Map::generate(61, 61, 0.45, &mut rng);
            picked += m.quality().score;
            single += Map::generate_with(61, 61, m.style, &mut Rng::new(seed + 1000)).quality().score;
        }
        assert!(picked >= single, "picked {picked} vs single {single}");
    }

    #[test]
    fn big_maps_have_every_feature() {
        for seed in 0..10 {
            let m = map(81, seed);
            for b in [Biome::Grass, Biome::Snow, Biome::Desert, Biome::Volcano] {
                assert!(m.biomes.iter().any(|s| s.biome == b), "seed {seed}: no {b:?}");
            }
            assert!(m.count(Tile::Ice) > 20, "seed {seed}: snow region has ice");
            assert!(m.count(Tile::Armored) > 10, "seed {seed}: volcano region has armored crates");
            let conveyors = (4..=7).map(|t| m.count(Tile::from_u8(t))).sum::<usize>();
            assert!(conveyors > 3, "seed {seed}: desert region has conveyors");
            assert_ne!(m.teleports.len(), 0, "seed {seed}: the map has teleporter pairs");
            for &(a, b) in &m.teleports {
                assert_eq!(m.teleport_partner(a.0, a.1), Some(b));
                assert_eq!(m.teleport_partner(b.0, b.1), Some(a));
            }
        }
    }

    #[test]
    fn small_maps_get_one_theme() {
        let themes: std::collections::HashSet<_> = (0..30)
            .map(|seed| {
                let m = map(21, seed);
                let b = m.biome(1, 1);
                assert!((1..20).all(|y| (1..20).all(|x| m.biome(x, y) == b)));
                b as u8
            })
            .collect();
        assert!(themes.len() >= 3, "small maps vary their theme");
    }
}
