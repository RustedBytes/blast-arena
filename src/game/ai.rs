//! Server-side AI players. Bots are ordinary `Player`s without a socket: each
//! tick the AI sets their `input_dir` / `want_bomb`, exactly like a client
//! would, so they obey the same movement and bomb rules as humans.
//!
//! The brain works on a shared *danger map* ("ticks until fire" per cell,
//! including chain reactions) and, in priority order: escapes danger, grabs
//! power-ups, bombs enemies, blasts crates, or wanders. It only drops a bomb
//! after checking it can reach a safe cell before the fuse runs out. In a
//! rockets arena it fires down lanes at enemies and nearby crates instead,
//! and the danger map follows each flying rocket's lane so bots step aside.
//!
//! All working memory lives in [`AiScratch`] and the bots' own path buffers,
//! reused tick after tick, so thinking doesn't allocate.

use std::collections::HashMap;

use super::bomb::{Blast, FUSE_TICKS, NUKE_FUSE_TICKS};
use super::items::Item;
use super::map::Tile;
use super::player::{AOI_MAX, DIRS, MAX_BOMBS, MAX_RANGE};
use super::rng::Rng;
use super::{BUCKET, DT, World};

/// Danger value of a cell no known blast will reach.
pub const SAFE: u16 = u16::MAX;
/// Upper bound on cells visited by one path search.
const SEARCH_LIMIT: usize = 400;
/// Bomb spots further than this (in steps) aren't worth evaluating.
const BOMB_SPOT_RANGE: u16 = 8;
/// Extra ticks of slack when racing a fuse through a dangerous cell.
const ESCAPE_MARGIN: f32 = 3.0;
/// Safe cells needed behind a single exit before a bot dares to bomb.
const MIN_SAFE_POCKET: usize = 6;
/// How soon bots assume a remote bomb might be detonated.
const REMOTE_ASSUMED_TICKS: u16 = FUSE_TICKS as u16;
/// Rockets arena: how far down a lane a bot looks for an enemy to shoot,
/// and how near a crate must be to be worth a rocket.
const ROCKET_SIGHT: i32 = 12;
const ROCKET_CRATE_SIGHT: i32 = 5;
/// What hitting an enemy is worth to a bot, against 1 for a crate.
const ROCKET_ENEMY: u32 = 4;
/// What a bomb spot is worth per enemy it traps, on top of the hit itself:
/// once the bomb is down, that enemy can't reach any cell the fire spares.
const TRAP_VALUE: f32 = 12.0;
/// Level of detail: in an arena with at least this many bots, a bot no
/// human can see (farther than the widest view plus `WATCH_MARGIN` cells
/// from every human) plans every `FAR_THINK` ticks instead of every 2 to
/// 4, times `World::ai_slowdown`. It still reacts at once to danger and to
/// its path being blocked, so it plays the same, only less sharply.
pub const LOD_MIN_BOTS: usize = 100;
const WATCH_MARGIN: i32 = 8;
const FAR_THINK: (i32, i32) = (8, 14);

const NAMES: &[&str] = &[
    "Sparky", "Boomer", "Kaboom", "Fuse", "Dynamo", "Pixel", "Zapper", "Turbo", "Nova", "Gizmo",
    "Bolt", "Cinder", "Ember", "Flare", "Rocket", "Jolt", "Volt", "Comet", "Blaze", "Crank",
    "Sprocket", "Widget", "Ziggy", "Echo", "Rivet", "Glitch", "Rusty", "Blinky", "Torque", "Nitro",
];

/// Display name for the n-th bot created, e.g. "Sparky [bot]", "Sparky2 [bot]".
#[must_use]
pub fn bot_name(n: usize) -> String {
    let base = NAMES[n % NAMES.len()];
    match n / NAMES.len() {
        0 => format!("{base} [bot]"),
        round => format!("{base}{} [bot]", round + 1),
    }
}

pub struct BotBrain {
    next_think: u64,
    /// Remaining cells to walk through; the next one is last.
    path: Vec<(i32, i32)>,
    /// Drop a bomb when the path is finished.
    goal_bomb: bool,
    escaping: bool,
    /// Direction to push when stuck (to kick an adjacent bomb).
    push_dir: u8,
    /// Chance of dropping an attack bomb without a safe way out.
    mistake_chance: f32,
}

impl BotBrain {
    pub fn new(rng: &mut Rng) -> Self {
        BotBrain {
            next_think: 0,
            path: Vec::with_capacity(64),
            goal_bomb: false,
            escaping: false,
            push_dir: 0,
            mistake_chance: rng.below(5) as f32 / 100.0,
        }
    }

    fn reset(&mut self) {
        self.path.clear();
        self.goal_bomb = false;
        self.escaping = false;
        self.push_dir = 0;
    }
}

#[derive(Clone, Copy)]
struct Node {
    cell: (i32, i32),
    parent: usize,
    dist: u16,
}

/// Breadth-first search state. `seen` uses generation stamps, so starting a
/// new search never needs to clear it.
#[derive(Default)]
struct Search {
    seen: Vec<u32>,
    generation: u32,
    nodes: Vec<Node>,
    /// Also hop over stone pillars (2 cells), like players can.
    jumps: bool,
}

impl Search {
    /// Explores from `start`; `passable(cell, dist)` decides whether a
    /// neighbour at that distance may be entered. Results land in `nodes`
    /// in order of distance, with the root at index 0.
    fn explore(&mut self, world: &World, start: (i32, i32), passable: impl Fn((i32, i32), u16) -> bool) {
        self.explore_until(world, start, passable, |_| false);
    }

    /// Like `explore`, but after each cell it adds (the root included) asks
    /// `stop`, given the nodes so far (that cell last), whether it has seen
    /// enough; then it stops there and returns true. Everything up to that
    /// point is exactly what `explore` would have found first.
    fn explore_until(
        &mut self,
        world: &World,
        start: (i32, i32),
        passable: impl Fn((i32, i32), u16) -> bool,
        mut stop: impl FnMut(&[Node]) -> bool,
    ) -> bool {
        self.generation = self.generation.wrapping_add(1);
        if self.generation == 0 {
            self.seen.fill(0);
            self.generation = 1;
        }
        let g = self.generation;
        self.seen[world.map.idx(start.0, start.1)] = g;
        self.nodes.clear();
        self.nodes.push(Node { cell: start, parent: 0, dist: 0 });
        if stop(&self.nodes) {
            return true;
        }
        // The hot loop of the bots' thinking: each neighbour's index is
        // worked out once, with one bounds check, and tiles and bombs are
        // read straight from their arrays (`World::walkable`, inlined).
        let (width, height) = (world.map.w, world.map.h);
        let inside = |(x, y): (i32, i32)| x >= 0 && y >= 0 && x < width && y < height;
        let index = |(x, y): (i32, i32)| (y * width + x) as usize;
        let mut head = 0;
        while head < self.nodes.len() && self.nodes.len() < SEARCH_LIMIT {
            let Node { cell, dist, .. } = self.nodes[head];
            for &(dx, dy) in &DIRS[1..] {
                let c = (cell.0 + dx, cell.1 + dy);
                if !inside(c) {
                    continue;
                }
                let i = index(c);
                let tile = world.map.tile_at(i);
                // A pillar ahead: maybe hop over it (counted as two steps).
                if self.jumps && tile == Tile::Wall {
                    let l = (cell.0 + 2 * dx, cell.1 + 2 * dy);
                    if inside(l) {
                        let li = index(l);
                        if !world.map.tile_at(li).is_solid() && world.bomb_grid[li] == 0 && self.seen[li] != g && passable(l, dist + 2) {
                            self.seen[li] = g;
                            self.nodes.push(Node { cell: l, parent: head, dist: dist + 2 });
                            if stop(&self.nodes) {
                                return true;
                            }
                        }
                    }
                    continue;
                }
                if self.seen[i] == g || tile.is_solid() || (c != start && world.bomb_grid[i] != 0) || !passable(c, dist + 1) {
                    continue;
                }
                self.seen[i] = g;
                self.nodes.push(Node { cell: c, parent: head, dist: dist + 1 });
                if stop(&self.nodes) {
                    return true;
                }
            }
            head += 1;
        }
        false
    }

    /// Writes the route from the root to `nodes[k]` into `path`, next step last.
    fn path_to(&self, mut k: usize, path: &mut Vec<(i32, i32)>) {
        path.clear();
        while k != 0 {
            path.push(self.nodes[k].cell);
            k = self.nodes[k].parent;
        }
    }
}

/// A player bots may hunt, as the trap check sees it.
#[derive(Clone, Copy)]
struct Prey {
    id: u32,
    cell: (i32, i32),
    /// Tiles travelled per tick.
    spt: f32,
    team: u8,
    /// Can kick or punch a bomb out of the way, so can't be sealed in.
    shoves: bool,
}

/// The hunted players of this tick, findable by cell: `head[cell]` is the
/// first prey standing there (`NO_PREY` if none), `next[k]` the one after
/// prey `k`. The trap check only looks at the few cells a blast covers,
/// instead of every player in the arena.
#[derive(Default)]
struct PreyIndex {
    list: Vec<Prey>,
    head: Vec<u32>,
    next: Vec<u32>,
}

const NO_PREY: u32 = u32::MAX;

