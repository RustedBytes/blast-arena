//! The six ability power-ups: inventory, the ability key, recharging,
//! events and cleanup. The mechanics live in their own modules:
//! `builder` (temporary walls), `gas` (gas clouds), `clone` (decoy
//! doubles), `sticky` (bombs that stick to players), `portal` (linked
//! portals) and `dash`.
//!
//! Every ability follows the same contract, spelled out here once instead
//! of as a trait object per player (which would cost an allocation and a
//! virtual call per player per tick):
//!
//! | step                 | where                                                  |
//! |----------------------|--------------------------------------------------------|
//! | `canActivate`        | [`World::check_ability`] plus the module's placement test |
//! | `activate`           | [`World::use_ability`] → `place_wall` / `spawn_clone` / `place_portal` / `start_dash`; bomb modifiers in `place_bomb` |
//! | `update`             | `update_walls`, `update_gas`, `update_clones`, `update_sticky`, `update_portals`, `dash_step` (see `tick.rs` for the order) |
//! | `onCollision`        | dash: `dash_step`; sticky: `update_sticky`; portals: `portal_entry` |
//! | `onDamage`           | walls: `damage_wall`; gas: `ignite`; clones: `update_clones` |
//! | `deactivate`         | [`World::abilities_on_death`], expiry in the updates   |
//! | `serialize`          | the snapshot's `EXTRA` section and `me` fields (see `protocol::snap`) |
//! | `reset`              | [`World::reset_abilities_for_round`]                   |
//!
//! Active abilities (builder, clone, portal pair, dash) are held in one
//! slot, like gadgets: picking up another one replaces it. Each has a few
//! charges; a spent charge comes back after the ability's cooldown, which
//! starts only on a successful activation. A failed activation costs
//! nothing and tells the player why (`AbilityRejected`). Gas and sticky
//! bombs are bomb modifiers with their own counters, mutually exclusive.

use crate::protocol::{self, ev};

use super::ability_config::Tuning;
use super::items::Item;
use super::player::{AOI_MAX, MAX_GADGET_CHARGES, Player};
use super::World;

/// Sub-kinds of [`ev::ABILITY`] events. Every event's values start with the
/// sub-kind and the server tick; the rest is listed per kind.
pub mod ab {
    /// Player id, ability item code.
    pub const ACTIVATED: i64 = 1;
    /// Ability item code, reason (see [`super::reject`]). To the player only.
    pub const REJECTED: i64 = 2;
    /// Ability item code, ticks until a charge is back. To the player only.
    pub const COOLDOWN: i64 = 3;
    /// Wall id, owner id, x, y, ticks it stands.
    pub const WALL_CREATED: i64 = 4;
    /// Wall id, x, y, 1 if destroyed (0 if it expired).
    pub const WALL_REMOVED: i64 = 5;
    /// Cloud id, owner id, x, y, ticks it lasts.
    pub const GAS_CREATED: i64 = 6;
    /// Cloud id, x, y.
    pub const GAS_EXPIRED: i64 = 7;
    /// Cloud id, x, y.
    pub const GAS_IGNITED: i64 = 8;
    /// Clone id, owner id, x, y. To the owner (and teammates) only.
    pub const CLONE_SPAWNED: i64 = 9;
    /// Clone id, x, y, 1 if blown up (0 if it expired or its owner died).
    pub const CLONE_DESTROYED: i64 = 10;
    /// Bomb id, target id, owner id, x, y.
    pub const STICKY_ATTACHED: i64 = 11;
    /// Bomb id, target id, x, y (where it fell).
    pub const STICKY_DETACHED: i64 = 12;
    /// Portal id, owner id, x, y.
    pub const PORTAL_CREATED: i64 = 13;
    /// First portal id, second portal id, owner id, x, y (of the second).
    pub const PORTAL_LINKED: i64 = 14;
    /// Portal id, x, y.
    pub const PORTAL_DESTROYED: i64 = 15;
    /// What (0 player, 1 bomb), its id, from x, y, to x, y.
    pub const TELEPORTED: i64 = 16;
    /// Player id, direction, x, y.
    pub const DASH_STARTED: i64 = 17;
    /// Player id, x, y.
    pub const DASH_ENDED: i64 = 18;
}

/// Why an activation was refused ([`ab::REJECTED`]).
pub mod reject {
    /// No charge left (the ability is recharging).
    pub const NO_CHARGE: i64 = 1;
    /// The target cell is taken, solid or off the map.
    pub const BLOCKED: i64 = 2;
    /// Too many of this ability's objects are out already.
    pub const LIMIT: i64 = 3;
    /// Not now: dead, mid-jump, stunned or already dashing.
    pub const STATE: i64 = 4;
    /// Clone: not enough recorded movement, or the old spot is blocked.
    pub const NO_HISTORY: i64 = 5;
    /// Switched off in the configuration.
    pub const DISABLED: i64 = 6;
}

