//! Wire format. JSON with short keys and tuples-as-arrays keeps messages
//! compact while staying easy to inspect in the browser dev tools.

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
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("server messages always serialize")
    }
}
