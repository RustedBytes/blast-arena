//! Tests for the six ability power-ups, named after the scenarios of the
//! specification (B01 builder … D09 dash, N01 network/system).

use bytes::Bytes;
use tokio::sync::mpsc;

use super::abilities::{ab, reject};
use super::bomb::BombKind;
use super::items::Item;
use super::map::{Map, Tile};
use super::player::Player;
use super::*;
use crate::protocol::{self, ev};

/// A 15x15 classic map: border walls and pillars on even coordinates, so
/// row 1 and column 1 are open lanes.
fn world() -> World {
    test_world(Map::empty(15, 15))
}

/// A player whose events we can read.
fn spawn(w: &mut World, x: f32, y: f32) -> (u32, mpsc::Receiver<Bytes>) {
    let (link, rx) = test_link();
    w.next_player_id += 1;
    let id = w.next_player_id;
    let mut p = Player::new(id, format!("p{id}"), Some(link));
    (p.x, p.y, p.alive) = (x, y, true);
    w.players.insert(id, p);
    w.rebuild_buckets();
    (id, rx)
}

/// Ability events this player received: (sub-kind, values after the tick).
fn ability_events(rx: &mut mpsc::Receiver<Bytes>) -> Vec<(i64, Vec<i64>)> {
    let mut out = Vec::new();
    while let Ok(m) = rx.try_recv() {
        let v = protocol::testing::decode(&m);
        if v["t"] == "ev" && v["kind"] == ev::ABILITY {
            let vals: Vec<i64> = v["v"].as_array().unwrap().iter().map(|x| x.as_i64().unwrap()).collect();
            out.push((vals[0], vals[2..].to_vec()));
        }
    }
    out
}

fn rejections(rx: &mut mpsc::Receiver<Bytes>) -> Vec<i64> {
    ability_events(rx).into_iter().filter(|e| e.0 == ab::REJECTED).map(|e| e.1[1]).collect()
}

fn give(w: &mut World, id: u32, item: Item, facing: u8) {
    w.grant_ability(id, item);
    w.players.get_mut(&id).unwrap().facing = facing;
}

fn steps(w: &mut World, n: u64) {
    for _ in 0..n {
        w.step();
    }
}

// ------------------------------------------------------------------ builder

#[test]
fn b01_wall_on_an_empty_cell() {
    let mut w = world();
    let (id, mut rx) = spawn(&mut w, 3.5, 1.5);
    give(&mut w, id, Item::Builder, 2);
    w.use_ability(id);
    assert_eq!(w.map.get(4, 1), Tile::Built);
    assert_eq!((w.walls.len(), w.players[&id].ability_n), (1, 1));
    assert!(ability_events(&mut rx).iter().any(|e| e.0 == ab::WALL_CREATED && e.1[2..4] == [4, 1]));
    assert!(w.map.is_solid(4, 1), "the wall is solid for movement, blasts and AI");
}

#[test]
fn b02_occupied_cell_is_refused_for_free() {
    let mut w = world();
    let (id, mut rx) = spawn(&mut w, 3.5, 1.5);
    give(&mut w, id, Item::Builder, 2);
    w.place_bomb_at(0, (4, 1), BombKind::plain(2, 50));
    w.use_ability(id);
    w.players.get_mut(&id).unwrap().facing = 1; // (3, 0) is the border
    w.use_ability(id);
    let (_other, _) = spawn(&mut w, 6.3, 1.5); // overlaps (6, 1) and (5, 1)
    assert_eq!(w.map.get(4, 1), Tile::Floor);
    assert_eq!(w.players[&id].ability_n, 2, "no charge spent");
    assert_eq!(w.players[&id].ability_recharge_at, 0, "no cooldown started");
    assert_eq!(rejections(&mut rx), [reject::BLOCKED, reject::BLOCKED]);
    assert!(w.wall_blocked(5, 1).is_some(), "a player overlapping the cell blocks it");
    assert!(w.wall_blocked(7, 1).is_none());
}

#[test]
fn b03_outside_the_map_is_refused() {
    let mut w = world();
    let (id, mut rx) = spawn(&mut w, 1.5, 1.5);
    give(&mut w, id, Item::Builder, 1); // (1, 0): the border
    w.use_ability(id);
    assert_eq!(rejections(&mut rx), [reject::BLOCKED]);
    assert!(w.wall_blocked(-1, 5).is_some() && w.wall_blocked(15, 5).is_some());
}

#[test]
fn b04_no_more_walls_than_the_limit() {
    let mut w = world();
    let (id, mut rx) = spawn(&mut w, 3.5, 1.5);
    give(&mut w, id, Item::Builder, 2);
    w.players.get_mut(&id).unwrap().ability_n = 9;
    w.use_ability(id);
    w.players.get_mut(&id).unwrap().facing = 4;
    w.use_ability(id);
    w.players.get_mut(&id).unwrap().x = 5.5; // facing left: (4, 1) is a wall now
    w.players.get_mut(&id).unwrap().facing = 2;
    w.use_ability(id);
    assert_eq!(w.walls.len(), 2);
    assert_eq!(rejections(&mut rx), [reject::LIMIT]);
}

#[test]
fn b05_wall_crumbles_after_its_time() {
    let mut w = world();
    let (id, mut rx) = spawn(&mut w, 3.5, 1.5);
    give(&mut w, id, Item::Builder, 2);
    w.use_ability(id);
    { let n = w.tuning.wall_ticks - 1; steps(&mut w, n); }
    assert_eq!(w.map.get(4, 1), Tile::Built);
    w.step();
    assert_eq!(w.map.get(4, 1), Tile::Floor);
    assert!(w.walls.is_empty());
    assert!(ability_events(&mut rx).iter().any(|e| e.0 == ab::WALL_REMOVED && e.1[3] == 0));
}