impl PreyIndex {
    fn new(cells: usize) -> Self {
        PreyIndex { list: Vec::with_capacity(64), head: vec![NO_PREY; cells], next: Vec::with_capacity(64) }
    }

    /// Empties it, resetting only the cells last tick's prey stood on.
    fn clear(&mut self, map: &super::map::Map) {
        for p in &self.list {
            self.head[map.idx(p.cell.0, p.cell.1)] = NO_PREY;
        }
        self.list.clear();
        self.next.clear();
    }

    fn push(&mut self, i: usize, prey: Prey) {
        self.next.push(self.head[i]);
        self.head[i] = self.list.len() as u32;
        self.list.push(prey);
    }

    /// The prey standing on cell `i`.
    fn at(&self, i: usize) -> impl Iterator<Item = &Prey> {
        let mut k = self.head[i];
        std::iter::from_fn(move || {
            let p = self.list.get(k as usize)?;
            k = self.next[k as usize];
            Some(p)
        })
    }
}

/// Working memory for the trap check: the planned bomb's fire times laid
/// over the danger map (valid where `stamp` is the current generation, so
/// it never needs clearing), and a search of its own, since it runs while
/// the bot's own search results are still being read.
#[derive(Default)]
struct TrapScratch {
    fire: Vec<u16>,
    stamp: Vec<u32>,
    /// The cells stamped this generation (the bomb's own and its blast's).
    cells: Vec<usize>,
    generation: u32,
    search: Search,
}

impl TrapScratch {
    fn new(cells: usize) -> Self {
        TrapScratch {
            fire: vec![SAFE; cells],
            stamp: vec![0; cells],
            cells: Vec::with_capacity(64),
            generation: 0,
            // Assume the prey can hop pillars: better to miss a trap than
            // to count one that isn't.
            search: Search { seen: vec![0; cells], generation: 0, nodes: Vec::with_capacity(SEARCH_LIMIT + 4), jumps: true },
        }
    }

    /// When fire reaches cell `i`: the danger map, or the planned bomb.
    fn at(&self, danger: &[u16], i: usize) -> u16 {
        if self.stamp[i] == self.generation { danger[i].min(self.fire[i]) } else { danger[i] }
    }
}

/// A bomb as the danger map sees it: where, what blast, and ticks until it
/// goes off (chain reactions included).
#[derive(Clone, Copy)]
struct DangerBomb {
    x: i32,
    y: i32,
    range: u8,
    pierce: bool,
    nuke: bool,
    t: u16,
}

/// A danger map (see [`World::danger_map`]) with its reusable buffers, for
/// whoever needs one outside the bots (the worms).
#[derive(Default)]
pub struct DangerScratch {
    pub danger: Vec<u16>,
    bombs: Vec<DangerBomb>,
    bomb_index: HashMap<u32, usize>,
}

/// Per-tick view of the world shared by all bots, plus search buffers.
#[derive(Default)]
pub struct AiScratch {
    danger: Vec<u16>,
    hypothetical: Vec<u16>,
    /// Living, unshielded players per cell that a bot of each team (index
    /// 0 = no team) may target.
    targets: [Vec<u8>; 3],
    /// Living players per cell.
    occupied: Vec<u8>,
    bombs: Vec<DangerBomb>,
    bomb_index: HashMap<u32, usize>,
    search: Search,
    /// Players bots may hunt, refreshed every tick.
    prey: PreyIndex,
    trap: TrapScratch,
    /// Per player bucket (see `World::buckets`): whether a human can see
    /// into it; empty when every bot thinks at full rate.
    watched: Vec<bool>,
}

impl AiScratch {
    #[must_use]
    pub fn new(cells: usize) -> Self {
        AiScratch {
            danger: vec![SAFE; cells],
            hypothetical: vec![SAFE; cells],
            targets: [vec![0; cells], vec![0; cells], vec![0; cells]],
            occupied: vec![0; cells],
            bombs: Vec::with_capacity(256),
            bomb_index: HashMap::with_capacity(256),
            search: Search { seen: vec![0; cells], generation: 0, nodes: Vec::with_capacity(SEARCH_LIMIT + 4), jumps: true },
            prey: PreyIndex::new(cells),
            trap: TrapScratch::new(cells),
            watched: Vec::new(),
        }
    }
}

impl Me {
    /// The blast of the next bomb this bot would drop.
    fn blast(&self) -> Blast {
        Blast { range: self.range, pierce: self.pierce, nuke: self.nuke }
    }
}

/// What a bot knows about itself while deciding.
#[allow(clippy::struct_excessive_bools, reason = "independent facts a bot weighs")]
struct Me {
    id: u32,
    cur: (i32, i32),
    /// Tiles travelled per tick.
    spt: f32,
    range: u8,
    pierce: bool,
    /// The next bomb dropped is an atomic one.
    nuke: bool,
    can_bomb: bool,
    vulnerable: bool,
    max_bombs: u8,
    speed_lvl: u8,
    kick: bool,
    shielded: bool,
    /// Index into the per-team target grids.
    team: usize,
    /// Has remote bombs waiting to be detonated.
    remote_out: bool,
    /// A rockets arena: the bomb key fires a rocket the way the bot faces.
    rockets: bool,
}

/// Direction from cell `a` to the next cell `b` on a path: a neighbour, or
/// a cell two away in a straight line (a hop over a pillar).
fn dir_between(a: (i32, i32), b: (i32, i32)) -> u8 {
    match (b.0 - a.0, b.1 - a.1) {
        (0, -1 | -2) => 1,
        (1 | 2, 0) => 2,
        (0, 1 | 2) => 3,
        (-1 | -2, 0) => 4,
        _ => 0,
    }
}

/// The next path step is a hop over a pillar.
fn is_hop(a: (i32, i32), b: (i32, i32)) -> bool {
    (b.0 - a.0).abs() + (b.1 - a.1).abs() == 2 && (a.0 == b.0 || a.1 == b.1)
}


impl World {
    pub fn update_bots(&mut self) {
        if self.bot_ids.is_empty() {
            return;
        }
        let mut sc = std::mem::take(&mut self.ai_scratch);
        self.fill_senses(&mut sc);
        self.fill_watched(&mut sc);
        // Stable (ascending id) order, so no bot systematically reacts first.
        for k in 0..self.bot_ids.len() {
            let id = self.bot_ids[k];
            let Some(mut brain) = self.bots.remove(&id) else { continue };
            self.drive_bot(id, &mut brain, &mut sc);
            self.bots.insert(id, brain);
        }
        self.ai_scratch = sc;
    }

    /// Marks the buckets some human can see into (with a margin), for the
    /// level of detail; left empty in arenas with fewer than `LOD_MIN_BOTS`.
    fn fill_watched(&self, sc: &mut AiScratch) {
        sc.watched.clear();
        if self.bot_ids.len() < LOD_MIN_BOTS {
            return;
        }
        let bw = self.buckets_w;
        let bh = (self.map.h + BUCKET - 1) / BUCKET;
        sc.watched.resize((bw * bh) as usize, false);
        let (rx, ry) = (AOI_MAX.0 + WATCH_MARGIN, AOI_MAX.1 + WATCH_MARGIN);
        for p in self.players.values().filter(|p| !p.is_bot()) {
            let (x, y) = p.cell();
            let (bx0, by0) = ((x - rx).max(0) / BUCKET, (y - ry).max(0) / BUCKET);
            let (bx1, by1) = ((x + rx).min(self.map.w - 1) / BUCKET, (y + ry).min(self.map.h - 1) / BUCKET);
            for by in by0..=by1 {
                for bx in bx0..=bx1 {
                    sc.watched[(by * bw + bx) as usize] = true;
                }
            }
        }
    }

    /// Ticks until a bot plans again: 2 to 4, or `FAR_THINK` times the
    /// back-pressure for one no human can see.
    fn think_gap(&mut self, far: bool) -> u64 {
        if far {
            self.rng.between(FAR_THINK.0, FAR_THINK.1) as u64 * u64::from(self.ai_slowdown.max(1))
        } else {
            self.rng.between(2, 4) as u64
        }
    }

    /// Whether a bot at `cell` plans at the reduced, far-away rate.
    fn bot_far(&self, sc: &AiScratch, (x, y): (i32, i32)) -> bool {
        !sc.watched.is_empty() && !sc.watched[((y / BUCKET) * self.buckets_w + x / BUCKET) as usize]
    }

    fn fill_senses(&self, sc: &mut AiScratch) {
        for t in &mut sc.targets {
            t.fill(0);
        }
        sc.occupied.fill(0);
        sc.prey.clear(&self.map);
        let slow = self.weather_slow() * DT;
        for p in self.players.values().filter(|p| p.alive) {
            let (x, y) = p.cell();
            let i = self.map.idx(x, y);
            sc.occupied[i] = sc.occupied[i].saturating_add(1);
            if p.invulnerable_until <= self.tick {
                sc.prey.push(i, Prey { id: p.id, cell: (x, y), spt: p.speed(self.tick) * slow, team: p.team, shoves: p.kick || p.punch });
                for (team, t) in sc.targets.iter_mut().enumerate() {
                    if team == 0 || p.team != team as u8 {
                        t[i] = t[i].saturating_add(1);
                    }
                }
            }
        }
        // So is the Warden: bringing it down scores big.
        if let Some(w) = &self.guard.warden {
            let i = self.map.idx(w.cell.0, w.cell.1);
            for t in &mut sc.targets {
                t[i] = t[i].saturating_add(1);
            }
        }
        // So are monsters.
        for m in &self.monsters.list {
            let i = self.map.idx(m.cell.0, m.cell.1);
            for t in &mut sc.targets {
                t[i] = t[i].saturating_add(1);
            }
        }
        // Worms are fair game for everyone: blowing one up scores.
        for w in &self.worms.list {
            for &(x, y) in &w.body {
                let i = self.map.idx(x, y);
                for t in &mut sc.targets {
                    t[i] = t[i].saturating_add(1);
                }
            }
        }
        self.fill_danger(&mut sc.danger, &mut sc.bombs, &mut sc.bomb_index, true);
    }

