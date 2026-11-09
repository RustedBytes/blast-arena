//! Server-side AI players. Bots are ordinary `Player`s without a socket: each
//! tick the AI sets their `input_dir` / `want_bomb`, exactly like a client
//! would, so they obey the same movement and bomb rules as humans.
//!
//! The brain works on a shared *danger map* ("ticks until fire" per cell,
//! including chain reactions) and, in priority order: escapes danger, grabs
//! power-ups, bombs enemies, blasts crates, or wanders. It only drops a bomb
//! after checking it can reach a safe cell before the fuse runs out.
//!
//! All working memory lives in [`AiScratch`] and the bots' own path buffers,
//! reused tick after tick, so thinking doesn't allocate.

use std::collections::HashMap;

use super::bomb::FUSE_TICKS;
use super::items::Item;
use super::map::Tile;
use super::player::{DIRS, MAX_BOMBS, MAX_RANGE};
use super::rng::Rng;
use super::{DT, World};

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
}

impl Search {
    /// Explores from `start`; `passable(cell, dist)` decides whether a
    /// neighbour at that distance may be entered. Results land in `nodes`
    /// in order of distance, with the root at index 0.
    fn explore(&mut self, world: &World, start: (i32, i32), passable: impl Fn((i32, i32), u16) -> bool) {
        self.generation = self.generation.wrapping_add(1);
        if self.generation == 0 {
            self.seen.fill(0);
            self.generation = 1;
        }
        let g = self.generation;
        self.seen[world.map.idx(start.0, start.1)] = g;
        self.nodes.clear();
        self.nodes.push(Node { cell: start, parent: 0, dist: 0 });
        let mut head = 0;
        while head < self.nodes.len() && self.nodes.len() < SEARCH_LIMIT {
            let Node { cell, dist, .. } = self.nodes[head];
            for &(dx, dy) in &DIRS[1..] {
                let c = (cell.0 + dx, cell.1 + dy);
                if !world.map.in_bounds(c.0, c.1) {
                    continue;
                }
                let i = world.map.idx(c.0, c.1);
                if self.seen[i] == g || !world.walkable(c, start) || !passable(c, dist + 1) {
                    continue;
                }
                self.seen[i] = g;
                self.nodes.push(Node { cell: c, parent: head, dist: dist + 1 });
            }
            head += 1;
        }
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
    bombs: Vec<(i32, i32, u8, bool, u16)>,
    bomb_index: HashMap<u32, usize>,
    search: Search,
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
            search: Search { seen: vec![0; cells], generation: 0, nodes: Vec::with_capacity(SEARCH_LIMIT + 4) },
        }
    }
}

/// What a bot knows about itself while deciding.
#[allow(clippy::struct_excessive_bools, reason = "independent facts a bot weighs")]
struct Me {
    cur: (i32, i32),
    /// Tiles travelled per tick.
    spt: f32,
    range: u8,
    pierce: bool,
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
}

fn dir_between(a: (i32, i32), b: (i32, i32)) -> u8 {
    match (b.0 - a.0, b.1 - a.1) {
        (0, -1) => 1,
        (1, 0) => 2,
        (0, 1) => 3,
        (-1, 0) => 4,
        _ => 0,
    }
}

impl World {
    pub fn update_bots(&mut self) {
        if self.bot_ids.is_empty() {
            return;
        }
        let mut sc = std::mem::take(&mut self.ai_scratch);
        self.fill_senses(&mut sc);
        // Stable (ascending id) order, so no bot systematically reacts first.
        for k in 0..self.bot_ids.len() {
            let id = self.bot_ids[k];
            let Some(mut brain) = self.bots.remove(&id) else { continue };
            self.drive_bot(id, &mut brain, &mut sc);
            self.bots.insert(id, brain);
        }
        self.ai_scratch = sc;
    }

    fn fill_senses(&self, sc: &mut AiScratch) {
        for t in &mut sc.targets {
            t.fill(0);
        }
        sc.occupied.fill(0);
        for p in self.players.values().filter(|p| p.alive) {
            let (x, y) = p.cell();
            let i = self.map.idx(x, y);
            sc.occupied[i] = sc.occupied[i].saturating_add(1);
            if p.invulnerable_until <= self.tick {
                for (team, t) in sc.targets.iter_mut().enumerate() {
                    if team == 0 || p.team != team as u8 {
                        t[i] = t[i].saturating_add(1);
                    }
                }
            }
        }
        self.fill_danger(&mut sc.danger, &mut sc.bombs, &mut sc.bomb_index);
    }

