//! Battle royale: last player standing. A match starts with everyone
//! spread over the map and the whole map safe; then a safe zone shrinks in
//! phases (the next, smaller circle is shown first, then the zone closes in
//! on it). Outside the zone is the storm: stay in it too long and you die,
//! sooner in later phases. No respawns during a match: the dead watch, and
//! a new match starts a few seconds after the last one is decided.

use crate::protocol::{self, ev};

use super::{TICK_RATE, World};

const SEC: u64 = TICK_RATE as u64;
/// Per phase: seconds the next circle is shown before the zone moves,
/// seconds it takes to close in, and the new radius as a fraction of half
/// the map size.
pub const PHASES: [(u64, u64, f32); 5] = [(25, 30, 0.55), (20, 25, 0.32), (15, 20, 0.18), (12, 15, 0.08), (10, 12, 0.0)];
/// Ticks a player survives in the storm, per phase (the last value also
/// after the final phase).
pub const STORM_TICKS: [u16; 6] = [100, 80, 60, 40, 30, 20];
/// Pause between matches.
pub const INTERMISSION_TICKS: u64 = 6 * SEC;
/// Points for winning a match.
pub const WIN_POINTS: i32 = 5;

#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct Circle {
    pub x: f32,
    pub y: f32,
    pub r: f32,
}

impl Circle {
    fn lerp(a: Circle, b: Circle, t: f32) -> Circle {
        Circle { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, r: a.r + (b.r - a.r) * t }
    }

