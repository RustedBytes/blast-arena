//! The authoritative game simulation. A single task owns a `World` (one per
//! arena) and advances it at a fixed tick rate. Clients feed it through
//! lock-free input slots and get snapshots encoded into a reusable arena,
//! so a steady-state tick performs no heap allocation.

pub mod abilities;
pub mod ability_config;
pub mod ai;
pub mod bomb;
pub mod builder;
pub mod clone;
pub mod dash;
pub mod gas;
pub mod guard;
pub mod portal;
pub mod sticky;
pub mod worms;
pub mod items;
pub mod link;
pub mod map;
pub mod mapgen;
pub mod player;
pub mod rng;

mod combat;
mod delta;
mod events;
pub mod gadgets;
mod input;
mod movement;
mod pickups;
mod profiles;
mod rounds;
pub mod royale;
mod roster;
mod snapshot;
mod terrain;
mod testing;
mod tick;
#[cfg(test)]
mod ability_tests;
#[cfg(test)]
mod tests;
#[cfg(test)]
mod worm_tests;
#[cfg(test)]
mod guard_tests;

use std::collections::HashMap;
use std::sync::Arc;

use bytes::Bytes;
use tokio::sync::oneshot;

use crate::db::{Db, Profile};
use crate::metrics::ArenaStats;
use crate::protocol::{ArenaRing, TileChange};
use ability_config::Tuning;
use bomb::{Bomb, Explosion};
use delta::DeltaScratch;
use items::Item;
use link::ClientLink;
use map::{Map, Tile};
use player::Player;
use rng::Rng;

pub use delta::SnapHistory;
pub use snapshot::aoi_rect;
#[cfg(test)]
pub use testing::test_world;
pub use testing::{plain_join, test_link};
pub use tick::run;

pub const TICK_RATE: u32 = 20;
pub const DT: f32 = 1.0 / TICK_RATE as f32;
const RESPAWN_TICKS: u64 = 3 * TICK_RATE as u64;
const SPAWN_SHIELD_TICKS: u64 = 2 * TICK_RATE as u64;
const BUCKET: i32 = 8;
const CRATE_DENSITY: f32 = 0.45;
/// Fraction of the initial crate count the map regrows towards.
const CRATE_REGROW_TARGET: f32 = 0.85;
/// Chance that a regrowth spot gets a lone secret box instead of a crate.
const REGROW_MYSTERY_CHANCE: f32 = 0.03;
const LEADERBOARD_EVERY: u64 = TICK_RATE as u64;
const ITEMS_DROPPED_ON_DEATH: usize = 3;
/// Per-arena capacity: a tick's worth of snapshots, and of reliable events.
const SNAPSHOT_ARENA_CAPACITY: usize = 1024 * 1024;
const EVENT_ARENA_CAPACITY: usize = 64 * 1024;
/// Conveyor belt speed in tiles per second.
const CONVEYOR_SPEED: f32 = 1.6;
const TELEPORT_COOLDOWN_TICKS: u64 = TICK_RATE as u64;
/// Standing on a hill this long earns a point.
const HILL_POINT_TICKS: u32 = 3 * TICK_RATE;
/// Score needed before the leader gets a bounty on their head.
const BOUNTY_MIN_SCORE: i32 = 5;
const BOUNTY_BONUS: i32 = 2;
/// Kill counts announced to everyone.
const STREAKS: [u32; 4] = [3, 5, 8, 12];
const EMOTE_COOLDOWN_TICKS: u64 = 15;
/// Emote shown automatically over a player's head after a kill.
pub const EMOTE_COOL: u8 = 7;
/// How long a disconnected player's progress is kept for them.
const PARK_TICKS: u64 = 30 * TICK_RATE as u64;
const PROFILE_FLUSH_TICKS: u64 = 10 * TICK_RATE as u64;
const XP_KILL: u64 = 10;
const XP_BOUNTY: u64 = 20;
const XP_HILL: u64 = 2;
const XP_MVP: u64 = 50;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    /// Free-for-all.
    Ffa,
    /// Red versus blue; no friendly fire.
    Teams,
    /// Battle royale: last player standing inside a shrinking zone.
    Royale,
    /// Free-for-all with worms: AI creatures that hunt everyone (see `worms`).
    Worms,
    /// Free-for-all where the bomb key fires a rocket instead of dropping a
    /// bomb (see `World::fire_bomb_rocket`).
    Rockets,
}

