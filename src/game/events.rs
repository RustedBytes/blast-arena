//! Arena-wide happenings: sudden death (the arena shrinks at the end of each
//! round), random map events (meteor showers, blizzards, lava surges,
//! reversed conveyors) and capture the flag in team arenas.

use crate::protocol::{self, ev};

use super::bomb::BombKind;
use super::items::Item;
use super::player::DIRS;
use super::map::{Biome, Tile};
use super::{Mode, TICK_RATE, World};

const SEC: u64 = TICK_RATE as u64;
/// Sudden death: the last this-many ticks of a round; the ring stops
/// closing at this radius; and each ring is shown this long before closing.
pub const SUDDEN_DEATH_TICKS: u64 = 60 * SEC;
pub const SUDDEN_DEATH_MIN_RADIUS: i32 = 6;
/// Rings never close faster than one every this many ticks (2.9 tiles a
/// second, slower than a player walks), so there's always time to get
/// inside. On very big maps that means the arena doesn't close all the way
/// before the round ends.
pub const SUDDEN_DEATH_MIN_RING_TICKS: u64 = 7;
/// Map events: the first one comes after `EVENT_FIRST_TICKS`, then every
/// `EVENT_GAP_MIN..=EVENT_GAP_MAX` seconds.
const EVENT_FIRST_TICKS: u64 = 45 * SEC;
const EVENT_GAP_MIN: i32 = 60;
const EVENT_GAP_MAX: i32 = 110;
const METEOR_SHOWER_TICKS: u64 = 8 * SEC;
const METEORS: usize = 14;
/// A meteor is shown this long before it hits.
pub const METEOR_WARNING_TICKS: u64 = 30;
const METEOR_RANGE: u8 = 1;
const BLIZZARD_TICKS: u64 = 15 * SEC;
/// Speed factor while a blizzard blows.
pub const BLIZZARD_SLOW: f32 = 0.65;
const LAVA_WARNING_TICKS: u64 = 2 * SEC;
const LAVA_BURN_TICKS: u64 = 2 * SEC;
const LAVA_MAX_CELLS: usize = 160;
const CONVEYOR_FLIP_TICKS: u64 = 20 * SEC;
/// Earthquake (volcano maps): how long it shakes, fissures of fire (count,
/// length, warning, burning), and what crumbles when it's over.
pub const QUAKE_TICKS: u64 = 6 * SEC;
const FISSURES: (i32, i32) = (3, 5);
const FISSURE_LEN: (i32, i32) = (5, 9);
const FISSURE_WARNING_TICKS: u64 = 30;
const FISSURE_BURN_TICKS: u64 = 30;
const QUAKE_CRATE_BREAK: f32 = 0.33;
const QUAKE_ARMOR_CRACK: f32 = 0.2;
const QUAKE_PILLAR_CRUMBLE: f32 = 0.08;
/// Capture the flag: points for a capture, and how long a dropped flag
/// waits before going home.
pub const CAPTURE_POINTS: i32 = 5;
const FLAG_RETURN_TICKS: u64 = 15 * SEC;

/// Event kinds as announced to clients.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum MapEvent {
    Meteors = 1,
    Blizzard = 2,
    Lava = 3,
    Conveyors = 4,
    Earthquake = 5,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug, Default)]
