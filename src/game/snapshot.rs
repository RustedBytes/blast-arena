//! Spatial buckets, per-client snapshots, the leaderboard and sending updates.

use bytes::{Bytes, BytesMut};

use crate::protocol::{self, MeState, Wire, snap};

use super::bomb::NUKE_RADIUS;
use super::clone::{F_DASHING, F_JUMPING, F_MOVING};
use super::delta::{Base, BombEntry, DeltaScratch, EMPTY_ME, PlayerEntry, SnapHistory, write_delta};
use super::player::{MAX_RANGE, Player};
use super::{BUCKET, LEADERBOARD_EVERY, World, monsters, worms};

impl World {
    pub(super) fn rebuild_buckets(&mut self) {
        for b in &mut self.buckets {
            b.clear();
        }
        for p in self.players.values() {
            let (x, y) = p.cell();
            let bi = ((y / BUCKET) * self.buckets_w + x / BUCKET) as usize;
            if let Some(b) = self.buckets.get_mut(bi) {
                b.push(p.id);
            }
        }
    }

    /// Players whose cell lies inside the inclusive tile rectangle.
    pub fn players_in_rect(&self, x0: i32, y0: i32, x1: i32, y1: i32) -> impl Iterator<Item = &Player> {
        let bx0 = x0.max(0) / BUCKET;
        let by0 = y0.max(0) / BUCKET;
        let bx1 = x1.min(self.map.w - 1) / BUCKET;
        let by1 = y1.min(self.map.h - 1) / BUCKET;
        (by0..=by1)
            .flat_map(move |by| (bx0..=bx1).map(move |bx| (by * self.buckets_w + bx) as usize))
            .flat_map(move |bi| self.buckets[bi].iter())
            .filter_map(move |id| self.players.get(id))
            .filter(move |p| {
                let (x, y) = p.cell();
                x >= x0 && x <= x1 && y >= y0 && y <= y1
            })
    }

