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
}

pub const ALL_ITEMS: u8 = 13;
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
            Mystery::Jackpot => 20,
            Mystery::Slow => 30,
            Mystery::NoBomb => 31,
            Mystery::BombRain => 32,
            Mystery::Reversed => 33,
        }
    }

    pub fn open(rng: &mut Rng) -> Mystery {
        match rng.below(100) {
            0..=54 => {
                // Any regular power-up, rare ones more likely than from crates.
                const POOL: [Item; 12] = [
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
            _ => return None,
        })
    }

    /// Weighted random pick (per 200): bombs and range are common, full
    /// fire is rare, and the atomic bomb rarest of all (1%).
    pub fn random(rng: &mut Rng) -> Item {
        match rng.below(200) {
            0..=47 => Item::ExtraBomb,
            48..=95 => Item::Range,
            96..=121 => Item::Speed,
            122..=133 => Item::Kick,
            134..=143 => Item::Shield,
            144..=151 => Item::Pierce,
            152..=157 => Item::FullFire,
            158..=169 => Item::Mystery,
            170..=177 => Item::Remote,
            178..=185 => Item::LineBomb,
            186..=193 => Item::Punch,
            194..=197 => Item::Ghost,
            _ => Item::Nuke,
        }
    }

    /// Item revealed when a crate is destroyed, if any.
    pub fn crate_drop(rng: &mut Rng) -> Option<Item> {
        rng.chance(CRATE_DROP_CHANCE).then(|| Item::random(rng))
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
        let missing: Vec<usize> = (1..=ALL_ITEMS as usize).filter(|&i| i != 8 && !items[i]).collect();
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
        assert!(seen[1..].iter().all(|&s| s));
        assert!((1..=ALL_ITEMS).all(|v| Item::from_u8(v).is_some()));
    }
}