pub enum FlagState {
    #[default]
    Home,
    Carried,
    Dropped,
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Flag {
    pub base: (i32, i32),
    pub state: FlagState,
    pub pos: (i32, i32),
    pub carrier: u32,
    pub return_at: u64,
}

#[derive(Default)]
pub struct Events {
    /// Sudden death: on, centre, open radius, next ring closes at, and the
    /// tiles the closing walls replaced (restored after the round).
    pub sd_active: bool,
    pub sd_center: (i32, i32),
    pub sd_radius: i32,
    pub sd_next: u64,
    pub sd_every: u64,
    sd_saved: Vec<(i32, i32, Tile)>,
    next_event: u64,
    /// The event running now and when it ends.
    pub current: Option<(MapEvent, u64)>,
    /// Meteors on their way: (x, y, impact tick).
    pub meteors: Vec<(i32, i32, u64)>,
    /// Conveyors flipped by the event: (x, y, original tile).
    flipped: Vec<(i32, i32, Tile)>,
    /// Pillars an earthquake crumbled into rubble; they're back next round.
    crumbled: Vec<(i32, i32)>,
    /// Capture the flag (team arenas): the red and blue flags, captures.
    pub ctf: bool,
    pub flags: [Flag; 2],
    pub captures: [u32; 2],
}

/// Chebyshev distance.
fn cheb(a: (i32, i32), b: (i32, i32)) -> i32 {
    (a.0 - b.0).abs().max((a.1 - b.1).abs())
}

impl World {
    /// Sends an event to everyone this tick.
    pub(super) fn broadcast_event(&mut self, kind: u8, values: &[i64]) {
        let msg = protocol::encode_event(self.event_arenas.current(), kind, values);
        self.broadcasts.push(msg);
    }

    /// Sets things up for a new world (capture the flag bases, first event).
    pub(super) fn init_events(&mut self) {
        self.events.next_event = self.tick + EVENT_FIRST_TICKS;
        self.events.ctf = self.mode == Mode::Teams;
        if self.events.ctf {
            let (w, h) = (self.map.w, self.map.h);
            let red = self.flag_base(w / 8, h / 2);
            let blue = self.flag_base(w - 1 - w / 8, h / 2);
            self.events.flags = [Flag { base: red, pos: red, ..Flag::default() }, Flag { base: blue, pos: blue, ..Flag::default() }];
        }
    }

    /// An open cell near (x, y) for a flag base, with the crates around it cleared.
    fn flag_base(&mut self, x: i32, y: i32) -> (i32, i32) {
        let mut best = (x, y);
        'search: for r in 0..12 {
            for dy in -r..=r {
                for dx in -r..=r {
                    let (cx, cy) = (x + dx, y + dy);
                    if self.map.in_bounds(cx, cy) && matches!(self.map.get(cx, cy), Tile::Floor | Tile::Crate | Tile::Armored) {
                        best = (cx, cy);
                        break 'search;
                    }
                }
            }
        }
        for cy in best.1 - 1..=best.1 + 1 {
            for cx in best.0 - 1..=best.0 + 1 {
                if self.map.in_bounds(cx, cy) && self.map.get(cx, cy).is_breakable() {
                    self.set_tile(cx, cy, Tile::Floor);
                }
            }
        }
        if self.map.get(best.0, best.1) != Tile::Floor {
            self.set_tile(best.0, best.1, Tile::Floor);
        }
        best
    }

    /// Every tick: sudden death, map events and flags.
    pub(super) fn update_events(&mut self) {
        self.update_sudden_death();
        self.update_map_events();
        if self.events.ctf {
            self.update_flags();
        }
    }

    // ------------------------------------------------------ sudden death

    fn update_sudden_death(&mut self) {
        let tick = self.tick;
        if !self.events.sd_active {
            if self.round_end.saturating_sub(tick) <= SUDDEN_DEATH_TICKS && self.round_end > tick {
                self.start_sudden_death();
            }
            return;
        }
        if tick >= self.events.sd_next && self.events.sd_radius > SUDDEN_DEATH_MIN_RADIUS {
            self.close_ring();
        }
    }

    fn start_sudden_death(&mut self) {
        let (w, h) = (self.map.w, self.map.h);
        // A random centre in the middle half of the map.
        let c = (self.rng.between(w / 4, w - 1 - w / 4), self.rng.between(h / 4, h - 1 - h / 4));
        let radius = c.0.max(c.1).max(w - 1 - c.0).max(h - 1 - c.1);
        let rings = (radius - SUDDEN_DEATH_MIN_RADIUS).max(1) as u64;
        // Close the rings over the first 85% of sudden death, if that can be
        // done at walking pace.
        let every = (SUDDEN_DEATH_TICKS * 85 / 100 / rings).max(SUDDEN_DEATH_MIN_RING_TICKS);
        let e = &mut self.events;
        (e.sd_active, e.sd_center, e.sd_radius, e.sd_every, e.sd_next) = (true, c, radius, every, self.tick + every);
        e.sd_saved.clear();
        tracing::debug!(center = ?c, radius, every, "sudden death");
        self.announce_shrink();
    }