    /// Writes one client's snapshot into the arena and returns it as a
    /// zero-copy slice. Snapshots carry only moving things (players, bombs,
    /// flames); tiles and items arrive through the reliable `w` stream.
    /// Arrays are written with back-patched lengths, so no intermediate
    /// lists are built.
    pub(super) fn encode_snapshot(&self, arena: &mut BytesMut, p: &Player, view: &ViewIndex, hist: &mut SnapHistory, cur: &mut DeltaScratch) -> Bytes {
        let tick = self.tick;
        // While dead, watch whoever got you.
        let spectating = (!p.alive).then_some(p.killed_by).flatten().and_then(|k| self.players.get(&k)).filter(|k| k.alive && k.id != p.id);
        // Out of a royale match (or killed by the storm): watch the nearest survivor.
        let spectating = spectating.or_else(|| {
            (!p.alive && self.is_royale()).then(|| {
                self.players.values().filter(|o| o.alive).min_by(|a, b| {
                    let d = |o: &Player| (o.x - p.x).powi(2) + (o.y - p.y).powi(2);
                    d(a).total_cmp(&d(b))
                })
            })?
        });
        let (cx, cy) = p.look.unwrap_or_else(|| spectating.map_or(p.cell(), super::player::Player::cell));
        let (x0, y0, x1, y1) = aoi_rect(cx, cy, p.aoi);
        let (px, py) = p.cell();
        let me_outside = p.alive && !(px >= x0 && px <= x1 && py >= y0 && py <= y1);

        // What the client should see now, sorted by id for diffing. A
        // client watching elsewhere still gets its own player.
        cur.players.clear();
        view.players_in_rect(self, (x0, y0, x1, y1), &mut cur.players);
        if me_outside {
            cur.players.push(player_entry(p, tick));
        }
        cur.players.sort_unstable_by_key(|e| e.0);
        cur.bombs.clear();
        // Atomic bombs a little outside the view are sent too: their danger
        // zone reaches into it.
        view.bombs_in_rect(self, (x0, y0, x1, y1), &mut cur.bombs);
        // Sticky bombs riding on players in view.
        for &bid in &self.sticky {
            if let Some(b) = self.bombs.get(&bid).filter(|b| b.attached != 0 && b.x >= x0 && b.x <= x1 && b.y >= y0 && b.y <= y1) {
                cur.bombs.push((bid, b.x, b.y, if b.remote { 0 } else { b.explode_at }, bomb_flags(b)));
            }
        }
        // Your own (and your team's) hidden mines, flagged 32 and fuseless.
        for m in &self.mines {
            let mine = m.owner == p.id || (p.team != 0 && m.team == p.team);
            if mine && m.x >= x0 && m.x <= x1 && m.y >= y0 && m.y <= y1 {
                cur.bombs.push((m.id, m.x, m.y, 0, 2 | 32));
            }
        }
        cur.bombs.sort_unstable_by_key(|e| e.0);

        cur.me = self.me_state(p, spectating.map(|k| k.id));

        // Delta against the newest snapshot the client confirmed, if we
        // still remember it; otherwise a full snapshot (a delta from nothing).
        let slot = hist.slot_for(u64::from(p.snap_ack));
        let base = match slot {
            Some(s) => Base { players: &hist.players[s], bombs: &hist.bombs[s], me: &hist.me[s] },
            None => Base { players: &[], bombs: &[], me: &EMPTY_ME },
        };
        let mut w = Wire(arena);
        w.u8(protocol::op::SNAP).uvar(tick).uvar(slot.map_or(0, |s| tick - hist.ticks[s]));
        let reach = i32::from(MAX_RANGE);
        let in_range = |e: &&super::bomb::Explosion| e.x >= x0 - reach && e.x <= x1 + reach && e.y >= y0 - reach && e.y <= y1 + reach;
        write_delta(&mut w, tick, &*cur, &base, |w| {
            let n = self.explosions.iter().filter(in_range).count();
            if n > 0 {
                w.len(n);
                for e in self.explosions.iter().filter(in_range) {
                    if e.nuke > 0 {
                        // Arms never reach 15, so 0xFF marks an atomic blast;
                        // the next byte is its radius.
                        w.coord(e.x).coord(e.y).u8(NUKE_MARK).u8(e.nuke).uvar(e.until.saturating_sub(tick));
                        continue;
                    }
                    // Arm lengths are at most MAX_RANGE, so they fit in a nibble.
                    let a = e.arms.map(|r| r.min(15));
                    w.coord(e.x).coord(e.y).u8(a[0] | a[1] << 4).u8(a[2] | a[3] << 4).uvar(e.until.saturating_sub(tick));
                }
            }
            n
        }, |w| {
            let seen = |d: &&super::gadgets::Drone| {
                let (dx, dy) = (d.x as i32, d.y as i32);
                dx >= x0 - 2 && dx <= x1 + 2 && dy >= y0 - 2 && dy <= y1 + 2
            };
            let n = self.drones.iter().filter(seen).count();
            if n > 0 {
                w.len(n);
                for d in self.drones.iter().filter(seen) {
                    w.id(d.id).ivar(i64::from((d.x * 100.0) as i32)).ivar(i64::from((d.y * 100.0) as i32)).u8(d.team);
                }
            }
            n
        }, |w| self.write_extra(w, (x0, y0, x1, y1)));
        hist.record(tick, cur);
        protocol::finish(arena)
    }

    pub(super) fn encode_leaderboard(&mut self) -> Bytes {
        let mut top = std::mem::take(&mut self.scratch.ids);
        top.clear();
        top.extend(self.players.keys().copied());
        let players = &self.players;
        let key = |id: &u32| {
            let p = &players[id];
            (std::cmp::Reverse(p.score), std::cmp::Reverse(p.kills), p.id)
        };
        let k = top.len().min(10);
        if k > 0 && k < top.len() {
            top.select_nth_unstable_by_key(k - 1, key);
        }
        top.truncate(k);
        top.sort_unstable_by_key(key);
        let entries = top.iter().map(|id| {
            let p = &players[id];
            (p.id, p.name.as_str(), p.score, p.kills, p.deaths)
        });
        let teams = self.team_scores();
        let secs = self.round_secs_left();
        let msg = protocol::encode_lb(self.event_arenas.current(), players.len(), entries, teams, secs);
        self.scratch.ids = top;
        msg
    }