    /// Ticks until fire reaches each cell (0 = burning now, `SAFE` = never),
    /// accounting for bombs setting each other off. Allocates; for tests and
    /// tools. The bots use the shared, reused map.
    #[must_use]
    pub fn danger_map(&self) -> Vec<u16> {
        let mut danger = vec![SAFE; (self.map.w * self.map.h) as usize];
        self.fill_danger(&mut danger, &mut Vec::new(), &mut HashMap::new(), true);
        danger
    }

    /// Fills `sc.danger` with when fire comes, worms left out: the worms' own view.
    pub(super) fn refresh_danger(&self, sc: &mut DangerScratch) {
        sc.danger.clear();
        sc.danger.resize((self.map.w * self.map.h) as usize, SAFE);
        self.fill_danger(&mut sc.danger, &mut sc.bombs, &mut sc.bomb_index, false);
    }

    fn fill_danger(&self, danger: &mut [u16], bombs: &mut Vec<DangerBomb>, index: &mut HashMap<u32, usize>, worms: bool) {
        // Burning now is 0; fire an atomic shockwave hasn't reached yet
        // counts down to when it will.
        for ((d, &until), &from) in danger.iter_mut().zip(&self.flame_until).zip(&self.flame_from) {
            *d = if until > self.tick { from.saturating_sub(self.tick).min(u64::from(SAFE) - 1) as u16 } else { SAFE };
        }
        // Sudden death: the next two rings turn to stone on schedule.
        let events = &self.events;
        if events.sd_active && events.sd_radius > super::events::SUDDEN_DEATH_MIN_RADIUS {
            let (centre, radius) = (events.sd_center, events.sd_radius);
            let first = events.sd_next.saturating_sub(self.tick).min(u64::from(SAFE) - 1) as u16;
            let second = first.saturating_add(events.sd_every.min(u64::from(SAFE)) as u16);
            for y in 0..self.map.h {
                for x in 0..self.map.w {
                    let ring = (x - centre.0).abs().max((y - centre.1).abs());
                    let at = if ring >= radius { first } else if ring == radius - 1 { second } else { continue };
                    let i = self.map.idx(x, y);
                    danger[i] = danger[i].min(at);
                }
            }
        }
        // Battle royale: the storm. Outside the zone it's danger now (less
        // pressing nearer the edge, so bots head inwards); between the zone
        // and the next circle, from when the closing edge gets there.
        if self.is_royale() && self.royale.match_on {
            self.zone_danger(danger);
        }
        // Meteors on their way (they hit a tick after landing).
        for &(x, y, at) in &events.meteors {
            let t = (at + 1).saturating_sub(self.tick).min(u64::from(SAFE) - 1) as u16;
            let i = self.map.idx(x, y);
            danger[i] = danger[i].min(t);
            self.trace_blast(x, y, 1, false, true, |_, _, cx, cy| {
                let i = self.map.idx(cx, cy);
                danger[i] = danger[i].min(t);
            });
        }
        bombs.clear();
        index.clear();
        for b in self.bombs.values() {
            let t = b.explode_at.saturating_sub(self.tick).min(u64::from(SAFE) - 1) as u16;
            let t = t.min(danger[self.map.idx(b.x, b.y)]);
            // A remote bomb can go off whenever its owner likes; treat it like
            // a freshly lit one.
            let t = if b.remote { t.min(REMOTE_ASSUMED_TICKS) } else { t };
            let (x, y, t) = if b.rocket && b.slide_dir != 0 && b.attached == 0 {
                self.rocket_lane(b.x, b.y, b.slide_dir, t, danger)
            } else {
                (b.x, b.y, t)
            };
            index.insert(b.id, bombs.len());
            bombs.push(DangerBomb { x, y, range: b.range, pierce: b.pierce, nuke: b.nuke, t });
        }

        // A bomb caught in another's blast goes off no later than the fire
        // reaches it.
        loop {
            let mut changed = false;
            for k in 0..bombs.len() {
                let DangerBomb { x, y, range, pierce, nuke, t } = bombs[k];
                self.blast_footprint((x, y), Blast { range, pierce, nuke }, false, |cx, cy, delay| {
                    let id = self.bomb_grid[self.map.idx(cx, cy)];
                    let at = t.saturating_add(delay);
                    if let Some(&j) = index.get(&id)
                        && bombs[j].t > at {
                            bombs[j].t = at;
                            changed = true;
                        }
                });
            }
            if !changed {
                break;
            }
        }

        for &DangerBomb { x, y, range, pierce, nuke, t } in bombs.iter() {
            let i = self.map.idx(x, y);
            danger[i] = danger[i].min(t);
            self.blast_footprint((x, y), Blast { range, pierce, nuke }, false, |cx, cy, delay| {
                let i = self.map.idx(cx, cy);
                danger[i] = danger[i].min(t.saturating_add(delay));
            });
        }
        if worms {
            self.worm_danger(danger);
            self.monster_danger(danger);
            self.warden_danger(danger);
        }
    }

    /// A flying rocket, one cell a tick: each cell of its lane is deadly from
    /// when it gets there (a direct hit), and it blows up where it runs into
    /// a wall, crate or bomb, or when it's flown its full time. Returns that
    /// impact cell and when it goes off there.
    fn rocket_lane(&self, mut x: i32, mut y: i32, dir: u8, fuse: u16, danger: &mut [u16]) -> (i32, i32, u16) {
        let (dx, dy) = DIRS[dir as usize];
        let mut k: u16 = 0;
        while k < fuse {
            let (nx, ny) = (x + dx, y + dy);
            if !self.map.in_bounds(nx, ny) || self.map.is_solid(nx, ny) || self.bomb_at(nx, ny).is_some() {
                break;
            }
            (x, y) = (nx, ny);
            let i = self.map.idx(x, y);
            // (A tick early: the rocket may move before the bot does.)
            danger[i] = danger[i].min(k);
            k += 1;
        }
        (x, y, fuse.min(k))
    }

    /// The Warden crushes: its cell is deadly now, the cells next to it from
    /// its next step, a wound-up slam's square and a charge's lane from
    /// when they go off.
    fn warden_danger(&self, danger: &mut [u16]) {
        use super::guard::Skill;
        let Some(warden) = &self.guard.warden else { return };
        let tuning = &self.guard.tuning;
        let mut mark = |x: i32, y: i32, at: u64| {
            if self.map.in_bounds(x, y) && !self.map.is_solid(x, y) {
                let i = self.map.idx(x, y);
                danger[i] = danger[i].min(at.min(u64::from(SAFE) - 1) as u16);
            }
        };
        let (x, y) = warden.cell;
        mark(x, y, 0);
        let next = warden.next_step.saturating_sub(self.tick);
        for &(dx, dy) in &DIRS[1..] {
            mark(x + dx, y + dy, next);
        }
        let at = warden.skill_at.saturating_sub(self.tick);
        match warden.skill {
            Skill::Slam => {
                let r = tuning.slam_radius;
                for cy in y - r..=y + r {
                    for cx in x - r..=x + r {
                        mark(cx, cy, at);
                    }
                }
            }
            Skill::Charge(d) | Skill::Charging(d, _) => {
                let (dx, dy) = DIRS[d as usize];
                for k in 1..=tuning.charge_cells {
                    let (cx, cy) = (x + dx * k, y + dy * k);
                    if self.map.is_solid(cx, cy) {
                        break;
                    }
                    mark(cx, cy, at + k as u64 - 1);
                }
            }
            Skill::None => {}
        }
    }

    /// Monsters bite: their cells are deadly now, and the cells next to
    /// one from when it could step there.
    fn monster_danger(&self, danger: &mut [u16]) {
        for m in &self.monsters.list {
            let (x, y) = m.cell;
            danger[self.map.idx(x, y)] = 0;
            let next = m.next_step.max(m.rise_until).saturating_sub(self.tick).min(u64::from(SAFE) - 1) as u16;
            for &(dx, dy) in &DIRS[1..] {
                let (nx, ny) = (x + dx, y + dy);
                if self.map.in_bounds(nx, ny) && !self.map.is_solid(nx, ny) {
                    let i = self.map.idx(nx, ny);
                    danger[i] = danger[i].min(next);
                }
            }
        }
    }