    fn announce_shrink(&mut self) {
        let e = &self.events;
        let next = e.sd_next.saturating_sub(self.tick);
        let values = [i64::from(e.sd_center.0), i64::from(e.sd_center.1), i64::from(e.sd_radius), next as i64, i64::from(e.sd_active)];
        self.broadcast_event(ev::SHRINK, &values);
    }

    /// The outermost open ring turns to stone, crushing whatever is in it.
    fn close_ring(&mut self) {
        let (c, r) = (self.events.sd_center, self.events.sd_radius);
        let mut cells = Vec::new();
        for y in (c.1 - r).max(0)..=(c.1 + r).min(self.map.h - 1) {
            for x in (c.0 - r).max(0)..=(c.0 + r).min(self.map.w - 1) {
                if cheb((x, y), c) == r {
                    cells.push((x, y));
                }
            }
        }
        for &(x, y) in &cells {
            let t = self.map.get(x, y);
            if t != Tile::Wall {
                // Save what the cell really is: temporary ice from a freeze
                // blast is floor, and a reversed belt its original direction
                // (their timers won't touch a stone cell).
                let original = if self.frozen.iter().any(|f| (f.0, f.1) == (x, y)) {
                    Tile::Floor
                } else {
                    self.events.flipped.iter().find(|f| (f.0, f.1) == (x, y)).map_or(t, |f| f.2)
                };
                self.events.sd_saved.push((x, y, original));
                self.set_tile(x, y, Tile::Wall);
            }
            self.set_item(x, y, 0);
            if let Some(b) = self.bomb_at(x, y) {
                self.remove_bomb(b);
            }
        }
        self.mines.retain(|m| cheb((m.x, m.y), c) < r);
        // Crushed: anyone standing in the ring.
        let crushed: Vec<u32> = self.players.values().filter(|p| p.alive && cheb(p.cell(), c) >= r).map(|p| p.id).collect();
        for id in crushed {
            self.kill(id, None);
        }
        self.events.sd_radius -= 1;
        self.events.sd_next = self.tick + self.events.sd_every;
        self.announce_shrink();
    }

    /// Removes a bomb without a blast (crushed by sudden death).
    fn remove_bomb(&mut self, id: u32) {
        if let Some(b) = self.bombs.remove(&id) {
            let i = self.map.idx(b.x, b.y);
            if self.bomb_grid[i] == id {
                self.bomb_grid[i] = 0;
            }
            if let Some(o) = self.players.get_mut(&b.owner).filter(|_| b.counted) {
                o.active_bombs = o.active_bombs.saturating_sub(1);
            }
        }
    }

    /// During sudden death: the centre and the radius (Chebyshev) of the
    /// area that is safe to spawn in. Cells up to `sd_radius` are open; while
    /// the arena still shrinks, the next two rings are about to close.
    #[must_use]
    pub fn sudden_death_zone(&self) -> Option<((i32, i32), i32)> {
        let e = &self.events;
        if !e.sd_active {
            return None;
        }
        let shrinking = e.sd_radius > SUDDEN_DEATH_MIN_RADIUS;
        Some((e.sd_center, if shrinking { e.sd_radius - 2 } else { e.sd_radius }))
    }

    /// A cell is closed or about to close (no spawning there).
    #[must_use]
    pub fn sudden_death_unsafe(&self, x: i32, y: i32) -> bool {
        self.sudden_death_zone().is_some_and(|(c, r)| cheb((x, y), c) > r)
    }