#[test]
fn b06_normal_blast_breaks_the_wall_and_stops() {
    let mut w = world();
    let (id, _rx) = spawn(&mut w, 5.5, 1.5);
    give(&mut w, id, Item::Builder, 2);
    w.use_ability(id); // wall at (6, 1)
    w.players.get_mut(&id).unwrap().x = 1.5;
    w.place_bomb_at(0, (3, 1), BombKind::plain(6, 1));
    w.explode(w.bomb_at(3, 1).unwrap());
    assert_eq!(w.map.get(6, 1), Tile::Floor, "destroyed");
    assert!(w.flame_active(6, 1) && !w.flame_active(7, 1), "the wave stops at the wall");
    assert!(w.items.iter().all(|&i| i == 0), "walls drop nothing");
}

#[test]
fn b07_piercing_blast_goes_through() {
    let mut w = world();
    let (id, _rx) = spawn(&mut w, 5.5, 1.5);
    give(&mut w, id, Item::Builder, 2);
    w.use_ability(id);
    w.players.get_mut(&id).unwrap().x = 1.5;
    w.place_bomb_at(0, (3, 1), BombKind { pierce: true, ..BombKind::plain(6, 1) });
    w.explode(w.bomb_at(3, 1).unwrap());
    assert_eq!(w.map.get(6, 1), Tile::Floor);
    assert!(w.flame_active(8, 1), "the wave continues");
}

#[test]
fn b08_simultaneous_walls_on_one_cell_first_command_wins() {
    let mut w = world();
    let (a, mut ra) = spawn(&mut w, 3.5, 1.5);
    let (b, mut rb) = spawn(&mut w, 5.5, 1.5);
    give(&mut w, a, Item::Builder, 2);
    give(&mut w, b, Item::Builder, 4);
    for id in [a, b] {
        w.players[&id].link.as_ref().unwrap().input.press_ability();
    }
    w.step();
    assert_eq!(w.walls.len(), 1);
    assert_eq!(w.walls[0].owner, a, "lower id is processed first");
    assert!(rejections(&mut ra).is_empty());
    assert_eq!(rejections(&mut rb), [reject::BLOCKED]);
    assert_eq!(w.players[&b].ability_n, 2);
}

#[test]
fn ghosts_and_walkers_cant_pass_a_wall() {
    let mut w = world();
    let (id, _rx) = spawn(&mut w, 3.5, 1.5);
    give(&mut w, id, Item::Builder, 2);
    w.use_ability(id);
    w.players.get_mut(&id).unwrap().ghost_until = u64::MAX;
    w.hold(id, 2, 0);
    steps(&mut w, 20);
    assert!(w.players[&id].x <= 3.5 + 1e-4, "stopped before the wall, even as a ghost");
}

// ----------------------------------------------------------------- gas bomb

/// A player at (3, 1) with gas bombs, one dropped.
fn gas_world() -> (World, u32) {
    let mut w = world();
    let (id, _) = spawn(&mut w, 3.5, 1.5);
    w.grant_ability(id, Item::GasBomb);
    assert!(w.place_bomb(id));
    w.players.get_mut(&id).unwrap().y = 9.5; // out of the way
    (w, id)
}

#[test]
fn g01_fuse_releases_gas_not_fire() {
    let (mut w, id) = gas_world();
    assert!(w.bombs.values().next().unwrap().gas);
    assert_eq!(w.players[&id].gas_bombs, 1);
    { let n = w.tuning.gas_fuse; steps(&mut w, n); }
    assert!(w.bombs.is_empty());
    assert_eq!(w.gas.len(), 1);
    assert_eq!(w.gas[0].arms, [0, 2, 2, 2], "up is the border");
    assert!(!w.flame_active(3, 1) && !w.flame_active(4, 1), "no fire");
}

#[test]
fn g02_g03_slowed_inside_and_a_moment_after() {
    let (mut w, _) = gas_world();
    let (v, _) = spawn(&mut w, 4.5, 1.5);
    let normal = w.players[&v].move_speed(w.tick, 1.0, 0.7);
    { let n = w.tuning.gas_fuse + 1; steps(&mut w, n); }
    let slowed = w.players[&v].move_speed(w.tick, 1.0, 0.7);
    assert!((slowed - normal * 0.7).abs() < 1e-4, "{slowed} vs {normal}");
    w.players.get_mut(&v).unwrap().y = 9.5;
    w.players.get_mut(&v).unwrap().x = 9.5;
    w.rebuild_buckets();
    { let n = w.tuning.gas_linger - 1; steps(&mut w, n); }
    assert!(w.players[&v].move_speed(w.tick, 1.0, 0.7) < normal, "lingers");
    w.step();
    assert!((w.players[&v].move_speed(w.tick, 1.0, 0.7) - normal).abs() < 1e-4, "wears off");
}

#[test]
fn g04_overlapping_clouds_dont_stack() {
    let mut w = world();
    let (first, _) = spawn(&mut w, 3.5, 1.5);
    let (second, _) = spawn(&mut w, 5.5, 1.5);
    for id in [first, second] {
        w.grant_ability(id, Item::GasBomb);
        assert!(w.place_bomb(id));
        w.players.get_mut(&id).unwrap().y = 9.5;
    }
    let (victim, _) = spawn(&mut w, 4.5, 1.5);
    { let n = w.tuning.gas_fuse + 1; steps(&mut w, n); }
    assert_eq!(w.gas.len(), 2);
    let p = &w.players[&victim];
    let normal = p.move_speed(0, 1.0, 1.0);
    assert!((p.move_speed(w.tick, 1.0, 0.7) - normal * 0.7).abs() < 1e-4);
    // Nor with the blizzard: the strongest slowdown applies.
    assert!((p.move_speed(w.tick, 0.65, 0.7) - normal * 0.65).abs() < 1e-4);
}

#[test]
fn g05_walls_stop_the_gas() {
    let mut w = world();
    let (id, _) = spawn(&mut w, 5.5, 1.5);
    give(&mut w, id, Item::Builder, 2);
    w.use_ability(id); // wall at (6, 1)
    w.grant_ability(id, Item::GasBomb);
    w.players.get_mut(&id).unwrap().x = 7.5;
    w.place_bomb(id);
    w.players.get_mut(&id).unwrap().y = 9.5;
    { let n = w.tuning.gas_fuse; steps(&mut w, n); }
    let c = &w.gas[0];
    assert_eq!(c.arms[3], 0, "the wall is right next to it");
    assert!(!c.covers(6, 1) && !c.covers(5, 1));
    assert!(c.covers(9, 1));
}

