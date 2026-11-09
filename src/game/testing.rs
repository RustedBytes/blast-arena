//! Helpers for tests and benchmarks.

use super::*;

/// A client link plus the receiving ends, for tests and benchmarks.
pub fn test_link() -> (ClientLink, mpsc::Receiver<Bytes>) {
    let (events, rx) = mpsc::channel(link::EVENT_QUEUE);
    let link = ClientLink { events, snapshot: Default::default(), input: Default::default() };
    (link, rx)
}

/// A join request with just a name (tests, benchmarks).
pub fn plain_join(name: &str) -> JoinRequest {
    JoinRequest { name: name.into(), token: None, hat: 0, trail: 0, near: 0, profile: None }
}

#[cfg(test)]
pub fn test_world(map: Map) -> World {
    World::with_map(map, Rng::new(3), 64)
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
        self.players[&id].link.as_ref().unwrap().input.set_dirs(dir, alt, 0);
    }

    /// A full (non-delta) snapshot for player `id`, decoded.
    pub(super) fn full_snapshot(&self, id: u32) -> serde_json::Value {
        let mut arena = BytesMut::new();
        let (mut hist, mut scratch) = (SnapHistory::default(), DeltaScratch::default());
        rmp_serde::from_slice(&self.encode_snapshot(&mut arena, &self.players[&id], &mut hist, &mut scratch)).unwrap()
    }
}