    /// A spawn cell inside the sudden-death zone. Random sampling over the
    /// whole map would almost never hit the small open area (and then carve
    /// a spawn inside the stone), so this scans the zone itself, relaxing
    /// its demands step by step, and as a last resort clears a cell there.
    pub(super) fn find_spawn_in_zone(&mut self, c: (i32, i32), r: i32) -> (i32, i32) {
        let r = r.max(0);
        let mut cells = Vec::with_capacity(((2 * r + 1) * (2 * r + 1)) as usize);
        for y in (c.1 - r).max(1)..=(c.1 + r).min(self.map.h - 2) {
            for x in (c.0 - r).max(1)..=(c.0 + r).min(self.map.w - 2) {
                cells.push((x, y));
            }
        }
        // Shuffle so players don't all appear in the same corner.
        for i in (1..cells.len()).rev() {
            let j = self.rng.below(i as u32 + 1) as usize;
            cells.swap(i, j);
        }
        for strict in [true, false] {
            if let Some(&cell) = cells.iter().find(|&&(x, y)| self.spawn_ok(x, y, strict)) {
                return cell;
            }
        }
        // Anything walkable and free of bombs and fire.
        let free = |w: &World, (x, y): (i32, i32)| {
            let i = w.map.idx(x, y);
            !w.map.is_solid(x, y) && w.bomb_grid[i] == 0 && w.flame_until[i] <= w.tick && w.map.get(x, y) != Tile::Teleport && !w.in_nuke_zone(x, y)
        };
        if let Some(&cell) = cells.iter().find(|&&cell| free(self, cell)) {
            return cell;
        }
        // Clear a crate (or, failing that, the centre) to make room.
        let cell = cells.iter().copied().find(|&(x, y)| self.map.get(x, y).is_breakable()).unwrap_or(c);
        self.set_tile(cell.0, cell.1, Tile::Floor);
        if let Some(b) = self.bomb_at(cell.0, cell.1) {
            self.remove_bomb(b);
        }
        cell
    }

    /// End of round: the arena opens up again and flags go home.
    pub(super) fn reset_events_for_round(&mut self) {
        let saved = std::mem::take(&mut self.events.sd_saved);
        for &(x, y, t) in saved.iter().rev() {
            if self.map.get(x, y) == Tile::Wall {
                self.set_tile(x, y, t);
            }
        }
        self.events.sd_saved = saved;
        self.events.sd_saved.clear();
        self.rebuild_pillars();
        if self.events.sd_active {
            self.events.sd_active = false;
            self.announce_shrink();
        }
        self.events.next_event = self.events.next_event.max(self.tick + EVENT_FIRST_TICKS);
        if self.events.ctf {
            for team in 0..2 {
                self.return_flag(team);
            }
            self.events.captures = [0, 0];
            for p in self.players.values_mut() {
                p.carrying = 0;
            }
            self.announce_flags();
        }
    }

    // -------------------------------------------------------- map events

    fn update_map_events(&mut self) {
        let tick = self.tick;
        if self.events.next_event == 0 {
            self.events.next_event = tick + EVENT_FIRST_TICKS;
        }
        self.update_meteors();
        if let Some((kind, end)) = self.events.current {
            if kind == MapEvent::Earthquake && tick < end && (end - tick).is_multiple_of(SEC) {
                self.tremor();
            }
            if tick >= end {
                self.events.current = None;
                match kind {
                    MapEvent::Conveyors => self.unflip_conveyors(),
                    MapEvent::Earthquake => self.crumble(),
                    _ => {}
                }
            }
        }
        // No new events during (or right before) sudden death.
        let calm = self.round_end.saturating_sub(tick) > SUDDEN_DEATH_TICKS + 20 * SEC;
        if tick >= self.events.next_event && self.events.current.is_none() && calm && !self.events.sd_active {
            self.events.next_event = tick + self.rng.between(EVENT_GAP_MIN, EVENT_GAP_MAX) as u64 * SEC;
            self.start_map_event();
        }
    }