#[test]
fn g06_g07_fire_ignites_the_gas_once_and_shields_hold() {
    let (mut w, owner) = gas_world();
    let (v, _) = spawn(&mut w, 4.5, 1.5);
    let (s, _) = spawn(&mut w, 5.5, 1.5);
    w.players.get_mut(&s).unwrap().invulnerable_until = u64::MAX;
    { let n = w.tuning.gas_fuse + 1; steps(&mut w, n); }
    assert!(w.players[&v].alive, "gas alone doesn't hurt");
    // A blast from below reaches the cloud's centre column... a bomb at (1, 1).
    w.place_bomb_at(0, (1, 1), BombKind::plain(2, 0));
    w.step();
    assert!(w.gas.is_empty(), "burnt up");
    assert_eq!(w.stats.gas_ignitions, 1);
    assert!(!w.players[&v].alive, "caught in the ignition");
    assert_eq!(w.players[&v].killed_by, Some(owner));
    assert!(w.players[&s].alive, "the shield takes it");
    assert!(w.players[&s].gassed_until > 0, "but not the slowdown");
    steps(&mut w, 5);
    assert_eq!(w.stats.gas_ignitions, 1, "only once");
}

#[test]
fn g08_no_second_hit_on_the_dead() {
    let (mut w, _) = gas_world();
    let (v, _) = spawn(&mut w, 4.5, 1.5);
    { let n = w.tuning.gas_fuse + 1; steps(&mut w, n); }
    // Fire right on the victim: killed by the bomb, then the gas ignites.
    w.place_bomb_at(0, (5, 1), BombKind::plain(1, 0));
    w.step();
    assert!(!w.players[&v].alive);
    assert_eq!(w.players[&v].deaths, 1, "one death, not two");
}

#[test]
fn gas_doesnt_go_through_portals_and_clouds_per_player_are_capped() {
    let mut w = world();
    let (id, _) = spawn(&mut w, 3.5, 1.5);
    w.grant_ability(id, Item::GasBomb);
    w.players.get_mut(&id).unwrap().gas_bombs = 3;
    for x in [3.5, 7.5, 11.5] {
        w.players.get_mut(&id).unwrap().x = x;
        w.players.get_mut(&id).unwrap().y = 1.5;
        assert!(w.place_bomb(id));
        w.players.get_mut(&id).unwrap().y = 9.5;
        { let n = w.tuning.gas_fuse; steps(&mut w, n); }
    }
    assert_eq!(w.gas.len(), 2, "maxActiveClouds: the oldest made room");
    assert!(w.gas.iter().all(|c| c.x != 3));
}

// -------------------------------------------------------------------- clone

/// A player who walked right along row 1 for `ticks` ticks.
fn walked(ticks: u64) -> (World, u32, mpsc::Receiver<Bytes>) {
    let mut w = world();
    let (id, rx) = spawn(&mut w, 1.5, 1.5);
    give(&mut w, id, Item::Clone, 2);
    w.hold(id, 2, 0);
    steps(&mut w, ticks);
    (w, id, rx)
}

#[test]
fn c01_c03_clone_replays_the_owner_from_two_seconds_ago() {
    let (mut w, id, mut rx) = walked(45);
    let delay = w.tuning.clone_delay;
    let past = w.players[&id].history.at(w.tick - delay).unwrap();
    w.use_ability(id);
    assert_eq!(w.clones.len(), 1);
    let c = &w.clones[0];
    assert_eq!((c.x, c.y), (past.x, past.y), "spawned where the owner was");
    assert!(ability_events(&mut rx).iter().any(|e| e.0 == ab::CLONE_SPAWNED));
    w.hold(id, 4, 0); // the owner turns back; the clone keeps the old path
    steps(&mut w, 5);
    let then = w.players[&id].history.at(w.tick - delay).unwrap();
    assert_eq!((w.clones[0].x, w.clones[0].y), (then.x, then.y));
    assert_eq!(w.clones[0].facing, 2);
}

#[test]
fn clone_is_announced_to_its_owner_only() {
    let (mut w, id, _rx) = walked(45);
    let (_enemy, mut enemy_rx) = spawn(&mut w, 3.5, 1.5);
    w.use_ability(id);
    assert_eq!(w.clones.len(), 1);
    let seen: Vec<i64> = ability_events(&mut enemy_rx).iter().map(|e| e.0).collect();
    assert!(!seen.contains(&ab::CLONE_SPAWNED) && !seen.contains(&ab::ACTIVATED), "{seen:?}");
}

#[test]
fn c02_not_enough_history() {
    let (mut w, id, mut rx) = walked(10);
    w.use_ability(id);
    assert!(w.clones.is_empty());
    assert_eq!(rejections(&mut rx), [reject::NO_HISTORY]);
    assert_eq!(w.players[&id].ability_n, 1, "the charge is kept");
}

#[test]
fn c04_old_spot_blocked() {
    let (mut w, id, mut rx) = walked(45);
    let f = w.players[&id].history.at(w.tick - w.tuning.clone_delay).unwrap();
    w.set_tile(f.x as i32, f.y as i32, Tile::Crate);
    w.use_ability(id);
    assert!(w.clones.is_empty());
    assert_eq!(rejections(&mut rx), [reject::NO_HISTORY]);
}

#[test]
fn c05_blast_destroys_the_clone() {
    let (mut w, id, _rx) = walked(45);
    w.use_ability(id);
    let (cx, cy) = (w.clones[0].x as i32, w.clones[0].y as i32);
    w.set_flame(cx, cy, 0, w.tick + 1, w.tick + 10);
    w.step();
    assert!(w.clones.is_empty());
    assert!(w.players[&id].alive, "the owner is elsewhere");
}