impl Mode {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Ffa => "ffa",
            Mode::Teams => "teams",
            Mode::Royale => "royale",
            Mode::Worms => "worms",
            Mode::Rockets => "rockets",
        }
    }

    #[must_use]
    pub fn parse(s: &str) -> Option<Mode> {
        match s {
            "ffa" => Some(Mode::Ffa),
            "teams" => Some(Mode::Teams),
            "royale" => Some(Mode::Royale),
            "worms" => Some(Mode::Worms),
            "rockets" => Some(Mode::Rockets),
            _ => None,
        }
    }
}

#[derive(Clone)]
pub struct Config {
    pub name: String,
    pub mode: Mode,
    pub map_w: i32,
    pub map_h: i32,
    pub max_players: usize,
    /// AI bots kept in the arena; they make room for humans when full.
    pub bots: usize,
    pub round_secs: u32,
    /// Seed for this arena's map; the same seed builds the same map.
    pub map_seed: u64,
    /// Ability power-up tuning (see `ability_config`).
    pub tuning: Arc<Tuning>,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            name: "Main".into(),
            mode: Mode::Ffa,
            map_w: 81,
            map_h: 81,
            max_players: 256,
            bots: 10,
            round_secs: 300,
            map_seed: 0,
            tuning: default_tuning(),
        }
    }
}

/// The shipped ability tuning, parsed once.
#[must_use]
pub fn default_tuning() -> Arc<Tuning> {
    static DEFAULT: std::sync::LazyLock<Arc<Tuning>> = std::sync::LazyLock::new(|| Arc::new(Tuning::default()));
    DEFAULT.clone()
}

/// Everything a client says when joining.
pub struct JoinRequest {
    pub name: String,
    pub token: Option<String>,
    pub hat: u8,
    pub trail: u8,
    /// Spawn next to this player (a friend's invite link), if present.
    pub near: u32,
    pub profile: Option<Profile>,
}

