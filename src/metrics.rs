//! Live per-arena statistics, shared lock-free between the game task (which
//! writes them) and the HTTP handlers (which read them for the lobby, the
//! dashboard and Prometheus).

use std::sync::atomic::{AtomicU32, AtomicU64, Ordering::Relaxed};

#[derive(Default)]
pub struct ArenaStats {
    pub players: AtomicU32,
    pub humans: AtomicU32,
    pub bots: AtomicU32,
    pub bombs: AtomicU32,
    /// Average and worst tick time over the last stats window, microseconds.
    pub tick_avg_us: AtomicU32,
    pub tick_max_us: AtomicU32,
    /// Seconds left in the current round.
    pub round_secs: AtomicU32,
    /// Bytes written to sockets (counted by the connection writers).
    pub bytes_out: AtomicU64,
    pub deaths: AtomicU64,
}

impl ArenaStats {
    pub fn snapshot(&self) -> ArenaSnapshot {
        ArenaSnapshot {
            players: self.players.load(Relaxed),
            humans: self.humans.load(Relaxed),
            bots: self.bots.load(Relaxed),
            bombs: self.bombs.load(Relaxed),
            tick_ms: f64::from(self.tick_avg_us.load(Relaxed)) / 1000.0,
            max_tick_ms: f64::from(self.tick_max_us.load(Relaxed)) / 1000.0,
            round_secs: self.round_secs.load(Relaxed),
            bytes_out: self.bytes_out.load(Relaxed),
            deaths: self.deaths.load(Relaxed),
        }
    }
}

#[derive(serde::Serialize, Clone, Copy, Default)]
pub struct ArenaSnapshot {
    pub players: u32,
    pub humans: u32,
    pub bots: u32,
    pub bombs: u32,
    pub tick_ms: f64,
    pub max_tick_ms: f64,
    pub round_secs: u32,
    pub bytes_out: u64,
    pub deaths: u64,
}
