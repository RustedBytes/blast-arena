//! The connection between a client's socket tasks and the game task.
//!
//! Input flows through an [`InputSlot`] of atomics: the socket reader
//! overwrites it, and the game reads it once per tick. There is no queue,
//! no allocation and no backlog; for a held direction only the newest
//! value matters anyway. Output goes through a bounded queue for reliable
//! events plus a one-slot [`SnapshotSlot`], so a client that falls behind
//! skips stale snapshots instead of building up a queue of them.

use std::sync::atomic::{AtomicU32, Ordering::Relaxed};
use std::sync::{Arc, Mutex, PoisonError};

use bytes::Bytes;
use tokio::sync::{Notify, mpsc};

#[derive(Default)]
pub struct InputSlot {
    /// Bits 0..3 held direction, bits 3..6 fallback direction, bit 6 jump
    /// held, bits 16..32 the client's input sequence number (echoed back
    /// for prediction).
    dirs: AtomicU32,
    /// Running count of bomb presses.
    bombs: AtomicU32,
    /// Running count of action-key presses (remote detonation, punch).
    acts: AtomicU32,
    /// Running count of gadget-key presses.
    gadgets: AtomicU32,
    /// Latest emote as `count << 8 | emote`.
    emote: AtomicU32,
    /// Requested view half extents as `w << 16 | h`; 0 when never set.
    view: AtomicU32,
    /// Newest snapshot tick the client has decoded (delta baseline).
    ack: AtomicU32,
}

#[must_use]
pub fn pack_dirs(dir: u8, alt: u8, jump: bool, seq: u16) -> u32 {
    u32::from(dir.min(4)) | u32::from(alt.min(4)) << 3 | u32::from(jump) << 6 | u32::from(seq) << 16
}

/// (direction, fallback direction, jump held, sequence number).
#[must_use]
pub fn unpack_dirs(v: u32) -> (u8, u8, bool, u16) {
    ((v & 7) as u8, (v >> 3 & 7) as u8, v & 64 != 0, (v >> 16) as u16)
}

impl InputSlot {
    pub fn set_dirs(&self, dir: u8, alt: u8, jump: bool, seq: u16) {
        self.dirs.store(pack_dirs(dir, alt, jump, seq), Relaxed);
    }

    pub fn dirs(&self) -> (u8, u8, bool, u16) {
        unpack_dirs(self.dirs.load(Relaxed))
    }

    pub fn press_bomb(&self) {
        self.bombs.fetch_add(1, Relaxed);
    }

    pub fn bomb_presses(&self) -> u32 {
        self.bombs.load(Relaxed)
    }

    pub fn set_ack(&self, tick: u32) {
        self.ack.store(tick, Relaxed);
    }

    pub fn ack(&self) -> u32 {
        self.ack.load(Relaxed)
    }

    pub fn press_gadget(&self) {
        self.gadgets.fetch_add(1, Relaxed);
    }

    pub fn gadget_presses(&self) -> u32 {
        self.gadgets.load(Relaxed)
    }

    pub fn press_act(&self) {
        self.acts.fetch_add(1, Relaxed);
    }

    pub fn act_presses(&self) -> u32 {
        self.acts.load(Relaxed)
    }

    pub fn emote(&self, e: u8) {
        let count = (self.emote.load(Relaxed) >> 8).wrapping_add(1);
        self.emote.store(count << 8 | u32::from(e), Relaxed);
    }

    /// (emote count, latest emote).
    pub fn latest_emote(&self) -> (u32, u8) {
        let v = self.emote.load(Relaxed);
        (v >> 8, v as u8)
    }

    pub fn set_view(&self, w: u16, h: u16) {
        self.view.store(u32::from(w) << 16 | u32::from(h), Relaxed);
    }

    pub fn view(&self) -> Option<(i32, i32)> {
        match self.view.load(Relaxed) {
            0 => None,
            v => Some(((v >> 16) as i32, (v & 0xffff) as i32)),
        }
    }
}

/// Holds only the newest snapshot for one client.
#[derive(Default)]
pub struct SnapshotSlot {
    latest: Mutex<Option<Bytes>>,
    notify: Notify,
}

impl SnapshotSlot {
    /// Replaces any snapshot the client hasn't sent yet.
    pub fn publish(&self, snapshot: Bytes) {
        *self.latest.lock().unwrap_or_else(PoisonError::into_inner) = Some(snapshot);
        self.notify.notify_one();
    }

    /// Takes the pending snapshot, if any, without waiting.
    pub fn take(&self) -> Option<Bytes> {
        self.latest.lock().unwrap_or_else(PoisonError::into_inner).take()
    }

    /// Waits for the next snapshot.
    pub async fn next(&self) -> Bytes {
        loop {
            let taken = self.latest.lock().unwrap_or_else(PoisonError::into_inner).take();
            if let Some(snapshot) = taken {
                return snapshot;
            }
            self.notify.notified().await;
        }
    }
}

/// Reliable messages buffered per client. A client that falls this far
/// behind on events (not snapshots, which are coalesced) is disconnected.
pub const EVENT_QUEUE: usize = 256;

/// The game's handle on one connected client.
pub struct ClientLink {
    /// Reliable messages (welcome, joins, kills, leaderboard, effects).
    pub events: mpsc::Sender<Bytes>,
    pub snapshot: Arc<SnapshotSlot>,
    pub input: Arc<InputSlot>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dirs_round_trip() {
        for d in 0..=4 {
            for a in 0..=4 {
                assert_eq!(unpack_dirs(pack_dirs(d, a, d % 2 == 0, 65535)), (d, a, d % 2 == 0, 65535));
            }
        }
        assert_eq!(unpack_dirs(pack_dirs(9, 200, false, 7)), (4, 4, false, 7), "out of range values are clamped");
    }

    #[test]
    fn input_slot_tracks_latest_state() {
        let slot = InputSlot::default();
        assert_eq!(slot.view(), None);
        slot.set_dirs(2, 1, false, 1);
        slot.set_dirs(3, 2, true, 2);
        slot.press_bomb();
        slot.press_bomb();
        slot.press_act();
        slot.emote(4);
        slot.emote(5);
        slot.set_view(20, 14);
        assert_eq!(slot.dirs(), (3, 2, true, 2));
        assert_eq!(slot.act_presses(), 1);
        assert_eq!(slot.latest_emote(), (2, 5));
        assert_eq!(slot.bomb_presses(), 2);
        assert_eq!(slot.view(), Some((20, 14)));
    }

    #[tokio::test]
    async fn snapshot_slot_keeps_only_newest() {
        let slot = SnapshotSlot::default();
        slot.publish(Bytes::from_static(b"old"));
        slot.publish(Bytes::from_static(b"new"));
        assert_eq!(&slot.next().await[..], b"new");
    }
}
