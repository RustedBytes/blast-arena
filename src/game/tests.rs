use tokio::sync::mpsc;

use crate::protocol;

use super::player::{AOI_DEFAULT, AOI_MAX};
use super::*;

#[test]
fn aoi_only_includes_nearby_players() {
    let mut w = test_world(Map::empty(81, 81));
    let me = w.spawn_test_player(10.5, 10.5);
    let near = w.spawn_test_player(20.5, 15.5);
    let far = w.spawn_test_player(60.5, 60.5);
    let (x0, y0, x1, y1) = aoi_rect(10, 10, AOI_DEFAULT);
    let ids: Vec<u32> = w.players_in_rect(x0, y0, x1, y1).map(|p| p.id).collect();
    assert!(ids.contains(&me) && ids.contains(&near));
    assert!(!ids.contains(&far));
    let snap: serde_json::Value = w.full_snapshot(me);
    assert_eq!(snap["t"], "s");
    let seen: Vec<u64> = snap["p"].as_array().unwrap().iter().map(|p| p[0].as_u64().unwrap()).collect();
    assert!(seen.contains(&u64::from(me)) && seen.contains(&u64::from(near)));
    assert!(!seen.contains(&u64::from(far)));
}

#[test]
fn snapshot_carries_atomic_bombs_and_blasts() {
    let mut w = test_world(Map::empty(21, 21));
    let me = w.spawn_test_player(7.5, 7.5);
    World::grant(w.players.get_mut(&me).unwrap(), Item::Nuke, 0);
    let snap: serde_json::Value = w.full_snapshot(me);
    assert_eq!(me_obj(&snap)["nukes"], 1);
    w.place_bomb(me);
    let snap: serde_json::Value = w.full_snapshot(me);
    assert_eq!(snap["b"][0][4].as_u64().unwrap() & 4, 4, "flag bit 2 marks a nuke");
    assert_eq!(me_obj(&snap)["nukes"], 0);
    w.explode(w.bomb_at(7, 7).unwrap());
    let snap: serde_json::Value = w.full_snapshot(me);
    assert_eq!(snap["e"][0], serde_json::json!([7, 7, [0, 0, 0, 0], bomb::NUKE_SHOW_TICKS, bomb::NUKE_RADIUS]));
}

#[test]
fn snapshot_has_every_field() {
    let mut map = Map::empty(21, 21);
    map.set(5, 5, Tile::Crate);
    let mut w = test_world(map);
    let me = w.spawn_test_player(3.5, 3.5);
    w.place_bomb(me);
    w.set_item(3, 5, Item::Mystery as u8);
    w.set_tile(5, 5, Tile::Floor);
    let snap: serde_json::Value = w.full_snapshot(me);
    assert_eq!(snap["k"], 0);
    assert_eq!(snap["p"][0], serde_json::json!([me, 350, 350, 3, 0]));
    assert_eq!(snap["b"][0], serde_json::json!([1, 3, 3, bomb::FUSE_TICKS, 0]));
    assert_eq!(snap["e"], serde_json::json!([]));
    assert!(snap.get("i").is_none() && snap.get("tc").is_none(), "static changes go through the world stream");
    assert_eq!(w.item_changes, vec![(3, 5, 8)]);
    assert_eq!(w.tile_changes, vec![(5, 5, 0)]);
    assert_eq!(snap["me"].as_array().unwrap().len(), protocol::ME_FIELDS.len());
    let me_v = &me_obj(&snap);
    assert_eq!(me_v["alive"], 1);
    assert_eq!(me_v["active"], 1);
    assert_eq!(me_v["killer"], 0, "nobody (ids are sent + 1)");
    assert_eq!((&me_v["aoi_w"], &me_v["aoi_h"]), (&serde_json::json!(AOI_DEFAULT.0), &serde_json::json!(AOI_DEFAULT.1)));
    assert_eq!(me_v["ack"], 0);
    assert_eq!(me_v["spec"], 0);
    assert_eq!(me_v.as_object().unwrap().len(), protocol::ME_LEN, "every field named");
}

