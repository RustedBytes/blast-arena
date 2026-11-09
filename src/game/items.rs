use super::rng::Rng;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum Item {
    ExtraBomb = 1,
    Range = 2,
    Speed = 3,
    Kick = 4,
}

pub const CRATE_DROP_CHANCE: f32 = 0.25;

impl Item {
    pub fn from_u8(v: u8) -> Option<Item> {
        match v {
            1 => Some(Item::ExtraBomb),
            2 => Some(Item::Range),
            3 => Some(Item::Speed),
            4 => Some(Item::Kick),
            _ => None,
        }
    }

    /// Weighted random pick: bombs and range are common, kick is rare.
    pub fn random(rng: &mut Rng) -> Item {
        match rng.below(100) {
            0..=34 => Item::ExtraBomb,
            35..=69 => Item::Range,
            70..=89 => Item::Speed,
            _ => Item::Kick,
        }
    }

    /// Item revealed when a crate is destroyed, if any.
    pub fn crate_drop(rng: &mut Rng) -> Option<Item> {
        rng.chance(CRATE_DROP_CHANCE).then(|| Item::random(rng))
    }
}