#[test]
fn c06_clone_picks_nothing_up() {
    let (mut w, id, _rx) = walked(45);
    w.use_ability(id);
    let cx = w.clones[0].x as i32;
    w.set_item(cx + 2, 1, Item::Range as u8);
    w.hold(id, 0, 0);
    let range = w.players[&id].range;
    steps(&mut w, 15);
    assert!(w.clones[0].x as i32 >= cx + 2, "the clone walked over it");
    assert_eq!(w.items[w.map.idx(cx + 2, 1)], Item::Range as u8);
    assert_eq!(w.players[&id].range, range);
}

#[test]
fn c07_one_clone_at_a_time() {
    let (mut w, id, mut rx) = walked(45);
    w.use_ability(id);
    w.players.get_mut(&id).unwrap().ability_n = 5;
    w.use_ability(id);
    assert_eq!(w.clones.len(), 1);
    assert_eq!(rejections(&mut rx), [reject::LIMIT]);
}

#[test]
fn c08_owner_dies_clone_goes() {
    let (mut w, id, _rx) = walked(45);
    w.use_ability(id);
    w.kill(id, None);
    assert!(w.clones.is_empty());
}

#[test]
fn clone_drops_decoys_and_respects_new_walls() {
    let mut w = world();
    let (id, _rx) = spawn(&mut w, 1.5, 1.5);
    give(&mut w, id, Item::Clone, 2);
    w.hold(id, 2, 0);
    steps(&mut w, 41);
    w.players[&id].link.as_ref().unwrap().input.press_bomb();
    steps(&mut w, 1);
    w.use_ability(id);
    let c0 = w.clones[0].x;
    // A wall right ahead of the clone's path.
    let wx = c0 as i32 + 1;
    w.set_tile(wx, 1, Tile::Crate);
    steps(&mut w, 30);
    assert!(w.clones.is_empty() || (w.clones[0].x as i32) < wx, "never walks into the crate");
    assert!(w.bombs.len() <= 1, "decoys aren't bombs");
}

// -------------------------------------------------------------- sticky bomb

/// A thrower at (1, 1) facing right with sticky bombs.
fn sticky_world() -> (World, u32) {
    let mut w = world();
    let (id, _) = spawn(&mut w, 1.5, 1.5);
    give(&mut w, id, Item::StickyBomb, 2);
    (w, id)
}

fn stuck(w: &World, target: u32) -> Option<u32> {
    w.sticky.iter().copied().find(|b| w.bombs.get(b).is_some_and(|b| b.attached == target))
}

#[test]
fn s01_sticks_to_an_enemy_in_the_path() {
    let (mut w, id) = sticky_world();
    let (e, mut re) = spawn(&mut w, 2.5, 1.5);
    assert!(w.place_bomb(id));
    let b = stuck(&w, e).expect("attached");
    assert_eq!(w.bombs[&b].owner, id, "the owner doesn't change");
    assert!(w.bomb_at(2, 1).is_none(), "off the grid while attached");
    assert_eq!(w.players[&id].sticky_bombs, 1);
    assert!(ability_events(&mut re).iter().any(|ev| ev.0 == ab::STICKY_ATTACHED));
}

#[test]
fn s02_not_to_a_teammate_or_the_thrower() {
    let (mut w, id) = sticky_world();
    let (mate, _) = spawn(&mut w, 2.5, 1.5);
    w.players.get_mut(&id).unwrap().team = 1;
    w.players.get_mut(&mate).unwrap().team = 1;
    assert!(w.place_bomb(id));
    assert!(stuck(&w, mate).is_none() && stuck(&w, id).is_none());
    assert!(w.bomb_at(3, 1).is_some(), "lands at the end of the throw");
}

#[test]
fn s03_rides_along() {
    let (mut w, id) = sticky_world();
    let (e, _) = spawn(&mut w, 2.5, 1.5);
    w.place_bomb(id);
    w.hold(e, 2, 0);
    steps(&mut w, 15);
    let b = stuck(&w, e).unwrap();
    assert_eq!((w.bombs[&b].x, w.bombs[&b].y), w.players[&e].cell());
    assert!(w.players[&e].x > 4.0);
}

#[test]
fn s04_s09_rides_through_portals_and_dashes() {
    let (mut w, id) = sticky_world();
    let (e, _) = spawn(&mut w, 2.5, 1.5);
    w.place_bomb(id);
    let b = stuck(&w, e).unwrap();
    // The carrier dashes down column 1, then walks into a portal.
    give(&mut w, e, Item::Dash, 3);
    w.players.get_mut(&e).unwrap().x = 1.5;
    w.players.get_mut(&e).unwrap().y = 3.5;
    w.use_ability(e);
    steps(&mut w, 4);
    assert_eq!(w.bombs[&b].attached, e, "still attached after the dash");
    let portal = (w.players[&e].cell().0, w.players[&e].cell().1 + 1);
    w.portals.push(portal::Portal { id: 900, owner: 99, x: portal.0, y: portal.1, partner: 901, until: u64::MAX });
    w.portals.push(portal::Portal { id: 901, owner: 99, x: 11, y: 1, partner: 900, until: u64::MAX });
    w.hold(e, 3, 0);
    steps(&mut w, 8);
    assert_eq!(w.players[&e].cell().1, 1, "teleported to row 1");
    assert_eq!(w.bombs[&b].attached, e);
    assert_eq!((w.bombs[&b].x, w.bombs[&b].y), w.players[&e].cell());
}

#[test]
fn s05_holding_the_detach_key_shakes_it_off() {
    let (mut w, id) = sticky_world();
    let (e, _) = spawn(&mut w, 2.5, 1.5);
    w.place_bomb(id);
    w.players.get_mut(&id).unwrap().y = 9.5;
    let b = stuck(&w, e).unwrap();
    let at = w.bombs[&b].explode_at;
    w.players[&e].link.as_ref().unwrap().input.set_input(0, 0, false, true, 0);
    { let n = w.tuning.detach_ticks - 1; steps(&mut w, n); }
    assert_eq!(w.bombs[&b].attached, e, "not yet");
    w.step();
    assert_eq!(w.bombs[&b].attached, 0);
    assert_eq!(w.bomb_at(2, 1), Some(b), "dropped where the carrier stands");
    assert_eq!(w.bombs[&b].explode_at, at, "the fuse keeps running");
}