    /// Worms bite: their bodies are deadly now, and the cells around a
    /// head from when it could crawl there.
    fn worm_danger(&self, danger: &mut [u16]) {
        const REACH: i32 = 2;
        for w in &self.worms.list {
            for &(x, y) in &w.body {
                danger[self.map.idx(x, y)] = 0;
            }
            let (hx, hy) = w.head();
            let next = w.next_step.saturating_sub(self.tick).min(u64::from(SAFE) - 1) as u16;
            let step = w.step_ticks.min(u64::from(SAFE)) as u16;
            for dy in -REACH..=REACH {
                for dx in -REACH..=REACH {
                    let steps = dx.abs() + dy.abs();
                    let (x, y) = (hx + dx, hy + dy);
                    if steps == 0 || steps > REACH || !self.map.in_bounds(x, y) || self.map.is_solid(x, y) {
                        continue;
                    }
                    let t = next.saturating_add(step.saturating_mul(steps as u16 - 1));
                    let i = self.map.idx(x, y);
                    danger[i] = danger[i].min(t);
                }
            }
        }
    }

    fn zone_danger(&self, danger: &mut [u16]) {
        use super::royale::{PHASES, ZoneState};
        let z = &self.royale;
        let (cur, next) = (self.zone(), z.to);
        let limit = u32::from(self.storm_limit());
        let tick = self.tick;
        // Ticks until the zone starts moving, and how long the move takes.
        let (wait, shrink) = match z.state {
            ZoneState::Waiting => (z.state_end.saturating_sub(tick), PHASES.get(z.phase).map_or(0, |p| p.1 * u64::from(super::TICK_RATE))),
            ZoneState::Shrinking => (0, z.state_end.saturating_sub(tick)),
            ZoneState::Done => (0, 0),
        };
        for y in 0..self.map.h {
            for x in 0..self.map.w {
                let (cx, cy) = (x as f32 + 0.5, y as f32 + 0.5);
                let d_cur = ((cx - cur.x).powi(2) + (cy - cur.y).powi(2)).sqrt();
                let t = if d_cur > cur.r {
                    let deep = ((d_cur - cur.r) * 6.0) as u32;
                    limit.saturating_sub(deep).max(1)
                } else if z.state != ZoneState::Done && !next.contains(cx, cy) {
                    let span = (cur.r - next.r).max(0.1);
                    let frac = ((cur.r - d_cur) / span).clamp(0.0, 1.0);
                    (wait as f32 + shrink as f32 * frac) as u32 + limit
                } else {
                    continue;
                };
                let i = self.map.idx(x, y);
                danger[i] = danger[i].min(t.min(u32::from(SAFE) - 1) as u16);
            }
        }
    }

    fn drive_bot(&mut self, id: u32, brain: &mut BotBrain, sc: &mut AiScratch) {
        let Some(p) = self.players.get(&id) else { return };
        if !p.alive {
            brain.reset();
            return;
        }
        if p.jump_left > 0 {
            return; // mid-air: nothing to steer
        }
        // Plan hops only with a jump ready (flag carriers can't jump at all).
        sc.search.jumps = p.carrying == 0 && p.jump_ready_at <= self.tick && p.stunned_until <= self.tick;
        let mut trapped = false;
        let me = self.bot_self(p);
        let cur = me.cur;
        while brain.path.last() == Some(&cur) {
            brain.path.pop();
        }
        let in_danger = sc.danger[self.map.idx(cur.0, cur.1)] != SAFE;
        let next_unsafe = brain.path.last().is_some_and(|&(x, y)| {
            self.map.is_solid(x, y) || self.bomb_at(x, y).is_some() || (!brain.escaping && sc.danger[self.map.idx(x, y)] != SAFE)
        });

        let mut want_bomb = false;
        // Rockets arena: the direction to fire in when `want_bomb`.
        let mut fire_dir = 0;
        let far = self.bot_far(sc, cur);
        // A far bot with nothing to do waits for its next planning tick.
        let think = self.tick >= brain.next_think
            || next_unsafe
            || (in_danger && !brain.escaping)
            || (brain.path.is_empty() && !brain.goal_bomb && !far);
        if think {
            brain.next_think = self.tick + self.think_gap(far);
            brain.push_dir = 0;
            if in_danger {
                brain.escaping = true;
                brain.goal_bomb = false;
                if !self.escape_path(&mut sc.search, cur, &sc.danger, me.spt, &mut brain.path) {
                    brain.path.clear();
                    brain.push_dir = self.last_resort_dir(cur, &sc.danger);
                    trapped = true;
                }
            } else {
                brain.escaping = false;
                // Reflex: an enemy is in the line of fire right now.
                if me.rockets {
                    fire_dir = self.rocket_aim(&me, &sc.targets[me.team], false);
                    want_bomb = fire_dir != 0;
                } else if me.can_bomb && self.blast_value(cur, &sc.targets[me.team], &me).1 > 0 {
                    if self.bomb_escape(sc, &me, &mut brain.path) {
                        want_bomb = true;
                        brain.escaping = true;
                        brain.goal_bomb = false;
                    } else if self.rng.chance(brain.mistake_chance) {
                        want_bomb = true;
                    }
                }
                if !want_bomb {
                    self.plan_goal(&me, brain, sc);
                }
            }
        }

        if !want_bomb && !in_danger && brain.goal_bomb && brain.path.is_empty() {
            (want_bomb, fire_dir) = self.at_bomb_spot(&me, brain, sc);
        }

        let mut dir = match brain.path.last() {
            Some(&next) => dir_between(cur, next),
            None => brain.push_dir,
        };
        if dir == 0 {
            brain.path.clear();
        }
        // Stand still on the tick the bomb is dropped so it lands in the cell
        // the escape route was planned from.
        if want_bomb {
            dir = 0;
        }
        let hop = brain.path.last().is_some_and(|&next| is_hop(cur, next));
        let gadget = !want_bomb && self.bot_wants_gadget(id, in_danger, trapped);
        let ability = !want_bomb && self.bot_wants_ability(id, in_danger);
        let p = self.players.get_mut(&id).unwrap();
        p.want_ability |= ability;
        // Turn to aim while standing still: the rocket flies the way the
        // bot faces, and walking after it could run into it.
        if fire_dir != 0 {
            p.facing = fire_dir;
        }
        p.input_dir = dir;
        p.input_alt = 0;
        p.input_jump = hop;
        p.want_bomb |= want_bomb;
        p.want_gadget |= gadget;
        // Safely clear of its remote bombs: set them off.
        if me.remote_out && !in_danger && !want_bomb && !brain.escaping {
            p.want_act = true;
        }
    }

    /// What a bot knows about itself right now.
    fn bot_self(&self, p: &super::player::Player) -> Me {
        Me {
            id: p.id,
            cur: p.cell(),
            spt: p.speed(self.tick) * self.weather_slow() * DT,
            range: p.range,
            pierce: p.pierce,
            nuke: p.nukes > 0,
            can_bomb: p.can_bomb(self.tick) && self.bomb_at(p.cell().0, p.cell().1).is_none(),
            team: p.team as usize,
            remote_out: p.remote && p.active_bombs > 0,
            vulnerable: p.invulnerable_until <= self.tick,
            max_bombs: p.max_bombs,
            speed_lvl: p.speed_lvl,
            kick: p.kick,
            shielded: p.invulnerable_until > self.tick + 20,
            // Cosmos blasters fire bolts, which fly like rockets.
            rockets: matches!(self.mode, super::Mode::Rockets | super::Mode::Cosmos),
        }
    }

    /// Reached a chosen bomb spot: drop only with a safe way out, or, in a
    /// rockets arena, fire if the shot is still there. Returns whether to
    /// press the bomb key, and which way to aim a rocket.
    fn at_bomb_spot(&self, me: &Me, brain: &mut BotBrain, sc: &mut AiScratch) -> (bool, u8) {
        brain.goal_bomb = false;
        brain.next_think = self.tick;
        if me.rockets {
            let d = self.rocket_aim(me, &sc.targets[me.team], true);
            return (d != 0, d);
        }
        let drop = me.can_bomb && self.bomb_escape(sc, me, &mut brain.path);
        brain.escaping |= drop;
        (drop, 0)
    }

    /// Whether a bot should fire its gadget now: drones when enemies are
    /// near, a rocket at an enemy straight ahead, a swap when trapped, and
    /// now and then a mine near enemies.
    fn bot_wants_gadget(&mut self, id: u32, in_danger: bool, trapped: bool) -> bool {
        let p = &self.players[&id];
        if p.gadget_n == 0 {
            return false;
        }
        let (cx, cy) = p.cell();
        let enemy_within = |r: i32| {
            self.players_in_rect(cx - r, cy - r, cx + r, cy + r).any(|o| o.alive && o.id != p.id && p.can_hurt(o))
        };
        match Item::from_u8(p.gadget) {
            Some(Item::Drone | Item::Swarm) => enemy_within(9),
            Some(Item::Rocket) => {
                let (dx, dy) = DIRS[p.facing as usize];
                (1..=10).map(|k| (cx + dx * k, cy + dy * k)).take_while(|&(x, y)| !self.map.is_solid(x, y)).any(|(x, y)| {
                    self.players_in_rect(x, y, x, y).any(|o| o.alive && o.id != p.id && p.can_hurt(o) && o.cell() == (x, y))
                })
            }
            Some(Item::Swap) => trapped,
            Some(Item::Mine) => !in_danger && enemy_within(8) && self.rng.chance(0.05),
            _ => false,
        }
    }

