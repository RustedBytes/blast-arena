//! Power-ups and the secret box.

use crate::protocol;

use super::World;
use super::items::{self, Item, Mystery};
use super::player::{MAX_BOMBS, MAX_GADGET_CHARGES, MAX_NUKES, MAX_RANGE, MAX_SPEED_LVL, Player};

impl World {
    /// Gives a power-up's effect to a player.
    pub(super) fn grant(p: &mut Player, item: Item, tick: u64) {
        match item {
            Item::ExtraBomb => p.max_bombs = (p.max_bombs + 1).min(MAX_BOMBS),
            Item::Range => p.range = (p.range + 1).min(MAX_RANGE),
            Item::Speed => p.speed_lvl = (p.speed_lvl + 1).min(MAX_SPEED_LVL),
            Item::Kick => p.kick = true,
            Item::Shield => p.invulnerable_until = p.invulnerable_until.max(tick + items::SHIELD_TICKS),
            Item::Pierce => p.pierce = true,
            Item::FullFire => p.range = MAX_RANGE,
            Item::Remote => p.remote = true,
            Item::LineBomb => p.line = true,
            Item::Punch => p.punch = true,
            Item::Ghost => p.ghost_until = p.ghost_until.max(tick + items::GHOST_TICKS),
            Item::Nuke => p.nukes = (p.nukes + 1).min(MAX_NUKES),
            Item::Freeze => p.freeze = true,
            Item::Stomp => p.stomp = true,
            // Every lost heart back.
            Item::Heart => p.wounds = 0,
            // Cosmos: a core recolours the blaster (see `cosmos`).
            Item::PlasmaCore => p.blaster = super::cosmos::blaster::PLASMA,
            Item::CryoCore => p.blaster = super::cosmos::blaster::CRYO,
            Item::PhaseCore => p.blaster = super::cosmos::blaster::PHASE,
            Item::NovaCore => p.blaster = super::cosmos::blaster::NOVA,
            Item::Overdrive => p.overdrive_until = p.overdrive_until.max(tick) + super::cosmos::OVERDRIVE_TICKS,
            Item::Mine | Item::Rocket | Item::Swap | Item::Drone | Item::Swarm => {
                let charges = item.gadget_charges().unwrap_or(1);
                // A new kind of gadget replaces the one held.
                if p.gadget == item as u8 {
                    p.gadget_n = (p.gadget_n + charges).min(MAX_GADGET_CHARGES);
                } else {
                    (p.gadget, p.gadget_n) = (item as u8, charges);
                }
            }
            // Abilities need the tuning: see `grant_ability`.
            Item::Mystery
            | Item::Builder
            | Item::GasBomb
            | Item::Clone
            | Item::StickyBomb
            | Item::PortalPair
            | Item::Dash => {}
        }
    }

    /// Applies a picked-up item and tells the player what they got.
    pub(super) fn pick_up(&mut self, id: u32, item: Item) {
        self.stats.items_picked += 1;
        let tick = self.tick;
        let (code, mystery) = if item == Item::Mystery {
            self.stats.mysteries_opened += 1;
            let outcome = match Mystery::open(&mut self.rng) {
                // A switched-off ability from a box is an extra bomb instead.
                Mystery::Item(i) if !self.ability_enabled(i) => Mystery::Item(Item::ExtraBomb),
                Mystery::Item(i) if self.mode == super::Mode::Cosmos => Mystery::Item(self.cosmos_swap(i)),
                o => o,
            };
            if let Mystery::Item(i) = outcome
                && i.is_ability()
            {
                self.grant_ability(id, i);
            }
            let p = self.players.get_mut(&id).unwrap();
            match outcome {
                Mystery::Item(i) => Self::grant(p, i, tick),
                Mystery::Jackpot => {
                    Self::grant(p, Item::ExtraBomb, tick);
                    Self::grant(p, Item::Range, tick);
                    Self::grant(p, Item::Speed, tick);
                }
                Mystery::Slow => p.slow_until = tick + items::SLOW_CURSE_TICKS,
                Mystery::NoBomb => p.nobomb_until = tick + items::NOBOMB_CURSE_TICKS,
                Mystery::Reversed => p.reversed_until = tick + items::REVERSE_CURSE_TICKS,
                Mystery::BombRain => {
                    let (x, y) = p.cell();
                    self.bomb_rain(x, y);
                }
            }
            (outcome.code(), true)
        } else {
            if item.is_ability() {
                self.grant_ability(id, item);
            } else {
                Self::grant(self.players.get_mut(&id).unwrap(), item, tick);
            }
            (item as u8, false)
        };
        if let Some(link) = &self.players[&id].link {
            let _ = link.events.try_send(protocol::encode_fx(self.event_arenas.current(), code, mystery));
        }
    }
}
