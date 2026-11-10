//! The vault and its Warden.

use std::sync::Arc;

use super::guard::Skill;
use super::map::Tile;
use super::{Config, Mode, World};

fn arena(mode: Mode, size: i32) -> World {
    let cfg = Config { mode, map_w: size, map_h: size, bots: 0, map_seed: 11, ..Config::default() };
    World::new(&cfg, Arc::default(), None)
}

impl World {
    fn home(&self) -> (i32, i32) {
        self.guard.vault.as_ref().unwrap().home
    }

    /// Takes the loot away and stops restocking: a shield picked up would
    /// make a test's intruder no target.
    fn empty_vault(&mut self) {
        for (x, y) in self.guard.vault.as_ref().unwrap().loot.clone() {
            self.set_item(x, y, 0);
        }
        self.guard.next_restock = u64::MAX;
    }

    /// A player standing at the middle of cell (x, y), unshielded, in an
    /// emptied vault.
    fn intruder(&mut self, (x, y): (i32, i32)) -> u32 {
        self.empty_vault();
        let p = self.spawn_test_player(x as f32 + 0.5, y as f32 + 0.5);
        self.players.get_mut(&p).unwrap().invulnerable_until = 0;
        p
    }

    fn steps(&mut self, n: u64) {
        for _ in 0..n {
            self.step();
        }
    }
}

#[test]
fn every_arena_has_a_stocked_guarded_vault() {
    for (mode, size) in [(Mode::Ffa, 41), (Mode::Teams, 61), (Mode::Royale, 81), (Mode::Worms, 61), (Mode::Ffa, 31)] {
        let w = arena(mode, size);
        let v = w.guard.vault.as_ref().unwrap_or_else(|| panic!("{mode:?} has a vault"));
        let (mx, my) = v.home;
        // Walls all round but for a gate in the middle of each side.
        for (x, y) in [(v.x0, v.y0), (v.x1, v.y0), (v.x0, v.y1), (v.x1, v.y1), (v.x0 + 1, v.y0), (v.x0, v.y1 - 1)] {
            assert_eq!(w.map.get(x, y), Tile::Wall, "{mode:?}: wall at {x},{y}");
        }
        for (x, y) in [(mx, v.y0), (mx, v.y1), (v.x0, my), (v.x1, my), (mx, v.y0 - 1), (v.x1 + 1, my)] {
            assert_eq!(w.map.get(x, y), Tile::Floor, "{mode:?}: open at {x},{y}");
        }
        let stocked = v.loot.iter().filter(|&&(x, y)| w.items[w.map.idx(x, y)] != 0).count();
        assert!(stocked >= 8 && stocked == v.loot.len(), "{mode:?}: {stocked} items");
        assert_eq!(w.guard.warden.as_ref().unwrap().cell, v.home);
        assert!(w.hills.iter().all(|&(x, y)| !w.in_vault(x, y, 2)), "{mode:?}: no hill in the vault");
    }
}

#[test]
fn nobody_spawns_in_or_by_the_vault() {
    let mut w = arena(Mode::Ffa, 41);
    for _ in 0..200 {
        let (x, y) = w.find_spawn();
        assert!(!w.in_vault(x, y, 2), "spawned at {x},{y}");
    }
}

#[test]
fn an_intruder_next_to_the_warden_is_slammed() {
    let mut w = arena(Mode::Ffa, 41);
    let (hx, hy) = w.home();
    let p = w.intruder((hx + 1, hy + 1));
    w.steps(60);
    assert!(!w.players[&p].alive, "slammed");
    assert_eq!(w.stats.warden_crushes, 1);
}

#[test]
fn a_jump_clears_the_slam() {
    let mut w = arena(Mode::Ffa, 41);
    let (hx, hy) = w.home();
    let p = w.intruder((hx + 2, hy + 2));
    w.guard.warden.as_mut().unwrap().slam_ready = 0;
    w.guard.warden.as_mut().unwrap().next_step = 0;
    w.steps(1);
    // Two cells off: not next to it, so walk in a step first.
    let pl = w.players.get_mut(&p).unwrap();
    (pl.x, pl.y) = (hx as f32 + 1.5, hy as f32 + 1.5);
    w.rebuild_buckets();
    for _ in 0..40 {
        if w.guard.warden.as_ref().unwrap().skill == Skill::Slam {
            break;
        }
        w.step();
    }
    assert_eq!(w.guard.warden.as_ref().unwrap().skill, Skill::Slam, "it winds up");
    // Up in the air when it lands (and out of the way of its body).
    let pl = w.players.get_mut(&p).unwrap();
    (pl.x, pl.y, pl.jump_left) = (hx as f32 + 2.5, hy as f32 + 2.5, 200);
    w.rebuild_buckets();
    w.steps(w.guard.tuning.slam_windup + 1);
    assert!(w.players[&p].alive, "jumped over the shockwave");
}