#[test]
fn s06_blast_during_the_detach() {
    let (mut w, id) = sticky_world();
    let (e, _) = spawn(&mut w, 2.5, 1.5);
    w.place_bomb(id);
    w.players.get_mut(&id).unwrap().y = 9.5;
    w.players[&e].link.as_ref().unwrap().input.set_input(0, 0, false, true, 0);
    { let n = w.tuning.sticky_fuse; steps(&mut w, n); }
    assert!(w.bombs.is_empty(), "the fuse ran out first ({} < {})", w.tuning.sticky_fuse, w.tuning.detach_ticks * 4);
    assert!(!w.players[&e].alive);
    assert_eq!(w.players[&e].detach_ticks, 0);
}

#[test]
fn s06b_the_fuse_wins_a_late_detach() {
    let (mut w, id) = sticky_world();
    let (e, _) = spawn(&mut w, 2.5, 1.5);
    w.place_bomb(id);
    w.players.get_mut(&id).unwrap().y = 9.5;
    { let n = w.tuning.sticky_fuse - 5; steps(&mut w, n); }
    w.players[&e].link.as_ref().unwrap().input.set_input(0, 0, false, true, 0);
    steps(&mut w, 5);
    assert!(w.bombs.is_empty() && !w.players[&e].alive, "exploded mid-detach");
}

#[test]
fn s07_carrier_dies_bomb_falls_off() {
    let (mut w, id) = sticky_world();
    let (e, _) = spawn(&mut w, 2.5, 1.5);
    w.place_bomb(id);
    let b = stuck(&w, e).unwrap();
    w.kill(e, None);
    w.step();
    assert_eq!(w.bombs[&b].attached, 0);
    assert_eq!(w.bomb_at(2, 1), Some(b));
}

#[test]
fn s08_one_bomb_per_target() {
    let (mut w, id) = sticky_world();
    let (e, _) = spawn(&mut w, 3.5, 1.5);
    w.players.get_mut(&id).unwrap().max_bombs = 3;
    assert!(w.place_bomb(id));
    w.players.get_mut(&id).unwrap().x = 1.6;
    w.step();
    assert!(w.place_bomb(id));
    assert_eq!(w.stuck_on(e), 1);
    assert_eq!(w.bombs.len(), 2, "the second one lands instead");
}

#[test]
fn walking_into_a_sticky_bomb_picks_it_up() {
    let (mut w, id) = sticky_world();
    w.players.get_mut(&id).unwrap().facing = 1; // the border above: lands at the feet
    assert!(w.place_bomb(id));
    w.players.get_mut(&id).unwrap().y = 9.5;
    let (e, _) = spawn(&mut w, 3.5, 1.5);
    w.hold(e, 4, 0);
    steps(&mut w, 15);
    assert_eq!(w.stuck_on(e), 1);
}

// ------------------------------------------------------------- portal pair

/// A player at (1, 1) facing right with the portal ability.
fn portal_world() -> (World, u32, mpsc::Receiver<Bytes>) {
    let mut w = world();
    let (id, rx) = spawn(&mut w, 1.5, 1.5);
    give(&mut w, id, Item::PortalPair, 2);
    (w, id, rx)
}

/// Places a pair: one at (4, 1), one at (1, 4) (three cells ahead each).
fn place_pair(w: &mut World, id: u32) {
    w.use_ability(id);
    w.players.get_mut(&id).unwrap().facing = 3;
    w.use_ability(id);
    w.players.get_mut(&id).unwrap().portal_lock = None;
}

#[test]
fn p01_p02_waiting_then_linked() {
    let (mut w, id, mut rx) = portal_world();
    w.use_ability(id);
    assert_eq!(w.portals.len(), 1);
    assert!(!w.portals[0].active());
    assert_eq!((w.portals[0].x, w.portals[0].y), (4, 1), "three cells ahead");
    assert_eq!(w.players[&id].ability_n, 1, "nothing spent yet");
    w.players.get_mut(&id).unwrap().facing = 3;
    w.use_ability(id);
    assert!(w.portals.iter().all(portal::Portal::active));
    assert_eq!(w.players[&id].ability_n, 0, "spent on the full pair");
    assert!(w.players[&id].ability_recharge_at > 0);
    let kinds: Vec<i64> = ability_events(&mut rx).iter().map(|e| e.0).collect();
    assert!(kinds.contains(&ab::PORTAL_LINKED));
}

#[test]
fn p03_p04_trip_and_no_loop_back() {
    let (mut w, id, _rx) = portal_world();
    place_pair(&mut w, id);
    w.hold(id, 2, 0);
    steps(&mut w, 20);
    w.hold(id, 0, 0);
    // Went in at (4, 1), came out at (1, 4).
    assert_eq!(w.players[&id].cell(), (1, 4));
    assert_eq!(w.stats.teleports, 1);
    steps(&mut w, 40);
    assert_eq!(w.players[&id].cell(), (1, 4), "standing on the exit doesn't bounce back");
    assert_eq!(w.stats.teleports, 1);
}

#[test]
fn p05_blocked_exit_refuses_the_trip() {
    let (mut w, id, _rx) = portal_world();
    place_pair(&mut w, id);
    w.place_bomb_at(0, (1, 4), BombKind::plain(1, 1000));
    w.hold(id, 2, 0);
    steps(&mut w, 15);
    assert_eq!(w.players[&id].cell(), (4, 1), "stays at the entrance");
    assert_eq!(w.players[&id].portal_ready_at, 0, "no cooldown");
    assert_eq!(w.stats.teleports, 0);
}

#[test]
fn p05b_exit_in_a_nukes_red_zone_refuses_the_trip() {
    let (mut w, id, _rx) = portal_world();
    place_pair(&mut w, id);
    let nuke = BombKind { pierce: true, nuke: true, ..BombKind::plain(super::bomb::NUKE_RADIUS, 1000) };
    w.place_bomb_at(0, (1, 10), nuke); // 6 cells below the exit at (1, 4)
    assert!(w.in_nuke_zone(1, 4) && !w.in_nuke_zone(4, 1));
    w.hold(id, 2, 0);
    steps(&mut w, 15);
    assert_eq!(w.players[&id].cell(), (4, 1), "stays at the entrance");
    assert_eq!(w.players[&id].portal_ready_at, 0, "no cooldown");
    assert_eq!(w.stats.teleports, 0);
}