    fn start_map_event(&mut self) {
        let has = |b: Biome| self.map.biomes.iter().any(|s| s.biome == b);
        let conveyors = [Tile::ConveyorUp, Tile::ConveyorRight, Tile::ConveyorDown, Tile::ConveyorLeft].iter().any(|&t| self.map.count(t) > 0);
        let mut options = vec![MapEvent::Meteors];
        if has(Biome::Snow) {
            options.push(MapEvent::Blizzard);
        }
        if has(Biome::Volcano) {
            options.push(MapEvent::Lava);
            options.push(MapEvent::Earthquake);
        }
        if conveyors {
            options.push(MapEvent::Conveyors);
        }
        let kind = options[self.rng.below(options.len() as u32) as usize];
        self.start_event(kind);
    }

    /// Starts a map event now (also used by tests).
    pub fn start_event(&mut self, kind: MapEvent) {
        let tick = self.tick;
        let lasts = match kind {
            MapEvent::Meteors => {
                self.schedule_meteors();
                METEOR_SHOWER_TICKS
            }
            MapEvent::Blizzard => {
                self.blizzard_until = tick + BLIZZARD_TICKS;
                BLIZZARD_TICKS
            }
            MapEvent::Lava => {
                self.lava_surge();
                LAVA_WARNING_TICKS + LAVA_BURN_TICKS
            }
            MapEvent::Conveyors => {
                self.flip_conveyors();
                CONVEYOR_FLIP_TICKS
            }
            MapEvent::Earthquake => {
                self.open_fissures();
                QUAKE_TICKS
            }
        };
        tracing::debug!(?kind, "map event");
        self.events.current = Some((kind, tick + lasts));
        self.broadcast_event(ev::ANNOUNCE, &[kind as i64, (lasts / SEC) as i64]);
    }

    /// Meteors aimed near players (and at random spots), spread over the shower.
    fn schedule_meteors(&mut self) {
        let alive: Vec<(i32, i32)> = self.players.values().filter(|p| p.alive).map(super::player::Player::cell).collect();
        let mut strikes = Vec::new();
        for _ in 0..METEORS * 6 {
            if strikes.len() >= METEORS {
                break;
            }
            let (x, y) = if !alive.is_empty() && self.rng.chance(0.7) {
                let (px, py) = alive[self.rng.below(alive.len() as u32) as usize];
                (px + self.rng.between(-4, 4), py + self.rng.between(-4, 4))
            } else {
                (self.rng.between(1, self.map.w - 2), self.rng.between(1, self.map.h - 2))
            };
            if !self.map.in_bounds(x, y) || self.map.is_solid(x, y) {
                continue;
            }
            let at = self.tick + METEOR_WARNING_TICKS + u64::from(self.rng.below((METEOR_SHOWER_TICKS - METEOR_WARNING_TICKS) as u32));
            strikes.push((x, y, at));
        }
        let mut values = Vec::with_capacity(strikes.len() * 3);
        for &(x, y, at) in &strikes {
            values.extend([i64::from(x), i64::from(y), (at - self.tick) as i64]);
        }
        self.events.meteors.extend(strikes);
        self.broadcast_event(ev::STRIKES, &values);
    }

    fn update_meteors(&mut self) {
        let tick = self.tick;
        let mut k = 0;
        while k < self.events.meteors.len() {
            let (x, y, at) = self.events.meteors[k];
            if at > tick {
                k += 1;
                continue;
            }
            self.events.meteors.swap_remove(k);
            // The impact: a short blast that breaks crates and sets off bombs.
            if let Some(b) = self.bomb_at(x, y) {
                self.bombs.get_mut(&b).unwrap().explode_at = tick;
            } else if !self.map.is_solid(x, y) {
                let kind = BombKind { pierce: true, ..BombKind::plain(METEOR_RANGE, 0) };
                self.place_bomb_at(0, (x, y), kind);
            }
        }
    }

