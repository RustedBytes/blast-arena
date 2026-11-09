//! Wire format: `MessagePack` over binary WebSocket frames. Short keys and
//! tuples-as-arrays keep messages compact.
//!
//! Hot messages (snapshots, joins, kills, leaderboard, effects, pongs) are
//! written by hand with [`Wire`] straight into a reusable `BytesMut` arena,
//! so steady-state encoding allocates nothing. Client messages are parsed
//! in place by [`ClientMsg::decode`], borrowing from the frame. Only the rare
//! welcome and error messages go through serde.

use bytes::{BufMut, Bytes, BytesMut};
use serde::Serialize;

/// Tile change: x, y, new tile.
pub type TileChange = (i32, i32, u8);

/// Order of the values in a snapshot's `me` array (the player's own state).
/// The browser client has the same list.
pub const ME_FIELDS: [&str; 22] = [
    "alive", "bombs", "active", "range", "speed", "kick", "pierce", "remote", "line", "punch", "ghost", "shield",
    "curse", "curse_t", "score", "respawn", "killer", "aoi", "ack", "team", "streak", "spec",
];

// ------------------------------------------------------------ client → server

#[derive(Debug, PartialEq)]
pub enum ClientMsg<'a> {
    /// Joining: display name, the browser's profile token (may be empty),
    /// chosen cosmetics, and optionally a friend to spawn next to.
    Join { name: &'a str, token: &'a str, hat: u8, trail: u8, near: u32 },
    /// Held direction plus a fallback direction (0 none, 1 up, 2 right,
    /// 3 down, 4 left), and the input's sequence number for prediction.
    /// `k` acknowledges the newest snapshot tick decoded (the delta baseline).
    In { d: u8, s: u8, q: u16, k: u32 },
    Bomb,
    /// Action key: detonate remote bombs, or punch the bomb in front.
    Act,
    /// Quick-chat emote.
    Emote { e: u8 },
    /// Client timestamp, echoed back in `pong` for latency measurement.
    Ping { c: f64 },
    /// Requested view half extents in tiles.
    View { w: u16, h: u16 },
}

/// Reads one `MessagePack` value at a time from a byte slice.
struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

enum Value<'a> {
    Num(f64),
    Str(&'a str),
    Other,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        let s = self.buf.get(self.pos..self.pos + n)?;
        self.pos += n;
        Some(s)
    }

    fn u8(&mut self) -> Option<u8> {
        Some(self.take(1)?[0])
    }

    fn be(&mut self, n: usize) -> Option<u64> {
        Some(self.take(n)?.iter().fold(0u64, |acc, &b| acc << 8 | u64::from(b)))
    }

    fn map_len(&mut self) -> Option<usize> {
        match self.u8()? {
            b @ 0x80..=0x8f => Some((b & 0x0f) as usize),
            0xde => Some(self.be(2)? as usize),
            0xdf => Some(self.be(4)? as usize),
            _ => None,
        }
    }

    fn str_body(&mut self, len: usize) -> Option<&'a str> {
        std::str::from_utf8(self.take(len)?).ok()
    }

    fn value(&mut self) -> Option<Value<'a>> {
        let b = self.u8()?;
        Some(match b {
            0x00..=0x7f => Value::Num(f64::from(b)),
            0xe0..=0xff => Value::Num(f64::from(b as i8)),
            0xa0..=0xbf => Value::Str(self.str_body((b & 0x1f) as usize)?),
            0xd9 => {
                let n = self.be(1)? as usize;
                Value::Str(self.str_body(n)?)
            }
            0xda => {
                let n = self.be(2)? as usize;
                Value::Str(self.str_body(n)?)
            }
            0xcc => Value::Num(self.be(1)? as f64),
            0xcd => Value::Num(self.be(2)? as f64),
            0xce => Value::Num(self.be(4)? as f64),
            0xcf => Value::Num(self.be(8)? as f64),
            0xd0 => Value::Num(f64::from(self.be(1)? as u8 as i8)),
            0xd1 => Value::Num(f64::from(self.be(2)? as u16 as i16)),
            0xd2 => Value::Num(f64::from(self.be(4)? as u32 as i32)),
            0xd3 => Value::Num(self.be(8)? as i64 as f64),
            0xca => Value::Num(f64::from(f32::from_bits(self.be(4)? as u32))),
            0xcb => Value::Num(f64::from_bits(self.be(8)?)),
            0xc0 | 0xc2 | 0xc3 => Value::Other,
            _ => return None,
        })
    }
}

