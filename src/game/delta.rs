//! Delta snapshots: what each client was last sent, and encoding only what changed.

use crate::protocol::Wire;

/// A player as a client sees it: id, x*100, y*100, facing, flags.
pub(super) type PlayerEntry = (u32, i32, i32, u8, u8);
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
        }
    }

    /// Slot holding the snapshot for `tick`, if it's still remembered.
    pub(super) fn slot_for(&self, tick: u64) -> Option<usize> {
        let s = (tick % SNAP_HISTORY as u64) as usize;
        (tick != 0 && self.ticks[s] == tick).then_some(s)
    }

    pub(super) fn record(&mut self, tick: u64, players: &[PlayerEntry], bombs: &[BombEntry]) {
        let s = (tick % SNAP_HISTORY as u64) as usize;
        self.ticks[s] = tick;
        self.players[s].clear();
        self.players[s].extend_from_slice(players);
        self.bombs[s].clear();
        self.bombs[s].extend_from_slice(bombs);
    }
}

/// Per-snapshot working lists.
#[derive(Default)]
pub(super) struct DeltaScratch {
    pub(super) players: Vec<PlayerEntry>,
    pub(super) bombs: Vec<BombEntry>,
}

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

/// Writes `changed`: entries of `cur` that are new or differ from `base`,
/// then `removed`: ids in `base` that are gone from `cur`. Both lists are
/// sorted by id, so this is a single merge pass.
pub(super) fn write_delta<E: Keyed>(w: &mut Wire<'_>, changed: &str, removed: &str, cur: &[E], base: &[E], write: impl Fn(&mut Wire<'_>, &E)) {
    w.key(changed);
    let at = w.open_arr();
    let (mut n, mut j) = (0, 0);
    for e in cur {
        while j < base.len() && base[j].key() < e.key() {
            j += 1;
        }
        if j < base.len() && base[j] == *e {
            continue;
        }
        write(w, e);
        n += 1;
    }
    w.close_arr(at, n);
    w.key(removed);
    let at = w.open_arr();
    let (mut n, mut i) = (0, 0);
    for b in base {
        while i < cur.len() && cur[i].key() < b.key() {
            i += 1;
        }
        if i >= cur.len() || cur[i].key() != b.key() {
            w.uint(u64::from(b.key()));
            n += 1;
        }
    }
    w.close_arr(at, n);
}