    /// The volcano's floor erupts: a warning, then fire for a moment.
    fn lava_surge(&mut self) {
        let mut cells = Vec::new();
        for y in 0..self.map.h {
            for x in 0..self.map.w {
                if self.map.biome(x, y) == Biome::Volcano && self.map.get(x, y) == Tile::Floor && self.rng.chance(0.3) {
                    cells.push((x, y));
                }
            }
        }
        // Keep it to a manageable patch.
        while cells.len() > LAVA_MAX_CELLS {
            let i = self.rng.below(cells.len() as u32) as usize;
            cells.swap_remove(i);
        }
        let from = self.tick + LAVA_WARNING_TICKS;
        let mut values = vec![LAVA_WARNING_TICKS as i64, LAVA_BURN_TICKS as i64];
        for &(x, y) in &cells {
            self.set_flame(x, y, 0, from, from + LAVA_BURN_TICKS);
            values.extend([i64::from(x), i64::from(y)]);
        }
        self.broadcast_event(ev::LAVA, &values);
    }

    fn in_volcano(&self, x: i32, y: i32) -> bool {
        self.map.biome(x, y) == Biome::Volcano
    }

    /// Cracks of fire run along volcano lanes: shown first, then burning
    /// (sent to clients like a lava surge).
    fn open_fissures(&mut self) {
        let floors: Vec<(i32, i32)> = (1..self.map.h - 1)
            .flat_map(|y| (1..self.map.w - 1).map(move |x| (x, y)))
            .filter(|&(x, y)| self.in_volcano(x, y) && !self.map.is_solid(x, y))
            .collect();
        if floors.is_empty() {
            return;
        }
        let mut cells: Vec<(i32, i32)> = Vec::new();
        for _ in 0..self.rng.between(FISSURES.0, FISSURES.1) {
            let (mut x, mut y) = floors[self.rng.below(floors.len() as u32) as usize];
            let (dx, dy) = DIRS[self.rng.between(1, 4) as usize];
            for _ in 0..self.rng.between(FISSURE_LEN.0, FISSURE_LEN.1) {
                if !self.map.in_bounds(x, y) || self.map.get(x, y) == Tile::Wall || !self.in_volcano(x, y) {
                    break;
                }
                if !cells.contains(&(x, y)) {
                    cells.push((x, y));
                }
                (x, y) = (x + dx, y + dy);
            }
        }
        let from = self.tick + FISSURE_WARNING_TICKS;
        let mut values = vec![FISSURE_WARNING_TICKS as i64, FISSURE_BURN_TICKS as i64];
        for &(x, y) in &cells {
            self.set_flame(x, y, 0, from, from + FISSURE_BURN_TICKS);
            values.extend([i64::from(x), i64::from(y)]);
        }
        self.broadcast_event(ev::LAVA, &values);
    }

    /// A tremor jolts resting bombs in the volcano one cell in a random direction.
    fn tremor(&mut self) {
        let mut jolt: Vec<u32> = self.bombs.values().filter(|b| b.slide_dir == 0 && self.in_volcano(b.x, b.y)).map(|b| b.id).collect();
        jolt.sort_unstable();
        for id in jolt {
            let dir = self.rng.between(1, 4) as u8;
            self.kick_bomb(id, dir);
        }
    }

    /// When the shaking stops: some crates break (and may drop power-ups),
    /// some armor cracks, and a few pillars crumble into rubble.
    fn crumble(&mut self) {
        let (w, h) = (self.map.w, self.map.h);
        for y in 2..h - 2 {
            for x in 2..w - 2 {
                if !self.in_volcano(x, y) || self.bomb_at(x, y).is_some() {
                    continue;
                }
                match self.map.get(x, y) {
                    Tile::Crate if self.rng.chance(QUAKE_CRATE_BREAK) => {
                        self.set_tile(x, y, Tile::Floor);
                        self.stats.crates_destroyed += 1;
                        let tuning = &self.tuning;
                        if let Some(item) = Item::crate_drop(&mut self.rng, |i| tuning.item_enabled(i)) {
                            self.set_item(x, y, item as u8);
                        }
                    }
                    Tile::Armored if self.rng.chance(QUAKE_ARMOR_CRACK) => self.set_tile(x, y, Tile::Crate),
                    Tile::Wall if self.rng.chance(QUAKE_PILLAR_CRUMBLE) => {
                        self.set_tile(x, y, Tile::Crate);
                        self.events.crumbled.push((x, y));
                    }
                    _ => {}
                }
            }
        }
    }