/// Rare events from connections. Input doesn't go through here: it's read
/// from each client's `InputSlot` every tick.
pub enum GameEvent {
    Join { req: JoinRequest, link: ClientLink, reply: oneshot::Sender<Result<u32, &'static str>> },
    Leave { id: u32 },
}

/// A disconnected player's progress, kept a little while for a reconnect.
struct Parked {
    expires: u64,
    team: u8,
    score: i32,
    kills: u32,
    deaths: u32,
    streak: u32,
    max_bombs: u8,
    range: u8,
    speed_lvl: u8,
    flags: [bool; 5],
}

/// Buffers reused every tick so the hot path doesn't allocate.
#[derive(Default)]
struct Scratch {
    delta: DeltaScratch,
    ids: Vec<u32>,
    bomb_ids: Vec<u32>,
    chain: Vec<u32>,
    blast: Vec<(usize, u8, i32, i32)>,
    drops: Vec<(i32, i32, Item)>,
    nuke_cells: Vec<(i32, i32, u16)>,
    victims: Vec<(u32, u32)>,
    broadcasts: Vec<Bytes>,
    dropped: Vec<u32>,
    emotes: Vec<(u32, u8)>,
    gassed: Vec<u32>,
    sticky_ids: Vec<u32>,
}

pub struct World {
    pub name: String,
    pub mode: Mode,
    /// Walk players once per input step they send (the client's 20 Hz
    /// clock), not once per server tick, so prediction and server agree on
    /// how far a key press went. Off only for tests that hold one input.
    pub input_lockstep: bool,
    pub tick: u64,
    pub map: Map,
    pub rng: Rng,
    max_players: usize,
    pub players: HashMap<u32, Player>,
    next_player_id: u32,
    pub bombs: HashMap<u32, Bomb>,
    pub bomb_grid: Vec<u32>,
    pub next_bomb_id: u32,
    pub items: Vec<u8>,
    /// Fire burns in a cell from `flame_from` (inclusive) to `flame_until`
    /// (exclusive); an atomic blast lights far cells a few ticks later.
    pub flame_from: Vec<u64>,
    pub flame_until: Vec<u64>,
    pub flame_owner: Vec<u32>,
    /// A player the fire in a cell doesn't hurt (the shooter of a rocket), or 0.
    pub flame_spare: Vec<u32>,
    pub explosions: Vec<Explosion>,
    /// Hidden land mines and flying drones (see `gadgets`).
    pub mines: Vec<gadgets::Mine>,
    pub drones: Vec<gadgets::Drone>,
    /// Ice from freeze blasts: (x, y, melts at tick).
    pub frozen: Vec<(i32, i32, u64)>,
    /// Ability tuning, and the objects abilities put in the world (see
    /// `abilities`): builder walls, gas clouds, clones and their decoy
    /// bombs, portals, and the ids of live sticky bombs.
    pub tuning: Arc<Tuning>,
    pub walls: Vec<builder::Wall>,
    pub gas: Vec<gas::GasCloud>,
    pub clones: Vec<clone::Clone>,
    pub decoys: Vec<clone::Decoy>,
    pub portals: Vec<portal::Portal>,
    pub sticky: Vec<u32>,
    /// Map events, sudden death and capture the flag (see `events`).
    pub events: events::Events,
    /// Everyone is slowed (blizzard) until this tick.
    pub blizzard_until: u64,
    /// Battle royale match and zone (see `royale`).
    pub royale: royale::Royale,
    /// Worms hunting players in the worms arena (see `worms`).
    pub worms: worms::Worms,
    /// The loot vault and its Warden (see `guard`).
    pub guard: guard::Guard,
    /// Tile and item changes made during the current tick, sent to everyone.
    pub tile_changes: Vec<TileChange>,
    pub item_changes: Vec<(i32, i32, u8)>,
    crate_target: usize,
    crate_count: usize,
    buckets: Vec<Vec<u32>>,
    buckets_w: i32,
    /// Messages for everyone (joins, leaves, kills), flushed each tick.
    broadcasts: Vec<Bytes>,
    /// Brains of the server-side bots, keyed by player id.
    pub bots: HashMap<u32, ai::BotBrain>,
    /// Bot ids in ascending order, for a stable update order.
    bot_ids: Vec<u32>,
    target_bots: usize,
    bots_created: usize,
    pub stats: WorldStats,
    /// Lock-free counters read by the lobby, dashboard and /metrics.
    pub live: Arc<ArenaStats>,
    db: Option<Db>,
    /// Centres of the 3x3 king-of-the-hill zones.
    pub hills: Vec<(i32, i32)>,
    round_ticks: u64,
    pub round_end: u64,
    parked: HashMap<String, Parked>,
    /// Per-client record of recent snapshots, for delta encoding.
    histories: HashMap<u32, SnapHistory>,
    snapshot_arenas: ArenaRing,
    /// Reliable events use their own arenas, so a slow client holding queued
    /// events never pins the (much larger) snapshot buffers.
    event_arenas: ArenaRing,
    scratch: Scratch,
    ai_scratch: ai::AiScratch,
}

/// Running totals, handy for logs and for judging the bots in tests.
#[derive(Default, Debug, Clone, Copy)]
pub struct WorldStats {
    pub deaths: u64,
    pub suicides: u64,
    pub crates_destroyed: u64,
    pub items_picked: u64,
    pub mysteries_opened: u64,
    pub nukes: u64,
    pub rounds: u64,
    pub ability_events: u64,
    pub gas_ignitions: u64,
    pub clones: u64,
    pub sticky_attached: u64,
    pub portal_pairs: u64,
    pub teleports: u64,
    pub dashes: u64,
    pub worms_killed: u64,
    pub worm_bites: u64,
    pub wardens_killed: u64,
    pub warden_crushes: u64,
}

impl World {
    pub fn new(cfg: &Config, live: Arc<ArenaStats>, db: Option<Db>) -> Self {
        // Battle royale needs room to run for the zone, and worms need room
        // to crawl and hunt: an open, connected map.
        let map = if matches!(cfg.mode, Mode::Royale | Mode::Worms) {
            Map::generate_open(cfg.map_w, cfg.map_h, &mut Rng::new(cfg.map_seed))
        } else {
            Map::generate(cfg.map_w, cfg.map_h, CRATE_DENSITY, &mut Rng::new(cfg.map_seed))
        };
        let s = &map.style;
        tracing::info!(
            arena = %cfg.name,
            map_seed = cfg.map_seed,
            pillars = ?s.pillars,
            symmetry = ?s.symmetry,
            crates = format_args!("{:.2}", s.crate_density),
            regions = ?map.biomes.iter().map(|b| b.biome).collect::<Vec<_>>(),
            teleports = map.teleports.len(),
            quality = %map.quality(),
            "map generated"
        );
        // Gameplay randomness stays independent of the map seed.
        let mut world = Self::with_map(map, Rng::from_time(), cfg.max_players);
        world.name.clone_from(&cfg.name);
        world.mode = cfg.mode;
        world.live = live;
        world.db = db;
        world.tuning = cfg.tuning.clone();
        world.round_ticks = u64::from(cfg.round_secs) * u64::from(TICK_RATE);
        // Royale matches end when one player is left, not on a timer.
        world.round_end = if cfg.mode == Mode::Royale { u64::MAX } else { world.round_ticks };
        world.carve_vault();
        world.place_hills();
        world.init_events();
        if cfg.mode == Mode::Worms {
            world.enable_worms();
        }
        world.set_target_bots(cfg.bots);
        world
    }

