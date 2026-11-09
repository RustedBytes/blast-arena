//! Spatial buckets, per-client snapshots, the leaderboard and sending updates.

use super::*;

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
        let (cx, cy) = spectating.map_or(p.cell(), |k| k.cell());
        let (x0, y0, x1, y1) = aoi_rect(cx, cy, p.aoi);

        // What the client should see now, sorted by id for diffing.
        cur.players.clear();
        cur.players.extend(self.players_in_rect(x0, y0, x1, y1).filter(|o| o.alive).map(|o| {
            let flags = o.moving as u8
                | ((o.invulnerable_until > tick) as u8) << 1
                | ((o.curse(tick).0 != 0) as u8) << 2
                | (o.ghost(tick) as u8) << 3
                | (o.bounty as u8) << 4;
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
                    cur.bombs.push((id, x, y, at, b.pierce as u8 | (b.remote as u8) << 1));
                }
            }
        }
        cur.bombs.sort_unstable_by_key(|e| e.0);

        // Delta against the newest snapshot the client confirmed, if we
        // still remember it; otherwise a full snapshot.
        let base = hist.slot_for(p.snap_ack as u64);
        let mut w = Wire(arena);
        w.map(9).key("t").str("s").key("k").uint(tick).key("bk").uint(base.map_or(0, |s| hist.ticks[s]));
        let (bp, bb): (&[PlayerEntry], &[BombEntry]) = match base {
            Some(s) => (&hist.players[s], &hist.bombs[s]),
            None => (&[], &[]),
        };
        write_delta(&mut w, "p", "pr", &cur.players, bp, |w, e| {
            w.arr(5).uint(e.0 as u64).int(e.1 as i64).int(e.2 as i64).uint(e.3 as u64).uint(e.4 as u64);
        });
        write_delta(&mut w, "b", "br", &cur.bombs, bb, |w, e| {
            w.arr(5).uint(e.0 as u64).int(e.1 as i64).int(e.2 as i64).uint(e.3).uint(e.4 as u64);
        });
        hist.record(tick, &cur.players, &cur.bombs);

        let reach = MAX_RANGE as i32;
        w.key("e");
        let at = w.open_arr();
        let mut n = 0;
        for e in &self.explosions {
            if e.x >= x0 - reach && e.x <= x1 + reach && e.y >= y0 - reach && e.y <= y1 + reach {
                w.arr(4).int(e.x as i64).int(e.y as i64);
                w.arr(4);
                for a in e.arms {
                    w.uint(a as u64);
                }
                w.uint(e.until - tick);
                n += 1;
            }
        }
        w.close_arr(at, n);

        let (curse, curse_t) = p.curse(tick);
        // Positional (see protocol::ME_FIELDS): this block goes out every tick,
        // so key names would be most of its size.
        w.key("me").arr(protocol::ME_FIELDS.len());
        w.bool(p.alive);
        w.uint(p.max_bombs as u64);
        w.uint(p.active_bombs as u64);
        w.uint(p.range as u64);
        w.uint(p.speed_lvl as u64);
        w.bool(p.kick);
        w.bool(p.pierce);
        w.bool(p.remote);
        w.bool(p.line);
        w.bool(p.punch);
        w.uint(p.ghost_until.saturating_sub(tick));
        w.uint(p.invulnerable_until.saturating_sub(tick));
        w.uint(curse as u64);
        w.uint(curse_t);
        w.int(p.score as i64);
        w.uint(if p.alive { 0 } else { p.respawn_at.saturating_sub(tick) });
        w.opt_uint(p.killed_by);
        w.arr(2).int(p.aoi.0 as i64).int(p.aoi.1 as i64);
        w.uint(p.input_seq as u64);
        w.uint(p.team as u64);
        w.uint(p.streak as u64);
        w.opt_uint(spectating.map(|k| k.id));
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

/// Inclusive tile rectangle a player at (cx, cy) receives updates for.
pub fn aoi_rect(cx: i32, cy: i32, (hw, hh): (i32, i32)) -> (i32, i32, i32, i32) {
    (cx - hw, cy - hh, cx + hw, cy + hh)
}
