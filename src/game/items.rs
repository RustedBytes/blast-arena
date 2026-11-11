use super::rng::Rng;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum Item {
    ExtraBomb = 1,
    Range = 2,
    Speed = 3,
    Kick = 4,
    /// Temporary invulnerability.
    Shield = 5,
    /// Blasts go through crates.
    Pierce = 6,
    /// Range jumps to the maximum.
    FullFire = 7,
    /// The secret box: a random outcome when opened.
    Mystery = 8,
    /// Your bombs wait for the action key (or 10 s) to go off.
    Remote = 9,
    /// Pressing bomb while standing on your bomb lays the rest in a line.
    LineBomb = 10,
    /// The action key throws the bomb in front of you over obstacles.
    Punch = 11,
    /// Walk through crates for a while.
    Ghost = 12,
    /// The next bomb is an atomic bomb (see `bomb::NUKE_RADIUS`).
    Nuke = 13,
    /// Your blasts leave ice behind for a while.
    Freeze = 14,
    /// Gadget: hidden land mines (Q places one).
    Mine = 15,
    /// Gadget: a rocket that flies straight and blows up on impact.
    Rocket = 16,
    /// Gadget: swap places with the nearest enemy.
    Swap = 17,
    /// Landing a jump next to enemies stuns them.
    Stomp = 18,
    /// Gadget: a drone that hunts enemies and drops bombs on them.
    Drone = 19,
    /// Gadget: a swarm of drones, one bomb each.
    Swarm = 20,
    /// Ability: builds a temporary wall in front of you.
    Builder = 21,
    /// Bomb modifier: the next bombs release a slowing gas cloud.
    GasBomb = 22,
    /// Ability: a decoy double replays your moves a moment later.
    Clone = 23,
    /// Bomb modifier: the next bombs are thrown and stick to enemies.
    StickyBomb = 24,
    /// Ability: two linked portals.
    PortalPair = 25,
    /// Ability: a quick burst of movement.
    Dash = 26,
    /// Restores every heart lost to monster bites (dungeon arena only:
    /// see `World::dungeon_drop`).
    Heart = 27,
}

pub const ALL_ITEMS: u8 = 27;
/// Gadget charges given by one pick-up.
pub const MINE_CHARGES: u8 = 3;
pub const ROCKET_CHARGES: u8 = 3;
pub const SWAP_CHARGES: u8 = 2;
pub const DRONE_CHARGES: u8 = 1;
pub const SWARM_CHARGES: u8 = 1;
pub const CRATE_DROP_CHANCE: f32 = 0.25;
pub const SHIELD_TICKS: u64 = 6 * 20;
pub const GHOST_TICKS: u64 = 6 * 20;
pub const SLOW_CURSE_TICKS: u64 = 8 * 20;
pub const NOBOMB_CURSE_TICKS: u64 = 6 * 20;
pub const REVERSE_CURSE_TICKS: u64 = 8 * 20;

/// What opening a secret box gave the player.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mystery {
    Item(Item),
    /// +1 bomb, +1 range and +1 speed at once.
    Jackpot,
    /// Slowed down for a while.
    Slow,
    /// Can't drop bombs for a while.
    NoBomb,
    /// Controls are reversed for a while.
    Reversed,
    /// Bombs rain down around the player.
    BombRain,
}

impl Mystery {
    /// Code sent to the client in `fx` messages: item codes as-is.
    #[must_use]
    pub fn code(self) -> u8 {
        match self {
            Mystery::Item(i) => i as u8,
            Mystery::Jackpot => 100,
            Mystery::Slow => 110,
            Mystery::NoBomb => 111,
            Mystery::BombRain => 112,
            Mystery::Reversed => 113,
        }
    }

    pub fn open(rng: &mut Rng) -> Mystery {
        match rng.below(100) {
            0..=54 => {
                // Any regular power-up, rare ones more likely than from crates.
                const POOL: [Item; 25] = [
                    Item::ExtraBomb,
                    Item::Range,
                    Item::Speed,
                    Item::Kick,
                    Item::Shield,
                    Item::Pierce,
                    Item::FullFire,
                    Item::Remote,
                    Item::LineBomb,
                    Item::Punch,
                    Item::Ghost,
                    Item::Nuke,
                    Item::Freeze,
                    Item::Mine,
                    Item::Rocket,
                    Item::Swap,
                    Item::Stomp,
                    Item::Drone,
                    Item::Swarm,
                    Item::Builder,
                    Item::GasBomb,
                    Item::Clone,
                    Item::StickyBomb,
                    Item::PortalPair,
                    Item::Dash,
                ];
                Mystery::Item(POOL[rng.below(POOL.len() as u32) as usize])
            }
            55..=67 => Mystery::Jackpot,
            68..=75 => Mystery::Slow,
            76..=83 => Mystery::NoBomb,
            84..=91 => Mystery::Reversed,
            _ => Mystery::BombRain,
        }
    }
}

