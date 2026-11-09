//! Wire format: MessagePack over binary WebSocket frames. Short keys and
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

// ------------------------------------------------------------ client → server

#[derive(Debug, PartialEq)]
pub enum ClientMsg<'a> {
    Join { name: &'a str },
    /// Held direction plus a fallback direction (0 none, 1 up, 2 right,
    /// 3 down, 4 left).
    In { d: u8, s: u8 },
    Bomb,
    /// Client timestamp, echoed back in `pong` for latency measurement.
    Ping { c: f64 },
    /// Requested view half extents in tiles.
    View { w: u16, h: u16 },
}

/// Reads one MessagePack value at a time from a byte slice.
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
        Some(self.take(n)?.iter().fold(0u64, |acc, &b| acc << 8 | b as u64))
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
            0x00..=0x7f => Value::Num(b as f64),
            0xe0..=0xff => Value::Num((b as i8) as f64),
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
            0xd0 => Value::Num(self.be(1)? as u8 as i8 as f64),
            0xd1 => Value::Num(self.be(2)? as u16 as i16 as f64),
            0xd2 => Value::Num(self.be(4)? as u32 as i32 as f64),
            0xd3 => Value::Num(self.be(8)? as i64 as f64),
            0xca => Value::Num(f32::from_bits(self.be(4)? as u32) as f64),
            0xcb => Value::Num(f64::from_bits(self.be(8)?)),
            0xc0 | 0xc2 | 0xc3 => Value::Other,
            _ => return None,
        })
    }
}

impl<'a> ClientMsg<'a> {
    /// Parses a client frame without allocating; `None` if malformed.
    pub fn decode(bytes: &'a [u8]) -> Option<ClientMsg<'a>> {
        let mut r = Reader { buf: bytes, pos: 0 };
        let n = r.map_len()?;
        let (mut tag, mut name) = (None, None);
        let (mut d, mut s, mut c, mut w, mut h) = (0.0, 0.0, 0.0, 0.0, 0.0);
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
                _ => {}
            }
        }
        let dir = |v: f64| if (0.0..=4.0).contains(&v) { v as u8 } else { 0 };
        Some(match tag? {
            "join" => ClientMsg::Join { name: name? },
            "in" => ClientMsg::In { d: dir(d), s: dir(s) },
            "bomb" => ClientMsg::Bomb,
            "ping" => ClientMsg::Ping { c },
            "view" => ClientMsg::View { w: w.clamp(0.0, 1000.0) as u16, h: h.clamp(0.0, 1000.0) as u16 },
            _ => return None,
        })
    }
}

// ------------------------------------------------------------ server → client

/// Hand-rolled MessagePack writer appending to a `BytesMut`.
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
        } else if v >= i8::MIN as i64 {
            self.0.put_u8(0xd0);
            self.0.put_i8(v as i8);
        } else if v >= i16::MIN as i64 {
            self.0.put_u8(0xd1);
            self.0.put_i16(v as i16);
        } else if v >= i32::MIN as i64 {
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
            Some(v) => self.uint(v as u64),
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

/// A player joined.
pub fn encode_pj(arena: &mut BytesMut, id: u32, name: &str) -> Bytes {
    Wire(arena).map(3).key("t").str("pj").key("id").uint(id as u64).key("name").str(name);
    finish(arena)
}

/// A player left.
pub fn encode_pl(arena: &mut BytesMut, id: u32) -> Bytes {
    Wire(arena).map(2).key("t").str("pl").key("id").uint(id as u64);
    finish(arena)
}

/// Someone was blasted; `k` is the bomb owner if still online.
pub fn encode_kill(arena: &mut BytesMut, k: Option<u32>, v: u32, x: f32, y: f32) -> Bytes {
    Wire(arena).map(5).key("t").str("kill").key("k").opt_uint(k).key("v").uint(v as u64).key("x").f32(x).key("y").f32(y);
    finish(arena)
}

/// Leaderboard: players online and top entries (id, name, score, kills, deaths).
pub fn encode_lb<'n>(arena: &mut BytesMut, online: usize, top: impl ExactSizeIterator<Item = (u32, &'n str, i32, u32, u32)>) -> Bytes {
    let mut w = Wire(arena);
    w.map(3).key("t").str("lb").key("n").uint(online as u64).key("top").arr(top.len());
    for (id, name, score, kills, deaths) in top {
        w.arr(5).uint(id as u64).str(name).int(score as i64).uint(kills as u64).uint(deaths as u64);
    }
    finish(arena)
}