#[test]
fn view_requests_are_clamped() {
    let mut w = test_world(Map::empty(81, 81));
    let me = w.spawn_test_player(40.5, 40.5);
    let input = w.players[&me].link.as_ref().unwrap().input.clone();
    input.set_view(100, 100);
    w.step();
    assert_eq!(w.players[&me].aoi, AOI_MAX);
    input.set_view(1, 1);
    w.step();
    assert_eq!(w.players[&me].aoi, player::AOI_MIN);
    input.set_view(20, 14);
    w.step();
    assert_eq!(w.players[&me].aoi, (20, 14));
}

#[test]
fn turn_buffering_takes_the_turn_when_it_opens() {
    // Corridor along row 1; column 3 opens downwards at (3,2).
    let mut w = test_world(Map::empty(15, 15));
    let id = w.spawn_test_player(1.5, 1.5);
    // At (2,1) the pillar (2,2) blocks the way down. Just right of the
    // cell centre, too little to trigger corner assist.
    w.players.get_mut(&id).unwrap().x = 2.6;
    w.hold(id, 3, 2); // newest: down, still held: right
    w.step();
    assert!(w.players[&id].x > 2.6, "keeps going right while down is blocked");
    for _ in 0..20 {
        w.step();
    }
    let p = &w.players[&id];
    assert_eq!(p.cell().0, 3, "turned down at the first opening");
    assert!(p.y > 2.0, "and went down: y = {}", p.y);
}

#[test]
fn shield_blocks_flames() {
    let mut w = test_world(Map::empty(15, 15));
    let me = w.spawn_test_player(1.5, 1.5);
    let i = w.map.idx(1, 1);
    w.items[i] = Item::Shield as u8;
    w.step(); // picks up the shield
    assert!(w.players[&me].invulnerable_until > w.tick);
    w.place_bomb(me);
    for _ in 0..bomb::FUSE_TICKS + 2 {
        w.step();
    }
    assert!(w.players[&me].alive, "shielded player survives their own bomb");
    assert_eq!(w.stats.deaths, 0);
}

#[test]
fn secret_box_gives_something_and_reports_it() {
    let mut w = test_world(Map::empty(15, 15));
    let (link, mut rx) = test_link();
    let id = w.join(plain_join("opener"), link).unwrap();
    let p = w.players.get_mut(&id).unwrap();
    (p.x, p.y) = (1.5, 1.5);
    let i = w.map.idx(1, 1);
    w.items[i] = Item::Mystery as u8;
    w.step();
    assert_eq!(w.items[i], 0);
    assert_eq!(w.stats.mysteries_opened, 1);
    let mut got_fx = false;
    while let Ok(msg) = rx.try_recv() {
        let v = protocol::testing::decode(&msg);
        if v["t"] == "fx" {
            assert_eq!(v["m"], true);
            got_fx = true;
        }
    }
    assert!(got_fx, "player is told what the box contained");
}

#[test]
fn slow_curse_slows_then_wears_off() {
    let mut w = test_world(Map::empty(15, 15));
    let id = w.spawn_test_player(1.5, 1.5);
    let normal = w.players[&id].speed(w.tick);
    w.players.get_mut(&id).unwrap().slow_until = w.tick + 5;
    assert!(w.players[&id].speed(w.tick) < normal);
    assert_eq!(w.players[&id].curse(w.tick).0, 1);
    assert_eq!(w.players[&id].speed(w.tick + 5), normal);
}

#[test]
fn owner_can_walk_off_own_bomb_but_not_back() {
    let mut w = test_world(Map::empty(15, 15));
    let id = w.spawn_test_player(1.5, 1.5);
    w.place_bomb(id);
    w.hold(id, 2, 0);
    for _ in 0..10 {
        w.step();
    }
    let x = w.players[&id].x;
    assert!(x > 2.0, "walked off the bomb, x = {x}");
    w.hold(id, 4, 0);
    for _ in 0..10 {
        w.step();
    }
    assert!(w.players[&id].x >= 2.5 - 1e-4, "bomb blocks the way back");
}

