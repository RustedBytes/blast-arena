//! Spatial buckets, per-client snapshots, the leaderboard and sending updates.

use bytes::{Bytes, BytesMut};

use crate::protocol::{self, MeState, Wire};

use super::delta::{Base, DeltaScratch, EMPTY_ME, SnapHistory, write_delta};
use super::player::{MAX_RANGE, Player};
use super::{BUCKET, LEADERBOARD_EVERY, World};

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
    pub(super) fn encode_snapshot(&self, arena: &mut BytesMut, p: &Player, hist: &mut SnapHistory, cur: &mut DeltaScratch) -> Bytes {
        let tick = self.tick;
        // While dead, watch whoever got you.
        let spectating = (!p.alive).then_some(p.killed_by).flatten().and_then(|k| self.players.get(&k)).filter(|k| k.alive && k.id != p.id);
        let (cx, cy) = spectating.map_or(p.cell(), super::player::Player::cell);
        let (x0, y0, x1, y1) = aoi_rect(cx, cy, p.aoi);

        // What the client should see now, sorted by id for diffing.
        cur.players.clear();
        cur.players.extend(self.players_in_rect(x0, y0, x1, y1).filter(|o| o.alive).map(|o| {
            let flags = u8::from(o.moving)
                | u8::from(o.invulnerable_until > tick) << 1
                | u8::from(o.curse(tick).0 != 0) << 2
                | u8::from(o.ghost(tick)) << 3
                | u8::from(o.bounty) << 4;
            (o.id, (o.x * 100.0) as i32, (o.y * 100.0) as i32, o.facing, flags)
        }));
        cur.players.sort_unstable_by_key(|e| e.0);
        cur.bombs.clear();
        let (bx0, by0, bx1, by1) = (x0.max(0), y0.max(0), x1.min(self.map.w - 1), y1.min(self.map.h - 1));
        for y in by0..=by1 {
            for x in bx0..=bx1 {
                let id = self.bomb_grid[self.map.idx(x, y)];
                if id != 0 {
                    let b = &self.bombs[&id];
                    // The absolute detonation tick never changes, so a resting
                    // bomb is identical from one snapshot to the next.
                    let at = if b.remote { 0 } else { b.explode_at };
                    cur.bombs.push((id, x, y, at, u8::from(b.pierce) | u8::from(b.remote) << 1));
                }
            }
        }
        cur.bombs.sort_unstable_by_key(|e| e.0);

        cur.me = me_state(p, tick, spectating.map(|k| k.id));

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
                    // Arm lengths are at most MAX_RANGE, so they fit in a nibble.
                    let a = e.arms.map(|r| r.min(15));
                    w.coord(e.x).coord(e.y).u8(a[0] | a[1] << 4).u8(a[2] | a[3] << 4).uvar(e.until.saturating_sub(tick));
                }
            }
            n
        });
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
        for p in self.players.values() {
            let Some(link) = &p.link else { continue };
            if !broadcasts.iter().all(|m| link.events.try_send(m.clone()).is_ok()) {
                dropped.push(p.id);
                continue;
            }
            let hist = histories.entry(p.id).or_default();
            link.snapshot.publish(self.encode_snapshot(arena, p, hist, &mut delta));
        }
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

const _: () = assert!(MAX_RANGE <= 15, "flame arms are sent as nibbles");

/// The player's own state in `protocol::ME_FIELDS` order.
fn me_state(p: &Player, tick: u64, spectating: Option<u32>) -> MeState {
    let (curse, curse_t) = p.curse(tick);
    let opt_id = |v: Option<u32>| v.map_or(0, |v| i64::from(v) + 1);
    let t = |v: u64| v as i64;
    [
        i64::from(p.input_seq),
        i64::from(p.alive),
        i64::from(p.active_bombs),
        t(p.invulnerable_until.saturating_sub(tick)),
        t(p.ghost_until.saturating_sub(tick)),
        i64::from(curse),
        t(curse_t),
        t(if p.alive { 0 } else { p.respawn_at.saturating_sub(tick) }),
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
    ]
}

/// Inclusive tile rectangle a player at (cx, cy) receives updates for.
#[must_use]
pub fn aoi_rect(cx: i32, cy: i32, (hw, hh): (i32, i32)) -> (i32, i32, i32, i32) {
    (cx - hw, cy - hh, cx + hw, cy + hh)
}