    /// Sends this tick's broadcasts (including the world delta) and
    /// publishes each client's snapshot. Clients whose reliable event queue
    /// is full or closed are collected in `scratch.dropped`.
    pub fn send_updates(&mut self) {
        self.send_emotes();
        let mut broadcasts = std::mem::take(&mut self.scratch.broadcasts);
        broadcasts.clear();
        broadcasts.append(&mut self.broadcasts);
        if !self.tile_changes.is_empty() || !self.item_changes.is_empty() {
            let w = protocol::encode_world(self.event_arenas.current(), &self.tile_changes, &self.item_changes);
            broadcasts.push(w);
        }
        self.tile_changes.clear();
        self.item_changes.clear();
        if self.tick.is_multiple_of(LEADERBOARD_EVERY) {
            let lb = self.encode_leaderboard();
            broadcasts.push(lb);
        }
        let mut ring = std::mem::take(&mut self.snapshot_arenas);
        let mut histories = std::mem::take(&mut self.histories);
        let mut delta = std::mem::take(&mut self.scratch.delta);
        let arena = ring.rotate();
        let mut dropped = std::mem::take(&mut self.scratch.dropped);
        dropped.clear();
        // Every client sees the same players the same way: work that out
        // once, not once per client.
        let mut view = std::mem::take(&mut self.scratch.view);
        view.build(self);
        for p in self.players.values() {
            let Some(link) = &p.link else { continue };
            if !broadcasts.iter().all(|m| link.events.try_send(m.clone()).is_ok()) {
                dropped.push(p.id);
                continue;
            }
            let hist = histories.entry(p.id).or_default();
            link.snapshot.publish(self.encode_snapshot(arena, p, &view, hist, &mut delta));
        }
        self.scratch.view = view;
        self.snapshot_arenas = ring;
        self.histories = histories;
        self.scratch.delta = delta;
        broadcasts.clear();
        self.scratch.broadcasts = broadcasts;
        self.scratch.dropped = dropped;
    }

    /// Clients that couldn't keep up with reliable events this tick.
    #[must_use]
    pub fn dropped_clients(&self) -> &[u32] {
        &self.scratch.dropped
    }

    pub fn drop_lagging_clients(&mut self) {
        let dropped = std::mem::take(&mut self.scratch.dropped);
        for &id in &dropped {
            tracing::warn!(id, "dropping a client whose event queue overflowed (too slow or closed)");
            self.leave(id);
        }
        self.scratch.dropped = dropped;
    }
}

/// A bomb on the grid as snapshots show it: id, x, y, detonation tick
/// (0 = remote), flags. The absolute detonation tick never changes, so a
/// resting bomb is identical from one snapshot to the next.
fn bomb_entry(b: &super::bomb::Bomb) -> BombEntry {
    (b.id, b.x, b.y, if b.remote { 0 } else { b.explode_at }, bomb_flags(b))
}

/// A living player as snapshots show it: id, x*100, y*100, facing, flags.
fn player_entry(o: &Player, tick: u64) -> PlayerEntry {
    let flags = u16::from(o.moving)
        | u16::from(o.invulnerable_until > tick) << 1
        | u16::from(o.curse(tick).0 != 0) << 2
        | u16::from(o.ghost(tick)) << 3
        | u16::from(o.bounty) << 4
        | u16::from(o.jump_left > 0) << 5
        | u16::from(o.stunned_until > tick) << 6
        | u16::from(o.carrying != 0) << 7
        | u16::from(o.dashing()) << 8
        | u16::from(o.gassed_until > tick) << 9
        | u16::from(o.hurt_until > tick) << 10
        | u16::from(o.wounds > 0) << 11;
    (o.id, (o.x * 100.0) as i32, (o.y * 100.0) as i32, o.facing, flags)
}

