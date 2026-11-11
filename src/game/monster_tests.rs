//! Tests of the dungeon arena: its map, and its monsters hunting, biting,
//! taking hits, dying, coming back, and what clients receive.

use std::sync::Arc;

use super::ai::SAFE;
use super::bomb::FUSE_TICKS;
use super::items::Item;
use super::map::{Biome, Map, Tile};
use super::monsters::{Kind, Monster, flag};
use super::rng::Rng;
use super::{Config, Mode, World, test_world};

impl World {
    /// A monster of `kind` at `cell`, already out of the ground.
    fn place_monster(&mut self, kind: Kind, cell: (i32, i32)) -> u32 {
        self.monsters.enabled = true;
        let id = self.add_monster(kind, cell);
        let m = self.monsters.list.last_mut().unwrap();
        (m.rise_until, m.next_step) = (0, self.tick + 1);
        id
    }

    fn monster(&self, id: u32) -> Option<&Monster> {
        self.monsters.list.iter().find(|m| m.id == id)
    }

    fn freeze_monster(&mut self, id: u32) {
        self.monsters.list.iter_mut().find(|m| m.id == id).unwrap().next_step = u64::MAX;
    }
}

/// No spawning in these tests unless they ask for it.
fn quiet(mut w: World) -> World {
    w.monsters.tuning.min_count = 0;
    w.monsters.tuning.max_count = 0;
    w
}

/// A player drops a bomb at `at`, then is moved out of harm's way.
fn bomb_from(w: &mut World, at: (i32, i32), range: u8) -> u32 {
    let p = w.spawn_test_player(at.0 as f32 + 0.5, at.1 as f32 + 0.5);
    w.players.get_mut(&p).unwrap().range = range;
    w.place_bomb(p);
    let (x, y) = (w.map.w as f32 - 1.5, w.map.h as f32 - 1.5);
    let pl = w.players.get_mut(&p).unwrap();
    (pl.x, pl.y) = (x, y);
    w.rebuild_buckets();
    p
}

#[test]
fn dungeon_maps_are_valid_rooms_and_corridors() {
    for seed in 0..6 {
        for size in [31, 61, 81] {
            let map = Map::generate_dungeon(size, size, &mut Rng::new(seed));
            assert_eq!(map.validate(), Ok(()), "seed {seed} size {size}");
            assert!(map.biomes.iter().all(|b| b.biome == Biome::Crypt));
            assert_eq!(map.count(Tile::Ice) + (4..=7).map(|t| map.count(Tile::from_u8(t))).sum::<usize>(), 0, "no ice or belts");
            // Rooms: open 3x3 squares (no pillar inside) are common.
            let mut squares = 0;
            for y in 1..size - 3 {
                for x in 1..size - 3 {
                    if (0..3).all(|dy| (0..3).all(|dx| map.get(x + dx, y + dy) != Tile::Wall)) {
                        squares += 1;
                    }
                }
            }
            assert!(squares > (size * size / 30) as usize, "rooms: {squares} open squares (seed {seed} size {size})");
        }
    }
    let a = Map::generate_dungeon(41, 41, &mut Rng::new(7));
    let b = Map::generate_dungeon(41, 41, &mut Rng::new(7));
    assert_eq!(a.encode_rle(), b.encode_rle(), "a seed replays its map");
}

#[test]
fn a_skeleton_hunts_down_and_bites_a_player() {
    let mut w = quiet(test_world(Map::empty(21, 21)));
    w.monsters.enabled = true;
    let id = w.place_monster(Kind::Skeleton, (3, 9));
    let p = w.spawn_test_player(11.5, 9.5);
    w.players.get_mut(&p).unwrap().invulnerable_until = 0;
    for _ in 0..400 {
        w.step();
        if w.stats.monster_bites > 0 {
            break;
        }
        assert!(w.monster(id).unwrap().chasing, "it sees the player");
    }
    assert!(w.players[&p].alive, "a bite costs a heart, not a life");
    assert_eq!(w.stats.monster_bites, 1);
    assert_eq!(w.hearts(&w.players[&p]), w.monsters.tuning.player_hp - 1);
}

#[test]
fn monsters_ignore_players_out_of_range() {
    let mut w = quiet(test_world(Map::empty(41, 15)));
    let id = w.place_monster(Kind::Slime, (3, 7));
    let range = w.monsters.tuning.slime.sense_range;
    w.spawn_test_player(3.5 + range as f32 + 3.0, 7.5);
    w.step();
    w.step();
    assert!(!w.monster(id).unwrap().chasing);
}