/// Who hears an ability event.
#[derive(Clone, Copy)]
pub(super) enum Audience {
    /// Everyone whose view may include this cell.
    Near(i32, i32),
    /// One player.
    Player(u32),
    /// A player and their teammates.
    Team(u32),
}

impl World {
    /// Whether an ability power-up is switched on in the configuration.
    #[must_use]
    pub fn ability_enabled(&self, item: Item) -> bool {
        self.tuning.item_enabled(item)
    }

    /// Gives an ability power-up. A different active ability replaces the
    /// one held (a half-placed portal pair is cancelled); the same one is
    /// refilled. Gas and sticky bombs add charges and drop the other kind.
    pub(super) fn grant_ability(&mut self, id: u32, item: Item) {
        let t = &self.tuning.raw;
        let Some(p) = self.players.get_mut(&id) else { return };
        let charges = match item {
            Item::GasBomb => {
                (p.gas_bombs, p.sticky_bombs) = ((p.gas_bombs + t.gas_bomb.charges).min(MAX_GADGET_CHARGES), 0);
                return;
            }
            Item::StickyBomb => {
                (p.sticky_bombs, p.gas_bombs) = ((p.sticky_bombs + t.sticky_bomb.charges).min(MAX_GADGET_CHARGES), 0);
                return;
            }
            Item::Builder => t.builder.charges,
            Item::Clone => t.clone.charges,
            Item::PortalPair => t.portal_pair.charges,
            Item::Dash => t.dash.charges,
            _ => return,
        };
        let replaced = p.ability != item as u8;
        (p.ability, p.ability_n, p.ability_max, p.ability_recharge_at) = (item as u8, charges, charges, 0);
        if replaced {
            self.cancel_pending_portal(id);
        }
    }

    /// The cooldown of an active ability, in ticks.
    fn ability_cooldown(t: &Tuning, item: Item) -> u64 {
        match item {
            Item::Builder => t.builder_cooldown,
            Item::Clone => t.clone_cooldown,
            Item::PortalPair => t.portal_cooldown,
            Item::Dash => t.dash_cooldown,
            _ => 0,
        }
    }

    /// `canActivate`: the shared part. The held ability, or why not.
    fn check_ability(&self, p: &Player) -> Result<Item, i64> {
        let item = Item::from_u8(p.ability).ok_or(reject::STATE)?;
        if !self.ability_enabled(item) {
            return Err(reject::DISABLED);
        }
        if !p.alive || p.jump_left > 0 || p.stunned_until > self.tick || p.dashing() {
            return Err(reject::STATE);
        }
        // A pending portal pair is finished without a new charge.
        let finishing_pair = item == Item::PortalPair && self.pending_portal(p.id).is_some();
        if p.ability_n == 0 && !finishing_pair {
            return Err(reject::NO_CHARGE);
        }
        Ok(item)
    }

    /// The ability key: activates the held ability. Commands come from the
    /// player's own connection (the id is the session's, never the
    /// client's), and repeated presses within a tick count once.
    pub(super) fn use_ability(&mut self, id: u32) {
        let Some(p) = self.players.get(&id) else { return };
        let code = p.ability;
        let item = match self.check_ability(p) {
            Ok(item) => item,
            Err(reason) => {
                if code != 0 {
                    self.ability_event(ab::REJECTED, Audience::Player(id), &[i64::from(code), reason]);
                }
                return;
            }
        };
        let done = match item {
            Item::Builder => self.place_wall(id),
            Item::Clone => self.spawn_clone(id),
            Item::PortalPair => self.place_portal(id),
            Item::Dash => self.start_dash(id),
            _ => Err(reject::STATE),
        };
        match done {
            // `Ok(false)`: a first step that costs nothing yet (the first portal).
            Ok(spent) => {
                if spent {
                    self.spend_charge(id, item);
                }
                let (x, y) = self.players[&id].cell();
                // A clone stays a secret from the other side.
                let to = if item == Item::Clone { Audience::Team(id) } else { Audience::Near(x, y) };
                self.ability_event(ab::ACTIVATED, to, &[i64::from(id), i64::from(code)]);
            }
            Err(reason) => self.ability_event(ab::REJECTED, Audience::Player(id), &[i64::from(code), reason]),
        }
    }

    /// The cancel key: withdraws a half-placed portal pair.
    pub(super) fn cancel_ability(&mut self, id: u32) {
        self.cancel_pending_portal(id);
    }

    /// Uses up a charge; the cooldown towards the next one starts now
    /// unless one is already running.
    fn spend_charge(&mut self, id: u32, item: Item) {
        let cd = Self::ability_cooldown(&self.tuning, item);
        let tick = self.tick;
        let p = self.players.get_mut(&id).unwrap();
        p.ability_n = p.ability_n.saturating_sub(1);
        if p.ability_recharge_at == 0 {
            p.ability_recharge_at = tick + cd;
            self.ability_event(ab::COOLDOWN, Audience::Player(id), &[i64::from(item as u8), cd as i64]);
        }
    }

