//! The tick: applying events, stepping the simulation, and the arena task.

use std::sync::Arc;
use std::sync::atomic::Ordering::Relaxed;
use std::time::{Duration, Instant};

use tokio::sync::mpsc;

use crate::db::Db;
use crate::metrics::ArenaStats;

use super::{Config, GameEvent, Mode, PROFILE_FLUSH_TICKS, TICK_RATE, World};

/// An arena no human is in steps once every this many ticks (once a
/// second): nobody sees it, and the first human to join starts the round
/// over anyway. Events (joins) are still handled every tick.
pub const IDLE_STEP_EVERY: u32 = TICK_RATE;
/// Back-pressure: when a second's ticks average more than this, far-away
/// bots think less often (`World::ai_slowdown` goes up a step, at most to
/// `MAX_AI_SLOWDOWN`); below `RELAX_TICK` it comes back down a step.
const BUSY_TICK: Duration = Duration::from_millis(8);
const RELAX_TICK: Duration = Duration::from_millis(4);
pub const MAX_AI_SLOWDOWN: u32 = 4;

impl World {
    pub(super) fn publish_live_stats(&self, tick_avg: Duration, tick_max: Duration) {
        let humans = self.players.values().filter(|p| !p.is_bot()).count() as u32;
        let live = &self.live;
        live.players.store(self.players.len() as u32, Relaxed);
        live.humans.store(humans, Relaxed);
        live.bots.store(self.bots.len() as u32, Relaxed);
        live.bombs.store(self.bombs.len() as u32, Relaxed);
        // Royale matches have no clock.
        let round = if self.mode == Mode::Royale { 0 } else { self.round_secs_left() };
        live.round_secs.store(round, Relaxed);
        live.tick_avg_us.store(u32::try_from(tick_avg.as_micros()).unwrap_or(u32::MAX), Relaxed);
        live.tick_max_us.store(u32::try_from(tick_max.as_micros()).unwrap_or(u32::MAX), Relaxed);
    }

    /// Whether a human is in the arena (playing, dead or watching).
    #[must_use]
    pub fn has_humans(&self) -> bool {
        self.players.values().any(|p| !p.is_bot())
    }

    /// Adjusts the back-pressure on the bots from a second's average tick.
    pub fn adapt_ai_load(&mut self, avg_tick: Duration) {
        let before = self.ai_slowdown;
        if avg_tick > BUSY_TICK {
            self.ai_slowdown = (self.ai_slowdown + 1).min(MAX_AI_SLOWDOWN);
        } else if avg_tick < RELAX_TICK {
            self.ai_slowdown = self.ai_slowdown.saturating_sub(1).max(1);
        }
        if self.ai_slowdown != before {
            tracing::debug!(slowdown = self.ai_slowdown, avg_tick_ms = format!("{:.2}", avg_tick.as_secs_f64() * 1000.0), "bot back-pressure");
        }
    }

    pub fn handle(&mut self, ev: GameEvent) {
        match ev {
            GameEvent::Join { req, link, reply } => {
                let _ = reply.send(self.join(req, link));
            }
            GameEvent::Leave { id } => self.leave(id),
        }
    }

    /// Advances the simulation by one tick (without networking).
    pub fn step(&mut self) {
        self.tick += 1;
        self.event_arenas.rotate();
        let tick = self.tick;
        self.explosions.retain(|e| e.until > tick);
        // Times a phase into `profile` when profiling; otherwise one branch.
        macro_rules! phase {
            ($i:expr, $e:expr) => {{
                let t = self.profile.is_some().then(Instant::now);
                $e;
                if let (Some(t), Some(p)) = (t, self.profile.as_deref_mut()) {
                    p.last[$i] = t.elapsed();
                }
            }};
        }
        if let Some(p) = self.profile.as_deref_mut() {
            p.last = [Duration::ZERO; PHASES.len()];
        }
        // The order inside a tick is fixed (see `abilities` for the
        // contract): commands and abilities, movement with portal trips and
        // dashes, sticky bombs following their carriers, fuses and blasts,
        // gas (which this tick's fire may ignite), damage, worms (cut by this
        // tick's fire, then crawling and biting), monsters (likewise), then
        // timers.
        phase!(0, self.read_inputs());
        phase!(1, self.update_bots());
        phase!(2, self.update_players());
        phase!(3, self.rebuild_buckets());
        phase!(4, {
            self.update_drones();
            self.update_mines();
            self.update_sliding_bombs();
            self.update_sticky();
        });
        phase!(5, self.update_fuses());
        phase!(6, {
            self.update_gas();
            self.apply_flame_damage();
        });
        phase!(7, {
            self.update_worms();
            self.update_monsters();
            self.update_guard();
            self.update_clones();
            self.update_walls();
            self.update_portals();
        });
        phase!(8, {
            self.recharge_abilities();
            self.update_hills();
            self.update_events();
            self.update_royale();
            self.melt_ice();
            self.regrow_crates();
        });
        if self.tick.is_multiple_of(u64::from(TICK_RATE)) {
            phase!(9, {
                self.maintain_bots();
                self.update_bounty();
            });
        }
        if self.tick >= self.round_end {
            phase!(10, self.end_round());
        }
        if self.tick.is_multiple_of(PROFILE_FLUSH_TICKS) {
            phase!(11, self.flush_profiles());
        }
    }