#[test]
fn a_running_player_outpaces_a_skeleton() {
    let mut w = quiet(test_world(Map::empty(41, 15)));
    let id = w.place_monster(Kind::Skeleton, (4, 7));
    let p = w.spawn_test_player(8.5, 7.5);
    w.players.get_mut(&p).unwrap().invulnerable_until = 0;
    w.hold(p, 2, 0);
    for _ in 0..120 {
        w.step();
    }
    assert!(w.players[&p].alive, "outran it");
    let gap = w.players[&p].cell().0 - w.monster(id).unwrap().cell.0;
    assert!(gap > 4, "the gap grew: {gap}");
}

#[test]
fn shielded_jumping_or_rising_are_safe() {
    let mut w = quiet(test_world(Map::empty(15, 15)));
    let id = w.place_monster(Kind::Slime, (5, 5));
    w.freeze_monster(id);
    let p = w.spawn_test_player(5.5, 5.5);
    w.players.get_mut(&p).unwrap().invulnerable_until = w.tick + 5;
    w.step();
    assert!(w.players[&p].alive, "shielded");
    let pl = w.players.get_mut(&p).unwrap();
    (pl.jump_left, pl.invulnerable_until) = (3, 0);
    w.monster_bites();
    assert!(w.players[&p].alive, "jumping over it");
    w.players.get_mut(&p).unwrap().jump_left = 0;
    w.monsters.list[0].rise_until = w.tick + 10;
    w.monster_bites();
    assert!(w.players[&p].alive, "still rising out of the ground");
    w.monsters.list[0].rise_until = 0;
    w.monster_bites();
    assert_eq!(w.stats.monster_bites, 1, "bitten");
}

#[test]
fn bites_take_hearts_and_the_last_one_kills() {
    let mut w = quiet(test_world(Map::empty(15, 15)));
    let id = w.place_monster(Kind::Bat, (5, 5));
    w.freeze_monster(id);
    let p = w.spawn_test_player(5.5, 5.5);
    w.players.get_mut(&p).unwrap().invulnerable_until = 0;
    let hp = w.monsters.tuning.player_hp;
    assert_eq!(hp, 3);
    for left in (1..hp).rev() {
        w.monster_bites();
        let pl = &w.players[&p];
        assert!(pl.alive);
        assert_eq!(w.hearts(pl), left);
        assert!(pl.hurt_until > w.tick, "a moment of immunity");
        assert!(w.monster(id).unwrap().next_step >= w.tick + w.monsters.tuning.recoil_ticks, "the bat staggers");
        assert_ne!(w.monster(id).unwrap().cell, (5, 5), "knocked back off the player");
        // Put it back on the player for the next bite.
        let m = w.monsters.list.iter_mut().find(|m| m.id == id).unwrap();
        let old = m.cell;
        m.cell = (5, 5);
        let (oi, ni) = (w.map.idx(old.0, old.1), w.map.idx(5, 5));
        w.monsters.occupied[oi] -= 1;
        w.monsters.occupied[ni] += 1;
        // No second bite while immune.
        w.monster_bites();
        assert_eq!(w.hearts(&w.players[&p]), left);
        w.players.get_mut(&p).unwrap().hurt_until = 0;
        w.freeze_monster(id);
    }
    w.monster_bites();
    assert!(!w.players[&p].alive, "the last heart");
    assert_eq!(w.players[&p].wounds, 0, "the next life starts unhurt");
}

#[test]
fn hearts_heal_over_time() {
    let mut w = quiet(test_world(Map::empty(15, 15)));
    w.monsters.enabled = true;
    let p = w.spawn_test_player(5.5, 5.5);
    let pl = w.players.get_mut(&p).unwrap();
    (pl.wounds, pl.heal_at) = (2, w.tick + 5);
    for _ in 0..6 {
        w.step();
    }
    assert_eq!(w.players[&p].wounds, 1, "one heart back");
    for _ in 0..w.monsters.tuning.heal_ticks {
        w.step();
    }
    assert_eq!(w.players[&p].wounds, 0);
}

/// A bitten player who runs gets away: monsters lose interest while the
/// bite immunity lasts, and a bat chases slower than a player walks.
fn bitten_player_gets_away(kind: Kind) {
    let mut w = quiet(test_world(Map::empty(41, 15)));
    let id = w.place_monster(kind, (6, 7));
    let p = w.spawn_test_player(6.5, 7.5);
    w.players.get_mut(&p).unwrap().invulnerable_until = 0;
    w.monster_bites();
    assert_eq!(w.stats.monster_bites, 1);
    w.hold(p, 2, 0);
    for _ in 0..140 {
        w.step();
    }
    assert!(w.players[&p].alive, "{kind:?}: got away");
    assert_eq!(w.stats.monster_bites, 1, "{kind:?}: no second bite");
    let gap = w.players[&p].cell().0 - w.monster(id).unwrap().cell.0;
    assert!(gap >= 6, "{kind:?}: the gap grew to {gap}");
}