impl<'a> ClientMsg<'a> {
    /// Parses a client frame without allocating; `None` if malformed.
    #[must_use]
    #[allow(clippy::many_single_char_names, reason = "locals are named after the one-letter wire keys")]
    pub fn decode(bytes: &'a [u8]) -> Option<ClientMsg<'a>> {
        let mut r = Reader { buf: bytes, pos: 0 };
        let n = r.map_len()?;
        let (mut tag, mut name, mut token) = (None, None, "");
        let (mut d, mut s, mut c, mut w, mut h) = (0.0, 0.0, 0.0, 0.0, 0.0);
        let (mut q, mut e, mut hat, mut trail, mut near, mut k) = (0.0, 0.0, 0.0, 0.0, 0.0, 0.0);
        for _ in 0..n {
            let Value::Str(key) = r.value()? else { return None };
            match (key, r.value()?) {
                ("t", Value::Str(t)) => tag = Some(t),
                ("name", Value::Str(v)) => name = Some(v),
                ("d", Value::Num(v)) => d = v,
                ("s", Value::Num(v)) => s = v,
                ("c", Value::Num(v)) => c = v,
                ("w", Value::Num(v)) => w = v,
                ("h", Value::Num(v)) => h = v,
                ("token", Value::Str(v)) => token = v,
                ("q", Value::Num(v)) => q = v,
                ("k", Value::Num(v)) => k = v,
                ("e", Value::Num(v)) => e = v,
                ("hat", Value::Num(v)) => hat = v,
                ("trail", Value::Num(v)) => trail = v,
                ("near", Value::Num(v)) => near = v,
                _ => {}
            }
        }
        let dir = |v: f64| if (0.0..=4.0).contains(&v) { v as u8 } else { 0 };
        Some(match tag? {
            "join" => ClientMsg::Join {
                name: name?,
                token,
                hat: hat.clamp(0.0, 255.0) as u8,
                trail: trail.clamp(0.0, 255.0) as u8,
                near: near.clamp(0.0, f64::from(u32::MAX)) as u32,
            },
            "in" => ClientMsg::In { d: dir(d), s: dir(s), q: q.clamp(0.0, 65535.0) as u16, k: k.clamp(0.0, f64::from(u32::MAX)) as u32 },
            "bomb" => ClientMsg::Bomb,
            "act" => ClientMsg::Act,
            "emote" => ClientMsg::Emote { e: e.clamp(0.0, 15.0) as u8 },
            "ping" => ClientMsg::Ping { c },
            "view" => ClientMsg::View { w: w.clamp(0.0, 1000.0) as u16, h: h.clamp(0.0, 1000.0) as u16 },
            _ => return None,
        })
    }
}

// ------------------------------------------------------------ server → client

/// Hand-rolled `MessagePack` writer appending to a `BytesMut`.
pub struct Wire<'a>(pub &'a mut BytesMut);