    /// Whether a bot should use its ability now: a dash out of danger, a
    /// wall or a clone when enemies are close, and a portal now and then
    /// (the second one follows a few steps later).
    fn bot_wants_ability(&mut self, id: u32, in_danger: bool) -> bool {
        let p = &self.players[&id];
        if p.ability_n == 0 && !(p.ability == Item::PortalPair as u8 && self.pending_portal(id).is_some()) {
            return false;
        }
        let (cx, cy) = p.cell();
        let enemy_within = |r: i32| {
            self.players_in_rect(cx - r, cy - r, cx + r, cy + r).any(|o| o.alive && o.id != p.id && p.can_hurt(o))
        };
        match Item::from_u8(p.ability) {
            Some(Item::Dash) => in_danger && p.input_dir != 0,
            Some(Item::Builder) => !in_danger && enemy_within(3) && self.rng.chance(0.2),
            Some(Item::Clone) => enemy_within(8) && self.rng.chance(0.05),
            Some(Item::PortalPair) => !in_danger && self.rng.chance(0.03),
            _ => false,
        }
    }

    /// Cells a bot may stop on: belts would carry it off, pads would
    /// teleport it away, and on ice it would keep sliding.
    fn rest_ok(&self, c: (i32, i32)) -> bool {
        let t = self.map.get(c.0, c.1);
        t.conveyor_dir() == 0 && t != Tile::Teleport && t != Tile::Ice
    }

    fn walkable(&self, c: (i32, i32), start: (i32, i32)) -> bool {
        !self.map.is_solid(c.0, c.1) && (c == start || self.bomb_at(c.0, c.1).is_none())
    }

    /// Shortest route to a cell no blast will reach, only crossing cells the
    /// bot can pass before they catch fire. Returns false if there is none.
    fn escape_path(&self, search: &mut Search, start: (i32, i32), danger: &[u16], spt: f32, path: &mut Vec<(i32, i32)>) -> bool {
        // The first such cell found is the nearest: stop there.
        let found = search.explore_until(
            self,
            start,
            |c, dist| {
                let d = danger[self.map.idx(c.0, c.1)];
                d == SAFE || f32::from(d) > (f32::from(dist) + 1.0) / spt + ESCAPE_MARGIN
            },
            |nodes| {
                let c = nodes[nodes.len() - 1].cell;
                danger[self.map.idx(c.0, c.1)] == SAFE && self.rest_ok(c)
            },
        );
        if found {
            search.path_to(search.nodes.len() - 1, path);
        }
        found
    }

    /// Writes an escape route into `path` if the bot could drop a bomb at its
    /// cell now and get away; false when doing so would be suicide, or could
    /// easily become so. Cells where other players stand are avoided, since
    /// they could drop a bomb there and cut the route.
    fn bomb_escape(&self, sc: &mut AiScratch, me: &Me, path: &mut Vec<(i32, i32)>) -> bool {
        let cur = me.cur;
        sc.hypothetical.copy_from_slice(&sc.danger);
        let hyp = &mut sc.hypothetical;
        let ci = self.map.idx(cur.0, cur.1);
        // If another blast reaches this cell first, the new bomb chains with it.
        let fuse = if me.nuke { NUKE_FUSE_TICKS } else { FUSE_TICKS };
        let t = (fuse as u16).min(sc.danger[ci]);
        hyp[ci] = hyp[ci].min(t);
        self.blast_footprint(cur, me.blast(), false, |x, y, delay| {
            let i = self.map.idx(x, y);
            hyp[i] = hyp[i].min(t.saturating_add(delay));
        });
        let (hyp, occupied, spt) = (&sc.hypothetical, &sc.occupied, me.spt);
        // Insist on a robust way out: either two separate exits, or a roomy
        // safe area, so another player can't seal the only escape cell. The
        // search stops once that's settled; the nearest safe cell is the
        // first one found either way.
        let mut exits = [false; 4];
        let mut safe_cells = 0;
        let mut nearest = None;
        let robust = |exits: &[bool; 4], safe_cells: usize| exits.iter().filter(|&&e| e).count() >= 2 || safe_cells >= MIN_SAFE_POCKET;
        sc.search.explore_until(
            self,
            cur,
            |c, dist| {
                let i = self.map.idx(c.0, c.1);
                let d = hyp[i];
                occupied[i] == 0 && (d == SAFE || f32::from(d) > (f32::from(dist) + 1.0) / spt + ESCAPE_MARGIN)
            },
            |nodes| {
                let k = nodes.len() - 1;
                let n = nodes[k];
                if k == 0 || hyp[self.map.idx(n.cell.0, n.cell.1)] != SAFE || !self.rest_ok(n.cell) {
                    return false;
                }
                safe_cells += 1;
                nearest.get_or_insert(k);
                let mut first = k;
                while nodes[first].parent != 0 {
                    first = nodes[first].parent;
                }
                exits[dir_between(cur, nodes[first].cell) as usize - 1] = true;
                robust(&exits, safe_cells)
            },
        );
        match nearest {
            Some(k) if robust(&exits, safe_cells) => {
                sc.search.path_to(k, path);
                true
            }
            _ => false,
        }
    }

    /// When there's no way out, step to the neighbour that burns last, or
    /// push into an adjacent bomb (a kick, or the trapped-player kick).
    fn last_resort_dir(&self, cur: (i32, i32), danger: &[u16]) -> u8 {
        let here = danger[self.map.idx(cur.0, cur.1)];
        let best = (1..=4u8)
            .filter_map(|d| {
                let (dx, dy) = DIRS[d as usize];
                let c = (cur.0 + dx, cur.1 + dy);
                self.walkable(c, cur).then(|| (danger[self.map.idx(c.0, c.1)], d))
            })
            .max();
        match best {
            Some((t, d)) if t > here => d,
            _ => self.adjacent_bomb_dir(cur),
        }
    }

    /// (crates destroyed, enemies hit) by the bot's bomb placed at `c`.
    fn blast_value(&self, c: (i32, i32), targets: &[u8], me: &Me) -> (u32, u32) {
        let mut crates = 0;
        let mut hit = u32::from(targets[self.map.idx(c.0, c.1)]);
        let mut hits_self = c == me.cur;
        self.blast_footprint(c, me.blast(), true, |x, y, _| {
            if self.map.get(x, y).is_breakable() {
                crates += 1;
            }
            hit += u32::from(targets[self.map.idx(x, y)]);
            hits_self |= (x, y) == me.cur;
        });
        if hits_self && me.vulnerable {
            hit = hit.saturating_sub(1);
        }
        (crates, hit)
    }

    /// How many enemies a bomb this bot drops at `spot`, `head_start` ticks
    /// from now (its walk there), would leave with no way out: every cell
    /// they could still reach before it burns, burns. Each enemy gets the
    /// benefit of the doubt (it runs flat out the moment it sees the bomb
    /// coming, hops pillars, and other bombs aren't set off any sooner), so
    /// a trap counted here is one that really holds.
    fn trapped_prey(&self, spot: (i32, i32), me: &Me, head_start: f32, danger: &[u16], prey: &PreyIndex, trap: &mut TrapScratch) -> u32 {
        trap.generation = trap.generation.wrapping_add(1);
        if trap.generation == 0 {
            trap.stamp.fill(0);
            trap.generation = 1;
        }
        let g = trap.generation;
        // Ticks from now until the bomb goes off: its fuse after the walk,
        // or sooner if other fire reaches it first.
        let fuse = if me.nuke { NUKE_FUSE_TICKS } else { FUSE_TICKS } as f32;
        let si = self.map.idx(spot.0, spot.1);
        let t = ((head_start + fuse).min(f32::from(SAFE - 1)) as u16).min(danger[si]);
        trap.stamp[si] = g;
        trap.fire[si] = t;
        trap.cells.clear();
        trap.cells.push(si);
        self.blast_footprint(spot, me.blast(), false, |x, y, delay| {
            let i = self.map.idx(x, y);
            let at = t.saturating_add(delay);
            if trap.stamp[i] != g {
                trap.stamp[i] = g;
                trap.fire[i] = at;
                trap.cells.push(i);
            } else if trap.fire[i] > at {
                trap.fire[i] = at;
            }
        });

        // Only the prey standing in the blast can be trapped by it.
        let mut count = 0;
        let cells = std::mem::take(&mut trap.cells);
        for p in cells.iter().flat_map(|&i| prey.at(i)) {
            let hostile = me.team == 0 || p.team as usize != me.team;
            // Outside the blast it's already safe; with kick or punch it
            // can knock the bomb aside.
            if p.id == me.id || !hostile || p.shoves || trap.stamp[self.map.idx(p.cell.0, p.cell.1)] != g {
                continue;
            }
            let prey_spt = p.spt.max(0.01);
            let mut search = std::mem::take(&mut trap.search);
            // The new bomb blocks its own cell.
            // It escapes as soon as it can reach a cell the fire never
            // touches, so the search stops there.
            let reached_safety = search.explore_until(
                self,
                p.cell,
                |c, dist| {
                    let d = trap.at(danger, self.map.idx(c.0, c.1));
                    c != spot && (d == SAFE || f32::from(d) > f32::from(dist) / prey_spt)
                },
                |nodes| {
                    let c = nodes[nodes.len() - 1].cell;
                    trap.at(danger, self.map.idx(c.0, c.1)) == SAFE
                },
            );
            // A search cut short at its limit proves nothing.
            let escapes = reached_safety || search.nodes.len() >= SEARCH_LIMIT;
            trap.search = search;
            count += u32::from(!escapes);
        }
        trap.cells = cells;
        count
    }

