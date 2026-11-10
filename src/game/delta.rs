//! Delta snapshots: what each client was last sent, and encoding only what
//! changed (see `protocol::snap` for the layout).

use crate::protocol::{ME_LEN, MeState, Wire, snap};

/// A player as a client sees it: id, x*100, y*100, facing, flags.
pub(super) type PlayerEntry = (u32, i32, i32, u8, u16);
/// A bomb as a client sees it: id, x, y, detonation tick (0 = remote), flags.
pub(super) type BombEntry = (u32, i32, i32, u64, u8);
pub(super) const SNAP_HISTORY: usize = 32;

/// What recent snapshots told one client, so the next one can be a delta
/// against whichever snapshot the client confirms it received. The lists
/// keep their capacity, so recording a snapshot doesn't allocate.
pub struct SnapHistory {
    pub(super) ticks: [u64; SNAP_HISTORY],
    pub(super) players: [Vec<PlayerEntry>; SNAP_HISTORY],
    pub(super) bombs: [Vec<BombEntry>; SNAP_HISTORY],
    pub(super) me: [MeState; SNAP_HISTORY],
}

impl Default for SnapHistory {
    fn default() -> Self {
        Self::new()
    }
}

impl SnapHistory {
    /// Pre-sized for a busy view, so recording rarely has to grow a list.
    fn new() -> Self {
        SnapHistory {
            ticks: [0; SNAP_HISTORY],
            players: std::array::from_fn(|_| Vec::with_capacity(96)),
            bombs: std::array::from_fn(|_| Vec::with_capacity(64)),
            me: [[0; ME_LEN]; SNAP_HISTORY],
        }
    }

    /// Slot holding the snapshot for `tick`, if it's still remembered.
    pub(super) fn slot_for(&self, tick: u64) -> Option<usize> {
        let s = (tick % SNAP_HISTORY as u64) as usize;
        (tick != 0 && self.ticks[s] == tick).then_some(s)
    }

    pub(super) fn record(&mut self, tick: u64, cur: &DeltaScratch) {
        let s = (tick % SNAP_HISTORY as u64) as usize;
        self.ticks[s] = tick;
        self.players[s].clear();
        self.players[s].extend_from_slice(&cur.players);
        self.bombs[s].clear();
        self.bombs[s].extend_from_slice(&cur.bombs);
        self.me[s] = cur.me;
    }
}

/// Per-snapshot working state: what the client should see now.
pub(super) struct DeltaScratch {
    pub(super) players: Vec<PlayerEntry>,
    pub(super) bombs: Vec<BombEntry>,
    pub(super) me: MeState,
}

impl Default for DeltaScratch {
    fn default() -> Self {
        DeltaScratch { players: Vec::new(), bombs: Vec::new(), me: [0; ME_LEN] }
    }
}

/// What the client already has: the acknowledged snapshot, or nothing.
pub(super) struct Base<'a> {
    pub(super) players: &'a [PlayerEntry],
    pub(super) bombs: &'a [BombEntry],
    pub(super) me: &'a MeState,
}

pub(super) const EMPTY_ME: MeState = [0; ME_LEN];

pub(super) trait Keyed: Copy + PartialEq {
    fn key(&self) -> u32;
}
impl Keyed for PlayerEntry {
    fn key(&self) -> u32 {
        self.0
    }
}
impl Keyed for BombEntry {
    fn key(&self) -> u32 {
        self.0
    }
}

/// Pairs each entry of `cur` with the entry of `base` that has the same id,
/// if any. Both lists are sorted by id, so this is a single merge pass.
fn matched<'a, E: Keyed>(cur: &'a [E], base: &'a [E]) -> impl Iterator<Item = (&'a E, Option<&'a E>)> {
    let mut j = 0;
    cur.iter().map(move |e| {
        while j < base.len() && base[j].key() < e.key() {
            j += 1;
        }
        (e, base.get(j).filter(|b| b.key() == e.key()))
    })
}

/// Entries of `cur` that are new or differ from `base`, with their old version.
fn changed<'a, E: Keyed>(cur: &'a [E], base: &'a [E]) -> impl Iterator<Item = (&'a E, Option<&'a E>)> {
    matched(cur, base).filter(|(e, b)| *b != Some(*e))
}

