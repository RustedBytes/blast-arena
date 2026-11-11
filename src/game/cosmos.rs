//! The cosmos arena: a free-for-all on a space station where the bomb key
//! fires a blaster bolt instead of dropping a bomb.
//!
//! A bolt is a rocket (it flies a cell a tick and blows up on whatever it
//! hits, sparing its shooter) with a colour. Everyone starts with a green
//! blaster; the cosmos-only blaster cores swap it for another colour, each
//! with its own effect, until you die:
//!
//! - **Plasma** (red): the blast reaches `PLASMA_BONUS` cells further.
//! - **Cryo** (cyan): the blast leaves ice behind.
//! - **Phase** (violet): the bolt flies through crates and its blast
//!   pierces them, so cover doesn't help.
//! - **Nova** (gold): fires a spread of three bolts, ahead and to both
//!   sides (the side bolts don't count towards your limit).
//!
//! **Overdrive** is rapid fire for a while: bolts stop counting towards
//! your limit and fire as fast as one every `OVERDRIVE_SHOT_TICKS`.
//!
//! Power-ups that only make sense with bombs (remote, line, punch, kick,
//! atomic, gas and sticky bombs) never turn up here: crates and the vault
//! give cosmos power-ups instead (see [`World::cosmos_drop`]).

use super::bomb::BombKind;
use super::gadgets::{ROCKET_MAX_TICKS, ROCKET_RANGE};
use super::items::Item;
use super::player::{DIRS, MAX_RANGE};
use super::{Mode, World};

/// Blaster colours, as sent to the browser in a bolt's flags.
pub mod blaster {
    /// Green: the blaster everyone starts with.
    pub const STANDARD: u8 = 1;
    /// Red: bigger blasts.
    pub const PLASMA: u8 = 2;
    /// Cyan: blasts leave ice.
    pub const CRYO: u8 = 3;
    /// Violet: flies through crates, blasts pierce.
    pub const PHASE: u8 = 4;
    /// Gold: three bolts at once.
    pub const NOVA: u8 = 5;
}

/// How long one overdrive pick-up lasts (they stack).
pub const OVERDRIVE_TICKS: u64 = 8 * 20;
/// During overdrive, one bolt every this many ticks.
pub const OVERDRIVE_SHOT_TICKS: u64 = 4;
/// How much further a plasma blast reaches.
pub const PLASMA_BONUS: u8 = 2;
/// The longest a bolt flies.
pub const BOLT_MAX_TICKS: u64 = ROCKET_MAX_TICKS;
/// Share of crate drops (and vault loot) that become cosmos power-ups.
pub const COSMIC_DROP_SHARE: f32 = 0.35;

impl World {
    /// The bomb key in a cosmos arena: fires a bolt of the player's
    /// blaster colour the way they steer (or face). Counts towards their
    /// bomb limit like a rocket, except in overdrive.
    pub(super) fn fire_blaster(&mut self, id: u32) -> bool {
        let tick = self.tick;
        let Some(p) = self.players.get(&id) else { return false };
        let overdrive = p.overdrive_until > tick;
        let ready = if overdrive {
            // Rapid fire: no limit, just a cadence (curses and stuns still hold).
            p.alive
                && p.nobomb_until <= tick
                && p.jump_left == 0
                && p.stunned_until <= tick
                && p.carrying == 0
                && tick >= p.next_shot
        } else {
            p.can_bomb(tick)
        };
        if !ready {
            return false;
        }
        let colour = p.blaster.max(blaster::STANDARD);
        let base = p.range.max(ROCKET_RANGE);
        let range = if colour == blaster::PLASMA { (base + PLASMA_BONUS).min(MAX_RANGE) } else { base };
        let kind = BombKind {
            rocket: true,
            bolt: colour,
            counted: !overdrive,
            pierce: p.pierce || colour == blaster::PHASE,
            freeze: p.freeze || colour == blaster::CRYO,
            ..BombKind::plain(range, BOLT_MAX_TICKS)
        };
        let dir = if p.input_dir != 0 { p.input_dir } else { p.facing }.max(1);
        if !self.launch_rocket(id, kind) {
            return false;
        }
        self.players.get_mut(&id).unwrap().next_shot = tick + OVERDRIVE_SHOT_TICKS;
        if colour == blaster::NOVA {
            let side = BombKind { counted: false, ..kind };
            let sides = if dir % 2 == 1 { [2, 4] } else { [1, 3] };
            for d in sides {
                self.side_bolt(id, d, side);
            }
        }
        true
    }