impl Item {
    #[must_use]
    pub fn from_u8(v: u8) -> Option<Item> {
        Some(match v {
            1 => Item::ExtraBomb,
            2 => Item::Range,
            3 => Item::Speed,
            4 => Item::Kick,
            5 => Item::Shield,
            6 => Item::Pierce,
            7 => Item::FullFire,
            8 => Item::Mystery,
            9 => Item::Remote,
            10 => Item::LineBomb,
            11 => Item::Punch,
            12 => Item::Ghost,
            13 => Item::Nuke,
            14 => Item::Freeze,
            15 => Item::Mine,
            16 => Item::Rocket,
            17 => Item::Swap,
            18 => Item::Stomp,
            19 => Item::Drone,
            20 => Item::Swarm,
            21 => Item::Builder,
            22 => Item::GasBomb,
            23 => Item::Clone,
            24 => Item::StickyBomb,
            25 => Item::PortalPair,
            26 => Item::Dash,
            27 => Item::Heart,
            _ => return None,
        })
    }

    /// Weighted random pick (per 224): bombs and range are common, full
    /// fire is rare, and the atomic bomb and the drone swarm rarest of all
    /// (under 1% each). The six abilities take 4 of 224 each.
    pub fn random(rng: &mut Rng) -> Item {
        match rng.below(224) {
            0..=41 => Item::ExtraBomb,
            42..=83 => Item::Range,
            84..=105 => Item::Speed,
            106..=115 => Item::Kick,
            116..=123 => Item::Shield,
            124..=130 => Item::Pierce,
            131..=135 => Item::FullFire,
            136..=145 => Item::Mystery,
            146..=151 => Item::Remote,
            152..=157 => Item::LineBomb,
            158..=163 => Item::Punch,
            164..=167 => Item::Ghost,
            168..=172 => Item::Freeze,
            173..=178 => Item::Mine,
            179..=184 => Item::Rocket,
            185..=188 => Item::Swap,
            189..=192 => Item::Stomp,
            193..=195 => Item::Drone,
            196..=197 => Item::Swarm,
            198..=199 => Item::Nuke,
            200..=203 => Item::Builder,
            204..=207 => Item::GasBomb,
            208..=211 => Item::Clone,
            212..=215 => Item::StickyBomb,
            216..=219 => Item::PortalPair,
            _ => Item::Dash,
        }
    }

    /// One-shot gadgets fired with the gadget key, and how many charges a
    /// pick-up gives; `None` for everything else.
    #[must_use]
    pub fn gadget_charges(self) -> Option<u8> {
        Some(match self {
            Item::Mine => MINE_CHARGES,
            Item::Rocket => ROCKET_CHARGES,
            Item::Swap => SWAP_CHARGES,
            Item::Drone => DRONE_CHARGES,
            Item::Swarm => SWARM_CHARGES,
            _ => return None,
        })
    }

    /// The six ability power-ups (see `abilities`): active abilities fired
    /// with the ability key, and bomb modifiers.
    #[must_use]
    pub fn is_ability(self) -> bool {
        matches!(self, Item::Builder | Item::GasBomb | Item::Clone | Item::StickyBomb | Item::PortalPair | Item::Dash)
    }

    /// Item revealed when a crate is destroyed, if any. Items `enabled`
    /// rejects (abilities switched off in the config) are re-rolled, and
    /// become an extra bomb if that keeps failing.
    pub fn crate_drop(rng: &mut Rng, enabled: impl Fn(Item) -> bool) -> Option<Item> {
        if !rng.chance(CRATE_DROP_CHANCE) {
            return None;
        }
        for _ in 0..4 {
            let item = Item::random(rng);
            if enabled(item) {
                return Some(item);
            }
        }
        Some(Item::ExtraBomb)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_box_produces_every_outcome() {
        let mut rng = Rng::new(9);
        let mut items = [false; ALL_ITEMS as usize + 1];
        let mut other = [0; 5];
        for _ in 0..4000 {
            match Mystery::open(&mut rng) {
                Mystery::Item(i) => {
                    items[i as usize] = true;
                    assert_ne!(i, Item::Mystery, "a box never contains another box");
                }
                Mystery::Jackpot => other[0] += 1,
                Mystery::Slow => other[1] += 1,
                Mystery::NoBomb => other[2] += 1,
                Mystery::Reversed => other[3] += 1,
                Mystery::BombRain => other[4] += 1,
            }
        }
        // Not the box itself, nor the dungeon-only heart.
        let missing: Vec<usize> = (1..=ALL_ITEMS as usize).filter(|&i| i != 8 && i != Item::Heart as usize && !items[i]).collect();
        assert!(missing.is_empty(), "missing power-ups: {missing:?}");
        assert!(other.iter().all(|&n| n > 150), "{other:?}");
    }

    #[test]
    fn crate_drops_include_every_item() {
        let mut rng = Rng::new(4);
        let mut seen = [false; ALL_ITEMS as usize + 1];
        for _ in 0..10000 {
            seen[Item::random(&mut rng) as usize] = true;
        }
        // Everything but the dungeon-only heart.
        assert!(seen[1..].iter().enumerate().all(|(i, &s)| s || i + 1 == Item::Heart as usize));
        assert!(!seen[Item::Heart as usize]);
        assert!((1..=ALL_ITEMS).all(|v| Item::from_u8(v).is_some()));
    }
}
