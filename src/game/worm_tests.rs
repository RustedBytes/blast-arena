//! Tests of the worms arena: crawling, hunting, biting, blasts that kill
//! and cut worms, respawning, the arena mode and what clients receive.

use std::collections::VecDeque;
use std::sync::Arc;

use super::ai::SAFE;
use super::bomb::FUSE_TICKS;
use super::map::Map;
use super::worms::{Worm, flag};
use super::{Config, Mode, World, test_world};

impl World {
    /// A grown worm lying on `cells` (head first), ready to crawl.
    fn place_worm(&mut self, cells: &[(i32, i32)]) -> u32 {
        let id = self.add_worm(cells[0], 1);
        let w = self.worms.list.last_mut().unwrap();
        w.body = cells.iter().copied().collect();
        w.trail = *cells.last().unwrap();
        (w.emerge_until, w.next_step) = (0, self.tick + 1);
        self.worms.enabled = true;
        self.recount_worms();
        id
    }

    fn recount_worms(&mut self) {
        self.worms.occupied.fill(0);
        for w in &self.worms.list {
            for &(x, y) in &w.body {
                self.worms.occupied[self.map.idx(x, y)] += 1;
            }
        }
    }

    fn worm(&self, id: u32) -> &Worm {
        self.worms.list.iter().find(|w| w.id == id).unwrap()
    }

    /// Stops worm `id` where it is.
    fn freeze_worm(&mut self, id: u32) {
        self.worms.list.iter_mut().find(|w| w.id == id).unwrap().next_step = u64::MAX;
    }
}

/// No spawning in these tests unless they ask for it.
fn quiet(mut w: World) -> World {
    w.worms.tuning.min_count = 0;
    w.worms.tuning.max_count = 0;
    w
}

fn connected(body: &VecDeque<(i32, i32)>) -> bool {
    body.iter().zip(body.iter().skip(1)).all(|(a, b)| (a.0 - b.0).abs() + (a.1 - b.1).abs() <= 1)
}

fn cells(w: &Worm) -> Vec<(i32, i32)> {
    w.body.iter().copied().collect()
}

#[test]
fn worm_crawls_and_the_body_follows_the_head() {
    let mut w = quiet(test_world(Map::empty(15, 15)));
    let id = w.place_worm(&[(7, 7), (7, 8), (7, 9), (7, 10)]);
    let mut heads = vec![(7, 10), (7, 9), (7, 8), (7, 7)];
    for _ in 0..200 {
        w.step();
        let worm = w.worm(id);
        assert!(connected(&worm.body), "body stays in one piece: {:?}", worm.body);
        assert_eq!(worm.body.len(), 4);
        assert!(worm.body.iter().all(|&(x, y)| !w.map.is_solid(x, y)), "never inside a wall");
        if heads.last() != Some(&worm.head()) {
            heads.push(worm.head());
        }
    }
    assert!(heads.len() >= 15, "the worm wandered: {} cells", heads.len());
    // The tail walks where the head went.
    let n = heads.len();
    assert_eq!(cells(w.worm(id)), heads[n - 4..].iter().rev().copied().collect::<Vec<_>>());
    let total: u32 = w.worms.occupied.iter().map(|&c| u32::from(c)).sum();
    assert_eq!(total, 4, "occupancy follows the worm");
}

#[test]
fn worm_hunts_down_and_eats_a_player() {
    let mut w = quiet(test_world(Map::empty(21, 21)));
    let id = w.place_worm(&[(3, 9), (2, 9), (1, 9)]);
    let p = w.spawn_test_player(13.5, 9.5);
    w.players.get_mut(&p).unwrap().invulnerable_until = 0;
    for _ in 0..400 {
        w.step();
        if !w.players[&p].alive {
            break;
        }
        assert!(w.worm(id).chasing, "it smells the player");
        let t = &w.worms.tuning;
        let pace = if w.worm(id).lunging { t.lunge_step_ticks } else { t.chase_step_ticks };
        assert_eq!(w.worm(id).step_ticks, pace);
    }
    assert!(!w.players[&p].alive, "eaten");
    assert_eq!(w.stats.worm_bites, 1);
    assert_eq!(w.worm(id).body.len(), 4, "a meal makes it longer");
}

