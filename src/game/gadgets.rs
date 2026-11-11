//! Gadgets (one-shot items fired with the gadget key: land mines, rockets,
//! swaps, drones and drone swarms), the freeze power-up's ice and the stomp
//! power-up's stun.

use crate::protocol;

use super::bomb::BombKind;
use super::items::Item;
use super::map::Tile;
use super::player::Player;
use super::{DT, World};

/// Ice left by a freeze blast lasts this long before it melts back.
pub const FREEZE_TICKS: u64 = 8 * 20;
/// A mine goes off this long after an enemy comes next to it.
pub const MINE_ARM_TICKS: u64 = 10;
pub const MINE_RANGE: u8 = 2;
/// Rockets: blast range, and the longest they fly.
pub const ROCKET_RANGE: u8 = 2;
pub const ROCKET_MAX_TICKS: u64 = 60;
/// Swap reaches enemies this many tiles away.
pub const SWAP_RANGE: f32 = 6.0;
/// A stomp stuns for this long.
pub const STUN_TICKS: u64 = 20;
/// Drones: speed in tiles per second, lifetime, how far they look for
/// enemies, bombs per drone, bomb range and fuse, and time between drops.
pub const DRONE_SPEED: f32 = 6.0;
pub const DRONE_LIFE_TICKS: u64 = 12 * 20;
pub const DRONE_SIGHT: f32 = 14.0;
pub const DRONE_BOMBS: u8 = 3;
pub const SWARM_SIZE: usize = 5;
pub const DRONE_BOMB_RANGE: u8 = 2;
pub const DRONE_FUSE_TICKS: u64 = 40;
pub const DRONE_DROP_COOLDOWN: u64 = 15;

/// A hidden land mine: invisible to enemies until it arms.
pub struct Mine {
    pub id: u32,
    pub owner: u32,
    pub team: u8,
    pub x: i32,
    pub y: i32,
}

/// A bomber drone flying over the map (walls don't stop it).
pub struct Drone {
    pub id: u32,
    pub owner: u32,
    pub team: u8,
    pub x: f32,
    pub y: f32,
    pub target: Option<u32>,
    pub bombs_left: u8,
    pub until: u64,
    pub next_drop: u64,
}

/// `p` may hurt `o` and they're different players: an enemy.
fn enemy(p: &Player, o: &Player) -> bool {
    p.id != o.id && p.can_hurt(o) && o.alive
}

impl World {
    /// The gadget key: fires one charge of the held gadget.
    pub(super) fn use_gadget(&mut self, id: u32) {
        let tick = self.tick;
        let Some(p) = self.players.get(&id) else { return };
        if !p.alive || p.gadget_n == 0 || p.jump_left > 0 || p.stunned_until > tick {
            return;
        }
        let Some(item) = Item::from_u8(p.gadget) else { return };
        let used = match item {
            Item::Mine => self.place_mine(id),
            Item::Rocket => self.fire_rocket(id),
            Item::Swap => self.swap(id),
            Item::Drone => self.launch_drones(id, 1, DRONE_BOMBS),
            Item::Swarm => self.launch_drones(id, SWARM_SIZE, 1),
            _ => false,
        };
        if used {
            let p = self.players.get_mut(&id).unwrap();
            p.gadget_n -= 1;
            if p.gadget_n == 0 {
                p.gadget = 0;
            }
        }
    }

    fn next_gadget_id(&mut self) -> u32 {
        self.next_bomb_id = self.next_bomb_id.wrapping_add(1).max(1);
        self.next_bomb_id
    }

    fn place_mine(&mut self, id: u32) -> bool {
        let p = &self.players[&id];
        let (x, y) = p.cell();
        let team = p.team;
        if self.bomb_at(x, y).is_some() || self.mines.iter().any(|m| (m.x, m.y) == (x, y)) {
            return false;
        }
        let mid = self.next_gadget_id();
        self.mines.push(Mine { id: mid, owner: id, team, x, y });
        true
    }

    fn fire_rocket(&mut self, id: u32) -> bool {
        let kind = BombKind { rocket: true, ..BombKind::gadget(ROCKET_RANGE, ROCKET_MAX_TICKS) };
        self.launch_rocket(id, kind)
    }

    /// The bomb key in a rockets arena: a rocket with the player's own blast
    /// (range, pierce, freeze) that counts towards their bomb limit, so the
    /// extra-bomb power-up means more rockets in the air. Bomb modifiers
    /// (atomic, gas, sticky, line, remote) don't apply to rockets.
    pub(super) fn fire_bomb_rocket(&mut self, id: u32) -> bool {
        let Some(p) = self.players.get(&id) else { return false };
        if !p.can_bomb(self.tick) {
            return false;
        }
        let kind = BombKind {
            rocket: true,
            pierce: p.pierce,
            freeze: p.freeze,
            ..BombKind::plain(p.range.max(ROCKET_RANGE), ROCKET_MAX_TICKS)
        };
        self.launch_rocket(id, kind)
    }