impl Wire<'_> {
    fn len_header(&mut self, len: usize, fix: u8, fix_max: usize, c8: Option<u8>, c16: u8, c32: u8) {
        if len <= fix_max {
            self.0.put_u8(fix | len as u8);
        } else if let (Some(c8), true) = (c8, len < 0x100) {
            self.0.put_u8(c8);
            self.0.put_u8(len as u8);
        } else if len < 0x10000 {
            self.0.put_u8(c16);
            self.0.put_u16(len as u16);
        } else {
            self.0.put_u8(c32);
            self.0.put_u32(len as u32);
        }
    }

    pub fn map(&mut self, len: usize) -> &mut Self {
        self.len_header(len, 0x80, 15, None, 0xde, 0xdf);
        self
    }

    pub fn arr(&mut self, len: usize) -> &mut Self {
        self.len_header(len, 0x90, 15, None, 0xdc, 0xdd);
        self
    }

    /// Starts an array whose length is only known after writing it; finish
    /// with [`Wire::close_arr`]. Uses the fixed-size 32-bit header.
    pub fn open_arr(&mut self) -> usize {
        self.0.put_u8(0xdd);
        let at = self.0.len();
        self.0.put_u32(0);
        at
    }

    pub fn close_arr(&mut self, at: usize, len: usize) {
        self.0[at..at + 4].copy_from_slice(&(len as u32).to_be_bytes());
    }

    pub fn str(&mut self, s: &str) -> &mut Self {
        self.len_header(s.len(), 0xa0, 31, Some(0xd9), 0xda, 0xdb);
        self.0.put_slice(s.as_bytes());
        self
    }

    pub fn uint(&mut self, v: u64) -> &mut Self {
        match v {
            0..=0x7f => self.0.put_u8(v as u8),
            0x80..=0xff => {
                self.0.put_u8(0xcc);
                self.0.put_u8(v as u8);
            }
            0x100..=0xffff => {
                self.0.put_u8(0xcd);
                self.0.put_u16(v as u16);
            }
            0x1_0000..=0xffff_ffff => {
                self.0.put_u8(0xce);
                self.0.put_u32(v as u32);
            }
            _ => {
                self.0.put_u8(0xcf);
                self.0.put_u64(v);
            }
        }
        self
    }

    pub fn int(&mut self, v: i64) -> &mut Self {
        if v >= 0 {
            return self.uint(v as u64);
        }
        if v >= -32 {
            self.0.put_u8(v as i8 as u8);
        } else if v >= i64::from(i8::MIN) {
            self.0.put_u8(0xd0);
            self.0.put_i8(v as i8);
        } else if v >= i64::from(i16::MIN) {
            self.0.put_u8(0xd1);
            self.0.put_i16(v as i16);
        } else if v >= i64::from(i32::MIN) {
            self.0.put_u8(0xd2);
            self.0.put_i32(v as i32);
        } else {
            self.0.put_u8(0xd3);
            self.0.put_i64(v);
        }
        self
    }

    pub fn bool(&mut self, v: bool) -> &mut Self {
        self.0.put_u8(if v { 0xc3 } else { 0xc2 });
        self
    }

    pub fn nil(&mut self) -> &mut Self {
        self.0.put_u8(0xc0);
        self
    }

    pub fn f32(&mut self, v: f32) -> &mut Self {
        self.0.put_u8(0xca);
        self.0.put_f32(v);
        self
    }

    pub fn f64(&mut self, v: f64) -> &mut Self {
        self.0.put_u8(0xcb);
        self.0.put_f64(v);
        self
    }

    /// Map key followed by a value written by the caller.
    pub fn key(&mut self, k: &str) -> &mut Self {
        self.str(k)
    }

    pub fn opt_uint(&mut self, v: Option<u32>) -> &mut Self {
        match v {
            Some(v) => self.uint(u64::from(v)),
            None => self.nil(),
        }
    }
}

/// A ring of encoding arenas used in rotation.
///
/// Messages are zero-copy slices of an arena, so an arena can only be
/// reused once all of its messages have been sent. Rotating through a few
/// arenas gives sockets several ticks to finish; by the time an arena comes
/// round again it is normally free, and `reserve` reclaims its buffer in
/// place instead of allocating.
pub struct ArenaRing {
    arenas: [BytesMut; 3],
    current: usize,
    capacity: usize,
}

impl ArenaRing {
    #[must_use]
    pub fn new(capacity: usize) -> Self {
        ArenaRing { arenas: std::array::from_fn(|_| BytesMut::with_capacity(capacity)), current: 0, capacity }
    }

    /// Moves on to the next arena, making sure it can hold a whole tick.
    pub fn rotate(&mut self) -> &mut BytesMut {
        self.current = (self.current + 1) % self.arenas.len();
        let arena = &mut self.arenas[self.current];
        arena.reserve(self.capacity);
        arena
    }

    pub fn current(&mut self) -> &mut BytesMut {
        &mut self.arenas[self.current]
    }
}

impl Default for ArenaRing {
    /// An empty ring that owns no buffers yet (used while the real ring is
    /// temporarily taken out of its owner).
    fn default() -> Self {
        ArenaRing { arenas: Default::default(), current: 0, capacity: 0 }
    }
}

/// Takes everything written to the arena so far as a shareable message.
/// The bytes are not copied: the returned `Bytes` points into the arena's
/// buffer, which is reused once every message from it has been sent.
pub fn finish(arena: &mut BytesMut) -> Bytes {
    arena.split().freeze()
}

/// A player joined, with their team and cosmetics.
pub fn encode_pj(arena: &mut BytesMut, id: u32, name: &str, team: u8, hat: u8, trail: u8) -> Bytes {
    Wire(arena)
        .map(6)
        .key("t")
        .str("pj")
        .key("id")
        .uint(u64::from(id))
        .key("name")
        .str(name)
        .key("team")
        .uint(u64::from(team))
        .key("hat")
        .uint(u64::from(hat))
        .key("trail")
        .uint(u64::from(trail));
    finish(arena)
}