    /// Puts crumbled pillars back where nothing is in the way.
    fn rebuild_pillars(&mut self) {
        let crumbled = std::mem::take(&mut self.events.crumbled);
        for &(x, y) in &crumbled {
            let occupied = self.bomb_at(x, y).is_some() || self.players.values().any(|p| p.alive && p.cell() == (x, y));
            if !occupied && matches!(self.map.get(x, y), Tile::Floor | Tile::Crate) {
                self.set_item(x, y, 0);
                self.set_tile(x, y, Tile::Wall);
            }
        }
    }

    fn flip_conveyors(&mut self) {
        self.events.flipped.clear();
        for y in 0..self.map.h {
            for x in 0..self.map.w {
                let t = self.map.get(x, y);
                let flipped = match t {
                    Tile::ConveyorUp => Tile::ConveyorDown,
                    Tile::ConveyorDown => Tile::ConveyorUp,
                    Tile::ConveyorLeft => Tile::ConveyorRight,
                    Tile::ConveyorRight => Tile::ConveyorLeft,
                    _ => continue,
                };
                self.events.flipped.push((x, y, t));
                self.set_tile(x, y, flipped);
            }
        }
    }

    fn unflip_conveyors(&mut self) {
        let flipped = std::mem::take(&mut self.events.flipped);
        for &(x, y, t) in &flipped {
            if self.map.get(x, y).conveyor_dir() != 0 {
                self.set_tile(x, y, t);
            }
        }
    }

    /// Speed factor from the weather.
    #[must_use]
    pub fn weather_slow(&self) -> f32 {
        if self.blizzard_until > self.tick { BLIZZARD_SLOW } else { 1.0 }
    }

    // ---------------------------------------------------- capture the flag

    fn update_flags(&mut self) {
        let tick = self.tick;
        for team in 0..2 {
            let f = self.events.flags[team];
            match f.state {
                FlagState::Dropped if tick >= f.return_at => {
                    self.return_flag(team);
                    self.flag_news(3, team, 0);
                    self.announce_flags();
                }
                FlagState::Carried => {
                    // Follow the carrier.
                    match self.players.get(&f.carrier).filter(|p| p.alive) {
                        Some(p) => self.events.flags[team].pos = p.cell(),
                        None => self.drop_flag(team, f.pos),
                    }
                }
                _ => {}
            }
        }
        // Touching flags: grab the enemy's, return your own, capture at home.
        let mut touches = Vec::new();
        for p in self.players.values().filter(|p| p.alive && p.jump_left == 0 && p.team != 0) {
            touches.push((p.id, p.team, p.cell(), p.carrying));
        }
        for (id, team, cell, carrying) in touches {
            let mine = (team - 1) as usize;
            let theirs = 1 - mine;
            let fm = self.events.flags[mine];
            let ft = self.events.flags[theirs];
            if fm.state == FlagState::Dropped && fm.pos == cell {
                self.return_flag(mine);
                self.flag_news(3, mine, id);
                self.announce_flags();
            }
            if carrying == 0 && ft.state != FlagState::Carried && ft.pos == cell {
                let f = &mut self.events.flags[theirs];
                (f.state, f.carrier) = (FlagState::Carried, id);
                self.players.get_mut(&id).unwrap().carrying = theirs as u8 + 1;
                self.flag_news(1, theirs, id);
                self.announce_flags();
            }
            let at_home = cheb(cell, fm.base) <= 1;
            if carrying != 0 && at_home && self.events.flags[mine].state == FlagState::Home {
                let taken = (carrying - 1) as usize;
                self.return_flag(taken);
                self.events.captures[mine] += 1;
                let p = self.players.get_mut(&id).unwrap();
                p.carrying = 0;
                p.score += CAPTURE_POINTS;
                self.flag_news(4, taken, id);
                self.announce_flags();
            }
        }
    }