/// Something happened to this player: a power-up (`f` = item code) or a
/// secret box outcome (`m` true; see `Mystery::code`).
pub fn encode_fx(arena: &mut BytesMut, f: u8, mystery: bool) -> Bytes {
    Wire(arena).map(3).key("t").str("fx").key("f").uint(f as u64).key("m").bool(mystery);
    finish(arena)
}

pub fn encode_pong(arena: &mut BytesMut, c: f64) -> Bytes {
    Wire(arena).map(2).key("t").str("pong").key("c").f64(c);
    finish(arena)
}

/// Rare, larger messages encoded with serde.
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
        /// Default half extents of the area of interest in tiles.
        aoi: (i32, i32),
        /// Largest half extents a client may request when zooming out.
        aoi_max: (i32, i32),
        /// Everyone online: (id, name).
        roster: Vec<(u32, &'a str)>,
    },
    Err { m: &'a str },
}

impl ServerMsg<'_> {
    pub fn encode(&self) -> Bytes {
        rmp_serde::to_vec_named(self).expect("server messages always serialize").into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn pack(v: serde_json::Value) -> Vec<u8> {
        rmp_serde::to_vec_named(&v).unwrap()
    }

    fn unpack(b: &[u8]) -> serde_json::Value {
        rmp_serde::from_slice(b).unwrap()
    }

    #[test]
    fn decodes_client_messages() {
        let join = pack(json!({"t": "join", "name": "Ann"}));
        assert_eq!(ClientMsg::decode(&join), Some(ClientMsg::Join { name: "Ann" }));
        assert_eq!(ClientMsg::decode(&pack(json!({"t": "in", "d": 3, "s": 2}))), Some(ClientMsg::In { d: 3, s: 2 }));
        assert_eq!(ClientMsg::decode(&pack(json!({"t": "in", "d": 3}))), Some(ClientMsg::In { d: 3, s: 0 }));
        assert_eq!(ClientMsg::decode(&pack(json!({"t": "in", "d": 99}))), Some(ClientMsg::In { d: 0, s: 0 }));
        assert_eq!(ClientMsg::decode(&pack(json!({"t": "bomb"}))), Some(ClientMsg::Bomb));
        assert_eq!(ClientMsg::decode(&pack(json!({"t": "view", "w": 20, "h": 14}))), Some(ClientMsg::View { w: 20, h: 14 }));
        // JS encodes whole-number timestamps as ints and others as float64.
        assert_eq!(ClientMsg::decode(&pack(json!({"t": "ping", "c": 1234}))), Some(ClientMsg::Ping { c: 1234.0 }));
        assert_eq!(ClientMsg::decode(&pack(json!({"t": "ping", "c": 12.5}))), Some(ClientMsg::Ping { c: 12.5 }));
        assert_eq!(ClientMsg::decode(&[0xc1, 0xff]), None);
        assert_eq!(ClientMsg::decode(&pack(json!({"t": "nope"}))), None);
        assert_eq!(ClientMsg::decode(&[0x82, 0xa1]), None, "truncated input is rejected");
    }

    /// The hand-written encoder must produce the same values serde would.
    #[test]
    fn manual_encoding_matches_serde() {
        let mut arena = BytesMut::with_capacity(1024);
        assert_eq!(unpack(&encode_pj(&mut arena, 7, "Ann")), json!({"t": "pj", "id": 7, "name": "Ann"}));
        assert_eq!(unpack(&encode_pl(&mut arena, 300)), json!({"t": "pl", "id": 300}));
        assert_eq!(unpack(&encode_kill(&mut arena, None, 70000, 1.5, 2.25)), json!({"t": "kill", "k": null, "v": 70000, "x": 1.5, "y": 2.25}));
        assert_eq!(unpack(&encode_kill(&mut arena, Some(3), 4, 0.5, 0.5))["k"], json!(3));
        assert_eq!(unpack(&encode_pong(&mut arena, 1.5)), json!({"t": "pong", "c": 1.5}));
        assert_eq!(unpack(&encode_fx(&mut arena, 20, true)), json!({"t": "fx", "f": 20, "m": true}));
        let top = [(1, "a", -3, 0, 2), (2, "a-much-longer-name-than-thirty-one-bytes", 200, 5, 70000)];
        assert_eq!(
            unpack(&encode_lb(&mut arena, 2, top.into_iter())),
            json!({"t": "lb", "n": 2, "top": [[1, "a", -3, 0, 2], [2, "a-much-longer-name-than-thirty-one-bytes", 200, 5, 70000]]})
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
