//! Wire format: MessagePack over binary WebSocket frames. Short keys and
//! tuples-as-arrays keep messages compact.

use axum::body::Bytes;
use serde::{Deserialize, Serialize};

#[derive(Deserialize, Debug)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum ClientMsg {
    Join { name: String },
    /// Held direction: 0 none, 1 up, 2 right, 3 down, 4 left.
    In { d: u8 },
    Bomb,
    /// Client timestamp, echoed back in `pong` for latency measurement.
    Ping { c: f64 },
}

/// Player as seen in a snapshot: id, x*100, y*100, facing, flags.
/// Flags: bit0 moving, bit1 invulnerable.
pub type PlayerView = (u32, i32, i32, u8, u8);
/// Bomb: id, x, y, ticks until detonation.
pub type BombView = (u32, i32, i32, u16);
/// Explosion: centre x, y, arm lengths [up, right, down, left], ticks left.
pub type ExplosionView = (i32, i32, [u8; 4], u8);
/// Item: x, y, kind.
pub type ItemView = (i32, i32, u8);
/// Tile change: x, y, new tile.
pub type TileChange = (i32, i32, u8);

#[derive(Serialize)]
pub struct Me {
    pub alive: bool,
    pub bombs: u8,
    pub active: u8,
    pub range: u8,
    pub speed: u8,
    pub kick: bool,
    pub score: i32,
    /// Ticks until respawn while dead.
    pub respawn: u32,
    pub killer: Option<u32>,
}

#[derive(Serialize)]
#[serde(tag = "t", rename_all = "lowercase")]
pub enum ServerMsg<'a> {
    Welcome {
        id: u32,
        w: i32,
        h: i32,
        /// Run-length encoded tiles: (tile, count) pairs, row-major.
        map: Vec<(u8, u32)>,
        rate: u32,
        /// Half extents of the area of interest in tiles.
        aoi: (i32, i32),
        /// Everyone online: (id, name).
        roster: Vec<(u32, &'a str)>,
    },
    #[serde(rename = "s")]
    Snapshot {
        k: u64,
        p: Vec<PlayerView>,
        b: Vec<BombView>,
        e: Vec<ExplosionView>,
        i: Vec<ItemView>,
        tc: &'a [TileChange],
        me: Me,
    },
    /// A player joined.
    Pj { id: u32, name: &'a str },
    /// A player left.
    Pl { id: u32 },
    /// Someone was blasted. `k` is the bomb owner, if still online.
    Kill { k: Option<u32>, v: u32, x: f32, y: f32 },
    /// Leaderboard: players online and top entries (id, name, score, kills, deaths).
    Lb { n: usize, top: Vec<(u32, &'a str, i32, u32, u32)> },
    Pong { c: f64 },
    Err { m: &'a str },
}

impl ServerMsg<'_> {
    /// Encodes as MessagePack. Structs become maps keyed by field name so
    /// the client can dispatch on `t`; tuples become compact arrays.
    pub fn encode(&self) -> Bytes {
        rmp_serde::to_vec_named(self).expect("server messages always serialize").into()
    }
}

impl ClientMsg {
    pub fn decode(bytes: &[u8]) -> Option<ClientMsg> {
        rmp_serde::from_slice(bytes).ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pack(v: serde_json::Value) -> Vec<u8> {
        rmp_serde::to_vec_named(&v).unwrap()
    }

    #[test]
    fn decodes_client_messages() {
        let join = ClientMsg::decode(&pack(serde_json::json!({"t": "join", "name": "Ann"})));
        assert!(matches!(join, Some(ClientMsg::Join { name }) if name == "Ann"));
        assert!(matches!(ClientMsg::decode(&pack(serde_json::json!({"t": "in", "d": 3}))), Some(ClientMsg::In { d: 3 })));
        assert!(matches!(ClientMsg::decode(&pack(serde_json::json!({"t": "bomb"}))), Some(ClientMsg::Bomb)));
        // JS encodes whole-number timestamps as ints; they must still parse.
        assert!(matches!(ClientMsg::decode(&pack(serde_json::json!({"t": "ping", "c": 1234}))), Some(ClientMsg::Ping { c }) if c == 1234.0));
        assert!(ClientMsg::decode(&[0xc1, 0xff]).is_none());
    }

    #[test]
    fn server_messages_are_tagged_maps() {
        let bytes = ServerMsg::Pong { c: 1.5 }.encode();
        assert!(bytes.starts_with(&[0x82, 0xa1, b't', 0xa4, b'p', b'o', b'n', b'g']));
        let v: serde_json::Value = rmp_serde::from_slice(&bytes).unwrap();
        assert_eq!(v, serde_json::json!({"t": "pong", "c": 1.5}));
        let kill: serde_json::Value = rmp_serde::from_slice(&ServerMsg::Kill { k: None, v: 7, x: 1.5, y: 2.5 }.encode()).unwrap();
        assert_eq!(kill["k"], serde_json::Value::Null);
    }
}
