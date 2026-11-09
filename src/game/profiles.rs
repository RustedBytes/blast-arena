//! Saving player profiles.

use crate::db::{self, Profile};
use crate::protocol::ProfileView;

use super::World;

impl World {
    /// Saves changed profiles now and then (and forgets stale parked players).
    pub(super) fn flush_profiles(&mut self) {
        let tick = self.tick;
        self.parked.retain(|_, p| p.expires > tick);
        let Some(db) = &self.db else { return };
        let mut saved = 0;
        for p in self.players.values_mut() {
            if p.profile_dirty {
                if let Some(prof) = &p.profile {
                    db.save(prof.clone());
                    saved += 1;
                }
                p.profile_dirty = false;
            }
        }
        if saved > 0 {
            tracing::debug!(saved, "profiles queued for saving");
        }
    }

    /// Saves every profile (on shutdown).
    pub fn save_all(&mut self) {
        for p in self.players.values_mut() {
            p.profile_dirty = true;
        }
        self.flush_profiles();
    }
}

pub(super) fn profile_view(p: &Profile) -> ProfileView {
    let level = p.level();
    ProfileView {
        level,
        xp: p.xp,
        next_xp: db::xp_for_level(level + 1),
        kills: p.kills,
        deaths: p.deaths,
        wins: p.wins,
        best_streak: p.best_streak,
    }
}
