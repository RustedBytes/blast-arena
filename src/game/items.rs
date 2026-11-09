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
}

pub const CRATE_DROP_CHANCE: f32 = 0.25;
pub const SHIELD_TICKS: u64 = 6 * 20;
pub const SLOW_CURSE_TICKS: u64 = 8 * 20;
pub const NOBOMB_CURSE_TICKS: u64 = 6 * 20;

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
}

impl Mystery {
    /// Code sent to the client in `fx` messages: item codes 1–7 as-is.
    pub fn code(self) -> u8 {
        match self {
            Mystery::Item(i) => i as u8,
            Mystery::Jackpot => 20,
            Mystery::Slow => 30,
            Mystery::NoBomb => 31,
        }
    }

    pub fn open(rng: &mut Rng) -> Mystery {
        match rng.below(100) {
            0..=59 => {
                // Any regular power-up, rare ones a bit more likely than from crates.
                const POOL: [Item; 7] =
                    [Item::ExtraBomb, Item::Range, Item::Speed, Item::Kick, Item::Shield, Item::Pierce, Item::FullFire];
                Mystery::Item(POOL[rng.below(POOL.len() as u32) as usize])
            }
            60..=74 => Mystery::Jackpot,
            75..=87 => Mystery::Slow,
            _ => Mystery::NoBomb,
        }
    }
}

impl Item {
    pub fn from_u8(v: u8) -> Option<Item> {
        match v {
            1 => Some(Item::ExtraBomb),
            2 => Some(Item::Range),
            3 => Some(Item::Speed),
            4 => Some(Item::Kick),
            5 => Some(Item::Shield),
            6 => Some(Item::Pierce),
            7 => Some(Item::FullFire),
            8 => Some(Item::Mystery),
            _ => None,
        }
    }

    /// Weighted random pick: bombs and range are common, full fire is rare.
    pub fn random(rng: &mut Rng) -> Item {
        match rng.below(100) {
            0..=27 => Item::ExtraBomb,
            28..=55 => Item::Range,
            56..=71 => Item::Speed,
            72..=79 => Item::Kick,
            80..=85 => Item::Shield,
            86..=90 => Item::Pierce,
            91..=93 => Item::FullFire,
            _ => Item::Mystery,
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
        let (mut items, mut jackpot, mut slow, mut nobomb) = (0, 0, 0, 0);
        let mut kinds = [false; 8];
        for _ in 0..2000 {
            match Mystery::open(&mut rng) {
                Mystery::Item(i) => {
                    items += 1;
                    kinds[i as usize] = true;
                    assert_ne!(i, Item::Mystery, "a box never contains another box");
                }
                Mystery::Jackpot => jackpot += 1,
                Mystery::Slow => slow += 1,
                Mystery::NoBomb => nobomb += 1,
            }
        }
        assert!(kinds[1..8].iter().all(|&k| k), "every power-up can come out: {kinds:?}");
        assert!(items > 1000 && jackpot > 200 && slow > 150 && nobomb > 150);
    }

    #[test]
    fn crate_drops_include_new_items() {
        let mut rng = Rng::new(4);
        let mut seen = [false; 9];
        for _ in 0..5000 {
            seen[Item::random(&mut rng) as usize] = true;
        }
        assert!(seen[1..].iter().all(|&s| s));
    }
}