/// A player left.
pub fn encode_pl(arena: &mut BytesMut, id: u32) -> Bytes {
    Wire(arena).map(2).key("t").str("pl").key("id").uint(u64::from(id));
    finish(arena)
}

/// Someone was blasted; `k` is the bomb owner if still online, `b` whether
/// the victim carried the bounty.
pub fn encode_kill(arena: &mut BytesMut, k: Option<u32>, v: u32, x: f32, y: f32, bounty: bool) -> Bytes {
    Wire(arena)
        .map(6)
        .key("t")
        .str("kill")
        .key("k")
        .opt_uint(k)
        .key("v")
        .uint(u64::from(v))
        .key("x")
        .f32(x)
        .key("y")
        .f32(y)
        .key("b")
        .bool(bounty);
    finish(arena)
}

/// Leaderboard: players online, top entries (id, name, score, kills,
/// deaths), team scores (red, blue) and seconds left in the round.
pub fn encode_lb<'n>(
    arena: &mut BytesMut,
    online: usize,
    top: impl ExactSizeIterator<Item = (u32, &'n str, i32, u32, u32)>,
    teams: (i32, i32),
    round_secs: u32,
) -> Bytes {
    let mut w = Wire(arena);
    w.map(5).key("t").str("lb").key("n").uint(online as u64).key("top").arr(top.len());
    for (id, name, score, kills, deaths) in top {
        w.arr(5).uint(u64::from(id)).str(name).int(i64::from(score)).uint(u64::from(kills)).uint(u64::from(deaths));
    }
    w.key("teams").arr(2).int(i64::from(teams.0)).int(i64::from(teams.1));
    w.key("r").uint(u64::from(round_secs));
    finish(arena)
}

/// Static world changes this tick, sent reliably to everyone: tiles
/// (x, y, tile) and items (x, y, kind, 0 = gone). Snapshots carry only
/// moving things, so these must never be skipped.
pub fn encode_world(arena: &mut BytesMut, tiles: &[(i32, i32, u8)], items: &[(i32, i32, u8)]) -> Bytes {
    let mut w = Wire(arena);
    w.map(3).key("t").str("w").key("tc").arr(tiles.len());
    for &(x, y, t) in tiles {
        w.arr(3).int(i64::from(x)).int(i64::from(y)).uint(u64::from(t));
    }
    w.key("ic").arr(items.len());
    for &(x, y, k) in items {
        w.arr(3).int(i64::from(x)).int(i64::from(y)).uint(u64::from(k));
    }
    finish(arena)
}

/// Something happened to this player: a power-up (`f` = item code) or a
/// secret box outcome (`m` true; see `Mystery::code`).
pub fn encode_fx(arena: &mut BytesMut, f: u8, mystery: bool) -> Bytes {
    Wire(arena).map(3).key("t").str("fx").key("f").uint(u64::from(f)).key("m").bool(mystery);
    finish(arena)
}

/// A player showed a quick-chat emote.
pub fn encode_emote(arena: &mut BytesMut, id: u32, e: u8) -> Bytes {
    Wire(arena).map(3).key("t").str("emote").key("id").uint(u64::from(id)).key("e").uint(u64::from(e));
    finish(arena)
}

/// A player reached a kill streak.
pub fn encode_streak(arena: &mut BytesMut, id: u32, n: u32) -> Bytes {
    Wire(arena).map(3).key("t").str("streak").key("id").uint(u64::from(id)).key("n").uint(u64::from(n));
    finish(arena)
}

/// The hills currently scoring points: centres of 3x3 zones.
pub fn encode_hills(arena: &mut BytesMut, hills: &[(i32, i32)]) -> Bytes {
    let mut w = Wire(arena);
    w.map(2).key("t").str("hills").key("h").arr(hills.len());
    for &(x, y) in hills {
        w.arr(2).int(i64::from(x)).int(i64::from(y));
    }
    finish(arena)
}

/// A round ended: the top players (id, name, score, kills), team scores,
/// the winning team (0 in free-for-all) and the next round's length.
pub fn encode_round<'n>(
    arena: &mut BytesMut,
    mvp: impl ExactSizeIterator<Item = (u32, &'n str, i32, u32)>,
    teams: (i32, i32),
    winner: u8,
    next_secs: u32,
) -> Bytes {
    let mut w = Wire(arena);
    w.map(5).key("t").str("round").key("mvp").arr(mvp.len());
    for (id, name, score, kills) in mvp {
        w.arr(4).uint(u64::from(id)).str(name).int(i64::from(score)).uint(u64::from(kills));
    }
    w.key("teams").arr(2).int(i64::from(teams.0)).int(i64::from(teams.1));
    w.key("win").uint(u64::from(winner));
    w.key("next").uint(u64::from(next_secs));
    finish(arena)
}