#[test]
fn a_bitten_player_escapes_a_bat() {
    bitten_player_gets_away(Kind::Bat);
}

#[test]
fn a_bitten_player_escapes_a_slime() {
    bitten_player_gets_away(Kind::Slime);
}

#[test]
fn bats_chase_slower_than_a_player_walks() {
    let t = super::monsters::MonsterTuning::default();
    let player_ticks_per_cell = 1.0 / (super::player::BASE_SPEED * super::DT);
    for k in super::monsters::KINDS {
        assert!(t.of(k).chase_step_ticks as f32 > player_ticks_per_cell, "{k:?} must be outrun");
    }
}

#[test]
fn a_blast_slays_a_slime_and_scores() {
    let mut w = quiet(test_world(Map::empty(15, 15)));
    let id = w.place_monster(Kind::Slime, (5, 1));
    w.freeze_monster(id);
    let p = bomb_from(&mut w, (3, 1), 3);
    for _ in 0..FUSE_TICKS + 2 {
        w.step();
    }
    assert!(w.monster(id).is_none(), "slain");
    assert_eq!(w.stats.monsters_killed, 1);
    assert_eq!(w.players[&p].score, w.monsters.tuning.slime.points);
    assert!(w.monsters.occupied.iter().all(|&c| c == 0));
    assert!(w.monsters.next_spawn + 3 >= w.tick + w.monsters.tuning.respawn_ticks, "a replacement comes later");
}

#[test]
fn a_skeleton_takes_two_blasts() {
    let mut w = quiet(test_world(Map::empty(15, 15)));
    let id = w.place_monster(Kind::Skeleton, (5, 1));
    w.freeze_monster(id);
    let p = bomb_from(&mut w, (3, 1), 3);
    for _ in 0..FUSE_TICKS + 2 {
        w.step();
    }
    let m = w.monster(id).expect("one blast is one hit");
    assert_eq!(m.hp, 1);
    assert_eq!(m.last_hitter, p);
    // Let the first fire die down, then a second bomb.
    for _ in 0..20 {
        w.step();
    }
    w.freeze_monster(id);
    let cell = w.monster(id).unwrap().cell;
    let q = bomb_from(&mut w, (cell.0, cell.1 + 2), 3);
    for _ in 0..FUSE_TICKS + 2 {
        w.step();
    }
    assert!(w.monster(id).is_none(), "the second blast finishes it");
    assert_eq!(w.players[&q].score, w.monsters.tuning.skeleton.points);
}

#[test]
fn monsters_keep_away_from_fire() {
    let mut w = quiet(test_world(Map::empty(15, 15)));
    let id = w.place_monster(Kind::Skeleton, (5, 1));
    bomb_from(&mut w, (3, 1), 4);
    for _ in 0..FUSE_TICKS + 2 {
        w.step();
    }
    assert!(w.monster(id).is_some(), "it got out of the way");
    let d = w.danger_map();
    assert_eq!(d[w.map.idx(1, 13)], SAFE);
}

#[test]
fn bats_fly_over_crates_but_not_walls() {
    let mut w = quiet(test_world(Map::empty(15, 15)));
    w.place_monster(Kind::Bat, (3, 3));
    w.set_tile(4, 3, Tile::Crate);
    assert!(w.monster_can_enter(Kind::Bat, 4, 3));
    assert!(!w.monster_can_enter(Kind::Slime, 4, 3));
    assert!(!w.monster_can_enter(Kind::Bat, 4, 4), "a pillar");
    for _ in 0..400 {
        w.step();
        let (x, y) = w.monsters.list[0].cell;
        assert_ne!(w.map.get(x, y), Tile::Wall);
    }
}

#[test]
fn monsters_come_back_and_rise_away_from_players() {
    let mut w = test_world(Map::empty(41, 41));
    w.monsters.tuning.min_count = 5;
    w.monsters.tuning.max_count = 5;
    let p = w.spawn_test_player(20.5, 20.5);
    w.players.get_mut(&p).unwrap().invulnerable_until = u64::MAX;
    w.enable_monsters();
    assert_eq!(w.monsters.list.len(), 5);
    let clear = w.monsters.tuning.spawn_clearance;
    for m in &w.monsters.list {
        assert!((m.cell.0 - 20).abs().max((m.cell.1 - 20).abs()) > clear, "not on top of the player");
        assert!(m.rising(w.tick));
    }
    w.monsters.list.clear();
    w.monsters.occupied.fill(0);
    for _ in 0..200 {
        w.step();
    }
    assert_eq!(w.monsters.list.len(), 5, "they came back");
}