#[test]
fn flames_kill_and_credit_owner() {
    let mut w = test_world(Map::empty(15, 15));
    let a = w.spawn_test_player(1.5, 1.5);
    let b = w.spawn_test_player(3.5, 1.5);
    w.place_bomb(a);
    w.players.get_mut(&a).unwrap().x = 3.5;
    w.players.get_mut(&a).unwrap().y = 3.5; // hide around the corner
    for _ in 0..=bomb::FUSE_TICKS {
        w.step();
    }
    assert!(!w.players[&b].alive);
    assert!(w.players[&a].alive);
    assert_eq!(w.players[&a].score, 1);
    for _ in 0..=RESPAWN_TICKS {
        w.step();
    }
    assert!(w.players[&b].alive, "respawned");
}

#[test]
fn trapped_player_can_kick_without_power_up() {
    // Player at (3,2): pillars at (2,2)/(4,2), crate above, bomb below.
    let mut map = Map::empty(15, 15);
    map.set(3, 1, Tile::Crate);
    let mut w = test_world(map);
    let other = w.spawn_test_player(3.5, 3.5);
    w.place_bomb(other);
    w.players.get_mut(&other).unwrap().x = 9.5;
    let me = w.spawn_test_player(3.5, 2.5);
    assert!(!w.players[&me].kick);
    w.hold(me, 3, 0);
    w.step();
    let bid = w.bomb_at(3, 3).expect("bomb still in place before sliding");
    assert_eq!(w.bombs[&bid].slide_dir, 3, "trapped player kicked the bomb");
    for _ in 0..10 {
        w.step();
    }
    assert!(w.bomb_at(3, 3).is_none(), "bomb slid away, freeing the player");
}

#[test]
fn free_player_cannot_kick_without_power_up() {
    let mut w = test_world(Map::empty(15, 15));
    let other = w.spawn_test_player(1.5, 2.5);
    w.place_bomb(other);
    w.players.get_mut(&other).unwrap().x = 5.5;
    let me = w.spawn_test_player(1.5, 3.5); // (1,4) below is open
    w.hold(me, 1, 0);
    w.step();
    let bid = w.bomb_at(1, 2).unwrap();
    assert_eq!(w.bombs[&bid].slide_dir, 0);
}

#[test]
fn humans_take_a_bots_place_when_full() {
    let mut w = World::with_map(Map::empty(21, 21), Rng::new(5), 3);
    w.set_target_bots(3);
    assert_eq!((w.players.len(), w.bots.len()), (3, 3));

    let (link, _rx) = test_link();
    assert!(w.join(plain_join("human"), link).is_ok(), "a bot makes room");
    assert_eq!((w.players.len(), w.bots.len()), (3, 2));
    for _ in 0..TICK_RATE * 2 {
        w.step();
    }
    assert_eq!(w.players.len(), 3, "bots don't refill past the cap");

    let (link, _rx2) = test_link();
    let human = w.join(plain_join("human2"), link).unwrap();
    w.leave(human);
    for _ in 0..TICK_RATE {
        w.step();
    }
    assert_eq!(w.bots.len(), 2, "bots refill once there's room");
}

#[test]
fn picking_up_items_upgrades_stats() {
    let mut w = test_world(Map::empty(15, 15));
    let id = w.spawn_test_player(1.5, 1.5);
    let i = w.map.idx(2, 1);
    w.items[i] = Item::Range as u8;
    w.hold(id, 2, 0);
    for _ in 0..5 {
        w.step();
    }
    assert_eq!(w.players[&id].range, player::BASE_RANGE + 1);
    assert_eq!(w.items[i], 0);
}

#[test]
fn slow_clients_skip_snapshots_instead_of_dropping() {
    let mut w = test_world(Map::empty(15, 15));
    let (link, _rx) = test_link();
    let id = w.join(plain_join("slow"), link).unwrap();
    // The client never reads anything; snapshots just keep replacing
    // each other, and only the bounded event queue can overflow.
    for _ in 0..30 {
        w.step();
        w.send_updates();
    }
    assert_eq!(w.dropped_clients().len(), 0, "nobody is dropped");
    assert!(w.players.contains_key(&id));
}