    /// Puts a rocket of `kind` in the player's cell, flying the way they're
    /// steering (or facing, when they stand still) from this tick on.
    pub(super) fn launch_rocket(&mut self, id: u32, kind: BombKind) -> bool {
        let p = &self.players[&id];
        let (x, y) = p.cell();
        let dir = if p.input_dir != 0 { p.input_dir } else { p.facing };
        if !self.place_bomb_at(id, (x, y), kind) {
            return false;
        }
        let b = self.bomb_at(x, y).unwrap();
        let tick = self.tick;
        let b = self.bombs.get_mut(&b).unwrap();
        (b.slide_dir, b.next_slide) = (dir.max(1), tick);
        true
    }

    fn swap(&mut self, id: u32) -> bool {
        let p = &self.players[&id];
        let (px, py) = (p.x, p.y);
        let r = SWAP_RANGE as i32 + 1;
        let (cx, cy) = p.cell();
        let target = self
            .players_in_rect(cx - r, cy - r, cx + r, cy + r)
            .filter(|o| enemy(p, o) && o.jump_left == 0)
            .map(|o| (((o.x - px).powi(2) + (o.y - py).powi(2)).sqrt(), o.id))
            .filter(|&(d, _)| d <= SWAP_RANGE)
            .min_by(|a, b| a.0.total_cmp(&b.0))
            .map(|(_, o)| o);
        let Some(t) = target else { return false };
        let (tx, ty) = {
            let o = &self.players[&t];
            (o.x, o.y)
        };
        let ready = self.tick + 20;
        for (who, x, y) in [(id, tx, ty), (t, px, py)] {
            let q = self.players.get_mut(&who).unwrap();
            (q.x, q.y, q.teleport_ready_at) = (x, y, ready);
        }
        self.rebuild_buckets();
        self.broadcast_event(protocol::ev::SWAP, &[i64::from(id), i64::from(t)]);
        true
    }

    fn launch_drones(&mut self, id: u32, count: usize, bombs: u8) -> bool {
        let p = &self.players[&id];
        let (x, y, team) = (p.x, p.y, p.team);
        for k in 0..count {
            let a = k as f32 / count as f32 * std::f32::consts::TAU;
            let spread = if count > 1 { 0.6 } else { 0.0 };
            let did = self.next_gadget_id();
            self.drones.push(Drone {
                id: did,
                owner: id,
                team,
                x: x + a.cos() * spread,
                y: y + a.sin() * spread,
                target: None,
                bombs_left: bombs,
                until: self.tick + DRONE_LIFE_TICKS,
                next_drop: self.tick + DRONE_DROP_COOLDOWN,
            });
        }
        true
    }

    /// Mines arm when an enemy comes next to them (or fire reaches them),
    /// turning into a bomb with a short fuse.
    pub(super) fn update_mines(&mut self) {
        let mut k = 0;
        while k < self.mines.len() {
            let m = &self.mines[k];
            let (x, y) = (m.x, m.y);
            let owner_gone = !self.players.contains_key(&m.owner);
            let burning = self.flame_active(x, y);
            let stepped = self.players_in_rect(x - 1, y - 1, x + 1, y + 1).any(|o| {
                let (ox, oy) = o.cell();
                let hurt = self.players.get(&m.owner).map_or(o.team == 0 || o.team != m.team, |p| enemy(p, o));
                hurt && o.jump_left == 0 && (ox - x).abs() + (oy - y).abs() <= 1
            });
            if !(owner_gone || burning || stepped) {
                k += 1;
                continue;
            }
            let m = self.mines.swap_remove(k);
            if owner_gone || self.bomb_at(x, y).is_some() {
                continue;
            }
            let fuse = if burning { 0 } else { MINE_ARM_TICKS };
            self.place_bomb_at(m.owner, (x, y), BombKind::gadget(MINE_RANGE, fuse));
        }
    }