#[test]
fn p05c_exit_on_fire_refuses_the_trip() {
    let (mut w, id, _rx) = portal_world();
    place_pair(&mut w, id);
    let t = w.tick;
    w.set_flame(1, 4, 0, t, t + 1000);
    w.hold(id, 2, 0);
    steps(&mut w, 15);
    assert_eq!(w.players[&id].cell(), (4, 1), "stays at the entrance");
    assert!(w.players[&id].alive);
    assert_eq!(w.stats.teleports, 0);
}

#[test]
fn p06_bombs_go_through_keeping_fuse_and_owner() {
    let (mut w, id, _rx) = portal_world();
    place_pair(&mut w, id);
    let (k, _) = spawn(&mut w, 7.5, 1.5);
    w.place_bomb_at(k, (6, 1), BombKind::plain(2, 200));
    let b = w.bomb_at(6, 1).unwrap();
    let at = w.bombs[&b].explode_at;
    w.players.get_mut(&id).unwrap().y = 9.5;
    w.kick_bomb(b, 4);
    steps(&mut w, 8);
    let bomb = &w.bombs[&b];
    assert_eq!(bomb.x, 1, "came out of the portal at (1, 4) and slid on down");
    assert!(bomb.y >= 4);
    assert_eq!((bomb.owner, bomb.explode_at), (k, at));
}

#[test]
fn p07_blasts_dont_travel_through() {
    let (mut w, id, _rx) = portal_world();
    place_pair(&mut w, id);
    w.players.get_mut(&id).unwrap().y = 9.5;
    w.place_bomb_at(0, (3, 1), BombKind::plain(2, 0));
    w.step();
    assert!(w.flame_active(4, 1));
    assert!(!w.flame_active(1, 4) && !w.flame_active(1, 5), "nothing at the other end");
}

#[test]
fn p08_p09_pair_expires_or_dies_with_its_owner() {
    let (mut w, id, _rx) = portal_world();
    place_pair(&mut w, id);
    { let n = w.tuning.portal_ticks; steps(&mut w, n); }
    assert!(w.portals.is_empty(), "expired");
    w.players.get_mut(&id).unwrap().ability_n = 1;
    w.players.get_mut(&id).unwrap().facing = 2;
    place_pair(&mut w, id);
    assert_eq!(w.portals.len(), 2);
    w.kill(id, None);
    assert!(w.portals.is_empty(), "owner died");
}

#[test]
fn p10_simultaneous_entries_never_stack() {
    let (mut w, id, _rx) = portal_world();
    place_pair(&mut w, id);
    w.players.get_mut(&id).unwrap().y = 9.5;
    w.players.get_mut(&id).unwrap().x = 9.5;
    // Two players reach the same portal in the same tick: whoever is
    // processed first takes the exit, the other finds it occupied.
    let (a, _) = spawn(&mut w, 3.5, 1.5);
    let (b, _) = spawn(&mut w, 5.5, 1.5);
    w.hold(a, 2, 0);
    w.hold(b, 4, 0);
    steps(&mut w, 6);
    w.hold(a, 0, 0);
    w.hold(b, 0, 0);
    steps(&mut w, 20);
    assert_eq!(w.players[&a].cell(), (1, 4));
    assert_eq!(w.players[&b].cell(), (4, 1), "waits at the entrance");
    assert_eq!(w.stats.teleports, 1, "one went, one was blocked");
    // Opposite trips at once: each exit is the other's entrance, both
    // blocked, nobody overlaps.
    w.hold(a, 1, 0);
    steps(&mut w, 30);
    assert_ne!(w.players[&a].cell(), w.players[&b].cell());
}

#[test]
fn portal_placement_rules_and_cancel() {
    let (mut w, id, _rx) = portal_world();
    w.use_ability(id);
    w.cancel_ability(id);
    assert!(w.portals.is_empty(), "cancelled");
    w.use_ability(id);
    { let n = w.tuning.portal_timeout; steps(&mut w, n); }
    assert!(w.portals.is_empty(), "the lone portal timed out");
    assert_eq!(w.players[&id].ability_n, 1, "nothing spent");
    // Not on a wall: the builder's wall cuts the line short.
    give(&mut w, id, Item::Builder, 2);
    w.use_ability(id); // wall at (2, 1)
    give(&mut w, id, Item::PortalPair, 2);
    w.use_ability(id);
    assert_eq!((w.portals[0].x, w.portals[0].y), (1, 1), "only the own cell is left");
}

// ------------------------------------------------------------------- dash

fn dash_world() -> (World, u32, mpsc::Receiver<Bytes>) {
    let mut w = world();
    let (id, rx) = spawn(&mut w, 1.5, 1.5);
    give(&mut w, id, Item::Dash, 2);
    (w, id, rx)
}

#[test]
fn d01_full_distance_on_a_clear_line() {
    let (mut w, id, mut rx) = dash_world();
    w.use_ability(id);
    { let n = w.tuning.dash_ticks; steps(&mut w, n); }
    assert!((w.players[&id].x - 4.0).abs() < 1e-3, "2.5 cells: {}", w.players[&id].x);
    assert!(!w.players[&id].dashing());
    let kinds: Vec<i64> = ability_events(&mut rx).iter().map(|e| e.0).collect();
    assert!(kinds.contains(&ab::DASH_STARTED) && kinds.contains(&ab::DASH_ENDED));
}

#[test]
fn d02_stops_before_a_wall() {
    let (mut w, id, _rx) = dash_world();
    w.set_tile(3, 1, Tile::Built);
    w.use_ability(id);
    steps(&mut w, 4);
    assert!(w.players[&id].x <= 2.5 + 1e-4, "{}", w.players[&id].x);
}