/// The living players and the bombs on the grid of this tick as snapshots
/// show them, bucketed by cell like `World::buckets`. Built once per tick
/// in `send_updates`, so a crowded arena doesn't look every visible thing
/// up again (and scan every cell of the view for bombs) for every client
/// that can see it.
#[derive(Default)]
pub(super) struct ViewIndex {
    /// Cell and entry of each living player.
    players: Vec<((i32, i32), PlayerEntry)>,
    /// Per bucket, indices into `players`.
    buckets: Vec<Vec<u32>>,
    /// Entry of each bomb on the grid, and whether it's atomic.
    bombs: Vec<(BombEntry, bool)>,
    /// Per bucket, indices into `bombs`.
    bomb_buckets: Vec<Vec<u32>>,
}

impl ViewIndex {
    pub(super) fn build(&mut self, world: &World) {
        self.players.clear();
        self.bombs.clear();
        for buckets in [&mut self.buckets, &mut self.bomb_buckets] {
            buckets.resize_with(world.buckets.len(), Vec::new);
            for b in buckets.iter_mut() {
                b.clear();
            }
        }
        // Bombs riding a player (sticky) aren't on the grid; they're sent
        // separately.
        for b in world.bombs.values() {
            if !world.map.in_bounds(b.x, b.y) || world.bomb_grid[world.map.idx(b.x, b.y)] != b.id {
                continue;
            }
            let bi = ((b.y / BUCKET) * world.buckets_w + b.x / BUCKET) as usize;
            if let Some(bucket) = self.bomb_buckets.get_mut(bi) {
                bucket.push(self.bombs.len() as u32);
                self.bombs.push((bomb_entry(b), b.nuke));
            }
        }
        for p in world.players.values().filter(|p| p.alive) {
            let (x, y) = p.cell();
            let bi = ((y / BUCKET) * world.buckets_w + x / BUCKET) as usize;
            if let Some(b) = self.buckets.get_mut(bi) {
                b.push(self.players.len() as u32);
                self.players.push(((x, y), player_entry(p, world.tick)));
            }
        }
    }

    /// Appends the entries of the bombs inside the inclusive tile rectangle,
    /// and of atomic ones a little outside it: their danger zone reaches in.
    fn bombs_in_rect(&self, world: &World, (x0, y0, x1, y1): (i32, i32, i32, i32), out: &mut Vec<BombEntry>) {
        let margin = i32::from(NUKE_RADIUS);
        let (mx0, my0, mx1, my1) = (x0 - margin, y0 - margin, x1 + margin, y1 + margin);
        let (bx0, by0) = (mx0.max(0) / BUCKET, my0.max(0) / BUCKET);
        let (bx1, by1) = (mx1.min(world.map.w - 1) / BUCKET, my1.min(world.map.h - 1) / BUCKET);
        for by in by0..=by1 {
            for bx in bx0..=bx1 {
                for &k in &self.bomb_buckets[(by * world.buckets_w + bx) as usize] {
                    let (entry, nuke) = self.bombs[k as usize];
                    let (x, y) = (entry.1, entry.2);
                    let inside = x >= x0 && x <= x1 && y >= y0 && y <= y1;
                    let near = x >= mx0 && x <= mx1 && y >= my0 && y <= my1;
                    if inside || (nuke && near) {
                        out.push(entry);
                    }
                }
            }
        }
    }