    /// Ticks until fire reaches each cell (0 = burning now, `SAFE` = never),
    /// accounting for bombs setting each other off. Allocates; for tests and
    /// tools. The bots use the shared, reused map.
    #[must_use]
    pub fn danger_map(&self) -> Vec<u16> {
        let mut danger = vec![SAFE; (self.map.w * self.map.h) as usize];
        self.fill_danger(&mut danger, &mut Vec::new(), &mut HashMap::new());
        danger
    }

    fn fill_danger(&self, danger: &mut [u16], bombs: &mut Vec<(i32, i32, u8, bool, u16)>, index: &mut HashMap<u32, usize>) {
        for (d, &until) in danger.iter_mut().zip(&self.flame_until) {
            *d = if until > self.tick { 0 } else { SAFE };
        }
        bombs.clear();
        index.clear();
        for b in self.bombs.values() {
            let t = b.explode_at.saturating_sub(self.tick).min(u64::from(SAFE) - 1) as u16;
            let t = if danger[self.map.idx(b.x, b.y)] == 0 { 0 } else { t };
            // A remote bomb can go off whenever its owner likes; treat it like
            // a freshly lit one.
            let t = if b.remote { t.min(REMOTE_ASSUMED_TICKS) } else { t };
            index.insert(b.id, bombs.len());
            bombs.push((b.x, b.y, b.range, b.pierce, t));
        }

        // A bomb caught in another's blast goes off no later than that one.
        loop {
            let mut changed = false;
            for k in 0..bombs.len() {
                let (x, y, range, pierce, t) = bombs[k];
                self.trace_blast(x, y, range, false, pierce, |_, _, cx, cy| {
                    let id = self.bomb_grid[self.map.idx(cx, cy)];
                    if let Some(&j) = index.get(&id)
                        && bombs[j].4 > t {
                            bombs[j].4 = t;
                            changed = true;
                        }
                });
            }
            if !changed {
                break;
            }
        }

        for &(x, y, range, pierce, t) in bombs.iter() {
            let i = self.map.idx(x, y);
            danger[i] = danger[i].min(t);
            self.trace_blast(x, y, range, false, pierce, |_, _, cx, cy| {
                let i = self.map.idx(cx, cy);
                danger[i] = danger[i].min(t);
            });
        }
    }

