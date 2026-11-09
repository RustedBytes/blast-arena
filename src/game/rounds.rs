//! Rounds, hills, the bounty and the end-of-round MVP.

use super::*;

impl World {
    pub(super) fn round_secs_left(&self) -> u32 {
        (self.round_end.saturating_sub(self.tick) / TICK_RATE as u64) as u32
    }

    pub fn in_hill(&self, x: i32, y: i32) -> bool {
        self.hills.iter().any(|&(hx, hy)| (x - hx).abs() <= 1 && (y - hy).abs() <= 1)
    }

    /// Moves the king-of-the-hill zones to new spots, clearing crates so
    /// they can be stood on.
    pub(super) fn place_hills(&mut self) {
        let n = ((self.map.w * self.map.h) / 1600).clamp(1, 6) as usize;
        self.hills.clear();
        for _ in 0..n * 10 {
            if self.hills.len() >= n {
                break;
            }
            let x = self.rng.between(1, (self.map.w - 3) / 2) * 2 + 1;
            let y = self.rng.between(1, (self.map.h - 3) / 2) * 2 + 1;
            if x + 1 >= self.map.w - 1 || y + 1 >= self.map.h - 1 {
                continue;
            }
            let far = self.hills.iter().all(|&(hx, hy)| (hx - x).abs() + (hy - y).abs() > self.map.w / 4);
            if !far {
                continue;
            }
            for cy in y - 1..=y + 1 {
                for cx in x - 1..=x + 1 {
                    if self.map.get(cx, cy).is_breakable() {
                        self.set_tile(cx, cy, Tile::Floor);
                    }
                }
            }
            self.hills.push((x, y));
        }
    }

    /// Players on a hill earn a point every few seconds.
    pub(super) fn update_hills(&mut self) {
        for p in self.players.values_mut() {
            if !p.alive {
                continue;
            }
            let (x, y) = p.cell();
            if !self.hills.iter().any(|&(hx, hy)| (x - hx).abs() <= 1 && (y - hy).abs() <= 1) {
                p.hill_ticks = 0;
                continue;
            }
            p.hill_ticks += 1;
            if p.hill_ticks >= HILL_POINT_TICKS {
                p.hill_ticks = 0;
                p.score += 1;
                if let Some(prof) = &mut p.profile {
                    prof.xp += XP_HILL;
                    p.profile_dirty = true;
                }
            }
        }
    }

    /// The highest scorer (if clearly ahead) carries a bounty.
    pub(super) fn update_bounty(&mut self) {
        let leader = self.players.values().filter(|p| p.score >= BOUNTY_MIN_SCORE).max_by_key(|p| (p.score, std::cmp::Reverse(p.id))).map(|p| p.id);
        for p in self.players.values_mut() {
            p.bounty = Some(p.id) == leader;
        }
    }

    pub(super) fn team_scores(&self) -> (i32, i32) {
        let mut s = (0, 0);
        for p in self.players.values() {
            match p.team {
                1 => s.0 += p.score,
                2 => s.1 += p.score,
                _ => {}
            }
        }
        s
    }

    /// Ends the round: announces the MVPs, rewards them, resets scores and
    /// moves the hills.
    pub(super) fn end_round(&mut self) {
        self.stats.rounds += 1;
        let mut ranked: Vec<&Player> = self.players.values().collect();
        ranked.sort_by_key(|p| (std::cmp::Reverse(p.score), std::cmp::Reverse(p.kills), p.id));
        let mvp_id = ranked.first().filter(|p| p.score > 0).map(|p| p.id);
        let teams = self.team_scores();
        let winner = match self.mode {
            Mode::Teams if teams.0 > teams.1 => 1,
            Mode::Teams if teams.1 > teams.0 => 2,
            _ => 0,
        };
        match ranked.first().filter(|p| p.score > 0) {
            Some(mvp) => tracing::info!(
                round = self.stats.rounds,
                mvp = %mvp.name,
                score = mvp.score,
                kills = mvp.kills,
                red = teams.0,
                blue = teams.1,
                winner,
                players = ranked.len(),
                "round ended"
            ),
            None => tracing::info!(round = self.stats.rounds, players = ranked.len(), "round ended without a winner"),
        }
        let top = ranked.iter().take(3).map(|p| (p.id, p.name.as_str(), p.score, p.kills));
        let round_secs = (self.round_ticks / TICK_RATE as u64) as u32;
        let msg = protocol::encode_round(self.event_arenas.current(), top, teams, winner, round_secs);
        self.broadcasts.push(msg);

        for p in self.players.values_mut() {
            let won = Some(p.id) == mvp_id || (winner != 0 && p.team == winner);
            if let Some(prof) = &mut p.profile {
                if Some(p.id) == mvp_id {
                    prof.wins += 1;
                    prof.xp += XP_MVP;
                } else if won {
                    prof.xp += XP_MVP / 2;
                }
                p.profile_dirty = true;
            }
            (p.score, p.kills, p.deaths, p.streak, p.bounty) = (0, 0, 0, 0, false);
        }
        self.round_end = self.tick + self.round_ticks;
        self.place_hills();
        let hills = protocol::encode_hills(self.event_arenas.current(), &self.hills);
        self.broadcasts.push(hills);
    }
}
