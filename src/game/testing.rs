//! Helpers for tests and benchmarks.

use std::sync::Arc;

use bytes::Bytes;
#[cfg(test)]
use bytes::BytesMut;
use tokio::sync::mpsc;

use super::JoinRequest;
use super::link::{self, ClientLink};
#[cfg(test)]
use super::{World, delta::{DeltaScratch, SnapHistory}, map::Map, player::Player, rng::Rng};

/// A client link plus the receiving ends, for tests and benchmarks.
#[must_use]
pub fn test_link() -> (ClientLink, mpsc::Receiver<Bytes>) {
    let (events, rx) = mpsc::channel(link::EVENT_QUEUE);
    let link = ClientLink { events, snapshot: Arc::default(), input: Arc::default() };
    (link, rx)
}

/// A join request with just a name (tests, benchmarks).
#[must_use]
pub fn plain_join(name: &str) -> JoinRequest {
    JoinRequest { name: name.into(), token: None, hat: 0, trail: 0, near: 0, profile: None }
}

#[cfg(test)]
#[must_use]
pub fn test_world(map: Map) -> World {
    let mut w = World::with_map(map, Rng::new(3), 64);
    // Tests hold one input for many ticks instead of sending one per step.
    w.input_lockstep = false;
    w
}

#[cfg(test)]
impl World {
    pub fn spawn_test_player(&mut self, x: f32, y: f32) -> u32 {
        let (link, rx) = test_link();
        std::mem::forget(rx);
        self.next_player_id += 1;
        let id = self.next_player_id;
        let mut p = Player::new(id, format!("p{id}"), Some(link));
        p.x = x;
        p.y = y;
        p.alive = true;
        self.players.insert(id, p);
        self.rebuild_buckets();
        id
    }

    /// Simulates the client holding `dir` (with fallback `alt`).
    pub(super) fn hold(&mut self, id: u32, dir: u8, alt: u8) {
        self.players[&id].link.as_ref().unwrap().input.set_dirs(dir, alt, false, 0);
    }

    /// A full (non-delta) snapshot for player `id`, encoded.
    pub(super) fn full_snapshot_bytes(&self, id: u32) -> Bytes {
        let mut arena = BytesMut::new();
        let (mut hist, mut scratch) = (SnapHistory::default(), DeltaScratch::default());
        let mut view = super::snapshot::ViewIndex::default();
        view.build(self);
        self.encode_snapshot(&mut arena, &self.players[&id], &view, &mut hist, &mut scratch)
    }

    /// A full (non-delta) snapshot for player `id`, decoded.
    pub(super) fn full_snapshot(&self, id: u32) -> serde_json::Value {
        crate::protocol::testing::SnapDecoder::default().decode(&self.full_snapshot_bytes(id)).unwrap()
    }
}