    /// Rockets arena: which way to fire right now (0: hold fire). A rocket
    /// flies off and spares its shooter, so unlike a bomb it needs no way
    /// out, just a clear shot at an enemy (or, with `crates`, at a crate).
    fn rocket_aim(&self, me: &Me, targets: &[u8], crates: bool) -> u8 {
        if !me.can_bomb {
            return 0;
        }
        self.rocket_shot(me.cur, targets).filter(|&(_, v)| crates || v >= ROCKET_ENEMY).map_or(0, |(d, _)| d)
    }

    /// Rockets arena: the best rocket to fire from `c`, as a direction and
    /// a value: `ROCKET_ENEMY` for each enemy first in line down a lane, 1
    /// for a nearby crate the rocket would blow open. None when no lane
    /// has anything worth a rocket.
    fn rocket_shot(&self, c: (i32, i32), targets: &[u8]) -> Option<(u8, u32)> {
        let mut best: Option<(u8, u32)> = None;
        for d in 1..=4u8 {
            let (dx, dy) = DIRS[d as usize];
            let mut value = 0;
            for k in 1..=ROCKET_SIGHT {
                let (x, y) = (c.0 + dx * k, c.1 + dy * k);
                if !self.map.in_bounds(x, y) || self.bomb_at(x, y).is_some() {
                    break;
                }
                if self.map.is_solid(x, y) {
                    if k <= ROCKET_CRATE_SIGHT && self.map.get(x, y).is_breakable() {
                        value = 1;
                    }
                    break;
                }
                let hit = u32::from(targets[self.map.idx(x, y)]);
                if hit > 0 {
                    value = ROCKET_ENEMY * hit;
                    break;
                }
            }
            if value > 0 && best.is_none_or(|(_, v)| value > v) {
                best = Some((d, value));
            }
        }
        best
    }

    fn item_value(item: Item, me: &Me) -> f32 {
        match item {
            Item::ExtraBomb if me.max_bombs < MAX_BOMBS => 6.0,
            Item::Range if me.range < MAX_RANGE => 6.0,
            Item::FullFire if me.range < MAX_RANGE => 7.0,
            Item::Speed if me.speed_lvl < 4 => 5.0,
            Item::Kick if !me.kick => 5.0,
            Item::Pierce if !me.pierce => 5.0,
            Item::Shield if !me.shielded => 4.0,
            // A gamble (usually good, sometimes a curse), and hearts back
            // in the dungeon.
            Item::Mystery | Item::Heart => 4.0,
            // Cosmos: a new blaster colour, and rapid fire.
            Item::PlasmaCore | Item::CryoCore | Item::PhaseCore | Item::NovaCore | Item::Overdrive => 4.5,
            Item::Nuke => 5.0,
            Item::Remote
            | Item::Punch
            | Item::LineBomb
            | Item::Ghost
            | Item::Builder
            | Item::GasBomb
            | Item::Clone
            | Item::StickyBomb
            | Item::PortalPair
            | Item::Dash => 3.0,
            _ => 1.0,
        }
    }

    /// Picks the most worthwhile reachable target (power-up, attack spot or
    /// crate-blasting spot), or wanders when there's nothing to do.
    fn plan_goal(&mut self, me: &Me, brain: &mut BotBrain, sc: &mut AiScratch) {
        let danger = &sc.danger;
        sc.search.explore(self, me.cur, |c, _| danger[self.map.idx(c.0, c.1)] == SAFE);
        let nodes = &sc.search.nodes;
        let mut best: Option<(f32, usize, bool)> = None;
        for (k, n) in nodes.iter().enumerate() {
            let i = self.map.idx(n.cell.0, n.cell.1);
            let reach = f32::from(n.dist) + 1.0;
            let jitter = 1.0 + self.rng.below(100) as f32 / 1000.0;
            let mut consider = |value: f32, bomb: bool| {
                let score = value / reach * jitter;
                if value > 0.0 && best.is_none_or(|b| score > b.0) {
                    best = Some((score, k, bomb));
                }
            };
            if k > 0
                && let Some(item) = Item::from_u8(self.items[i]) {
                    consider(Self::item_value(item, me), false);
                }
            if me.can_bomb && n.dist <= BOMB_SPOT_RANGE && self.rest_ok(n.cell) {
                if me.rockets {
                    // A spot with a clear shot down a lane.
                    if let Some((_, v)) = self.rocket_shot(n.cell, &sc.targets[me.team]) {
                        consider(v as f32, true);
                    }
                } else {
                    let (crates, enemies) = self.blast_value(n.cell, &sc.targets[me.team], me);
                    // Only a spot whose blast hits someone can trap them.
                    let trapped = if enemies > 0 {
                        let head_start = f32::from(n.dist) / me.spt.max(0.01);
                        self.trapped_prey(n.cell, me, head_start, &sc.danger, &sc.prey, &mut sc.trap)
                    } else {
                        0
                    };
                    consider(crates as f32 + 4.0 * enemies as f32 + TRAP_VALUE * trapped as f32, true);
                }
            }
        }

        brain.goal_bomb = false;
        brain.path.clear();
        if let Some((_, k, bomb)) = best {
            sc.search.path_to(k, &mut brain.path);
            brain.goal_bomb = bomb;
        } else if nodes.len() > 1 {
            // Nothing in reach: head somewhere far to explore. The nodes are
            // in distance order, so the far ones are a suffix.
            let far = nodes.last().unwrap().dist.saturating_sub(2);
            let first_far = nodes.iter().position(|n| n.dist >= far).unwrap();
            let k = first_far + self.rng.below((nodes.len() - first_far) as u32) as usize;
            // Prefer somewhere it can stand still.
            let k = (k..nodes.len()).chain(first_far..k).find(|&j| self.rest_ok(nodes[j].cell)).unwrap_or(k);
            sc.search.path_to(k, &mut brain.path);
        }
    }