#[test]
fn d03_stays_on_the_map() {
    let (mut w, id, _rx) = dash_world();
    w.players.get_mut(&id).unwrap().x = 12.5;
    w.use_ability(id);
    steps(&mut w, 4);
    assert!((w.players[&id].x - 13.5).abs() < 1e-4);
}

#[test]
fn d04_fire_on_the_way_hurts() {
    let (mut w, id, _rx) = dash_world();
    // Fire in (3, 1) only, which the dash passes through without stopping.
    w.set_flame(3, 1, 0, 0, 1000);
    w.use_ability(id);
    steps(&mut w, 4);
    assert!(!w.players[&id].alive);
}

#[test]
fn d05_gas_on_the_way_clings() {
    let (mut w, id, _rx) = dash_world();
    w.gas.push(gas::GasCloud { id: 77, owner: 0, team: 0, x: 3, y: 1, arms: [0; 4], cells: vec![(3, 1)], born: 0, until: u64::MAX });
    w.use_ability(id);
    steps(&mut w, 4);
    assert!(w.players[&id].gassed_until > w.tick);
}

#[test]
fn d06_one_portal_per_dash() {
    let (mut w, id, _rx) = dash_world();
    w.portals.push(portal::Portal { id: 900, owner: 99, x: 2, y: 1, partner: 901, until: u64::MAX });
    w.portals.push(portal::Portal { id: 901, owner: 99, x: 9, y: 1, partner: 900, until: u64::MAX });
    w.use_ability(id);
    steps(&mut w, 4);
    assert_eq!(w.stats.teleports, 1);
    assert!(w.players[&id].x > 9.0, "kept going after the exit: {}", w.players[&id].x);
}

#[test]
fn d07_d08_refused_while_recharging_or_stunned() {
    let (mut w, id, mut rx) = dash_world();
    w.players.get_mut(&id).unwrap().ability_max = 1;
    w.players.get_mut(&id).unwrap().ability_n = 1;
    w.use_ability(id);
    steps(&mut w, 4);
    w.use_ability(id);
    w.players.get_mut(&id).unwrap().ability_n = 1;
    w.players.get_mut(&id).unwrap().stunned_until = w.tick + 10;
    w.use_ability(id);
    assert_eq!(rejections(&mut rx), [reject::NO_CHARGE, reject::STATE]);
    // The charge comes back after the cooldown.
    w.players.get_mut(&id).unwrap().ability_n = 0;
    w.players.get_mut(&id).unwrap().stunned_until = 0;
    let at = w.players[&id].ability_recharge_at;
    { let n = at - w.tick; steps(&mut w, n); }
    assert_eq!(w.players[&id].ability_n, 1);
}

#[test]
fn dash_doesnt_change_direction_and_gives_no_shield() {
    let (mut w, id, _rx) = dash_world();
    w.use_ability(id);
    w.hold(id, 3, 0);
    steps(&mut w, 4);
    assert!((w.players[&id].y - 1.5).abs() < 1e-4, "kept its direction");
    assert_eq!(w.players[&id].invulnerable_until, 0);
}

// --------------------------------------------------------- network, system

#[test]
fn n01_repeated_presses_in_one_tick_act_once() {
    let mut w = world();
    let (id, _rx) = spawn(&mut w, 3.5, 1.5);
    give(&mut w, id, Item::Builder, 2);
    let input = w.players[&id].link.as_ref().unwrap().input.clone();
    input.press_ability();
    input.press_ability();
    w.step();
    assert_eq!(w.walls.len(), 1);
    w.step(); // the same count read again does nothing
    assert_eq!(w.players[&id].ability_n, 1);
}

#[test]
fn n04_n05_dead_players_and_missing_abilities() {
    let mut w = world();
    let (id, mut rx) = spawn(&mut w, 3.5, 1.5);
    w.use_ability(id);
    assert!(rejections(&mut rx).is_empty(), "nothing held: silently ignored");
    give(&mut w, id, Item::Builder, 2);
    w.kill(id, None);
    w.players.get_mut(&id).unwrap().ability = Item::Builder as u8;
    w.players.get_mut(&id).unwrap().ability_n = 1;
    w.use_ability(id);
    assert!(w.walls.is_empty());
    assert_eq!(rejections(&mut rx), [reject::STATE]);
    // An opcode the server doesn't know is dropped by the decoder.
    assert_eq!(protocol::ClientMsg::decode(&[42]), None);
}

#[test]
fn n06_commands_carry_no_player_id() {
    // The ability command is a bare opcode: the player is always the
    // connection's own, so there's nothing to forge.
    assert_eq!(&protocol::ClientMsg::Ability.encode()[..], [protocol::cop::ABILITY]);
    assert_eq!(&protocol::ClientMsg::Cancel.encode()[..], [protocol::cop::CANCEL]);
}

#[test]
fn n07_object_ids_never_collide() {
    let mut w = world();
    let (id, _rx) = spawn(&mut w, 3.5, 1.5);
    give(&mut w, id, Item::Builder, 2);
    w.place_bomb_at(0, (5, 1), BombKind::plain(2, 50));
    w.use_ability(id);
    let wall = w.walls[0].id;
    assert!(!w.bombs.contains_key(&wall), "walls, clouds, clones, portals and bombs share one id sequence");
}

/// Plays the same scripted match in a fresh world.
fn scripted() -> World {
    let mut w = test_world(Map::empty(21, 21));
    let (a, _) = spawn(&mut w, 1.5, 1.5);
    let (b, _) = spawn(&mut w, 9.5, 1.5);
    let (c, _) = spawn(&mut w, 1.5, 9.5);
    w.grant_ability(a, Item::Dash);
    w.grant_ability(b, Item::GasBomb);
    w.grant_ability(c, Item::StickyBomb);
    for t in 0..120u64 {
        let input = |id: u32| w.players[&id].link.as_ref().unwrap().input.clone();
        input(a).set_dirs([2, 3, 4, 1][(t / 15 % 4) as usize], 0, false, 0);
        input(b).set_dirs([4, 2][(t / 20 % 2) as usize], 0, false, 0);
        input(c).set_dirs([1, 3][(t / 25 % 2) as usize], 0, false, 0);
        if t % 30 == 5 {
            input(a).press_ability();
            input(b).press_bomb();
            input(c).press_bomb();
        }
        w.step();
    }
    w
}