/// Ids in `base` that are gone from `cur`.
fn gone<'a, E: Keyed>(cur: &'a [E], base: &'a [E]) -> impl Iterator<Item = u32> {
    matched(base, cur).filter(|(_, c)| c.is_none()).map(|(b, _)| b.key())
}

/// Facing (0..=4) and flags, sent as a varint.
fn look(e: &PlayerEntry) -> u64 {
    u64::from(e.3 & 7) | u64::from(e.4) << 3
}

/// Writes the delta between `cur` and `base` after the snapshot header:
/// the section mask, then each non-empty section. Counting first (a cheap
/// extra merge pass) keeps lengths exact. `flames` writes the flames
/// section (nothing if empty) and returns how many it wrote.
pub(super) fn write_delta(
    w: &mut Wire<'_>,
    tick: u64,
    cur: &DeltaScratch,
    base: &Base<'_>,
    flames: impl Fn(&mut Wire<'_>) -> usize,
    drones: impl Fn(&mut Wire<'_>) -> usize,
    extra: impl Fn(&mut Wire<'_>) -> bool,
) {
    let np = changed(&cur.players, base.players).count();
    let npg = gone(&cur.players, base.players).count();
    let nb = changed(&cur.bombs, base.bombs).count();
    let nbg = gone(&cur.bombs, base.bombs).count();
    let me_mask = cur.me.iter().zip(base.me).enumerate().filter(|(_, (a, b))| a != b).fold(0u64, |m, (i, _)| m | 1 << i);
    let mut sections = 0;
    for (n, bit) in [(np, snap::PLAYERS), (npg, snap::PLAYERS_GONE), (nb, snap::BOMBS), (nbg, snap::BOMBS_GONE)] {
        if n > 0 {
            sections |= bit;
        }
    }
    if me_mask != 0 {
        sections |= snap::ME;
    }
    // `flames` sets its own bit once it knows whether it wrote anything.
    let mask_at = w.0.len();
    w.u8(sections);

    if np > 0 {
        w.len(np);
        let mut prev = 0;
        for (e, b) in changed(&cur.players, base.players) {
            let gap = u64::from(e.0 - prev) << 4;
            prev = e.0;
            match b {
                None => {
                    w.uvar(gap | snap::NEW).ivar(i64::from(e.1)).ivar(i64::from(e.2)).uvar(look(e));
                }
                Some(b) => {
                    let (dx, dy) = (i64::from(e.1) - i64::from(b.1), i64::from(e.2) - i64::from(b.2));
                    let new_look = look(e) != look(b);
                    let header = (u64::from(dx != 0) * snap::DX) | (u64::from(dy != 0) * snap::DY) | (u64::from(new_look) * snap::LOOK);
                    w.uvar(gap | header);
                    if dx != 0 {
                        w.ivar(dx);
                    }
                    if dy != 0 {
                        w.ivar(dy);
                    }
                    if new_look {
                        w.uvar(look(e));
                    }
                }
            }
        }
    }
    if npg > 0 {
        write_ids(w, npg, gone(&cur.players, base.players));
    }
    if nb > 0 {
        w.len(nb);
        let mut prev = 0;
        for (e, _) in changed(&cur.bombs, base.bombs) {
            w.id(e.0 - prev).coord(e.1).coord(e.2).u8(e.4);
            prev = e.0;
            if e.4 & 2 == 0 {
                w.ivar(e.3 as i64 - tick as i64);
            }
        }
    }
    if nbg > 0 {
        write_ids(w, nbg, gone(&cur.bombs, base.bombs));
    }
    if flames(w) > 0 {
        w.0[mask_at] |= snap::FLAMES;
    }
    if drones(w) > 0 {
        w.0[mask_at] |= snap::DRONES;
    }
    if extra(w) {
        w.0[mask_at] |= snap::EXTRA;
    }
    if me_mask != 0 {
        w.uvar(me_mask);
        for (i, v) in cur.me.iter().enumerate() {
            if me_mask >> i & 1 != 0 {
                w.ivar(*v);
            }
        }
    }
}

fn write_ids(w: &mut Wire<'_>, n: usize, ids: impl Iterator<Item = u32>) {
    w.len(n);
    let mut prev = 0;
    for id in ids {
        w.id(id - prev);
        prev = id;
    }
}