pub fn encode_pong(arena: &mut BytesMut, c: f64) -> Bytes {
    Wire(arena).map(2).key("t").str("pong").key("c").f64(c);
    finish(arena)
}

/// What the client knows about its own profile.
#[derive(Serialize)]
pub struct ProfileView {
    pub level: u32,
    pub xp: u64,
    pub next_xp: u64,
    pub kills: u64,
    pub deaths: u64,
    pub wins: u64,
    pub best_streak: u64,
}

/// Rare, larger messages encoded with serde.
#[derive(Serialize)]
#[serde(tag = "t", rename_all = "lowercase")]
#[allow(clippy::large_enum_variant, reason = "built on the stack and encoded at once; boxing would only add an allocation")]
pub enum ServerMsg<'a> {
    Welcome {
        id: u32,
        w: i32,
        h: i32,
        /// Run-length encoded tiles: (tile, count) pairs, row-major.
        map: Vec<(u8, u32)>,
        /// Every item on the map: (x, y, kind). Later changes come in `w`.
        items: Vec<(i32, i32, u8)>,
        rate: u32,
        /// Default half extents of the area of interest in tiles.
        aoi: (i32, i32),
        /// Largest half extents a client may request when zooming out.
        aoi_max: (i32, i32),
        /// Everyone online: (id, name, team, hat, trail).
        roster: Vec<(u32, &'a str, u8, u8, u8)>,
        arena: &'a str,
        /// "ffa" or "teams".
        mode: &'a str,
        team: u8,
        hills: Vec<(i32, i32)>,
        /// Seconds left in the current round.
        round: u32,
        /// True when an earlier session's score and power-ups were restored.
        resumed: bool,
        profile: Option<ProfileView>,
    },
    Err { m: &'a str },
}

impl ServerMsg<'_> {
    /// Encodes the message as `MessagePack`.
    ///
    /// # Panics
    /// Never in practice: these types always serialize.
    #[must_use]
    pub fn encode(&self) -> Bytes {
        rmp_serde::to_vec_named(self).expect("server messages always serialize").into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn pack(v: &serde_json::Value) -> Vec<u8> {
        rmp_serde::to_vec_named(v).unwrap()
    }

    fn unpack(b: &[u8]) -> serde_json::Value {
        rmp_serde::from_slice(b).unwrap()
    }

    #[test]
    fn decodes_client_messages() {
        let join = pack(&json!({"t": "join", "name": "Ann", "token": "tok-123456", "hat": 2, "trail": 1, "near": 9}));
        assert_eq!(ClientMsg::decode(&join), Some(ClientMsg::Join { name: "Ann", token: "tok-123456", hat: 2, trail: 1, near: 9 }));
        let bare = pack(&json!({"t": "join", "name": "Bo"}));
        assert_eq!(ClientMsg::decode(&bare), Some(ClientMsg::Join { name: "Bo", token: "", hat: 0, trail: 0, near: 0 }));
        assert_eq!(ClientMsg::decode(&pack(&json!({"t": "in", "d": 3, "s": 2, "q": 513, "k": 70000}))), Some(ClientMsg::In { d: 3, s: 2, q: 513, k: 70000 }));
        assert_eq!(ClientMsg::decode(&pack(&json!({"t": "in", "d": 3}))), Some(ClientMsg::In { d: 3, s: 0, q: 0, k: 0 }));
        assert_eq!(ClientMsg::decode(&pack(&json!({"t": "in", "d": 99}))), Some(ClientMsg::In { d: 0, s: 0, q: 0, k: 0 }));
        assert_eq!(ClientMsg::decode(&pack(&json!({"t": "bomb"}))), Some(ClientMsg::Bomb));
        assert_eq!(ClientMsg::decode(&pack(&json!({"t": "act"}))), Some(ClientMsg::Act));
        assert_eq!(ClientMsg::decode(&pack(&json!({"t": "emote", "e": 3}))), Some(ClientMsg::Emote { e: 3 }));
        assert_eq!(ClientMsg::decode(&pack(&json!({"t": "view", "w": 20, "h": 14}))), Some(ClientMsg::View { w: 20, h: 14 }));
        // JS encodes whole-number timestamps as ints and others as float64.
        assert_eq!(ClientMsg::decode(&pack(&json!({"t": "ping", "c": 1234}))), Some(ClientMsg::Ping { c: 1234.0 }));
        assert_eq!(ClientMsg::decode(&pack(&json!({"t": "ping", "c": 12.5}))), Some(ClientMsg::Ping { c: 12.5 }));
        assert_eq!(ClientMsg::decode(&[0xc1, 0xff]), None);
        assert_eq!(ClientMsg::decode(&pack(&json!({"t": "nope"}))), None);
        assert_eq!(ClientMsg::decode(&[0x82, 0xa1]), None, "truncated input is rejected");
    }

    /// The hand-written encoder must produce the same values serde would.
    #[test]
    fn manual_encoding_matches_serde() {
        let mut arena = BytesMut::with_capacity(1024);
        assert_eq!(
            unpack(&encode_pj(&mut arena, 7, "Ann", 2, 3, 1)),
            json!({"t": "pj", "id": 7, "name": "Ann", "team": 2, "hat": 3, "trail": 1})
        );
        assert_eq!(unpack(&encode_pl(&mut arena, 300)), json!({"t": "pl", "id": 300}));
        assert_eq!(
            unpack(&encode_kill(&mut arena, None, 70000, 1.5, 2.25, true)),
            json!({"t": "kill", "k": null, "v": 70000, "x": 1.5, "y": 2.25, "b": true})
        );
        assert_eq!(unpack(&encode_kill(&mut arena, Some(3), 4, 0.5, 0.5, false))["k"], json!(3));
        assert_eq!(unpack(&encode_pong(&mut arena, 1.5)), json!({"t": "pong", "c": 1.5}));
        assert_eq!(unpack(&encode_fx(&mut arena, 20, true)), json!({"t": "fx", "f": 20, "m": true}));
        assert_eq!(unpack(&encode_emote(&mut arena, 5, 2)), json!({"t": "emote", "id": 5, "e": 2}));
        assert_eq!(unpack(&encode_streak(&mut arena, 5, 3)), json!({"t": "streak", "id": 5, "n": 3}));
        assert_eq!(unpack(&encode_hills(&mut arena, &[(3, 5), (9, 11)])), json!({"t": "hills", "h": [[3, 5], [9, 11]]}));
        assert_eq!(
            unpack(&encode_world(&mut arena, &[(1, 2, 0)], &[(3, 4, 8), (5, 6, 0)])),
            json!({"t": "w", "tc": [[1, 2, 0]], "ic": [[3, 4, 8], [5, 6, 0]]})
        );
        let top = [(1, "a", -3, 0, 2), (2, "a-much-longer-name-than-thirty-one-bytes", 200, 5, 70000)];
        assert_eq!(
            unpack(&encode_lb(&mut arena, 2, top.into_iter(), (4, -1), 299)),
            json!({"t": "lb", "n": 2, "top": [[1, "a", -3, 0, 2], [2, "a-much-longer-name-than-thirty-one-bytes", 200, 5, 70000]], "teams": [4, -1], "r": 299})
        );
        assert_eq!(
            unpack(&encode_round(&mut arena, [(1, "a", 9, 4)].into_iter(), (10, 7), 1, 300)),
            json!({"t": "round", "mvp": [[1, "a", 9, 4]], "teams": [10, 7], "win": 1, "next": 300})
        );
        let pong = encode_pong(&mut arena, 1.5);
        assert!(pong.starts_with(&[0x82, 0xa1, b't', 0xa4, b'p', b'o', b'n', b'g']), "bots rely on this prefix");
    }

    #[test]
    fn wire_handles_every_integer_width() {
        let mut arena = BytesMut::new();
        let values: [i64; 12] = [0, 127, 128, 255, 256, 65535, 65536, 1 << 40, -1, -32, -33, -100_000];
        {
            let mut w = Wire(&mut arena);
            let at = w.open_arr();
            for v in values {
                w.int(v);
            }
            w.close_arr(at, values.len());
        }
        assert_eq!(unpack(&finish(&mut arena)), json!(values));
    }

    #[test]
    fn arena_reuses_its_buffer() {
        let mut arena = BytesMut::with_capacity(4096);
        let first = encode_pl(&mut arena, 1);
        let ptr = first.as_ptr();
        drop(first);
        // Writing more without the earlier message alive stays in the same block.
        let second = encode_pl(&mut arena, 2);
        assert!(second.as_ptr() > ptr && (second.as_ptr() as usize) < ptr as usize + 4096);
    }
}