    #[must_use]
    pub fn contains(&self, x: f32, y: f32) -> bool {
        (x - self.x).powi(2) + (y - self.y).powi(2) <= self.r * self.r
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum ZoneState {
    /// The next circle is shown; the zone holds still.
    #[default]
    Waiting,
    /// The zone closes in from `from` to `to`.
    Shrinking,
    /// The last phase is over (or no match is running).
    Done,
}

#[derive(Default)]
pub struct Royale {
    pub match_on: bool,
    pub next_match_at: u64,
    /// Players in the match when it started.
    pub started_with: usize,
    pub phase: usize,
    pub state: ZoneState,
    pub state_start: u64,
    pub state_end: u64,
    /// The zone now (or where a shrink starts) and the next circle.
    pub from: Circle,
    pub to: Circle,
    last_alive: usize,
    /// Who was still standing at the end of the previous tick: if they all
    /// go down together, the match still has a winner among them.
    survivors: Vec<u32>,
    /// The last match's winner (`None` for a solo match nobody survived).
    pub last_winner: Option<u32>,
}

impl World {
    #[must_use]
    pub fn is_royale(&self) -> bool {
        self.mode == super::Mode::Royale
    }

    /// The safe zone right now.
    #[must_use]
    pub fn zone(&self) -> Circle {
        let z = &self.royale;
        if z.state == ZoneState::Shrinking {
            let span = z.state_end.saturating_sub(z.state_start).max(1) as f32;
            let t = (self.tick.saturating_sub(z.state_start) as f32 / span).min(1.0);
            Circle::lerp(z.from, z.to, t)
        } else {
            z.from
        }
    }

    /// Ticks a player can stand in the storm now.
    #[must_use]
    pub fn storm_limit(&self) -> u16 {
        STORM_TICKS[self.royale.phase.min(STORM_TICKS.len() - 1)]
    }

    pub(super) fn update_royale(&mut self) {
        if !self.is_royale() {
            return;
        }
        let tick = self.tick;
        if !self.royale.match_on {
            if tick >= self.royale.next_match_at {
                self.start_match();
            }
            return;
        }
        self.advance_zone();
        self.storm_damage();
        let alive: Vec<u32> = self.players.values().filter(|p| p.alive).map(|p| p.id).collect();
        if alive.len() != self.royale.last_alive {
            self.royale.last_alive = alive.len();
            self.announce_royale();
        }
        // Decided: one left of a real match, or nobody at all. A real match
        // always has a winner: if the last few went down together (a shared
        // blast), the best of them takes it.
        if alive.is_empty() || (self.royale.started_with >= 2 && alive.len() <= 1) {
            let winner = alive.first().copied().or_else(|| {
                if self.royale.started_with < 2 {
                    return None;
                }
                let survivors = std::mem::take(&mut self.royale.survivors);
                survivors.into_iter().filter_map(|id| self.players.get(&id)).max_by_key(|p| (p.score, std::cmp::Reverse(p.id))).map(|p| p.id)
            });
            self.end_match(winner);
            return;
        }
        self.royale.survivors = alive;
    }

    /// Everyone back on the map, spread out, power-ups reset, full zone.
    pub(super) fn start_match(&mut self) {
        // A clean board: no leftover bombs, mines or drones.
        let ids: Vec<u32> = self.bombs.keys().copied().collect();
        for id in ids {
            if let Some(b) = self.bombs.remove(&id) {
                let i = self.map.idx(b.x, b.y);
                if self.bomb_grid[i] == id {
                    self.bomb_grid[i] = 0;
                }
            }
        }
        self.mines.clear();
        self.drones.clear();
        self.sticky.clear();
        self.reset_abilities_for_round();
        let mut ids: Vec<u32> = self.players.keys().copied().collect();
        ids.sort_unstable();
        for &id in &ids {
            let p = self.players.get_mut(&id).unwrap();
            p.reset_stats();
            (p.active_bombs, p.storm, p.carrying) = (0, 0, 0);
            self.respawn(id);
        }
        let (w, h) = (self.map.w as f32, self.map.h as f32);
        let full = Circle { x: w / 2.0, y: h / 2.0, r: (w * w + h * h).sqrt() / 2.0 + 1.0 };
        let r = &mut self.royale;
        (r.match_on, r.started_with, r.phase, r.from) = (true, ids.len(), 0, full);
        r.last_alive = ids.len();
        r.survivors.clone_from(&ids);
        self.begin_wait();
        self.announce_royale();
        tracing::debug!(players = ids.len(), "royale match started");
    }

    /// Picks the next circle inside the current one and shows it.
    fn begin_wait(&mut self) {
        let phase = self.royale.phase;
        let Some(&(wait, _, frac)) = PHASES.get(phase) else {
            self.royale.state = ZoneState::Done;
            self.announce_zone();
            return;
        };
        let cur = self.royale.from;
        let half = self.map.w.min(self.map.h) as f32 / 2.0;
        let radius = frac * half;
        // A centre that keeps the new circle inside the old one and on the map.
        let room = (cur.r - radius).max(0.0);
        let angle = self.rng.range(0.0, std::f32::consts::TAU);
        let dist = self.rng.range(0.0, 1.0).sqrt() * room;
        let margin = radius.min(half - 1.0);
        let x = (cur.x + angle.cos() * dist).clamp(margin + 1.0, self.map.w as f32 - margin - 1.0);
        let y = (cur.y + angle.sin() * dist).clamp(margin + 1.0, self.map.h as f32 - margin - 1.0);
        let z = &mut self.royale;
        z.to = Circle { x, y, r: radius };
        (z.state, z.state_start, z.state_end) = (ZoneState::Waiting, self.tick, self.tick + wait * SEC);
        self.announce_zone();
    }

    fn advance_zone(&mut self) {
        let tick = self.tick;
        let z = &self.royale;
        if z.state == ZoneState::Done || tick < z.state_end {
            return;
        }
        match z.state {
            ZoneState::Waiting => {
                let shrink = PHASES[z.phase].1 * SEC;
                let z = &mut self.royale;
                (z.state, z.state_start, z.state_end) = (ZoneState::Shrinking, tick, tick + shrink);
                self.announce_zone();
            }
            ZoneState::Shrinking => {
                let z = &mut self.royale;
                z.from = z.to;
                z.phase += 1;
                self.begin_wait();
            }
            ZoneState::Done => {}
        }
    }

    /// The storm: time outside the zone adds up (and wears off inside).
    /// The storm never takes the last players all at once (the zone ends at
    /// a point, so in the end everyone is in it): whoever is closest to the
    /// zone's centre is spared and wins.
    fn storm_damage(&mut self) {
        let zone = self.zone();
        let limit = self.storm_limit();
        let mut dead = Vec::new();
        let mut alive = 0;
        for p in self.players.values_mut().filter(|p| p.alive) {
            alive += 1;
            if zone.contains(p.x, p.y) {
                p.storm = p.storm.saturating_sub(2);
            } else {
                p.storm += 1;
                if p.storm >= limit {
                    dead.push(p.id);
                }
            }
        }
        if !dead.is_empty() && dead.len() == alive && self.royale.started_with >= 2 {
            let players = &self.players;
            let dist = |id: &u32| {
                let p = &players[id];
                (p.x - zone.x).powi(2) + (p.y - zone.y).powi(2)
            };
            let spared = dead.iter().enumerate().min_by(|a, b| dist(a.1).total_cmp(&dist(b.1)).then(a.1.cmp(b.1))).map(|(k, _)| k);
            if let Some(k) = spared {
                dead.swap_remove(k);
            }
        }
        for id in dead {
            self.kill(id, None);
        }
    }

    fn end_match(&mut self, winner: Option<u32>) {
        self.royale.last_winner = winner;
        if let Some(p) = winner.and_then(|w| self.players.get_mut(&w)) {
            p.score += WIN_POINTS;
            if let Some(prof) = &mut p.profile {
                prof.wins += 1;
                prof.xp += super::XP_MVP;
                p.profile_dirty = true;
            }
            tracing::info!(winner = %p.name, "royale match won");
        }
        self.broadcast_event(ev::WINNER, &[winner.map_or(0, |w| i64::from(w) + 1)]);
        // Scores and the MVP panel work per match.
        self.end_round();
        let r = &mut self.royale;
        (r.match_on, r.next_match_at, r.state) = (false, self.tick + INTERMISSION_TICKS, ZoneState::Done);
        self.announce_royale();
        self.announce_zone();
    }

    /// Deaths are final until the next match.
    pub(super) fn royale_on_death(&mut self, id: u32) {
        if self.is_royale()
            && self.royale.match_on
            && let Some(p) = self.players.get_mut(&id)
        {
            p.respawn_at = u64::MAX;
        }
    }

    /// Someone joining mid-match watches until the next one, unless the
    /// zone hasn't moved yet: then there's still time to join in.
    pub(super) fn royale_on_join(&mut self, id: u32) {
        let z = &self.royale;
        let early = z.phase == 0 && z.state == ZoneState::Waiting;
        if self.is_royale()
            && z.match_on
            && !early
            && let Some(p) = self.players.get_mut(&id)
        {
            (p.alive, p.respawn_at) = (false, u64::MAX);
        }
    }

    fn zone_values(&self) -> Vec<i64> {
        let z = &self.royale;
        let state = match z.state {
            ZoneState::Waiting => 0,
            ZoneState::Shrinking => 1,
            ZoneState::Done => 2,
        };
        let c = |v: f32| (v * 100.0).round() as i64;
        let left = z.state_end.saturating_sub(self.tick) as i64;
        let (a, b) = (z.from, z.to);
        vec![state, left, c(a.x), c(a.y), c(a.r), c(b.x), c(b.y), c(b.r), z.phase as i64]
    }

    fn announce_zone(&mut self) {
        let v = self.zone_values();
        self.broadcast_event(ev::ZONE, &v);
    }

    fn royale_values(&self) -> Vec<i64> {
        let r = &self.royale;
        let alive = self.players.values().filter(|p| p.alive).count() as i64;
        let next = r.next_match_at.saturating_sub(self.tick) as i64;
        vec![alive, i64::from(r.match_on), if r.match_on { 0 } else { next }]
    }

    fn announce_royale(&mut self) {
        let v = self.royale_values();
        self.broadcast_event(ev::ROYALE, &v);
    }

    /// The zone and match status for a client that just joined.
    pub(super) fn royale_state_for_join(&mut self) -> Vec<bytes::Bytes> {
        if !self.is_royale() {
            return Vec::new();
        }
        let (z, r) = (self.zone_values(), self.royale_values());
        vec![
            protocol::encode_event(self.event_arenas.current(), ev::ZONE, &z),
            protocol::encode_event(self.event_arenas.current(), ev::ROYALE, &r),
        ]
    }
}