#[test]
fn bots_see_monsters_as_danger() {
    let mut w = quiet(test_world(Map::empty(15, 15)));
    w.place_monster(Kind::Skeleton, (7, 7));
    let d = w.danger_map();
    assert_eq!(d[w.map.idx(7, 7)], 0, "it bites now");
    assert!(d[w.map.idx(7, 6)] < SAFE, "next to it");
    assert_eq!(d[w.map.idx(1, 1)], SAFE);
    assert!(!w.safe_arrival(7, 7));
}

#[test]
fn the_dungeon_arena_mode() {
    assert_eq!(Mode::parse("dungeon"), Some(Mode::Dungeon));
    assert_eq!(Mode::Dungeon.as_str(), "dungeon");
    let cfg = Config { mode: Mode::Dungeon, map_w: 41, map_h: 41, bots: 4, map_seed: 5, ..Config::default() };
    let mut w = World::new(&cfg, Arc::default(), None);
    assert!(w.monsters_on());
    assert_eq!(w.monsters.list.len(), w.monster_target());
    assert!(w.map.biomes.iter().all(|b| b.biome == Biome::Crypt));
    let ffa = World::new(&Config { mode: Mode::Ffa, ..cfg.clone() }, Arc::default(), None);
    assert!(!ffa.monsters_on() && ffa.monsters.list.is_empty(), "no monsters elsewhere");
    // A minute with bots: monsters roam, bite and get slain, never inside
    // a wall or stacked on one cell, and the dungeon never runs dry.
    for _ in 0..1200 {
        w.step();
        let mut cells: Vec<_> = w.monsters.list.iter().map(|m| m.cell).collect();
        for &(x, y) in &cells {
            assert!(!matches!(w.map.get(x, y), Tile::Wall | Tile::Built));
        }
        cells.sort_unstable();
        cells.dedup();
        assert_eq!(cells.len(), w.monsters.list.len(), "one monster per cell");
        let total: usize = w.monsters.occupied.iter().map(|&c| usize::from(c)).sum();
        assert_eq!(total, w.monsters.list.len(), "occupancy stays in step");
    }
    eprintln!("{:?}", w.stats);
    assert!(!w.monsters.list.is_empty());
    // Clients get the monsters in view.
    let p = w.spawn_test_player(20.5, 20.5);
    let snap = w.full_snapshot(p);
    let sent = snap["x"]["monsters"].as_array().cloned().unwrap_or_default();
    assert!(!sent.is_empty(), "a 41x41 dungeon is in view");
    for s in &sent {
        let m = w.monster(u32::try_from(s[0].as_u64().unwrap()).unwrap()).unwrap();
        assert_eq!(s[1], m.kind as u8);
        assert_eq!((s[3].as_i64().unwrap(), s[4].as_i64().unwrap()), (i64::from(m.cell.0), i64::from(m.cell.1)));
        assert_eq!(s[2].as_u64().unwrap() & u64::from(flag::RISING) != 0, m.rising(w.tick));
        assert_eq!(s[9], m.hp);
    }
}

#[test]
fn a_heart_restores_every_heart() {
    let mut w = quiet(test_world(Map::empty(15, 15)));
    w.monsters.enabled = true;
    let p = w.spawn_test_player(5.5, 5.5);
    w.players.get_mut(&p).unwrap().wounds = 2;
    assert_eq!(w.hearts(&w.players[&p]), 1);
    w.set_item(6, 5, Item::Heart as u8);
    w.hold(p, 2, 0);
    for _ in 0..10 {
        w.step();
    }
    assert_eq!(w.hearts(&w.players[&p]), w.monsters.tuning.player_hp, "all hearts back");
    assert_eq!(w.items[w.map.idx(6, 5)], 0, "picked up");
}

#[test]
fn hearts_drop_only_in_the_dungeon() {
    let mut dungeon = quiet(test_world(Map::empty(15, 15)));
    dungeon.monsters.enabled = true;
    dungeon.monsters.tuning.heart_crate_share = 1.0;
    assert_eq!(dungeon.dungeon_drop(Item::Range), Item::Heart);
    let mut ffa = test_world(Map::empty(15, 15));
    ffa.monsters.tuning.heart_crate_share = 1.0;
    assert_eq!(ffa.dungeon_drop(Item::Range), Item::Range, "no monsters, no hearts");
    // Slain monsters drop hearts too.
    let mut w = quiet(test_world(Map::empty(15, 15)));
    w.monsters.tuning.drop_chance = 1.0;
    w.monsters.tuning.heart_monster_share = 1.0;
    let id = w.place_monster(Kind::Slime, (5, 1));
    w.freeze_monster(id);
    bomb_from(&mut w, (3, 1), 3);
    for _ in 0..FUSE_TICKS + 2 {
        w.step();
    }
    assert!(w.monster(id).is_none());
    assert_eq!(w.items[w.map.idx(5, 1)], Item::Heart as u8);
}