#[test]
fn n08_same_commands_same_outcome() {
    let (x, y) = (scripted(), scripted());
    let state = |w: &World| {
        let mut ps: Vec<_> = w.players.values().map(|p| (p.id, p.x.to_bits(), p.y.to_bits(), p.alive, p.deaths)).collect();
        ps.sort_unstable();
        let mut bs: Vec<_> = w.bombs.values().map(|b| (b.id, b.x, b.y, b.attached, b.explode_at)).collect();
        bs.sort_unstable();
        let gas: Vec<_> = w.gas.iter().map(|c| (c.id, c.x, c.y)).collect();
        (ps, bs, gas, w.stats.dashes, w.stats.sticky_attached)
    };
    assert_eq!(state(&x), state(&y));
}

#[test]
fn n09_round_end_clears_everything() {
    let mut w = world();
    let (a, _) = spawn(&mut w, 3.5, 1.5);
    give(&mut w, a, Item::Builder, 2);
    w.use_ability(a);
    give(&mut w, a, Item::PortalPair, 4);
    w.use_ability(a); // left waiting
    w.gas.push(gas::GasCloud { id: 77, owner: a, team: 0, x: 9, y: 1, arms: [0; 4], cells: vec![(9, 1)], born: 0, until: u64::MAX });
    w.clones.push(clone::Clone { id: 78, owner: a, x: 5.5, y: 1.5, facing: 2, flags: 0, delay: 40, until: u64::MAX });
    w.players.get_mut(&a).unwrap().ability_n = 0;
    w.round_end = w.tick + 1;
    w.step();
    assert!(w.walls.is_empty() && w.gas.is_empty() && w.clones.is_empty() && w.portals.is_empty());
    assert_eq!(w.map.get(4, 1), Tile::Floor);
    assert_eq!(w.players[&a].ability_n, w.players[&a].ability_max, "cooldowns reset");
}

#[test]
fn n10_snapshot_carries_ability_state_and_objects() {
    let mut w = world();
    let (a, _) = spawn(&mut w, 1.5, 1.5);
    let (e, _) = spawn(&mut w, 2.5, 1.5);
    give(&mut w, a, Item::StickyBomb, 2);
    w.place_bomb(a);
    give(&mut w, a, Item::PortalPair, 2);
    w.players.get_mut(&a).unwrap().facing = 3;
    w.use_ability(a);
    w.gas.push(gas::GasCloud { id: 77, owner: a, team: 0, x: 9, y: 1, arms: [0, 2, 0, 1], cells: vec![(9, 1)], born: 0, until: 40 });
    w.clones.push(clone::Clone { id: 78, owner: a, x: 5.5, y: 1.5, facing: 2, flags: 1, delay: 40, until: 100 });
    let snap = w.full_snapshot(a);
    let me = |k: &str| snap["me"][protocol::ME_FIELDS.iter().position(|f| *f == k).unwrap()].as_i64().unwrap();
    assert_eq!(me("ability"), i64::from(Item::PortalPair as u8));
    assert_eq!(me("ability_n"), 1);
    assert!(me("portal_wait") > 0);
    assert_eq!(me("sticky_bombs"), 1, "bomb modifiers stay when an active ability is picked up");
    let x = &snap["x"];
    assert_eq!(x["gas"][0], serde_json::json!([77, 9, 1, [0, 2, 0, 1], 40]));
    let portal = &x["portals"][0];
    assert_eq!([&portal[1], &portal[2], &portal[3], &portal[4]], [&serde_json::json!(1), &serde_json::json!(4), &serde_json::json!(a), &serde_json::json!(0)]);
    assert_eq!(x["clones"][0], serde_json::json!([78, a, 550, 150, 2 | 1 << 3]));
    assert_eq!(x["stuck"][0][1], serde_json::json!(e));
    let bomb = &snap["b"][0];
    assert_eq!(bomb[4].as_u64().unwrap() & 64, 64, "flagged sticky");
    let es = w.full_snapshot(e);
    let them = |k: &str| es["me"][protocol::ME_FIELDS.iter().position(|f| *f == k).unwrap()].as_i64().unwrap();
    assert_eq!(them("stuck"), w.tuning.sticky_fuse as i64 + 1);
}

#[test]
fn disabled_abilities_never_drop_and_cant_be_used() {
    let mut cfg = ability_config::Abilities::default();
    cfg.dash.enabled = false;
    let mut w = world();
    w.tuning = std::sync::Arc::new(ability_config::Tuning::from_abilities(cfg).unwrap());
    for _ in 0..3000 {
        if let Some(i) = Item::crate_drop(&mut w.rng, |i| w.tuning.item_enabled(i)) {
            assert_ne!(i, Item::Dash);
        }
    }
    let (id, mut rx) = spawn(&mut w, 1.5, 1.5);
    give(&mut w, id, Item::Dash, 2);
    w.use_ability(id);
    assert_eq!(rejections(&mut rx), [reject::DISABLED]);
    assert_eq!(w.ability_info().disabled, [Item::Dash as u8]);
}

#[test]
fn picking_up_abilities_replaces_or_refills() {
    let mut w = world();
    let (id, _rx) = spawn(&mut w, 1.5, 1.5);
    w.grant_ability(id, Item::GasBomb);
    w.grant_ability(id, Item::StickyBomb);
    let p = &w.players[&id];
    assert_eq!((p.gas_bombs, p.sticky_bombs), (0, 2), "bomb modifiers are exclusive");
    w.grant_ability(id, Item::Builder);
    w.players.get_mut(&id).unwrap().ability_n = 0;
    w.grant_ability(id, Item::Builder);
    assert_eq!(w.players[&id].ability_n, 2, "refilled");
    w.grant_ability(id, Item::Dash);
    assert_eq!(w.players[&id].ability, Item::Dash as u8);
    // Death drops the ability like other power-ups.
    w.kill(id, None);
    assert_eq!((w.players[&id].ability, w.players[&id].sticky_bombs), (0, 0));
}