    fn drive_bot(&mut self, id: u32, brain: &mut BotBrain, sc: &mut AiScratch) {
        let Some(p) = self.players.get(&id) else { return };
        if !p.alive {
            brain.reset();
            return;
        }
        let me = Me {
            cur: p.cell(),
            spt: p.speed(self.tick) * DT,
            range: p.range,
            pierce: p.pierce,
            can_bomb: p.can_bomb(self.tick) && self.bomb_at(p.cell().0, p.cell().1).is_none(),
            team: p.team as usize,
            remote_out: p.remote && p.active_bombs > 0,
            vulnerable: p.invulnerable_until <= self.tick,
            max_bombs: p.max_bombs,
            speed_lvl: p.speed_lvl,
            kick: p.kick,
            shielded: p.invulnerable_until > self.tick + 20,
        };
        let cur = me.cur;
        while brain.path.last() == Some(&cur) {
            brain.path.pop();
        }
        let in_danger = sc.danger[self.map.idx(cur.0, cur.1)] != SAFE;
        let next_unsafe = brain.path.last().is_some_and(|&(x, y)| {
            self.map.is_solid(x, y) || self.bomb_at(x, y).is_some() || (!brain.escaping && sc.danger[self.map.idx(x, y)] != SAFE)
        });

        let mut want_bomb = false;
        let think = self.tick >= brain.next_think
            || next_unsafe
            || (in_danger && !brain.escaping)
            || (brain.path.is_empty() && !brain.goal_bomb);
        if think {
            brain.next_think = self.tick + self.rng.between(2, 4) as u64;
            brain.push_dir = 0;
            if in_danger {
                brain.escaping = true;
                brain.goal_bomb = false;
                if !self.escape_path(&mut sc.search, cur, &sc.danger, me.spt, &mut brain.path) {
                    brain.path.clear();
                    brain.push_dir = self.last_resort_dir(cur, &sc.danger);
                }
            } else {
                brain.escaping = false;
                // Reflex: an enemy is in the line of fire right now.
                if me.can_bomb && self.blast_value(cur, &sc.targets[me.team], &me).1 > 0 {
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

        // Reached a chosen bomb spot: drop only with a safe way out.
        if !want_bomb && !in_danger && brain.goal_bomb && brain.path.is_empty() {
            brain.goal_bomb = false;
            brain.next_think = self.tick;
            if me.can_bomb && self.bomb_escape(sc, &me, &mut brain.path) {
                want_bomb = true;
                brain.escaping = true;
            }
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
        let p = self.players.get_mut(&id).unwrap();
        p.input_dir = dir;
        p.input_alt = 0;
        p.want_bomb |= want_bomb;
        // Safely clear of its remote bombs: set them off.
        if me.remote_out && !in_danger && !want_bomb && !brain.escaping {
            p.want_act = true;
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
        search.explore(self, start, |c, dist| {
            let d = danger[self.map.idx(c.0, c.1)];
            d == SAFE || f32::from(d) > (f32::from(dist) + 1.0) / spt + ESCAPE_MARGIN
        });
        match search.nodes.iter().position(|n| danger[self.map.idx(n.cell.0, n.cell.1)] == SAFE && self.rest_ok(n.cell)) {
            Some(k) => {
                search.path_to(k, path);
                true
            }
            None => false,
        }
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
        let t = (FUSE_TICKS as u16).min(sc.danger[ci]);
        hyp[ci] = hyp[ci].min(t);
        self.trace_blast(cur.0, cur.1, me.range, false, me.pierce, |_, _, x, y| {
            let i = self.map.idx(x, y);
            hyp[i] = hyp[i].min(t);
        });
        let (hyp, occupied, spt) = (&sc.hypothetical, &sc.occupied, me.spt);
        sc.search.explore(self, cur, |c, dist| {
            let i = self.map.idx(c.0, c.1);
            let d = hyp[i];
            occupied[i] == 0 && (d == SAFE || f32::from(d) > (f32::from(dist) + 1.0) / spt + ESCAPE_MARGIN)
        });
        // Insist on a robust way out: either two separate exits, or a roomy
        // safe area, so another player can't seal the only escape cell.
        let nodes = &sc.search.nodes;
        let mut exits = [false; 4];
        let mut safe_cells = 0;
        let mut nearest = None;
        for (k, n) in nodes.iter().enumerate().skip(1) {
            if hyp[self.map.idx(n.cell.0, n.cell.1)] != SAFE || !self.rest_ok(n.cell) {
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
        self.trace_blast(c.0, c.1, me.range, true, me.pierce, |_, _, x, y| {
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

    fn item_value(item: Item, me: &Me) -> f32 {
        match item {
            Item::ExtraBomb if me.max_bombs < MAX_BOMBS => 6.0,
            Item::Range if me.range < MAX_RANGE => 6.0,
            Item::FullFire if me.range < MAX_RANGE => 7.0,
            Item::Speed if me.speed_lvl < 4 => 5.0,
            Item::Kick if !me.kick => 5.0,
            Item::Pierce if !me.pierce => 5.0,
            Item::Shield if !me.shielded => 4.0,
            // A gamble: usually good, sometimes a curse.
            Item::Mystery => 4.0,
            Item::Remote | Item::Punch | Item::LineBomb | Item::Ghost => 3.0,
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
                let (crates, enemies) = self.blast_value(n.cell, &sc.targets[me.team], me);
                consider(crates as f32 + 4.0 * enemies as f32, true);
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

    #[test]
    fn bot_never_bombs_a_dead_end() {
        // (1,1) and (2,1) open; (3,1) and (1,2) crates; (2,2) pillar.
        let mut map = Map::empty(15, 15);
        map.set(3, 1, Tile::Crate);
        map.set(1, 2, Tile::Crate);
        let mut w = test_world(map);
        let bot = w.spawn_test_bot(1.5, 1.5);
        for _ in 0..200 {
            w.step();
        }
        assert!(w.bombs.is_empty());
        assert!(w.players[&bot].alive);
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
}