/// The positional `me` array of a snapshot as a named object.
fn me_obj(snap: &serde_json::Value) -> serde_json::Value {
    let values = snap["me"].as_array().unwrap();
    protocol::ME_FIELDS.iter().zip(values).map(|(k, v)| (k.to_string(), v.clone())).collect::<serde_json::Map<_, _>>().into()
}

/// Messages a client received, decoded.
fn drain(rx: &mut mpsc::Receiver<Bytes>) -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    while let Ok(m) = rx.try_recv() {
        out.push(protocol::testing::decode(&m));
    }
    out
}

fn joined(w: &mut World, name: &str) -> (u32, mpsc::Receiver<Bytes>) {
    let (link, rx) = test_link();
    let id = w.join(plain_join(name), link).unwrap();
    (id, rx)
}

#[test]
fn rounds_end_with_mvp_and_reset_scores() {
    let mut w = test_world(Map::empty(31, 31));
    w.round_ticks = 40;
    w.round_end = 40;
    let (a, mut rx) = joined(&mut w, "a");
    w.players.get_mut(&a).unwrap().score = 7;
    for _ in 0..40 {
        w.step();
        w.send_updates();
    }
    let msgs = drain(&mut rx);
    let round = msgs.iter().find(|m| m["t"] == "round").expect("round message");
    assert_eq!(round["mvp"][0][0], a);
    assert_eq!(round["mvp"][0][2], 7);
    assert_eq!(w.players[&a].score, 0, "scores reset for the next round");
    assert!(msgs.iter().any(|m| m["t"] == "hills"), "hills move");
    assert_eq!(w.round_end, 80);
}

#[test]
fn teams_have_no_friendly_fire() {
    let mut w = test_world(Map::empty(15, 15));
    w.mode = Mode::Teams;
    let a = w.spawn_test_player(1.5, 1.5);
    let mate = w.spawn_test_player(3.5, 1.5);
    let foe = w.spawn_test_player(1.5, 3.5);
    w.players.get_mut(&a).unwrap().team = 1;
    w.players.get_mut(&mate).unwrap().team = 1;
    w.players.get_mut(&foe).unwrap().team = 2;
    w.place_bomb(a);
    w.players.get_mut(&a).unwrap().x = 5.5;
    w.players.get_mut(&a).unwrap().y = 5.5;
    for _ in 0..=bomb::FUSE_TICKS {
        w.step();
    }
    assert!(w.players[&mate].alive, "teammate survives");
    assert!(!w.players[&foe].alive, "opponent does not");
    assert_eq!(w.team_scores(), (1, 0));
}

#[test]
fn standing_on_a_hill_scores() {
    let mut w = test_world(Map::empty(15, 15));
    w.hills = vec![(5, 5)];
    let id = w.spawn_test_player(5.5, 5.5);
    for _ in 0..HILL_POINT_TICKS {
        w.step();
    }
    assert_eq!(w.players[&id].score, 1);
}

#[test]
fn bounty_pays_extra_and_streaks_are_announced() {
    let mut w = test_world(Map::empty(21, 21));
    let (hunter, mut rx) = joined(&mut w, "hunter");
    let mut victims = Vec::new();
    for i in 0..3 {
        victims.push(w.spawn_test_player(10.5, 3.5 + 2.0 * i as f32));
    }
    let leader = victims[0];
    w.players.get_mut(&leader).unwrap().score = BOUNTY_MIN_SCORE;
    w.update_bounty();
    assert!(w.players[&leader].bounty);
    for &v in &victims {
        w.kill(v, Some(hunter));
    }
    w.send_updates();
    assert_eq!(w.players[&hunter].score, 3 + BOUNTY_BONUS, "bounty kill pays extra");
    let msgs = drain(&mut rx);
    assert!(msgs.iter().any(|m| m["t"] == "streak" && m["n"] == 3));
    assert!(msgs.iter().any(|m| m["t"] == "kill" && m["b"] == true));
    assert!(msgs.iter().any(|m| m["t"] == "emote" && m["id"] == hunter), "auto emote after a kill");
}