#[test]
fn worm_ignores_players_out_of_smelling_range() {
    let mut w = quiet(test_world(Map::empty(41, 15)));
    let id = w.place_worm(&[(3, 7), (2, 7)]);
    let range = i32::from(w.worms.tuning.sense_range);
    w.spawn_test_player(3.5 + range as f32 + 3.0, 7.5);
    w.step();
    w.step();
    assert!(!w.worm(id).chasing);
}

#[test]
fn worm_is_slower_than_a_fleeing_player() {
    let mut w = quiet(test_world(Map::empty(41, 15)));
    let id = w.place_worm(&[(4, 7), (3, 7), (2, 7)]);
    let p = w.spawn_test_player(9.5, 7.5);
    w.players.get_mut(&p).unwrap().invulnerable_until = 0;
    w.hold(p, 2, 0);
    for _ in 0..120 {
        w.step();
    }
    assert!(w.players[&p].alive, "outran it");
    let gap = w.players[&p].cell().0 - w.worm(id).head().0;
    assert!(gap > 5, "the gap grew: {gap}");
}

#[test]
fn shielded_or_jumping_players_are_not_eaten() {
    let mut w = quiet(test_world(Map::empty(15, 15)));
    let id = w.place_worm(&[(5, 5), (5, 6), (5, 7)]);
    w.freeze_worm(id);
    let p = w.spawn_test_player(5.5, 6.5);
    w.players.get_mut(&p).unwrap().invulnerable_until = w.tick + 5;
    w.step();
    assert!(w.players[&p].alive, "shielded");
    let pl = w.players.get_mut(&p).unwrap();
    (pl.jump_left, pl.invulnerable_until) = (3, 0);
    w.worm_bites();
    assert!(w.players[&p].alive, "jumping over it");
    w.players.get_mut(&p).unwrap().jump_left = 0;
    w.worm_bites();
    assert!(!w.players[&p].alive, "touching the body is enough");
    assert_eq!(w.worm(id).body.len(), 4);
}