    /// Drones pick the nearest enemy (one not already hunted by another of
    /// the owner's drones, if possible), fly to them and drop bombs.
    pub(super) fn update_drones(&mut self) {
        let tick = self.tick;
        let mut k = 0;
        while k < self.drones.len() {
            let (owner, dx0, dy0, until, left) = {
                let d = &self.drones[k];
                (d.owner, d.x, d.y, d.until, d.bombs_left)
            };
            let Some(op) = self.players.get(&owner) else {
                self.drones.swap_remove(k);
                continue;
            };
            if tick >= until || left == 0 {
                self.drones.swap_remove(k);
                continue;
            }
            // Keep the current target while it's alive and in sight.
            let current = self.drones[k].target.and_then(|t| self.players.get(&t)).filter(|o| o.alive && enemy(op, o));
            let target = current.map(|o| o.id).or_else(|| {
                let taken: Vec<u32> = self.drones.iter().filter(|d| d.owner == owner).filter_map(|d| d.target).collect();
                let r = DRONE_SIGHT as i32;
                let (cx, cy) = (dx0 as i32, dy0 as i32);
                let mut best: Option<(bool, f32, u32)> = None;
                for o in self.players_in_rect(cx - r, cy - r, cx + r, cy + r).filter(|o| enemy(op, o)) {
                    let d = ((o.x - dx0).powi(2) + (o.y - dy0).powi(2)).sqrt();
                    if d > DRONE_SIGHT {
                        continue;
                    }
                    let key = (taken.contains(&o.id), d, o.id);
                    if best.is_none_or(|b| (key.0, key.1) < (b.0, b.1)) {
                        best = Some(key);
                    }
                }
                best.map(|b| b.2)
            });
            // Fly towards the target's cell centre, or circle the owner.
            let (gx, gy) = if let Some(o) = target.and_then(|t| self.players.get(&t)) {
                (o.x.floor() + 0.5, o.y.floor() + 0.5)
            } else {
                let a = tick as f32 * 0.08 + k as f32;
                (op.x + a.cos() * 1.5, op.y + a.sin() * 1.5)
            };
            let (vx, vy) = (gx - dx0, gy - dy0);
            let dist = (vx * vx + vy * vy).sqrt();
            let step = DRONE_SPEED * DT;
            let (nx, ny) = if dist <= step { (gx, gy) } else { (dx0 + vx / dist * step, dy0 + vy / dist * step) };
            let ready = self.drones[k].next_drop <= tick;
            {
                let d = &mut self.drones[k];
                (d.x, d.y, d.target) = (nx, ny, target);
            }
            // Over the target: bombs away.
            if target.is_some() && dist < 0.35 && ready {
                let (cx, cy) = (nx.floor() as i32, ny.floor() as i32);
                if !self.map.is_solid(cx, cy) && self.place_bomb_at(owner, (cx, cy), BombKind::gadget(DRONE_BOMB_RANGE, DRONE_FUSE_TICKS)) {
                    let d = &mut self.drones[k];
                    d.bombs_left -= 1;
                    d.next_drop = tick + DRONE_DROP_COOLDOWN;
                }
            }
            k += 1;
        }
    }

    /// Turns a floor cell to ice for a while (freeze blasts).
    pub(super) fn freeze_cell(&mut self, x: i32, y: i32) {
        let until = self.tick + FREEZE_TICKS;
        match self.map.get(x, y) {
            Tile::Floor => {
                self.set_tile(x, y, Tile::Ice);
                self.frozen.push((x, y, until));
            }
            Tile::Ice => {
                if let Some(f) = self.frozen.iter_mut().find(|f| (f.0, f.1) == (x, y)) {
                    f.2 = until;
                }
            }
            _ => {}
        }
    }

    /// Melts ice from freeze blasts back to floor.
    pub(super) fn melt_ice(&mut self) {
        let tick = self.tick;
        let mut k = 0;
        while k < self.frozen.len() {
            let (x, y, until) = self.frozen[k];
            if until > tick {
                k += 1;
                continue;
            }
            self.frozen.swap_remove(k);
            if self.map.get(x, y) == Tile::Ice {
                self.set_tile(x, y, Tile::Floor);
            }
        }
    }

    /// A stomp: landing a jump stuns enemies on or next to the landing cell.
    pub(super) fn stomp(&mut self, id: u32) {
        let p = &self.players[&id];
        let (x, y) = p.cell();
        let mut hit = Vec::new();
        for o in self.players_in_rect(x - 1, y - 1, x + 1, y + 1) {
            let (ox, oy) = o.cell();
            if enemy(p, o) && o.jump_left == 0 && (ox - x).abs() + (oy - y).abs() <= 1 && o.invulnerable_until <= self.tick {
                hit.push(o.id);
            }
        }
        let until = self.tick + STUN_TICKS;
        for v in hit {
            let o = self.players.get_mut(&v).unwrap();
            o.stunned_until = o.stunned_until.max(until);
        }
    }
}
