//! Deaths, scoring for kills, and flame damage.

use std::sync::atomic::Ordering::Relaxed;

use crate::protocol;

use super::items::Item;
use super::player;
use super::{BOUNTY_BONUS, EMOTE_COOL, ITEMS_DROPPED_ON_DEATH, RESPAWN_TICKS, STREAKS, World, XP_BOUNTY, XP_KILL};

impl World {
    pub(super) fn kill(&mut self, victim: u32, killer: Option<u32>) {
        let Some(cell) = self.players.get(&victim).map(super::player::Player::cell) else { return };
        self.carrier_lost(victim, cell);
        let Some(dead) = self.players.get_mut(&victim) else { return };
        dead.alive = false;
        (dead.jump_left, dead.jump_dir, dead.stunned_until) = (0, 0, 0);
        dead.moving = false;
        dead.deaths += 1;
        dead.streak = 0;
        dead.respawn_at = self.tick + RESPAWN_TICKS;
        dead.killed_by = killer;
        let had_bounty = std::mem::take(&mut dead.bounty);
        if let Some(prof) = &mut dead.profile {
            prof.deaths += 1;
            dead.profile_dirty = true;
        }
        let (vx, vy) = (dead.x, dead.y);
        let (cx, cy) = dead.cell();

        // Lose upgrades; a few of them are scattered for others to grab.
        let mut upgrades = [Item::ExtraBomb; 40];
        let mut count = 0;
        let mut lose = |item: Item, levels: u8| {
            for _ in 0..levels {
                upgrades[count] = item;
                count += 1;
            }
        };
        lose(Item::ExtraBomb, dead.max_bombs - player::BASE_BOMBS);
        lose(Item::Range, dead.range - player::BASE_RANGE);
        lose(Item::Speed, dead.speed_lvl);
        lose(Item::Kick, u8::from(dead.kick));
        lose(Item::Pierce, u8::from(dead.pierce));
        lose(Item::Remote, u8::from(dead.remote));
        lose(Item::LineBomb, u8::from(dead.line));
        lose(Item::Punch, u8::from(dead.punch));
        lose(Item::Nuke, dead.nukes);
        lose(Item::Freeze, u8::from(dead.freeze));
        lose(Item::Stomp, u8::from(dead.stomp));
        if let Some(g) = Item::from_u8(dead.gadget).filter(|_| dead.gadget_n > 0) {
            lose(g, 1);
        }
        if let Some(a) = Item::from_u8(dead.ability) {
            lose(a, 1);
        }
        lose(Item::GasBomb, u8::from(dead.gas_bombs > 0));
        lose(Item::StickyBomb, u8::from(dead.sticky_bombs > 0));
        dead.reset_stats();
        for _ in 0..ITEMS_DROPPED_ON_DEATH.min(count) {
            let pick = self.rng.below(count as u32) as usize;
            let item = upgrades[pick];
            upgrades[pick] = upgrades[count - 1];
            count -= 1;
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
                    prof.best_streak = prof.best_streak.max(u64::from(streak));
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
        self.abilities_on_death(victim);
        self.royale_on_death(victim);
    }

    /// Who owns the fire at (x, y), if it would hurt player `id` there now:
    /// burning, they're on the ground and unshielded, it isn't their own
    /// rocket's blast, and no friendly fire.
    pub(super) fn flame_threat(&self, id: u32, x: i32, y: i32) -> Option<u32> {
        let p = self.players.get(&id)?;
        if !p.alive || p.invulnerable_until > self.tick || p.jump_left > 0 || !self.flame_active(x, y) {
            return None;
        }
        let i = self.map.idx(x, y);
        if self.flame_spare[i] == p.id {
            return None; // your own rocket's blast
        }
        let owner = self.flame_owner[i];
        // No friendly fire in team mode (your own bombs still hurt).
        let friendly = self.players.get(&owner).is_some_and(|o| !o.can_hurt(p));
        (!friendly).then_some(owner)
    }

    pub(super) fn apply_flame_damage(&mut self) {
        let mut victims = std::mem::take(&mut self.scratch.victims);
        victims.clear();
        // Mid-jump players are above the fire.
        victims.extend(self.players.values().filter_map(|p| {
            let (x, y) = p.cell();
            self.flame_threat(p.id, x, y).map(|owner| (p.id, owner))
        }));
        // A fixed order, so the same inputs always give the same outcome.
        victims.sort_unstable();
        for &(v, k) in &victims {
            self.kill(v, Some(k));
        }
        self.scratch.victims = victims;
    }
}