    #[must_use]
    pub fn with_map(map: Map, rng: Rng, max_players: usize) -> Self {
        let n = (map.w * map.h) as usize;
        let crate_count = map.count(Tile::Crate) + map.count(Tile::Armored);
        let buckets_w = (map.w + BUCKET - 1) / BUCKET;
        let buckets_h = (map.h + BUCKET - 1) / BUCKET;
        let round_ticks = u64::from(Config::default().round_secs) * u64::from(TICK_RATE);
        World {
            name: "Test".into(),
            mode: Mode::Ffa,
            input_lockstep: true,
            tick: 0,
            rng,
            max_players,
            players: HashMap::with_capacity(max_players),
            next_player_id: 0,
            bombs: HashMap::with_capacity(max_players * 2),
            bomb_grid: vec![0; n],
            next_bomb_id: 0,
            items: vec![0; n],
            flame_from: vec![0; n],
            flame_until: vec![0; n],
            flame_owner: vec![0; n],
            flame_spare: vec![0; n],
            explosions: Vec::new(),
            mines: Vec::new(),
            drones: Vec::new(),
            frozen: Vec::new(),
            tuning: default_tuning(),
            walls: Vec::new(),
            gas: Vec::new(),
            clones: Vec::new(),
            decoys: Vec::new(),
            portals: Vec::new(),
            sticky: Vec::new(),
            events: events::Events::default(),
            blizzard_until: 0,
            royale: royale::Royale::default(),
            worms: worms::Worms::new(n),
            guard: guard::Guard::default(),
            tile_changes: Vec::new(),
            item_changes: Vec::new(),
            crate_target: (crate_count as f32 * CRATE_REGROW_TARGET) as usize,
            crate_count,
            buckets: vec![Vec::new(); (buckets_w * buckets_h) as usize],
            buckets_w,
            broadcasts: Vec::new(),
            bots: HashMap::new(),
            bot_ids: Vec::new(),
            target_bots: 0,
            bots_created: 0,
            stats: WorldStats::default(),
            live: Arc::default(),
            db: None,
            hills: Vec::new(),
            round_ticks,
            round_end: round_ticks,
            parked: HashMap::new(),
            histories: HashMap::new(),
            snapshot_arenas: ArenaRing::new(SNAPSHOT_ARENA_CAPACITY),
            event_arenas: ArenaRing::new(EVENT_ARENA_CAPACITY),
            scratch: Scratch::default(),
            ai_scratch: ai::AiScratch::new(n),
            map,
        }
    }

    pub fn set_target_bots(&mut self, bots: usize) {
        self.target_bots = bots.min(self.max_players);
        self.maintain_bots();
    }
}