    /// Appends the entries of the players whose cell lies inside the
    /// inclusive tile rectangle.
    fn players_in_rect(&self, world: &World, (x0, y0, x1, y1): (i32, i32, i32, i32), out: &mut Vec<PlayerEntry>) {
        let (bx0, by0) = (x0.max(0) / BUCKET, y0.max(0) / BUCKET);
        let (bx1, by1) = (x1.min(world.map.w - 1) / BUCKET, y1.min(world.map.h - 1) / BUCKET);
        for by in by0..=by1 {
            for bx in bx0..=bx1 {
                for &k in &self.buckets[(by * world.buckets_w + bx) as usize] {
                    let ((x, y), entry) = self.players[k as usize];
                    if x >= x0 && x <= x1 && y >= y0 && y <= y1 {
                        out.push(entry);
                    }
                }
            }
        }
    }
}

/// Flags of a bomb as sent (a varint): pierce, remote, nuke, freeze,
/// rocket, (mine), sticky, gas, then a blaster bolt's colour in bits 8-10.
fn bomb_flags(b: &super::bomb::Bomb) -> u16 {
    u16::from(b.pierce)
        | u16::from(b.remote) << 1
        | u16::from(b.nuke) << 2
        | u16::from(b.freeze) << 3
        | u16::from(b.rocket) << 4
        | u16::from(b.sticky) << 6
        | u16::from(b.gas) << 7
        | u16::from(b.bolt & 7) << 8
}

impl World {
    /// The vault and its Warden (sent everywhere: it's a landmark).
    fn write_guard(&self, w: &mut Wire<'_>) {
        use super::guard::{Skill, flag};
        let (tick, g) = (self.tick, &self.guard);
        let v = g.vault.as_ref().unwrap();
        w.coord(v.x0).coord(v.y0).coord(v.x1).coord(v.y1);
        w.uvar(if g.warden.is_some() { 0 } else { g.respawn_at.saturating_sub(tick) });
        w.len(usize::from(g.warden.is_some()));
        if let Some(d) = &g.warden {
            let t = &g.tuning;
            let (skill_flag, dir) = match d.skill {
                Skill::None => (0, 0),
                Skill::Slam => (flag::SLAM, 0),
                Skill::Charge(dir) => (flag::CHARGE_WINDUP, dir),
                Skill::Charging(dir, _) => (flag::CHARGING, dir),
            };
            let flags = (u8::from(d.hunting) * flag::HUNTING)
                | skill_flag
                | (u8::from(d.skin_until > tick) * flag::SKIN)
                | (u8::from(d.enraged(t)) * flag::ENRAGED)
                | (u8::from(d.hurt_until > tick) * flag::HURT);
            w.id(d.id).coord(d.cell.0).coord(d.cell.1).coord(d.from.0).coord(d.from.1);
            w.u8(flags).uvar(d.step_ticks).uvar(tick.saturating_sub(d.last_step));
            w.u8(d.hp).u8(t.max_hp).uvar(d.skill_at.saturating_sub(tick)).u8(if dir != 0 { dir } else { d.dir });
        }
    }