#[test]
fn reconnecting_restores_progress() {
    let mut w = test_world(Map::empty(21, 21));
    let (link, _rx) = test_link();
    let req = JoinRequest { token: Some("token-resume-1".into()), ..plain_join("ann") };
    let id = w.join(req, link).unwrap();
    let p = w.players.get_mut(&id).unwrap();
    (p.score, p.range, p.kick) = (4, 5, true);
    w.leave(id);
    let (link, mut rx) = test_link();
    let req = JoinRequest { token: Some("token-resume-1".into()), ..plain_join("ann") };
    let id2 = w.join(req, link).unwrap();
    let p = &w.players[&id2];
    assert_eq!((p.score, p.range, p.kick), (4, 5, true));
    let welcome = drain(&mut rx).into_iter().find(|m| m["t"] == "welcome").unwrap();
    assert_eq!(welcome["resumed"], true);
}

#[test]
fn teleporters_move_you_to_the_twin_pad() {
    let mut map = Map::empty(21, 21);
    map.set(3, 1, Tile::Teleport);
    map.set(15, 15, Tile::Teleport);
    map.teleports.push(((3, 1), (15, 15)));
    let mut w = test_world(map);
    let id = w.spawn_test_player(2.5, 1.5);
    w.hold(id, 2, 0);
    for _ in 0..8 {
        w.step();
    }
    let p = &w.players[&id];
    assert!(p.cell().1 >= 15, "teleported, now at {:?}", p.cell());
}

#[test]
fn ice_keeps_you_sliding_until_you_hit_something() {
    let mut map = Map::empty(15, 15);
    for x in 1..8 {
        map.set(x, 1, Tile::Ice);
    }
    map.set(8, 1, Tile::Crate);
    let mut w = test_world(map);
    let id = w.spawn_test_player(1.5, 1.5);
    w.hold(id, 2, 0);
    w.step();
    w.step();
    w.hold(id, 0, 0);
    for _ in 0..60 {
        w.step();
    }
    let x = w.players[&id].x;
    assert!((x - 7.5).abs() < 1e-3, "slid all the way to the crate, x = {x}");
    // Steering still works on ice.
    w.hold(id, 4, 0);
    w.step();
    assert!(w.players[&id].x < 7.5);
}

#[test]
fn ghosts_walk_through_crates() {
    let mut map = Map::empty(15, 15);
    map.set(2, 1, Tile::Crate);
    let mut w = test_world(map);
    let id = w.spawn_test_player(1.5, 1.5);
    w.players.get_mut(&id).unwrap().ghost_until = 1000;
    w.hold(id, 2, 0);
    for _ in 0..12 {
        w.step();
    }
    assert!(w.players[&id].x > 3.0, "passed the crate");
}

#[test]
fn reversed_controls_flip_directions() {
    let mut w = test_world(Map::empty(15, 15));
    let id = w.spawn_test_player(3.5, 1.5);
    w.players.get_mut(&id).unwrap().reversed_until = 1000;
    w.hold(id, 2, 0);
    for _ in 0..4 {
        w.step();
    }
    assert!(w.players[&id].x < 3.5, "pressing right moved left");
}

#[test]
fn emotes_reach_nearby_players_only() {
    let mut w = test_world(Map::empty(81, 81));
    let (a, _rxa) = joined(&mut w, "a");
    let (b, mut rxb) = joined(&mut w, "b");
    let (c, mut rxc) = joined(&mut w, "c");
    w.players.get_mut(&a).unwrap().x = 10.5;
    w.players.get_mut(&b).unwrap().x = 12.5;
    w.players.get_mut(&c).unwrap().x = 70.5;
    for id in [a, b, c] {
        w.players.get_mut(&id).unwrap().y = 10.5;
    }
    w.rebuild_buckets();
    w.players[&a].link.as_ref().unwrap().input.emote(2);
    w.step();
    w.send_updates();
    assert!(drain(&mut rxb).iter().any(|m| m["t"] == "emote" && m["e"] == 2));
    assert!(!drain(&mut rxc).iter().any(|m| m["t"] == "emote"));
}