#[test]
fn emerging_worms_neither_move_nor_bite() {
    let mut w = quiet(test_world(Map::empty(15, 15)));
    w.worms.enabled = true;
    let id = w.add_worm((7, 7), 5);
    let p = w.spawn_test_player(7.5, 7.5);
    w.players.get_mut(&p).unwrap().invulnerable_until = 0;
    for _ in 1..w.worms.tuning.emerge_ticks {
        w.step();
        assert!(w.players[&p].alive);
        assert_eq!(w.worm(id).head(), (7, 7));
    }
    for _ in 0..3 {
        w.step();
    }
    assert!(!w.players[&p].alive, "out of the ground, it bites");
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
fn a_blast_kills_a_worm_and_scores() {
    let mut w = quiet(test_world(Map::empty(15, 15)));
    let id = w.place_worm(&[(5, 1), (6, 1)]);
    w.freeze_worm(id);
    let p = bomb_from(&mut w, (3, 1), 3);
    for _ in 0..FUSE_TICKS + 2 {
        w.step();
    }
    assert!(w.worms.list.iter().all(|x| x.id != id), "blown up");
    assert_eq!(w.stats.worms_killed, 1);
    assert_eq!(w.players[&p].score, w.worms.tuning.kill_points);
    assert!(w.worms.occupied.iter().all(|&c| c == 0));
    assert!(w.worms.next_spawn + 3 >= w.tick + w.worms.tuning.respawn_ticks, "a replacement comes later");
}

#[test]
fn a_blast_through_the_middle_cuts_a_worm_in_two() {
    let mut w = quiet(test_world(Map::empty(15, 15)));
    // Head at (9, 1), tail at (3, 1); the blast goes up column 5.
    let body: Vec<_> = (3..=9).rev().map(|x| (x, 1)).collect();
    let id = w.place_worm(&body);
    w.freeze_worm(id);
    let p = bomb_from(&mut w, (5, 3), 2);
    for _ in 0..=FUSE_TICKS {
        w.step();
    }
    assert_eq!(w.worms.list.len(), 2, "two pieces");
    assert_eq!(cells(w.worm(id)), vec![(9, 1), (8, 1), (7, 1), (6, 1)], "the head end keeps the id");
    let back = w.worms.list.iter().find(|x| x.id != id).unwrap();
    assert_eq!(cells(back), vec![(4, 1), (3, 1)], "the tail end crawls on alone");
    assert_eq!(w.stats.worms_killed, 0, "cutting isn't killing");
    assert_eq!(w.players[&p].score, 0);
    let total: u32 = w.worms.occupied.iter().map(|&c| u32::from(c)).sum();
    assert_eq!(total, 6);
}

#[test]
fn short_pieces_die_and_a_lost_head_kills_the_worm() {
    let mut w = quiet(test_world(Map::empty(15, 15)));
    // The blast takes the head; the two segments behind it live on.
    let id = w.place_worm(&[(5, 1), (4, 1), (3, 1)]);
    w.freeze_worm(id);
    let p = bomb_from(&mut w, (5, 3), 2);
    for _ in 0..=FUSE_TICKS {
        w.step();
    }
    assert!(w.worms.list.iter().all(|x| x.id != id), "headless");
    assert_eq!(w.worms.list.len(), 1, "the two-segment tail crawls on");
    assert_eq!(w.stats.worms_killed, 1);
    assert_eq!(w.players[&p].score, 1);
    // One-segment leftovers are too short to live.
    let mut w = quiet(test_world(Map::empty(15, 15)));
    let id = w.place_worm(&[(6, 1), (5, 1), (4, 1)]);
    w.freeze_worm(id);
    bomb_from(&mut w, (5, 3), 2);
    for _ in 0..=FUSE_TICKS {
        w.step();
    }
    assert!(w.worms.list.is_empty(), "only scraps were left");
    assert_eq!(w.stats.worms_killed, 1);
}

#[test]
fn worms_keep_away_from_fire() {
    let mut w = quiet(test_world(Map::empty(15, 15)));
    w.place_worm(&[(3, 1), (2, 1), (1, 1)]);
    let i = w.map.idx(4, 1);
    (w.flame_from[i], w.flame_until[i]) = (0, u64::MAX);
    assert!(!w.worm_can_enter(4, 1));
    assert!(w.worm_can_enter(3, 2));
}

#[test]
fn worms_come_back_over_time() {
    let mut w = test_world(Map::empty(41, 41));
    w.enable_worms();
    let target = w.worm_target();
    assert!(target >= w.worms.tuning.min_count);
    assert_eq!(w.worms.list.len(), target, "a full arena from the start");
    w.worms.list.clear();
    w.recount_worms();
    w.worms.next_spawn = w.tick + 10;
    for _ in 0..10 + w.worms.tuning.spawn_gap_ticks * target as u64 + 2 {
        w.step();
    }
    assert_eq!(w.worms.list.len(), target, "all back");
    // New worms keep clear of players.
    let clear = w.worms.tuning.spawn_clearance;
    let p = w.spawn_test_player(20.5, 20.5);
    w.worms.list.clear();
    w.recount_worms();
    for _ in 0..30 {
        assert!(w.spawn_worm());
    }
    let (px, py) = w.players[&p].cell();
    assert!(w.worms.list.iter().all(|x| (x.head().0 - px).abs() > clear || (x.head().1 - py).abs() > clear));
}

#[test]
fn the_worms_arena_mode() {
    assert_eq!(Mode::parse("worms"), Some(Mode::Worms));
    assert_eq!(Mode::Worms.as_str(), "worms");
    let cfg = Config { mode: Mode::Worms, map_w: 41, map_h: 41, bots: 4, map_seed: 5, ..Config::default() };
    let mut w = World::new(&cfg, Arc::default(), None);
    assert!(w.worms_on());
    assert_eq!(w.worms.list.len(), w.worm_target());
    let ffa = World::new(&Config { mode: Mode::Ffa, ..cfg.clone() }, Arc::default(), None);
    assert!(!ffa.worms_on() && ffa.worms.list.is_empty(), "no worms elsewhere");
    // A minute with bots: worms crawl, bite and get blown up, and the arena
    // never runs dry.
    for _ in 0..1200 {
        w.step();
        for x in &w.worms.list {
            assert!(connected(&x.body), "worm {} broke apart: {:?}", x.id, x.body);
        }
    }
    eprintln!("{:?}", w.stats);
    assert!(!w.worms.list.is_empty());
    // Clients get every worm: in view whole, out of view by the head.
    let p = w.spawn_test_player(20.5, 20.5);
    let snap = w.full_snapshot(p);
    let worms = snap["x"]["worms"].as_array().unwrap();
    assert_eq!(worms.len(), w.worms.list.len());
    for (sent, worm) in worms.iter().zip(&w.worms.list) {
        assert_eq!(sent[0], worm.id);
        let far = sent[1].as_u64().unwrap() & u64::from(flag::FAR) != 0;
        let cells = sent[4].as_array().unwrap();
        assert_eq!(cells.len(), if far { 1 } else { worm.body.len() + 1 });
        assert_eq!(cells[0], serde_json::json!([worm.head().0, worm.head().1]));
    }
}

#[test]
fn bots_see_worms_as_danger_and_targets() {
    let mut w = quiet(test_world(Map::empty(15, 15)));
    let id = w.place_worm(&[(7, 7), (7, 8), (7, 9)]);
    let d = w.danger_map();
    assert_eq!(d[w.map.idx(7, 8)], 0, "the body bites now");
    assert!(d[w.map.idx(7, 6)] < SAFE, "in front of the head");
    assert_eq!(d[w.map.idx(1, 1)], SAFE);
    // A bot next to a worm gets away from it.
    w.freeze_worm(id);
    let bot = w.add_bot();
    let b = w.players.get_mut(&bot).unwrap();
    (b.x, b.y, b.invulnerable_until) = (8.5, 6.5, 0);
    for _ in 0..40 {
        w.step();
    }
    assert!(w.players[&bot].alive);
    let (bx, by) = w.players[&bot].cell();
    assert!((bx - 7).abs() + (by - 7).abs() >= 2, "kept its distance");
}

#[test]
fn a_worm_cuts_off_a_running_player() {
    // The player runs right along row 9; the worm comes down column 11.
    let mut w = quiet(test_world(Map::empty(25, 21)));
    let id = w.place_worm(&[(11, 3), (11, 2), (11, 1)]);
    let p = w.spawn_test_player(3.5, 9.5);
    w.players.get_mut(&p).unwrap().invulnerable_until = 0;
    w.hold(p, 2, 0);
    w.step();
    w.step();
    let worm = w.worm(id);
    let (px, py) = w.players[&p].cell();
    assert!(worm.chasing && worm.prey == p);
    assert_eq!(worm.target.1, py, "it makes for the player's row");
    assert!(worm.target.0 > px, "ahead of the player, not behind: {:?} vs {px}", worm.target);
}

#[test]
fn two_worms_after_one_player_come_from_different_sides() {
    let mut w = quiet(test_world(Map::empty(31, 21)));
    let a = w.place_worm(&[(13, 3), (13, 2), (13, 1)]);
    let b = w.place_worm(&[(15, 3), (15, 2), (15, 1)]);
    let p = w.spawn_test_player(5.5, 9.5);
    w.players.get_mut(&p).unwrap().invulnerable_until = 0;
    w.hold(p, 2, 0);
    for _ in 0..3 {
        w.step();
    }
    let (ta, tb) = (w.worm(a).target, w.worm(b).target);
    assert!(w.worm(a).prey == p && w.worm(b).prey == p, "both hunt the player");
    assert_ne!(ta, tb, "they split up");
}

#[test]
fn a_worm_lunges_at_close_prey() {
    let mut w = quiet(test_world(Map::empty(15, 15)));
    let id = w.place_worm(&[(4, 7), (3, 7), (2, 7)]);
    let p = w.spawn_test_player(6.5, 7.5);
    w.players.get_mut(&p).unwrap().invulnerable_until = 0;
    w.step();
    assert!(w.worm(id).lunging);
    assert_eq!(w.worm(id).step_ticks, w.worms.tuning.lunge_step_ticks);
}

#[test]
fn a_worm_keeps_looking_where_its_prey_slipped_away() {
    let mut w = quiet(test_world(Map::empty(41, 15)));
    let id = w.place_worm(&[(4, 7), (3, 7), (2, 7)]);
    let p = w.spawn_test_player(10.5, 7.5);
    w.players.get_mut(&p).unwrap().invulnerable_until = 0;
    w.step();
    assert!(w.worm(id).chasing);
    // Gone out of range in an instant (a portal, say).
    let pl = w.players.get_mut(&p).unwrap();
    (pl.x, pl.y) = (38.5, 13.5);
    w.rebuild_buckets();
    let start = w.worm(id).head();
    for _ in 0..3 * w.worms.tuning.chase_step_ticks {
        w.step();
    }
    let worm = w.worm(id);
    assert!(worm.chasing, "still on the trail");
    assert!(worm.head().0 > start.0, "towards where it last smelt the player");
}

#[test]
fn a_hunting_worm_waits_out_a_bomb_across_its_path() {
    let mut w = quiet(test_world(Map::empty(21, 15)));
    let id = w.place_worm(&[(4, 7), (3, 7), (2, 7)]);
    let p = w.spawn_test_player(15.5, 7.5);
    w.players.get_mut(&p).unwrap().invulnerable_until = 0;
    // A wall of fire to come across the worm's way: column 9, rows 4..10.
    bomb_from(&mut w, (9, 4), 6);
    w.step();
    for _ in 0..FUSE_TICKS + 20 {
        w.step();
        assert!(w.worms.list.iter().any(|x| x.id == id), "it stayed out of the blast");
    }
}

#[test]
fn new_worms_come_up_near_players_but_not_on_top_of_them() {
    let mut w = quiet(test_world(Map::empty(81, 81)));
    let p = w.spawn_test_player(40.5, 40.5);
    let (px, py) = w.players[&p].cell();
    let (clear, reach) = (w.worms.tuning.spawn_clearance, w.worms.tuning.spawn_reach);
    for _ in 0..10 {
        w.worms.list.clear();
        w.recount_worms();
        assert!(w.spawn_worm());
        let head = w.worms.list[0].head();
        let d = (head.0 - px).abs().max((head.1 - py).abs());
        assert!(d > clear && d <= reach, "at {d} cells");
    }
}

#[test]
fn idle_worms_drift_towards_players() {
    let mut w = quiet(test_world(Map::empty(61, 9)));
    let id = w.place_worm(&[(5, 4), (4, 4), (3, 4)]);
    w.spawn_test_player(30.5, 4.5);
    let start = w.worm(id).head().0;
    for _ in 0..200 {
        w.step();
    }
    let worm = w.worm(id);
    assert!(!worm.chasing || worm.head().0 > 15);
    assert!(worm.head().0 > start + 6, "it came closer: {}", worm.head().0);
}