    /// The `EXTRA` section: ability objects in view (gas clouds, portals,
    /// clones, decoy bombs, who carries which sticky bomb) and the worms.
    /// Returns whether
    /// it wrote anything.
    fn write_extra(&self, w: &mut Wire<'_>, (x0, y0, x1, y1): (i32, i32, i32, i32)) -> bool {
        let tick = self.tick;
        let inside = |x: i32, y: i32, m: i32| x >= x0 - m && x <= x1 + m && y >= y0 - m && y <= y1 + m;
        let reach = i32::from(MAX_RANGE);
        let gas = || self.gas.iter().filter(|c| inside(c.x, c.y, reach));
        let portals = || self.portals.iter().filter(|p| inside(p.x, p.y, 0));
        let clones = || self.clones.iter().filter(|c| inside(c.x as i32, c.y as i32, 1));
        let decoys = || self.decoys.iter().filter(|d| inside(d.x, d.y, 0));
        let monsters = || self.monsters.list.iter().filter(|m| inside(m.cell.0, m.cell.1, 1) || inside(m.from.0, m.from.1, 1));
        let stuck = || self.sticky.iter().filter_map(|id| self.bombs.get(id)).filter(|b| b.attached != 0 && inside(b.x, b.y, 0));
        let mut parts = 0;
        for (n, bit) in [
            (gas().count(), snap::GAS),
            (portals().count(), snap::PORTALS),
            (clones().count(), snap::CLONES),
            (decoys().count(), snap::DECOYS),
            (stuck().count(), snap::STUCK),
            (self.worms.list.len(), snap::WORMS),
            (usize::from(self.guard.vault.is_some()), snap::GUARD),
            (monsters().count(), snap::MONSTERS),
        ] {
            if n > 0 {
                parts |= bit;
            }
        }
        if parts == 0 {
            return false;
        }
        w.u8(parts);
        if parts & snap::GAS != 0 {
            w.len(gas().count());
            for c in gas() {
                let a = c.arms.map(|r| r.min(15));
                w.id(c.id).coord(c.x).coord(c.y).u8(a[0] | a[1] << 4).u8(a[2] | a[3] << 4).uvar(c.until.saturating_sub(tick));
            }
        }
        if parts & snap::PORTALS != 0 {
            w.len(portals().count());
            for p in portals() {
                w.id(p.id).coord(p.x).coord(p.y).id(p.owner).id(p.partner).uvar(p.until.saturating_sub(tick));
            }
        }
        if parts & snap::CLONES != 0 {
            w.len(clones().count());
            for c in clones() {
                let flags = u64::from(c.flags & F_MOVING != 0) | u64::from(c.flags & F_JUMPING != 0) << 5 | u64::from(c.flags & F_DASHING != 0) << 8;
                w.id(c.id).id(c.owner).ivar(i64::from((c.x * 100.0) as i32)).ivar(i64::from((c.y * 100.0) as i32)).uvar(u64::from(c.facing & 7) | flags << 3);
            }
        }
        if parts & snap::DECOYS != 0 {
            w.len(decoys().count());
            for d in decoys() {
                w.id(d.id).coord(d.x).coord(d.y).ivar(d.fuse_at as i64 - tick as i64);
            }
        }
        if parts & snap::STUCK != 0 {
            w.len(stuck().count());
            for b in stuck() {
                w.id(b.id).id(b.attached);
            }
        }
        if parts & snap::GUARD != 0 {
            self.write_guard(w);
        }
        if parts & snap::WORMS != 0 {
            // Every worm, so the minimap can show them all; the ones out of
            // view only by their head.
            w.len(self.worms.list.len());
            for worm in &self.worms.list {
                let seen = worm.body.iter().any(|&(x, y)| inside(x, y, 1));
                let flags = (u8::from(worm.chasing) * worms::flag::CHASING)
                    | (u8::from(worm.emerging(tick)) * worms::flag::EMERGING)
                    | (u8::from(!seen) * worms::flag::FAR)
                    | (u8::from(worm.lunging) * worms::flag::LUNGE)
                    | (u8::from(worm.lurking) * worms::flag::LURK);
                // While it burrows out, the "step" is the whole emergence,
                // so clients can show how soon it comes out.
                let step = if worm.emerging(tick) { self.worms.tuning.emerge_ticks } else { worm.step_ticks };
                w.id(worm.id).u8(flags).uvar(step).uvar(tick.saturating_sub(worm.last_step));
                if seen {
                    w.len(worm.body.len() + 1);
                    for &(x, y) in worm.body.iter().chain(std::iter::once(&worm.trail)) {
                        w.coord(x).coord(y);
                    }
                } else {
                    let (x, y) = worm.head();
                    w.len(1).coord(x).coord(y);
                }
            }
        }
        if parts & snap::MONSTERS != 0 {
            w.len(monsters().count());
            for m in monsters() {
                let rising = m.rising(tick);
                let flags = (u8::from(m.chasing) * monsters::flag::CHASING)
                    | (u8::from(rising) * monsters::flag::RISING)
                    | (u8::from(m.hurt_until > tick) * monsters::flag::HURT);
                // While it rises, the "step" is the whole rise.
                let step = if rising { self.monsters.tuning.rise_ticks } else { m.step_ticks };
                let max = self.monsters.tuning.of(m.kind).hp;
                w.id(m.id).u8(m.kind as u8).u8(flags).coord(m.cell.0).coord(m.cell.1).coord(m.from.0).coord(m.from.1);
                w.uvar(step).uvar(tick.saturating_sub(m.last_step)).u8(m.hp).u8(max);
            }
        }
        true
    }