#[test]
fn dead_players_watch_their_killer() {
    let mut w = test_world(Map::empty(81, 81));
    let me = w.spawn_test_player(5.5, 5.5);
    let killer = w.spawn_test_player(60.5, 60.5);
    w.kill(me, Some(killer));
    let snap: serde_json::Value = w.full_snapshot(me);
    assert_eq!(me_obj(&snap)["spec"], killer + 1, "ids are sent + 1");
    let ids: Vec<u64> = snap["p"].as_array().unwrap().iter().map(|p| p[0].as_u64().unwrap()).collect();
    assert!(ids.contains(&u64::from(killer)), "the killer is in view");
}

#[test]
fn world_changes_are_sent_reliably() {
    let mut w = test_world(Map::empty(15, 15));
    let (_, mut rx) = joined(&mut w, "a");
    w.set_tile(3, 3, Tile::Crate);
    w.set_item(5, 5, Item::Ghost as u8);
    w.send_updates();
    let msgs = drain(&mut rx);
    let delta = msgs.iter().find(|m| m["t"] == "w").expect("world delta");
    assert_eq!(delta["tc"], serde_json::json!([[3, 3, 2]]));
    assert_eq!(delta["ic"], serde_json::json!([[5, 5, 12]]));
}

#[test]
fn input_sequence_is_echoed_for_prediction() {
    let mut w = test_world(Map::empty(15, 15));
    let id = w.spawn_test_player(1.5, 1.5);
    w.players[&id].link.as_ref().unwrap().input.set_dirs(2, 0, false, 4242);
    w.step();
    let snap: serde_json::Value = w.full_snapshot(id);
    assert_eq!(me_obj(&snap)["ack"], 4242);
}

#[test]
fn delta_snapshots_rebuild_the_full_picture() {
    let mut rng = Rng::new(21);
    let map = Map::generate(41, 41, 0.45, &mut rng);
    let mut w = World::with_map(map, rng, 64);
    w.set_target_bots(12);
    let (me, _rx) = joined(&mut w, "viewer");
    w.players.get_mut(&me).unwrap().set_aoi(26, 18); // see most of the map
    let input = w.players[&me].link.as_ref().unwrap().input.clone();
    let snapshot = w.players[&me].link.as_ref().unwrap().snapshot.clone();
    let mut client = protocol::testing::SnapDecoder::default();
    let (mut delta_bytes, mut full_bytes, mut deltas) = (0usize, 0usize, 0);
    for t in 0..400 {
        w.step();
        w.send_updates();
        let msg = snapshot.take().expect("a snapshot every tick");
        let snap = client.decode(&msg).expect("the base is one the client acknowledged");
        let k = snap["k"].as_u64().unwrap();
        if snap["bk"] != 0 {
            deltas += 1;
        }
        // Compare with what a full snapshot would have said.
        let full_msg = w.full_snapshot_bytes(me);
        let full = w.full_snapshot(me);
        for key in ["p", "b", "e", "me"] {
            assert_eq!(snap[key], full[key], "{key} differs at tick {k}");
        }
        delta_bytes += msg.len();
        full_bytes += full_msg.len();
        // Like a real client: acknowledge now and then, sometimes late.
        if t % 3 != 2 {
            input.set_ack(k as u32);
        }
    }
    assert!(deltas > 300, "most snapshots are deltas: {deltas}");
    eprintln!("delta snapshots: {delta_bytes} bytes vs {full_bytes} full");
    assert!(delta_bytes * 2 < full_bytes, "deltas are much smaller");
}