    /// `send_updates`, timed into the profile's last slot when profiling.
    pub fn send_updates_profiled(&mut self) {
        let t = self.profile.is_some().then(Instant::now);
        self.send_updates();
        if let (Some(t), Some(p)) = (t, self.profile.as_deref_mut()) {
            p.last[PHASES.len() - 1] = t.elapsed();
        }
    }
}

/// Names of the profiled phases of a tick, in order (see `World::step`).
pub const PHASES: [&str; 13] = [
    "inputs",
    "bots (AI)",
    "players (movement)",
    "buckets",
    "drones/mines/sliding/sticky",
    "fuses & blasts",
    "gas & flame damage",
    "worms/monsters/guard/clones/walls/portals",
    "abilities/hills/events/royale/ice/crates",
    "per second: maintain bots, bounty",
    "end of round",
    "profile flush",
    "send updates (snapshots)",
];

/// Per-phase times of the last tick (`World::profile`).
pub struct TickProfile {
    pub last: [Duration; PHASES.len()],
}

impl Default for TickProfile {
    fn default() -> Self {
        TickProfile { last: [Duration::ZERO; PHASES.len()] }
    }
}

/// Handles every event waiting for the arena. Returns false when the
/// server is shutting down (profiles are saved then).
fn drain_events(world: &mut World, events: &mut mpsc::Receiver<GameEvent>) -> bool {
    loop {
        match events.try_recv() {
            Ok(ev) => world.handle(ev),
            Err(mpsc::error::TryRecvError::Empty) => return true,
            Err(mpsc::error::TryRecvError::Disconnected) => {
                world.save_all();
                tracing::info!(players = world.players.len(), "arena stopped, profiles saved");
                return false;
            }
        }
    }
}

#[tracing::instrument(name = "arena", skip_all, fields(arena = %cfg.name))]
pub async fn run(cfg: Config, mut events: mpsc::Receiver<GameEvent>, live: Arc<ArenaStats>, db: Option<Db>) {
    let mut world = World::new(&cfg, live, db);
    tracing::info!(mode = cfg.mode.as_str(), w = cfg.map_w, h = cfg.map_h, bots = world.bots.len(), "arena ready");
    let mut interval = tokio::time::interval(Duration::from_millis(1000 / u64::from(TICK_RATE)));
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    let mut stats_since = Instant::now();
    let (mut ticks, mut busy, mut worst) = (0u32, Duration::ZERO, Duration::ZERO);
    // This second's stepped ticks and their time, for the back-pressure.
    let (mut sec_ticks, mut sec_busy) = (0u32, Duration::ZERO);
    let mut beats = 0u32;
    loop {
        interval.tick().await;
        let started = Instant::now();
        if !drain_events(&mut world, &mut events) {
            return;
        }
        beats = beats.wrapping_add(1);
        if world.has_humans() || beats.is_multiple_of(IDLE_STEP_EVERY) {
            world.step();
            world.send_updates();
            world.drop_lagging_clients();
            let took = started.elapsed();
            ticks += 1;
            busy += took;
            worst = worst.max(took);
            sec_ticks += 1;
            sec_busy += took;
        }
        // Once a second of wall time, however often the world stepped.
        if beats.is_multiple_of(TICK_RATE) {
            world.publish_live_stats(busy / ticks.max(1), worst);
            if sec_ticks > 0 {
                world.adapt_ai_load(sec_busy / sec_ticks);
            }
            (sec_ticks, sec_busy) = (0, Duration::ZERO);
        }
        if stats_since.elapsed() >= Duration::from_secs(10) {
            tracing::info!(
                players = world.players.len(),
                bots = world.bots.len(),
                bombs = world.bombs.len(),
                avg_tick_ms = format!("{:.2}", busy.as_secs_f64() * 1000.0 / f64::from(ticks)),
                max_tick_ms = format!("{:.2}", worst.as_secs_f64() * 1000.0),
                "tick stats"
            );
            stats_since = Instant::now();
            (ticks, busy, worst) = (0, Duration::ZERO, Duration::ZERO);
        }
    }
}