    /// The player's own state in `protocol::ME_FIELDS` order.
    fn me_state(&self, p: &Player, spectating: Option<u32>) -> MeState {
        let tick = self.tick;
        let base = me_state(p, tick, spectating, self.blizzard_until, self.storm_limit());
        let t = |v: u64| v as i64;
        // The soonest sticky bomb riding on this player: its fuse + 1.
        let stuck = self
            .sticky
            .iter()
            .filter_map(|id| self.bombs.get(id))
            .filter(|b| b.attached == p.id)
            .map(|b| b.explode_at.saturating_sub(tick) + 1)
            .min()
            .unwrap_or(0);
        let portal_wait = self.pending_portal(p.id).map_or(0, |k| self.portals[k].until.saturating_sub(tick));
        let mut me = [0; protocol::ME_LEN];
        me[..base.len()].copy_from_slice(&base);
        me[base.len()..].copy_from_slice(&[
            i64::from(p.ability),
            i64::from(p.ability_n),
            i64::from(p.ability_max),
            t(p.ability_recharge_at.saturating_sub(tick)),
            i64::from(p.gas_bombs),
            i64::from(p.sticky_bombs),
            t(stuck),
            i64::from(p.detach_ticks),
            t(p.gassed_until.saturating_sub(tick)),
            i64::from(p.dash_left),
            i64::from(p.dash_dir),
            t(portal_wait),
            // Hearts against monster bites (dungeon arena); 0 elsewhere.
            if self.monsters_on() { i64::from(self.hearts(p)) } else { 0 },
            if self.monsters_on() { i64::from(self.monsters.tuning.player_hp) } else { 0 },
            // Cosmos arena: the blaster's colour and overdrive left; 0 elsewhere.
            if self.mode == super::Mode::Cosmos { i64::from(p.blaster.max(super::cosmos::blaster::STANDARD)) } else { 0 },
            t(p.overdrive_until.saturating_sub(tick)),
        ]);
        me
    }
}

/// Respawn ticks sent for a player out until the next royale match.
const OUT_OF_MATCH: u64 = 1_000_000;

const _: () = assert!(MAX_RANGE < 15, "flame arms are sent as nibbles; 15 | 15 << 4 marks a nuke");
const _: () = assert!(NUKE_RADIUS <= MAX_RANGE, "explosions are sent to clients within MAX_RANGE of their view");
/// First arm byte of an atomic blast in the flames section.
pub const NUKE_MARK: u8 = 0xFF;

/// The first `BASE_ME_LEN` values of the player's own state.
const BASE_ME_LEN: usize = 35;

fn me_state(p: &Player, tick: u64, spectating: Option<u32>, blizzard_until: u64, storm_max: u16) -> [i64; BASE_ME_LEN] {
    let (curse, curse_t) = p.curse(tick);
    let opt_id = |v: Option<u32>| v.map_or(0, |v| i64::from(v) + 1);
    let t = |v: u64| v as i64;
    [
        i64::from(p.ack_seq()),
        i64::from(p.alive),
        i64::from(p.active_bombs),
        t(p.invulnerable_until.saturating_sub(tick)),
        t(p.ghost_until.saturating_sub(tick)),
        i64::from(curse),
        t(curse_t),
        // Out of a royale match: "forever", capped to keep it a sane number.
        t(if p.alive { 0 } else { p.respawn_at.saturating_sub(tick).min(OUT_OF_MATCH) }),
        i64::from(p.score),
        i64::from(p.max_bombs),
        i64::from(p.range),
        i64::from(p.speed_lvl),
        i64::from(p.kick),
        i64::from(p.pierce),
        i64::from(p.remote),
        i64::from(p.line),
        i64::from(p.punch),
        opt_id(p.killed_by),
        opt_id(spectating),
        i64::from(p.aoi.0),
        i64::from(p.aoi.1),
        i64::from(p.team),
        i64::from(p.streak),
        i64::from(p.nukes),
        i64::from(p.jump_left),
        t(p.jump_ready_at.saturating_sub(tick)),
        i64::from(p.gadget),
        i64::from(p.gadget_n),
        i64::from(p.freeze),
        i64::from(p.stomp),
        t(p.stunned_until.saturating_sub(tick)),
        t(blizzard_until.saturating_sub(tick)),
        i64::from(p.carrying),
        i64::from(p.storm),
        i64::from(storm_max),
    ]
}