    /// Spent charges come back one per cooldown.
    pub(super) fn recharge_abilities(&mut self) {
        let tick = self.tick;
        let t = self.tuning.clone();
        for p in self.players.values_mut() {
            if p.ability_recharge_at == 0 || p.ability_recharge_at > tick {
                continue;
            }
            p.ability_n = (p.ability_n + 1).min(p.ability_max);
            let cd = Item::from_u8(p.ability).map_or(0, |i| Self::ability_cooldown(&t, i));
            p.ability_recharge_at = if p.ability_n < p.ability_max { tick + cd } else { 0 };
        }
    }

    /// `deactivate` on death: a dash stops, clones and portal pairs vanish,
    /// a half-done detach starts over. Walls, gas clouds and bombs stay.
    pub(super) fn abilities_on_death(&mut self, id: u32) {
        if let Some(p) = self.players.get_mut(&id) {
            (p.dash_dir, p.dash_left, p.dash_portal) = (0, 0, false);
            p.detach_ticks = 0;
            p.portal_lock = None;
            p.gassed_until = 0;
            p.history.clear();
        }
        self.remove_clones_of(id, 0);
        self.remove_portals_of(id);
    }

    /// `reset` at the end of a round: every temporary object goes, charges
    /// are full again, nothing is half done.
    pub(super) fn reset_abilities_for_round(&mut self) {
        self.clear_walls();
        self.clear_gas();
        self.clear_clones();
        self.clear_portals();
        for p in self.players.values_mut() {
            p.ability_n = p.ability_max;
            p.ability_recharge_at = 0;
            (p.dash_dir, p.dash_left, p.dash_portal) = (0, 0, false);
            p.detach_ticks = 0;
            p.portal_lock = None;
            p.gassed_until = 0;
        }
    }

    /// Sends an ability event (`ev::ABILITY`): the sub-kind, the tick, then
    /// `values`.
    pub(super) fn ability_event(&mut self, kind: i64, to: Audience, values: &[i64]) {
        let mut all = [0i64; 10];
        all[0] = kind;
        all[1] = self.tick as i64;
        let n = values.len().min(all.len() - 2);
        all[2..2 + n].copy_from_slice(&values[..n]);
        let msg = protocol::encode_event(self.event_arenas.current(), ev::ABILITY, &all[..2 + n]);
        let send = |p: &Player| {
            if let Some(link) = &p.link {
                let _ = link.events.try_send(msg.clone());
            }
        };
        match to {
            Audience::Player(id) => {
                if let Some(p) = self.players.get(&id) {
                    send(p);
                }
            }
            Audience::Team(id) => {
                let team = self.players.get(&id).map_or(0, |p| p.team);
                for p in self.players.values().filter(|p| p.id == id || (team != 0 && p.team == team)) {
                    send(p);
                }
            }
            Audience::Near(x, y) => {
                let (hw, hh) = AOI_MAX;
                for p in self.players_in_rect(x - hw, y - hh, x + hw, y + hh) {
                    send(p);
                }
            }
        }
        self.stats.ability_events += 1;
    }

    /// Tuning the client needs (sent in the welcome).
    #[must_use]
    pub fn ability_info(&self) -> protocol::AbilityInfo {
        let t = &self.tuning;
        let actives = [Item::Builder, Item::Clone, Item::PortalPair, Item::Dash];
        let all = [Item::Builder, Item::GasBomb, Item::Clone, Item::StickyBomb, Item::PortalPair, Item::Dash];
        protocol::AbilityInfo {
            v: 1,
            cooldowns: actives.iter().map(|&i| (i as u8, Self::ability_cooldown(t, i))).collect(),
            wall: t.wall_ticks,
            gas: t.gas_ticks,
            gas_fuse: t.gas_fuse,
            gas_mult: t.raw.gas_bomb.movement_multiplier,
            clone: t.clone_ticks,
            portal: t.portal_ticks,
            portal_wait: t.portal_timeout,
            sticky_fuse: t.sticky_fuse,
            detach: t.detach_ticks,
            dash: t.dash_ticks,
            dash_step: t.dash_step,
            disabled: all.iter().filter(|&&i| !t.item_enabled(i)).map(|&i| i as u8).collect(),
        }
    }

    /// The next free id for an ability object (shared with bombs and
    /// gadgets, so ids never collide in snapshots).
    pub(super) fn next_object_id(&mut self) -> u32 {
        self.next_bomb_id = self.next_bomb_id.wrapping_add(1).max(1);
        self.next_bomb_id
    }
}