#[test]
fn snapshots_fall_back_to_full_without_a_known_ack() {
    let mut w = test_world(Map::empty(15, 15));
    let (me, _rx) = joined(&mut w, "a");
    let link = w.players[&me].link.as_ref().unwrap();
    let (input, snapshot) = (link.input.clone(), link.snapshot.clone());
    input.set_ack(999_999); // a tick the server never sent
    w.step();
    w.send_updates();
    let snap = protocol::testing::SnapDecoder::default().decode(&snapshot.take().unwrap()).unwrap();
    assert_eq!(snap["bk"], 0, "full snapshot");
    assert_eq!(snap["p"].as_array().unwrap().len(), 1);
}

#[test]
fn invite_links_spawn_you_next_to_your_friend() {
    let mut w = test_world(Map::empty(81, 81));
    let friend = w.spawn_test_player(60.5, 60.5);
    for _ in 0..5 {
        let (link, _rx) = test_link();
        let id = w.join(JoinRequest { near: friend, ..plain_join("pal") }, link).unwrap();
        let (x, y) = w.players[&id].cell();
        assert!((x - 60).abs() <= 5 && (y - 60).abs() <= 5, "spawned at ({x},{y})");
    }
}

#[test]
fn teams_are_balanced_on_join() {
    let mut w = test_world(Map::empty(41, 41));
    w.mode = Mode::Teams;
    let mut teams: Vec<u8> = (0..6).map(|i| {
        let (id, _rx) = joined(&mut w, &format!("p{i}"));
        w.players[&id].team
    }).collect();
    teams.sort_unstable();
    assert_eq!(teams, [1, 1, 1, 2, 2, 2]);
}

/// Holds a direction with the jump key down.
fn hold_jump(w: &World, id: u32, dir: u8) {
    w.players[&id].link.as_ref().unwrap().input.set_dirs(dir, 0, true, 1);
}

#[test]
fn jump_over_a_stone_pillar() {
    // Map::empty has pillars at even coordinates: (2, 2) is right of (1, 2).
    let mut w = test_world(Map::empty(15, 15));
    let id = w.spawn_test_player(1.5, 2.5);
    hold_jump(&w, id, 2);
    w.step();
    let p = &w.players[&id];
    assert!(p.jump_left > 0 && p.jump_dir == 2, "took off");
    for _ in 0..3 {
        w.step();
    }
    assert!((w.players[&id].x - 2.5).abs() < 1e-4, "over the pillar halfway through");
    for _ in 0..4 {
        w.step();
    }
    let p = &w.players[&id];
    assert_eq!((p.x, p.y, p.jump_left), (3.5, 2.5, 0), "landed behind it");
    // Holding on: (4, 2) is another pillar, but there's a cooldown first.
    w.step();
    assert_eq!(w.players[&id].jump_left, 0);
    for _ in 0..player::JUMP_COOLDOWN_TICKS {
        w.step();
    }
    assert!(w.players[&id].jump_left > 0, "jumps again after the cooldown");
}

#[test]
fn jump_needs_stone_and_a_free_landing() {
    let mut map = Map::empty(15, 15);
    map.set(3, 2, Tile::Crate); // landing spot behind the (2, 2) pillar
    map.set(1, 4, Tile::Crate); // not stone: below (1, 3)
    let mut w = test_world(map);
    let a = w.spawn_test_player(1.5, 2.5);
    let b = w.spawn_test_player(1.5, 3.5);
    let c = w.spawn_test_player(1.5, 1.5);
    hold_jump(&w, a, 2); // pillar, but a crate behind it
    hold_jump(&w, b, 3); // a crate isn't stone
    hold_jump(&w, c, 4); // the border: nowhere to land
    w.step();
    for id in [a, b, c] {
        assert_eq!(w.players[&id].jump_left, 0, "player {id} must not jump");
    }
}

#[test]
fn jumping_players_are_above_the_fire() {
    let mut w = test_world(Map::empty(15, 15));
    let id = w.spawn_test_player(1.5, 2.5);
    hold_jump(&w, id, 2);
    w.step();
    let tick = w.tick;
    w.flame_until.iter_mut().for_each(|u| *u = tick + 100);
    w.apply_flame_damage();
    assert!(w.players[&id].alive, "airborne");
    assert!(!w.players[&id].can_bomb(w.tick), "no bombs mid-air");
}