    fn return_flag(&mut self, team: usize) {
        let f = &mut self.events.flags[team];
        let carrier = f.carrier;
        (f.state, f.pos, f.carrier) = (FlagState::Home, f.base, 0);
        if let Some(p) = self.players.get_mut(&carrier).filter(|p| p.carrying == team as u8 + 1) {
            p.carrying = 0;
        }
    }

    fn drop_flag(&mut self, team: usize, at: (i32, i32)) {
        let tick = self.tick;
        let f = &mut self.events.flags[team];
        let carrier = f.carrier;
        (f.state, f.pos, f.carrier, f.return_at) = (FlagState::Dropped, at, 0, tick + FLAG_RETURN_TICKS);
        if let Some(p) = self.players.get_mut(&carrier) {
            p.carrying = 0;
        }
        self.flag_news(2, team, carrier);
        self.announce_flags();
    }

    /// A carrier died or left: their flag drops where they were.
    pub(super) fn carrier_lost(&mut self, id: u32, at: (i32, i32)) {
        if !self.events.ctf {
            return;
        }
        for team in 0..2 {
            let f = self.events.flags[team];
            if f.state == FlagState::Carried && f.carrier == id {
                self.drop_flag(team, at);
            }
        }
    }

    fn flag_news(&mut self, what: i64, team: usize, player: u32) {
        self.broadcast_event(ev::FLAG_NEWS, &[what, team as i64 + 1, i64::from(player) + 1]);
    }

    fn flag_values(&self) -> Vec<i64> {
        let mut v = Vec::with_capacity(14);
        for f in &self.events.flags {
            let state = match f.state {
                FlagState::Home => 0,
                FlagState::Carried => 1,
                FlagState::Dropped => 2,
            };
            v.extend([i64::from(f.base.0), i64::from(f.base.1), state, i64::from(f.pos.0), i64::from(f.pos.1), i64::from(f.carrier) + 1]);
        }
        v.extend(self.events.captures.map(i64::from));
        v
    }

    pub(super) fn announce_flags(&mut self) {
        let v = self.flag_values();
        self.broadcast_event(ev::FLAGS, &v);
    }

    /// What a joining client needs to know: sudden death and flags.
    pub(super) fn event_state_for_join(&mut self) -> Vec<bytes::Bytes> {
        let mut out = Vec::new();
        if self.events.sd_active {
            let e = &self.events;
            let next = e.sd_next.saturating_sub(self.tick) as i64;
            let v = [i64::from(e.sd_center.0), i64::from(e.sd_center.1), i64::from(e.sd_radius), next, 1];
            out.push(protocol::encode_event(self.event_arenas.current(), ev::SHRINK, &v));
        }
        if self.events.ctf {
            let v = self.flag_values();
            out.push(protocol::encode_event(self.event_arenas.current(), ev::FLAGS, &v));
        }
        // An event under way (a blizzard, say), with the time it has left.
        if let Some((kind, end)) = self.events.current
            && end > self.tick
        {
            let left = (end - self.tick).div_ceil(SEC) as i64;
            out.push(protocol::encode_event(self.event_arenas.current(), ev::ANNOUNCE, &[kind as i64, left]));
        }
        out
    }

    /// Where a team member respawns in capture the flag: near their base.
    #[must_use]
    pub fn team_base(&self, team: u8) -> Option<(i32, i32)> {
        (self.events.ctf && (1..=2).contains(&team)).then(|| self.events.flags[(team - 1) as usize].base)
    }
}
