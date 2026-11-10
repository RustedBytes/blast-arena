//! The tick: applying events, stepping the simulation, and the arena task.

use std::sync::Arc;
use std::sync::atomic::Ordering::Relaxed;
use std::time::{Duration, Instant};

use tokio::sync::mpsc;

use crate::db::Db;
use crate::metrics::ArenaStats;

use super::{Config, GameEvent, PROFILE_FLUSH_TICKS, TICK_RATE, World};

impl World {
    pub(super) fn publish_live_stats(&self, tick_avg: Duration, tick_max: Duration) {
        let humans = self.players.values().filter(|p| !p.is_bot()).count() as u32;
        let live = &self.live;
        live.players.store(self.players.len() as u32, Relaxed);
        live.humans.store(humans, Relaxed);
        live.bots.store(self.bots.len() as u32, Relaxed);
        live.bombs.store(self.bombs.len() as u32, Relaxed);
        live.round_secs.store(self.round_secs_left(), Relaxed);
        live.tick_avg_us.store(u32::try_from(tick_avg.as_micros()).unwrap_or(u32::MAX), Relaxed);
        live.tick_max_us.store(u32::try_from(tick_max.as_micros()).unwrap_or(u32::MAX), Relaxed);
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
        self.read_inputs();
        self.update_bots();
        self.update_players();
        self.rebuild_buckets();
        self.update_drones();
        self.update_mines();
        self.update_sliding_bombs();
        self.update_fuses();
        self.apply_flame_damage();
        self.update_hills();
        self.update_events();
        self.melt_ice();
        self.regrow_crates();
        if self.tick.is_multiple_of(u64::from(TICK_RATE)) {
            self.maintain_bots();
            self.update_bounty();
        }
        if self.tick >= self.round_end {
            self.end_round();
        }
        if self.tick.is_multiple_of(PROFILE_FLUSH_TICKS) {
            self.flush_profiles();
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
    loop {
        interval.tick().await;
        let started = Instant::now();
        loop {
            match events.try_recv() {
                Ok(ev) => world.handle(ev),
                Err(mpsc::error::TryRecvError::Empty) => break,
                Err(mpsc::error::TryRecvError::Disconnected) => {
                    world.save_all();
                    tracing::info!(players = world.players.len(), "arena stopped, profiles saved");
                    return;
                }
            }
        }
        world.step();
        world.send_updates();
        world.drop_lagging_clients();

        let took = started.elapsed();
        ticks += 1;
        busy += took;
        worst = worst.max(took);
        if world.tick.is_multiple_of(u64::from(TICK_RATE)) {
            world.publish_live_stats(busy / ticks.max(1), worst);
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