    fn adjacent_bomb_dir(&self, cur: (i32, i32)) -> u8 {
        (1..=4u8)
            .find(|&d| {
                let (dx, dy) = DIRS[d as usize];
                self.bomb_at(cur.0 + dx, cur.1 + dy).is_some()
            })
            .unwrap_or(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::map::Map;
    use crate::game::{World, test_world};

    impl World {
        fn spawn_test_bot(&mut self, x: f32, y: f32) -> u32 {
            let id = self.add_bot();
            let p = self.players.get_mut(&id).unwrap();
            p.x = x;
            p.y = y;
            p.invulnerable_until = 0;
            self.bots.get_mut(&id).unwrap().mistake_chance = 0.0;
            id
        }
    }

    /// The searches that stop early (escapes, bomb escapes, traps) must
    /// decide exactly what exploring everything would. Checked against the
    /// exhaustive versions, for every bot of a busy arena.
    #[test]
    fn early_stopping_searches_match_exhaustive_ones() {
        let mut rng = crate::game::rng::Rng::new(11);
        let map = Map::generate(61, 61, 0.45, &mut rng);
        let mut w = World::with_map(map, rng, 200);
        w.set_target_bots(150);
        let (mut escapes, mut bomb_escapes, mut traps) = (0, 0, 0);
        for round in 0..6 {
            for _ in 0..60 {
                w.step();
            }
            let mut sc = AiScratch::new((w.map.w * w.map.h) as usize);
            w.fill_senses(&mut sc);
            for id in w.bot_ids.clone() {
                let p = &w.players[&id];
                if !p.alive {
                    continue;
                }
                let me = w.bot_self(p);
                sc.search.jumps = round % 2 == 0;
                // Escape from danger: same verdict, same route.
                let (mut fast, mut full) = (Vec::new(), Vec::new());
                let a = w.escape_path(&mut sc.search, me.cur, &sc.danger, me.spt, &mut fast);
                let b = escape_reference(&w, &mut sc.search, me.cur, &sc.danger, me.spt, &mut full);
                assert_eq!((a, &fast), (b, &full), "escape for bot {id}");
                escapes += 1;
                // Bombing here and getting away.
                let a = w.bomb_escape(&mut sc, &me, &mut fast);
                let b = bomb_escape_reference(&w, &mut sc, &me, &mut full);
                assert_eq!((a, &fast), (b, &full), "bomb escape for bot {id}");
                bomb_escapes += 1;
                // Traps from a few spots around.
                for spot in [me.cur, (me.cur.0 + 1, me.cur.1), (me.cur.0, me.cur.1 + 2)] {
                    if w.map.in_bounds(spot.0, spot.1) && !w.map.is_solid(spot.0, spot.1) {
                        let a = w.trapped_prey(spot, &me, 3.0, &sc.danger, &sc.prey, &mut sc.trap);
                        let b = trapped_reference(&w, spot, &me, 3.0, &sc.danger, &sc.prey.list, &mut sc.trap);
                        assert_eq!(a, b, "trap from {spot:?} for bot {id}");
                        traps += 1;
                    }
                }
            }
        }
        assert!(escapes > 300 && bomb_escapes > 300 && traps > 300, "{escapes} {bomb_escapes} {traps}");
    }

    /// `escape_path` before it stopped early: explore all, then pick.
    fn escape_reference(w: &World, search: &mut Search, start: (i32, i32), danger: &[u16], spt: f32, path: &mut Vec<(i32, i32)>) -> bool {
        search.explore(w, start, |c, dist| {
            let d = danger[w.map.idx(c.0, c.1)];
            d == SAFE || f32::from(d) > (f32::from(dist) + 1.0) / spt + ESCAPE_MARGIN
        });
        match search.nodes.iter().position(|n| danger[w.map.idx(n.cell.0, n.cell.1)] == SAFE && w.rest_ok(n.cell)) {
            Some(k) => {
                search.path_to(k, path);
                true
            }
            None => false,
        }
    }

    /// `bomb_escape` before it stopped early.
    fn bomb_escape_reference(w: &World, sc: &mut AiScratch, me: &Me, path: &mut Vec<(i32, i32)>) -> bool {
        let cur = me.cur;
        sc.hypothetical.copy_from_slice(&sc.danger);
        let hyp = &mut sc.hypothetical;
        let ci = w.map.idx(cur.0, cur.1);
        let fuse = if me.nuke { NUKE_FUSE_TICKS } else { FUSE_TICKS };
        let t = (fuse as u16).min(sc.danger[ci]);
        hyp[ci] = hyp[ci].min(t);
        w.blast_footprint(cur, me.blast(), false, |x, y, delay| {
            let i = w.map.idx(x, y);
            hyp[i] = hyp[i].min(t.saturating_add(delay));
        });
        let (hyp, occupied, spt) = (&sc.hypothetical, &sc.occupied, me.spt);
        sc.search.explore(w, cur, |c, dist| {
            let i = w.map.idx(c.0, c.1);
            let d = hyp[i];
            occupied[i] == 0 && (d == SAFE || f32::from(d) > (f32::from(dist) + 1.0) / spt + ESCAPE_MARGIN)
        });
        let nodes = &sc.search.nodes;
        let mut exits = [false; 4];
        let mut safe_cells = 0;
        let mut nearest = None;
        for (k, n) in nodes.iter().enumerate().skip(1) {
            if hyp[w.map.idx(n.cell.0, n.cell.1)] != SAFE || !w.rest_ok(n.cell) {
                continue;
            }
            safe_cells += 1;
            nearest.get_or_insert(k);
            let mut first = k;
            while nodes[first].parent != 0 {
                first = nodes[first].parent;
            }
            exits[dir_between(cur, nodes[first].cell) as usize - 1] = true;
        }
        let exits = exits.iter().filter(|&&e| e).count();
        match nearest {
            Some(k) if exits >= 2 || safe_cells >= MIN_SAFE_POCKET => {
                sc.search.path_to(k, path);
                true
            }
            _ => false,
        }
    }

    /// `trapped_prey` before it looked prey up by cell and stopped early:
    /// every prey, explored in full.
    fn trapped_reference(w: &World, spot: (i32, i32), me: &Me, head_start: f32, danger: &[u16], prey: &[Prey], trap: &mut TrapScratch) -> u32 {
        trap.generation = trap.generation.wrapping_add(1);
        let g = trap.generation;
        let fuse = if me.nuke { NUKE_FUSE_TICKS } else { FUSE_TICKS } as f32;
        let si = w.map.idx(spot.0, spot.1);
        let t = ((head_start + fuse).min(f32::from(SAFE - 1)) as u16).min(danger[si]);
        trap.stamp[si] = g;
        trap.fire[si] = t;
        w.blast_footprint(spot, me.blast(), false, |x, y, delay| {
            let i = w.map.idx(x, y);
            let at = t.saturating_add(delay);
            if trap.stamp[i] != g || trap.fire[i] > at {
                trap.stamp[i] = g;
                trap.fire[i] = at;
            }
        });
        let mut count = 0;
        for p in prey {
            let hostile = me.team == 0 || p.team as usize != me.team;
            if p.id == me.id || !hostile || p.shoves || trap.stamp[w.map.idx(p.cell.0, p.cell.1)] != g {
                continue;
            }
            let prey_spt = p.spt.max(0.01);
            let mut search = std::mem::take(&mut trap.search);
            search.explore(w, p.cell, |c, dist| {
                let d = trap.at(danger, w.map.idx(c.0, c.1));
                c != spot && (d == SAFE || f32::from(d) > f32::from(dist) / prey_spt)
            });
            let escapes = search.nodes.len() >= SEARCH_LIMIT || search.nodes.iter().any(|n| trap.at(danger, w.map.idx(n.cell.0, n.cell.1)) == SAFE);
            trap.search = search;
            count += u32::from(!escapes);
        }
        count
    }

    #[test]
    fn far_bots_plan_less_often_in_a_crowded_arena() {
        // Room for more bots than `test_world` allows.
        let mut w = World::with_map(Map::empty(161, 161), Rng::new(3), 400);
        w.input_lockstep = false;
        w.spawn_test_player(5.5, 5.5);
        w.set_target_bots(LOD_MIN_BOTS + 40);
        assert_eq!(w.bot_ids.len(), LOD_MIN_BOTS + 40);
        for _ in 0..10 {
            w.step();
        }
        let mut sc = std::mem::take(&mut w.ai_scratch);
        w.fill_watched(&mut sc);
        assert!(!w.bot_far(&sc, (5, 5)), "the human's surroundings are watched");
        assert!(w.bot_far(&sc, (150, 150)), "the far corner is not");
        w.ai_scratch = sc;
        // A bot planned on a tick when its next planning tick moved.
        let far = |w: &World, id: u32| w.players[&id].alive && (w.players[&id].cell().0 >= 40 || w.players[&id].cell().1 >= 40);
        let (mut thinks_far, mut far_bots) = (0u32, 0u32);
        for _ in 0..200 {
            let before: HashMap<u32, u64> = w.bots.iter().map(|(&id, b)| (id, b.next_think)).collect();
            w.step();
            for (&id, b) in &w.bots {
                if far(&w, id) {
                    far_bots += 1;
                    thinks_far += u32::from(before.get(&id).is_some_and(|&t| t != b.next_think));
                }
            }
        }
        // Near bots plan every 2-4 ticks; far ones every 8-14 unless danger
        // or a blocked path makes them.
        let rate = f64::from(thinks_far) / f64::from(far_bots.max(1));
        assert!(rate < 0.2, "far bots planned {rate:.2} times a tick each");
        // A small arena keeps every bot at full rate.
        let mut small = test_world(Map::empty(41, 41));
        small.spawn_test_player(5.5, 5.5);
        small.set_target_bots(10);
        let mut sc = std::mem::take(&mut small.ai_scratch);
        small.fill_watched(&mut sc);
        assert!(!small.bot_far(&sc, (35, 35)));
    }

    #[test]
    fn back_pressure_follows_the_tick_time() {
        use std::time::Duration;
        let mut w = test_world(Map::empty(15, 15));
        assert_eq!(w.ai_slowdown, 1);
        for _ in 0..10 {
            w.adapt_ai_load(Duration::from_millis(12));
        }
        assert_eq!(w.ai_slowdown, crate::game::tick::MAX_AI_SLOWDOWN, "capped");
        w.adapt_ai_load(Duration::from_millis(6));
        assert_eq!(w.ai_slowdown, crate::game::tick::MAX_AI_SLOWDOWN, "in between: holds");
        for _ in 0..10 {
            w.adapt_ai_load(Duration::from_millis(1));
        }
        assert_eq!(w.ai_slowdown, 1);
    }

    #[test]
    fn bot_escapes_a_bomb() {
        let mut w = test_world(Map::empty(15, 15));
        let dummy = w.spawn_test_player(3.5, 1.5);
        w.players.get_mut(&dummy).unwrap().range = 3;
        w.place_bomb(dummy);
        w.players.get_mut(&dummy).unwrap().x = 13.5;
        w.players.get_mut(&dummy).unwrap().y = 13.5;
        let bot = w.spawn_test_bot(1.5, 1.5);
        assert_ne!(w.danger_map()[w.map.idx(1, 1)], SAFE, "bot starts in the blast");
        for _ in 0..FUSE_TICKS + 15 {
            w.step();
        }
        assert!(w.players[&bot].alive, "bot should have fled");
        assert_eq!(w.stats.deaths, 0);
    }

    #[test]
    fn danger_map_follows_chain_reactions() {
        let mut w = test_world(Map::empty(15, 15));
        let a = w.spawn_test_player(1.5, 1.5);
        let b = w.spawn_test_player(3.5, 1.5);
        w.place_bomb(a);
        w.tick += 30; // bomb a now has 20 ticks left
        w.place_bomb(b); // bomb b alone would have 50
        let d = w.danger_map();
        assert_eq!(d[w.map.idx(5, 1)], 20, "b's blast inherits a's earlier timer");
        assert_eq!(d[w.map.idx(9, 9)], SAFE);
    }

    /// Enemies a bomb by `bot` at `spot`, dropped `head_start` ticks from
    /// now, would trap.
    fn traps(w: &World, bot: u32, spot: (i32, i32), head_start: f32) -> u32 {
        let mut sc = AiScratch::new((w.map.w * w.map.h) as usize);
        w.fill_senses(&mut sc);
        let mut me = w.bot_self(&w.players[&bot]);
        me.range = 2;
        w.trapped_prey(spot, &me, head_start, &sc.danger, &sc.prey, &mut sc.trap)
    }

    /// A dead end at (1,1): crates below it and below the pillar next to
    /// it, so its only way out is east along row 1.
    fn dead_end_world() -> World {
        let mut map = Map::empty(15, 15);
        map.set(1, 2, Tile::Crate);
        map.set(2, 3, Tile::Crate);
        test_world(map)
    }

    #[test]
    fn bomb_at_the_mouth_of_a_dead_end_traps() {
        let mut w = dead_end_world();
        let bot = w.spawn_test_bot(9.5, 9.5);
        let enemy = w.spawn_test_player(1.5, 1.5);
        w.players.get_mut(&enemy).unwrap().invulnerable_until = 0;
        assert_eq!(traps(&w, bot, (3, 1), 0.0), 1, "sealed in at (1,1)");
        // However long the bot takes to get there, there's nowhere to go.
        assert_eq!(traps(&w, bot, (3, 1), 20.0), 1);
        // A blast that doesn't reach it traps nothing.
        assert_eq!(traps(&w, bot, (5, 1), 0.0), 0);
    }

    #[test]
    fn open_ground_or_a_kick_is_no_trap() {
        let mut w = test_world(Map::empty(15, 15));
        let bot = w.spawn_test_bot(9.5, 9.5);
        let enemy = w.spawn_test_player(1.5, 1.5);
        w.players.get_mut(&enemy).unwrap().invulnerable_until = 0;
        // (1,2) and on down column 1 stay clear of the blast.
        assert_eq!(traps(&w, bot, (3, 1), 0.0), 0);

        let mut w = dead_end_world();
        let bot = w.spawn_test_bot(9.5, 9.5);
        let enemy = w.spawn_test_player(1.5, 1.5);
        let p = w.players.get_mut(&enemy).unwrap();
        p.invulnerable_until = 0;
        p.kick = true;
        assert_eq!(traps(&w, bot, (3, 1), 0.0), 0, "can kick the bomb away");
    }

    #[test]
    fn a_teammate_is_never_counted_as_trapped() {
        let mut w = dead_end_world();
        let bot = w.spawn_test_bot(9.5, 9.5);
        let mate = w.spawn_test_player(1.5, 1.5);
        w.players.get_mut(&mate).unwrap().invulnerable_until = 0;
        w.players.get_mut(&mate).unwrap().team = 1;
        w.players.get_mut(&bot).unwrap().team = 1;
        assert_eq!(traps(&w, bot, (3, 1), 0.0), 0);
        w.players.get_mut(&mate).unwrap().team = 2;
        assert_eq!(traps(&w, bot, (3, 1), 0.0), 1, "the other team's player is");
    }

    #[test]
    fn bot_never_bombs_a_dead_end() {
        // (1,1) and (2,1) open; (3,1) and (1,2) crates; (2,2) pillar, with a
        // crate behind it at (2,3) so it can't be hopped over either.
        let mut map = Map::empty(15, 15);
        map.set(3, 1, Tile::Crate);
        map.set(1, 2, Tile::Crate);
        map.set(2, 3, Tile::Crate);
        let mut w = test_world(map);
        let bot = w.spawn_test_bot(1.5, 1.5);
        for _ in 0..200 {
            w.step();
        }
        assert!(w.bombs.is_empty());
        assert!(w.players[&bot].alive);
    }

    #[test]
    fn bot_outruns_sudden_death() {
        let mut w = test_world(Map::empty(41, 41));
        let bot = w.spawn_test_bot(1.5, 1.5);
        w.round_end = w.tick + crate::game::events::SUDDEN_DEATH_TICKS;
        w.step();
        // Bots see the closing rings coming.
        let (c, r) = (w.events.sd_center, w.events.sd_radius);
        let d = w.danger_map();
        // A cell of the second ring to close, on whichever side is on the map.
        let edge = if c.0 + r - 1 < w.map.w { c.0 + r - 1 } else { c.0 - r + 1 };
        assert_ne!(d[w.map.idx(edge, c.1)], SAFE, "the next rings are dangerous");
        assert_eq!(d[w.map.idx(c.0, c.1)], SAFE, "the middle is safe");
        for _ in 0..crate::game::events::SUDDEN_DEATH_TICKS - 20 {
            w.step();
        }
        assert!(w.events.sd_active);
        assert_eq!(w.events.sd_radius, crate::game::events::SUDDEN_DEATH_MIN_RADIUS, "fully shrunk");
        assert!(w.players[&bot].alive, "the bot moved inwards in time");
        assert_eq!(w.stats.deaths, 0);
    }

    #[test]
    fn bot_collects_nearby_item() {
        let mut w = test_world(Map::empty(15, 15));
        let i = w.map.idx(5, 1);
        w.items[i] = Item::Range as u8;
        let bot = w.spawn_test_bot(1.5, 1.5);
        for _ in 0..40 {
            w.step();
        }
        assert_eq!(w.items[i], 0);
        assert!(w.players[&bot].range > crate::game::player::BASE_RANGE);
    }

    #[test]
    fn bots_play_well() {
        // Three worlds (with every biome hazard) smooth out run-to-run noise.
        let (mut crates, mut items, mut suicides) = (0, 0, 0);
        for seed in [11, 12, 13] {
            let mut rng = Rng::new(seed);
            let map = Map::generate(41, 41, 0.45, &mut rng);
            let mut w = World::with_map(map, rng, 64);
            for _ in 0..10 {
                w.add_bot();
            }
            for _ in 0..2000 {
                w.step();
            }
            let s = w.stats;
            eprintln!("seed {seed}: {s:?}");
            crates += s.crates_destroyed;
            items += s.items_picked;
            suicides += s.suicides;
        }
        assert!(crates >= 450, "bots should farm crates: {crates}");
        assert!(items >= 60, "bots should collect power-ups: {items}");
        // 3 x 10 bots x 100 s: well under one suicide per bot per minute.
        assert!(suicides <= 21, "too many suicides: {suicides}");
    }
    #[test]
    fn danger_map_follows_a_rocket_lane() {
        let mut w = test_world(Map::empty(21, 21));
        w.mode = crate::game::Mode::Rockets;
        let me = w.spawn_test_player(3.5, 5.5);
        w.players.get_mut(&me).unwrap().facing = 2; // right
        assert!(w.place_bomb(me));
        let d = w.danger_map();
        assert_eq!(d[w.map.idx(4, 5)], 0, "the next cell: any moment now");
        assert_eq!(d[w.map.idx(12, 5)], 8, "further down the lane, later");
        assert!(d[w.map.idx(19, 5)] <= 16, "the far end, where it hits the border");
        assert_eq!(d[w.map.idx(12, 7)], SAFE, "a lane over is safe");
    }

    #[test]
    fn bot_dodges_an_incoming_rocket() {
        let mut w = test_world(Map::empty(21, 21));
        w.mode = crate::game::Mode::Rockets;
        let shooter = w.spawn_test_player(1.5, 5.5);
        w.players.get_mut(&shooter).unwrap().facing = 2; // right, at the bot
        let bot = w.spawn_test_bot(11.5, 5.5);
        assert!(w.place_bomb(shooter));
        // Move the shooter out of the bot's sights so it doesn't fire back.
        w.players.get_mut(&shooter).unwrap().y = 19.5;
        for _ in 0..40 {
            w.step();
        }
        assert!(w.players[&bot].alive, "the bot stepped out of the lane");
        assert_eq!(w.stats.deaths, 0);
    }

    #[test]
    fn rocket_bots_fire_rockets_and_never_plant_bombs() {
        let (mut rockets, mut kills, mut crates, mut suicides) = (0, 0, 0, 0);
        for seed in [21, 22] {
            let mut rng = Rng::new(seed);
            let map = Map::generate(41, 41, 0.45, &mut rng);
            let mut w = World::with_map(map, rng, 64);
            w.mode = crate::game::Mode::Rockets;
            for _ in 0..8 {
                w.add_bot();
            }
            let mut seen = std::collections::HashSet::new();
            for _ in 0..1500 {
                w.step();
                for b in w.bombs.values() {
                    // Gadgets (drones) and bomb rain drop uncounted or
                    // ownerless bombs; the bomb key only ever fires rockets.
                    if b.counted && b.owner != 0 {
                        assert!(b.rocket, "a bot planted a bomb");
                        assert_ne!(b.slide_dir, 0, "a bot's rocket sits still");
                        seen.insert(b.id);
                    }
                }
            }
            let s = w.stats;
            eprintln!("seed {seed}: {} rockets, {s:?}", seen.len());
            rockets += seen.len();
            kills += s.deaths - s.suicides;
            crates += s.crates_destroyed;
            suicides += s.suicides;
        }
        assert!(rockets >= 200, "bots should fire plenty of rockets: {rockets}");
        assert!(kills >= 10, "bots should hit each other (deaths that weren't suicides): {kills}");
        assert!(crates >= 100, "bots should shoot open crates: {crates}");
        assert!(suicides <= 4, "a rocket spares its shooter: {suicides}");
    }
}