    /// A nova's side bolt: starts in the cell next to the shooter, level
    /// with the main bolt, and blows up at once on an enemy standing there.
    fn side_bolt(&mut self, id: u32, dir: u8, kind: BombKind) {
        let (x, y) = self.players[&id].cell();
        let (dx, dy) = DIRS[dir as usize];
        let (nx, ny) = (x + dx, y + dy);
        if !self.map.in_bounds(nx, ny) || !self.place_bomb_at(id, (nx, ny), kind) {
            return;
        }
        let point_blank = self.players_in_rect(nx, ny, nx, ny).any(|o| o.id != id && o.alive && o.cell() == (nx, ny));
        let tick = self.tick;
        let bid = self.bomb_at(nx, ny).unwrap();
        let b = self.bombs.get_mut(&bid).unwrap();
        (b.slide_dir, b.next_slide) = (dir, tick + 1);
        if point_blank {
            b.explode_at = tick;
        }
    }

    /// Whether bomb `id` flies on into (x, y) although something is there:
    /// a phase bolt passes through crates.
    pub(super) fn phases_through(&self, id: u32, x: i32, y: i32) -> bool {
        self.bombs.get(&id).is_some_and(|b| b.bolt == blaster::PHASE)
            && self.map.in_bounds(x, y)
            && self.map.get(x, y).is_breakable()
            && self.bomb_at(x, y).is_none()
    }

    /// A crate's (or the vault's) drop in a cosmos arena: often a cosmos
    /// power-up, and never one that needs bombs. Other arenas keep `item`.
    pub(super) fn cosmos_drop(&mut self, item: Item) -> Item {
        if self.mode != Mode::Cosmos {
            return item;
        }
        if self.rng.chance(COSMIC_DROP_SHARE) {
            return self.random_cosmic();
        }
        self.cosmos_swap(item)
    }

    /// `item`, or a cosmos power-up if it is no use without bombs.
    pub(super) fn cosmos_swap(&mut self, item: Item) -> Item {
        if no_use_in_space(item) { self.random_cosmic() } else { item }
    }

    fn random_cosmic(&mut self) -> Item {
        match self.rng.below(100) {
            0..=21 => Item::PlasmaCore,
            22..=43 => Item::CryoCore,
            44..=65 => Item::PhaseCore,
            66..=83 => Item::NovaCore,
            _ => Item::Overdrive,
        }
    }
}