/// Inclusive tile rectangle a player at (cx, cy) receives updates for.
#[must_use]
pub fn aoi_rect(cx: i32, cy: i32, (hw, hh): (i32, i32)) -> (i32, i32, i32, i32) {
    (cx - hw, cy - hh, cx + hw, cy + hh)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::map::Map;
    use crate::game::rng::Rng;

    /// The per-tick view index finds exactly what looking at every player
    /// and every cell of the view would.
    #[test]
    fn view_index_matches_a_full_scan() {
        let mut rng = Rng::new(5);
        let map = Map::generate(61, 61, 0.45, &mut rng);
        let mut w = World::with_map(map, rng, 200);
        w.set_target_bots(150);
        let mut view = ViewIndex::default();
        let (mut players_seen, mut bombs_seen, mut nukes) = (0, 0, 0);
        for _ in 0..8 {
            for _ in 0..40 {
                w.step();
            }
            // Some atomic bombs, whose zone reaches into views from outside.
            for b in w.bombs.values_mut().step_by(7) {
                b.nuke = true;
                nukes += 1;
            }
            view.build(&w);
            for cy in (0..w.map.h).step_by(5) {
                for cx in (0..w.map.w).step_by(7) {
                    let (x0, y0, x1, y1) = aoi_rect(cx, cy, (9, 6));
                    let mut fast = Vec::new();
                    view.players_in_rect(&w, (x0, y0, x1, y1), &mut fast);
                    fast.sort_unstable_by_key(|e| e.0);
                    let mut full: Vec<_> = w
                        .players
                        .values()
                        .filter(|p| p.alive && (x0..=x1).contains(&p.cell().0) && (y0..=y1).contains(&p.cell().1))
                        .map(|p| player_entry(p, w.tick))
                        .collect();
                    full.sort_unstable_by_key(|e| e.0);
                    assert_eq!(fast, full, "players around ({cx}, {cy})");
                    players_seen += full.len();

                    let mut fast = Vec::new();
                    view.bombs_in_rect(&w, (x0, y0, x1, y1), &mut fast);
                    fast.sort_unstable_by_key(|e| e.0);
                    let m = i32::from(NUKE_RADIUS);
                    let mut full = Vec::new();
                    for y in (y0 - m).max(0)..=(y1 + m).min(w.map.h - 1) {
                        for x in (x0 - m).max(0)..=(x1 + m).min(w.map.w - 1) {
                            let id = w.bomb_grid[w.map.idx(x, y)];
                            if id != 0 && (w.bombs[&id].nuke || (x >= x0 && x <= x1 && y >= y0 && y <= y1)) {
                                full.push(bomb_entry(&w.bombs[&id]));
                            }
                        }
                    }
                    full.sort_unstable_by_key(|e| e.0);
                    assert_eq!(fast, full, "bombs around ({cx}, {cy})");
                    bombs_seen += full.len();
                }
            }
        }
        assert!(players_seen > 1000 && bombs_seen > 200 && nukes > 10, "{players_seen} {bombs_seen} {nukes}");
    }
}