#[test]
fn it_lobs_bombs_at_intruders_farther_off() {
    let mut w = arena(Mode::Ffa, 41);
    let (hx, hy) = w.home();
    let at = (hx + 3, hy + 3);
    let p = w.intruder(at);
    let mut lobbed = false;
    for _ in 0..80 {
        w.step();
        let pl = w.players.get_mut(&p).unwrap();
        (pl.x, pl.y) = (at.0 as f32 + 0.5, at.1 as f32 + 0.5); // holds still
        if w.bombs.values().any(|b| (b.x, b.y) == at && b.owner == 0) {
            lobbed = true;
            break;
        }
    }
    assert!(lobbed, "a bomb landed on the intruder");
}

#[test]
fn it_charges_down_a_clear_lane() {
    let mut w = arena(Mode::Ffa, 41);
    let (hx, hy) = w.home();
    let p = w.intruder((hx + 3, hy));
    let mut charged = false;
    for _ in 0..100 {
        w.step();
        charged |= matches!(w.guard.warden.as_ref().unwrap().skill, Skill::Charging(..));
        if !w.players[&p].alive {
            break;
        }
    }
    assert!(charged, "it charged");
    assert!(!w.players[&p].alive, "and ran the intruder down");
}

#[test]
fn blasts_hurt_it_once_each_and_bring_it_down_for_points() {
    let mut w = arena(Mode::Ffa, 41);
    let shooter = w.spawn_test_player(1.5, 1.5);
    w.players.get_mut(&shooter).unwrap().invulnerable_until = u64::MAX;
    let t = w.guard.tuning;
    let score = w.players[&shooter].score;
    let mut skinned = false;
    for _ in 0..2000 {
        let Some(warden) = &w.guard.warden else { break };
        skinned |= warden.skin_until > w.tick;
        let i = w.map.idx(warden.cell.0, warden.cell.1);
        (w.flame_from[i], w.flame_until[i], w.flame_owner[i]) = (w.tick, w.tick + 3, shooter);
        let before = warden.hp;
        w.step();
        if let Some(after) = w.guard.warden.as_ref().map(|x| x.hp) {
            assert!(before - after <= 1, "one hit at a time");
        }
    }
    assert!(w.guard.warden.is_none(), "brought down");
    assert!(skinned, "it used its stone skin on the way");
    assert_eq!(w.stats.wardens_killed, 1);
    assert_eq!(w.players[&shooter].score, score + t.kill_points);
    // Loot taken meanwhile comes back with it.
    let (x, y) = w.guard.vault.as_ref().unwrap().loot[0];
    w.set_item(x, y, 0);
    w.steps(t.respawn_ticks + 2);
    let back = w.guard.warden.as_ref().expect("back on guard");
    assert_eq!(back.hp, t.max_hp);
    assert_ne!(w.items[w.map.idx(x, y)], 0, "restocked");
}

#[test]
fn its_own_bombs_dont_hurt_it() {
    let mut w = arena(Mode::Ffa, 41);
    let (x, y) = w.home();
    let i = w.map.idx(x, y);
    (w.flame_from[i], w.flame_until[i], w.flame_owner[i]) = (w.tick, w.tick + 3, 0);
    w.step();
    assert_eq!(w.guard.warden.as_ref().unwrap().hp, w.guard.tuning.max_hp);
}

#[test]
fn it_stays_by_its_vault() {
    let mut w = arena(Mode::Ffa, 41);
    let (lx, ly) = {
        let v = w.guard.vault.as_ref().unwrap();
        (v.x1 + w.guard.tuning.aggro_margin + 4, v.y1 + w.guard.tuning.aggro_margin + 4)
    };
    w.intruder((lx, ly));
    w.steps(200);
    let warden = w.guard.warden.as_ref().unwrap();
    assert!(!warden.hunting, "out of reach");
    assert!(w.in_vault(warden.cell.0, warden.cell.1, w.guard.tuning.leash_margin));
}
