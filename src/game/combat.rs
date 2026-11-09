//! Deaths, scoring for kills, and flame damage.

use super::*;

impl World {
    pub(super) fn kill(&mut self, victim: u32, killer: Option<u32>) {
        let Some(v) = self.players.get_mut(&victim) else { return };
        v.alive = false;
        v.moving = false;
        v.deaths += 1;
        v.streak = 0;
        v.respawn_at = self.tick + RESPAWN_TICKS;
        v.killed_by = killer;
        let had_bounty = std::mem::take(&mut v.bounty);
        if let Some(prof) = &mut v.profile {
            prof.deaths += 1;
            v.profile_dirty = true;
        }
        let (vx, vy) = (v.x, v.y);
        let (cx, cy) = v.cell();

        // Lose upgrades; a few of them are scattered for others to grab.
        let mut lost = [Item::ExtraBomb; 40];
        let mut n = 0;
        let mut lose = |item: Item, count: u8| {
            for _ in 0..count {
                lost[n] = item;
                n += 1;
            }
        };
        lose(Item::ExtraBomb, v.max_bombs - player::BASE_BOMBS);
        lose(Item::Range, v.range - player::BASE_RANGE);
        lose(Item::Speed, v.speed_lvl);
        lose(Item::Kick, v.kick as u8);
        lose(Item::Pierce, v.pierce as u8);
        lose(Item::Remote, v.remote as u8);
        lose(Item::LineBomb, v.line as u8);
        lose(Item::Punch, v.punch as u8);
        v.reset_stats();
        for _ in 0..ITEMS_DROPPED_ON_DEATH.min(n) {
            let k = self.rng.below(n as u32) as usize;
            let item = lost[k];
            lost[k] = lost[n - 1];
            n -= 1;
            for _ in 0..20 {
                let x = cx + self.rng.between(-3, 3);
                let y = cy + self.rng.between(-3, 3);
                if self.map.in_bounds(x, y) && !self.map.is_solid(x, y) {
                    let i = self.map.idx(x, y);
                    if self.items[i] == 0 && self.bomb_grid[i] == 0 {
                        self.set_item(x, y, item as u8);
                        break;
                    }
                }
            }
        }

        let killer = killer.filter(|k| self.players.contains_key(k));
        self.stats.deaths += 1;
        self.live.deaths.fetch_add(1, Relaxed);
        match killer {
            Some(k) if k == victim => {
                self.stats.suicides += 1;
                self.players.get_mut(&k).unwrap().score -= 1;
            }
            Some(k) => {
                let kp = self.players.get_mut(&k).unwrap();
                kp.score += 1 + if had_bounty { BOUNTY_BONUS } else { 0 };
                kp.kills += 1;
                kp.streak += 1;
                let streak = kp.streak;
                if let Some(prof) = &mut kp.profile {
                    prof.kills += 1;
                    prof.xp += XP_KILL + if had_bounty { XP_BOUNTY } else { 0 };
                    prof.best_streak = prof.best_streak.max(streak as u64);
                    kp.profile_dirty = true;
                }
                if STREAKS.contains(&streak) {
                    self.broadcasts.push(protocol::encode_streak(self.event_arenas.current(), k, streak));
                }
                self.scratch.emotes.push((k, EMOTE_COOL));
            }
            None => {}
        }
        self.broadcasts.push(protocol::encode_kill(self.event_arenas.current(), killer, victim, vx, vy, had_bounty));
    }

    pub(super) fn apply_flame_damage(&mut self) {
        let mut victims = std::mem::take(&mut self.scratch.victims);
        victims.clear();
        victims.extend(self.players.values().filter(|p| p.alive && p.invulnerable_until <= self.tick).filter_map(|p| {
            let (x, y) = p.cell();
            if !self.flame_active(x, y) {
                return None;
            }
            let owner = self.flame_owner[self.map.idx(x, y)];
            // No friendly fire in team mode (your own bombs still hurt).
            let friendly = self.players.get(&owner).is_some_and(|o| !o.can_hurt(p));
            (!friendly).then_some((p.id, owner))
        }));
        for &(v, k) in &victims {
            self.kill(v, Some(k));
        }
        self.scratch.victims = victims;
    }
}