/// Power-ups that change dropped bombs, which a blaster never drops.
#[must_use]
pub fn no_use_in_space(item: Item) -> bool {
    matches!(item, Item::Remote | Item::LineBomb | Item::Punch | Item::Kick | Item::Nuke | Item::GasBomb | Item::StickyBomb | Item::Heart)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::map::{Map, Tile};
    use crate::game::player::BASE_RANGE;
    use crate::game::rng::Rng;
    use crate::game::testing::test_world;

    fn cosmos_world() -> World {
        let mut w = test_world(Map::empty(21, 21));
        w.mode = Mode::Cosmos;
        w
    }

    /// A player at (x, y) facing right, unshielded.
    fn shooter(w: &mut World, x: f32, y: f32) -> u32 {
        let id = w.spawn_test_player(x, y);
        let p = w.players.get_mut(&id).unwrap();
        p.facing = 2;
        p.invulnerable_until = 0;
        id
    }

    #[test]
    fn bomb_key_fires_a_green_bolt() {
        let mut w = cosmos_world();
        let me = shooter(&mut w, 3.5, 5.5);
        assert!(w.place_bomb(me));
        let b = w.bombs.values().next().unwrap();
        assert!(b.rocket && b.counted);
        assert_eq!((b.bolt, b.slide_dir, b.range), (blaster::STANDARD, 2, ROCKET_RANGE.max(BASE_RANGE)));
        assert!(!w.place_bomb(me), "one bolt in the air with one bomb");
    }

    #[test]
    fn cores_recolour_the_blaster() {
        let mut w = cosmos_world();
        let me = shooter(&mut w, 3.5, 5.5);
        w.players.get_mut(&me).unwrap().range = 3;
        w.pick_up(me, Item::PlasmaCore);
        assert!(w.place_bomb(me));
        let b = w.bombs.values().next().unwrap();
        assert_eq!((b.bolt, b.range), (blaster::PLASMA, 3 + PLASMA_BONUS));

        let mut w = cosmos_world();
        let me = shooter(&mut w, 3.5, 5.5);
        w.pick_up(me, Item::CryoCore);
        assert!(w.place_bomb(me));
        let b = w.bombs.values().next().unwrap();
        assert!(b.bolt == blaster::CRYO && b.freeze);

        // Dying takes the core away.
        w.players.get_mut(&me).unwrap().reset_stats();
        assert_eq!(w.players[&me].blaster, 0);
    }

    #[test]
    fn nova_fires_three_bolts() {
        let mut w = cosmos_world();
        let me = shooter(&mut w, 5.5, 5.5);
        w.pick_up(me, Item::NovaCore);
        assert!(w.place_bomb(me));
        let mut dirs: Vec<u8> = w.bombs.values().map(|b| b.slide_dir).collect();
        dirs.sort_unstable();
        assert_eq!(dirs, [1, 2, 3], "ahead (right) and both sides");
        assert!(w.bombs.values().all(|b| b.bolt == blaster::NOVA));
        assert_eq!(w.players[&me].active_bombs, 1, "only the main bolt counts");
        for _ in 0..30 {
            w.step();
        }
        assert!(w.bombs.is_empty());
        assert!(w.players[&me].alive, "a bolt spares its shooter");
    }

    #[test]
    fn phase_bolt_flies_through_crates_and_hits_who_hides_behind() {
        let mut w = cosmos_world();
        let me = shooter(&mut w, 3.5, 5.5);
        let target = shooter(&mut w, 11.5, 5.5);
        for x in [6, 7, 9] {
            w.map.set(x, 5, Tile::Crate);
        }
        w.pick_up(me, Item::PhaseCore);
        assert!(w.place_bomb(me));
        for _ in 0..15 {
            w.step();
        }
        assert!(!w.players[&target].alive, "the crates gave no cover");
        assert!(w.players[&me].alive);

        // A green bolt stops at the first crate.
        let mut w = cosmos_world();
        let me = shooter(&mut w, 3.5, 5.5);
        let target = shooter(&mut w, 11.5, 5.5);
        for x in [6, 7, 9] {
            w.map.set(x, 5, Tile::Crate);
        }
        assert!(w.place_bomb(me));
        for _ in 0..15 {
            w.step();
        }
        assert!(w.players[&target].alive);
    }

    #[test]
    fn overdrive_is_rapid_fire_past_the_limit() {
        let mut w = cosmos_world();
        let me = shooter(&mut w, 3.5, 5.5);
        w.pick_up(me, Item::Overdrive);
        assert!(w.place_bomb(me));
        assert!(!w.place_bomb(me), "a cadence, not a hose");
        for _ in 0..OVERDRIVE_SHOT_TICKS {
            w.step();
        }
        assert!(w.place_bomb(me), "past the one-bomb limit");
        assert_eq!(w.players[&me].active_bombs, 0, "overdrive bolts don't count");
        assert!(w.bombs.len() >= 2);
    }

    #[test]
    fn drops_are_cosmic_and_never_need_bombs() {
        let mut w = cosmos_world();
        w.rng = Rng::new(3);
        let (mut cosmic, mut bombish) = (0, 0);
        for _ in 0..2000 {
            let rolled = Item::random(&mut w.rng);
            let item = w.cosmos_drop(rolled);
            cosmic += usize::from(item.is_cosmic());
            bombish += usize::from(no_use_in_space(item));
        }
        assert_eq!(bombish, 0);
        assert!(cosmic > 600, "about a third of drops are cosmic: {cosmic}");
        // Other arenas never see them.
        let mut ffa = test_world(Map::empty(21, 21));
        assert_eq!(ffa.cosmos_drop(Item::Nuke), Item::Nuke);
    }

    #[test]
    fn bots_shoot_blasters_in_space() {
        let mut rng = Rng::new(7);
        let map = Map::generate_space(41, 41, &mut rng);
        let mut w = World::with_map(map, rng, 64);
        w.mode = Mode::Cosmos;
        for _ in 0..8 {
            w.add_bot();
        }
        let mut bolts = std::collections::HashSet::new();
        for _ in 0..1200 {
            w.step();
            for b in w.bombs.values().filter(|b| b.counted && b.owner != 0) {
                assert!(b.bolt != 0, "a bot dropped a bomb in space");
                bolts.insert(b.id);
            }
        }
        assert!(bolts.len() >= 100, "bots should fire plenty: {}", bolts.len());
        assert!(w.stats.crates_destroyed >= 40, "{:?}", w.stats);
    }
}
