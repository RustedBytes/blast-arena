//! Wire format: a compact binary protocol over binary WebSocket frames.
//!
//! Every frame starts with a one-byte opcode ([`op`] from the server,
//! [`cop`] from the client), followed by fields in a fixed order. There are
//! no keys or type tags; integers are LEB128 varints (signed ones zigzag
//! encoded), so the common small values take a single byte. Strings are a
//! varint byte length followed by UTF-8. Floats are little-endian.
//!
//! Snapshots, the bulk of the traffic, are deltas against the newest
//! snapshot the client acknowledged (see `game::delta`): players that moved
//! send only their position change, resting bombs send nothing, and the
//! player's own state sends only the fields that changed, picked out by a
//! bitmask. Empty sections cost nothing: a section bitmask says which ones
//! follow. The layout is documented on [`snap`].
//!
//! The one-off welcome message keeps a `MessagePack` body after its opcode
//! (it's large and irregular, and sent once per join).
//!
//! Server messages are written by hand with [`Wire`] straight into a
//! reusable `BytesMut` arena, so steady-state encoding allocates nothing.
//! Client messages are parsed in place by [`ClientMsg::decode`], borrowing
//! from the frame.

use bytes::{BufMut, Bytes, BytesMut};
use serde::Serialize;

/// Tile change: x, y, new tile.
pub type TileChange = (i32, i32, u8);

/// Server → client opcodes: the first byte of every server frame.
pub mod op {
    /// `MessagePack` body: see [`super::Welcome`].
    pub const WELCOME: u8 = 1;
    /// str message.
    pub const ERR: u8 = 2;
    /// See [`super::snap`].
    pub const SNAP: u8 = 3;
    /// Player joined: id, str name, u8 team, u8 hat, u8 trail.
    pub const PJ: u8 = 4;
    /// Player left: id.
    pub const PL: u8 = 5;
    /// Kill: killer id + 1 (0 = none), victim id, ivar x*100, ivar y*100, u8 bounty.
    pub const KILL: u8 = 6;
    /// Leaderboard: online, n, n × (id, str name, ivar score, kills, deaths),
    /// ivar red, ivar blue, round seconds left.
    pub const LB: u8 = 7;
    /// World changes: n, n × (x, y, u8 tile), n, n × (x, y, u8 item; 0 = gone).
    pub const WORLD: u8 = 8;
    /// Effect: u8 code, u8 mystery.
    pub const FX: u8 = 9;
    /// Emote: id, u8 emote.
    pub const EMOTE: u8 = 10;
    /// Kill streak: id, n.
    pub const STREAK: u8 = 11;
    /// Hills: n, n × (x, y).
    pub const HILLS: u8 = 12;
    /// Round over: n, n × (id, str name, ivar score, kills), ivar red,
    /// ivar blue, u8 winner, next round seconds.
    pub const ROUND: u8 = 13;
    /// Ping echo: f64 client timestamp.
    pub const PONG: u8 = 14;
    /// A game event: u8 kind (see [`super::ev`]), then a list of ivars.
    pub const EVENT: u8 = 15;
}

/// Client → server opcodes: the first byte of every client frame.
pub mod cop {
    /// str name, str token, u8 hat, u8 trail, near.
    pub const JOIN: u8 = 1;
    /// u8 `dir | alt << 3`, seq, ack tick.
    pub const IN: u8 = 2;
    pub const BOMB: u8 = 3;
    pub const ACT: u8 = 4;
    /// u8 emote.
    pub const EMOTE: u8 = 5;
    /// f64 timestamp.
    pub const PING: u8 = 6;
    /// Half extents w, h.
    pub const VIEW: u8 = 7;
    /// Use the held gadget.
    pub const GADGET: u8 = 8;
    /// Use the held ability (builder, clone, portal pair, dash).
    pub const ABILITY: u8 = 9;
    /// Cancel a half-placed ability (the first portal of a pair).
    pub const CANCEL: u8 = 10;
}

/// Kinds of [`op::EVENT`] messages and their values.
pub mod ev {
    /// Sudden death: centre x, y, open radius (cells farther than this in
    /// Chebyshev distance are stone), ticks until the next ring closes, and
    /// 1 while active (0 when it ends).
    pub const SHRINK: u8 = 1;
    /// A map event starts: kind (1 meteor shower, 2 blizzard, 3 lava surge,
    /// 4 conveyors reversed), seconds it lasts.
    pub const ANNOUNCE: u8 = 2;
    /// Meteor strikes: (x, y, ticks until impact) triples.
    pub const STRIKES: u8 = 3;
    /// Lava surge: ticks until it erupts, ticks it burns, then (x, y) pairs.
    pub const LAVA: u8 = 4;
    /// Capture the flag: per team (red, blue): base x, base y, state (0 at
    /// base, 1 carried, 2 dropped), x, y, carrier id + 1; then captures.
    pub const FLAGS: u8 = 5;
    /// A flag moment: what (1 taken, 2 dropped, 3 returned, 4 captured),
    /// whose flag (team), player id + 1.
    pub const FLAG_NEWS: u8 = 6;
    /// Two players swapped places: their ids.
    pub const SWAP: u8 = 7;
    /// Battle royale zone: state (0 next circle shown, 1 closing in, 2
    /// over), ticks left in that state, the zone (x, y, radius; closing in
    /// from here) and the next circle, in hundredths of a tile; the phase.
    pub const ZONE: u8 = 8;
    /// Battle royale match: players alive, 1 while a match runs, ticks until
    /// the next match.
    pub const ROYALE: u8 = 9;
    /// A battle royale match was won: the winner's id + 1 (0 for nobody).
    pub const WINNER: u8 = 10;
    /// An ability event: sub-kind (see `game::abilities::ab`), server
    /// tick, then that kind's values.
    pub const ABILITY: u8 = 11;
    /// Worms arena news: what (1 a worm ate a player, 2 a worm was killed,
    /// 3 a blast cut a worm in two), x, y, then the player (the one eaten,
    /// or whose fire did it) id + 1, 0 for nobody. A meal arrives just
    /// before the victim's kill message.
    pub const WORM: u8 = 12;
}

/// Snapshot layout (opcode [`op::SNAP`]):
///
/// ```text
/// tick, tick - base tick (0 = full snapshot), u8 sections,
/// [PLAYERS]      n, n × player
/// [PLAYERS_GONE] n, n × id gap
/// [BOMBS]        n, n × (id gap, x, y, u8 flags, [not remote] ivar fuse ticks)
/// [BOMBS_GONE]   n, n × id gap
/// [FLAMES]       n, n × (x, y, u8 arm0 | arm1 << 4, u8 arm2 | arm3 << 4, ticks left)
///                an atomic blast is (x, y, 0xFF, u8 radius, ticks left)
/// [DRONES]       n, n × (id, ivar x, ivar y in hundredths, u8 team)
/// [EXTRA]        u8 parts, then each part present (sent whole, not as deltas):
///   [GAS]        n, n × (id, x, y, u8 arm0 | arm1 << 4, u8 arm2 | arm3 << 4, ticks left)
///   [PORTALS]    n, n × (id, x, y, owner id, partner id (0 waiting), ticks left)
///   [CLONES]     n, n × (id, owner id, ivar x, ivar y in hundredths, look)
///   [DECOYS]     n, n × (id, x, y, ivar fuse ticks shown)
///   [STUCK]      n, n × (bomb id, carrier id)
///   [WORMS]      n, n × (id, u8 flags, ticks per step, ticks since the
///                last step, n cells, n × (x, y)): every worm in the arena.
///                Cells are head first, then the cell the tail just left;
///                a worm out of view (flag FAR) sends only its head. Flags:
///                1 chasing, 2 emerging (the step is then the whole
///                emergence), 4 far, 8 lunging, 16 lying in wait.
/// [ME]           changed-field mask, one ivar per set bit (see ME_FIELDS)
/// ```
///
/// Lists are sorted by id and carry the gap from the previous id. A player
/// is `varint(gap << 4 | header)`, then by header bit: `NEW` gives ivar x,
/// ivar y and the look (`varint(facing | flags << 3)`) in full; otherwise
/// `DX`/`DY` give ivar position changes and `LOOK` a new look. Flags:
/// moving, shield, cursed, ghost, bounty, jumping, stunned, carrying a
/// flag, dashing, gassed. Bomb flags: pierce, remote, nuke, freeze, rocket,
/// mine, sticky, gas. A clone's look is a player's: facing | flags << 3.
/// Positions are hundredths of a tile.
pub mod snap {
    pub const PLAYERS: u8 = 1;
    pub const PLAYERS_GONE: u8 = 2;
    pub const BOMBS: u8 = 4;
    pub const BOMBS_GONE: u8 = 8;
    pub const FLAMES: u8 = 16;
    pub const ME: u8 = 32;
    pub const DRONES: u8 = 64;
    pub const EXTRA: u8 = 128;

    /// Parts of the `EXTRA` section.
    pub const GAS: u8 = 1;
    pub const PORTALS: u8 = 2;
    pub const CLONES: u8 = 4;
    pub const DECOYS: u8 = 8;
    pub const STUCK: u8 = 16;
    pub const WORMS: u8 = 32;

    pub const DX: u64 = 1;
    pub const DY: u64 = 2;
    pub const LOOK: u64 = 4;
    pub const NEW: u64 = 8;
}

/// Order of the values in a snapshot's `me` block (the player's own state),
/// most frequently changing first so the change mask stays one byte.
/// Booleans are 0/1; `killer` and `spec` are id + 1 (0 = none). The
/// browser client has the same list.
pub const ME_FIELDS: [&str; ME_LEN] = [
    "ack", "alive", "active", "shield", "ghost", "curse", "curse_t", "respawn", "score", "bombs", "range", "speed",
    "kick", "pierce", "remote", "line", "punch", "killer", "spec", "aoi_w", "aoi_h", "team", "streak", "nukes",
    "jump", "jump_cd", "gadget", "gadget_n", "freeze", "stomp", "stun", "blizzard", "carrying", "storm", "storm_max",
    "ability", "ability_n", "ability_max", "ability_cd", "gas_bombs", "sticky_bombs", "stuck", "detach", "gassed", "dash",
    "dash_dir", "portal_wait",
];
pub const ME_LEN: usize = 47;
/// The player's own state as sent: values in [`ME_FIELDS`] order.
pub type MeState = [i64; ME_LEN];

// ------------------------------------------------------------ primitives

/// Hand-rolled writer appending to a `BytesMut`.
pub struct Wire<'a>(pub &'a mut BytesMut);

impl Wire<'_> {
    pub fn u8(&mut self, v: u8) -> &mut Self {
        self.0.put_u8(v);
        self
    }

    /// Unsigned LEB128 varint.
    pub fn uvar(&mut self, mut v: u64) -> &mut Self {
        while v >= 0x80 {
            self.0.put_u8(v as u8 | 0x80);
            v >>= 7;
        }
        self.0.put_u8(v as u8);
        self
    }

    /// Zigzag-encoded signed varint: small magnitudes of either sign are short.
    pub fn ivar(&mut self, v: i64) -> &mut Self {
        self.uvar(((v << 1) ^ (v >> 63)) as u64)
    }

    pub fn id(&mut self, v: u32) -> &mut Self {
        self.uvar(u64::from(v))
    }

    /// An optional id as id + 1, with 0 for none.
    pub fn opt_id(&mut self, v: Option<u32>) -> &mut Self {
        self.uvar(v.map_or(0, |v| u64::from(v) + 1))
    }

    /// A list length.
    pub fn len(&mut self, n: usize) -> &mut Self {
        self.uvar(n as u64)
    }

    /// A tile coordinate (never negative on the map).
    pub fn coord(&mut self, v: i32) -> &mut Self {
        self.uvar(v.max(0) as u64)
    }

    pub fn str(&mut self, s: &str) -> &mut Self {
        self.len(s.len());
        self.0.put_slice(s.as_bytes());
        self
    }

    pub fn bool(&mut self, v: bool) -> &mut Self {
        self.u8(u8::from(v))
    }

    pub fn f64(&mut self, v: f64) -> &mut Self {
        self.0.put_f64_le(v);
        self
    }
}

/// Reads protocol values from a byte slice; every read is bounds-checked.
pub struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    #[must_use]
    pub fn new(buf: &'a [u8]) -> Self {
        Reader { buf, pos: 0 }
    }

    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        let s = self.buf.get(self.pos..self.pos.checked_add(n)?)?;
        self.pos += n;
        Some(s)
    }

    pub fn u8(&mut self) -> Option<u8> {
        Some(self.take(1)?[0])
    }

    /// Unsigned varint; `None` if truncated or wider than 64 bits.
    pub fn uvar(&mut self) -> Option<u64> {
        let mut v = 0u64;
        for shift in (0..64).step_by(7) {
            let b = self.u8()?;
            v |= u64::from(b & 0x7f) << shift;
            if b < 0x80 {
                return Some(v);
            }
        }
        None
    }

    pub fn ivar(&mut self) -> Option<i64> {
        let v = self.uvar()?;
        Some((v >> 1) as i64 ^ -((v & 1) as i64))
    }

    pub fn str(&mut self) -> Option<&'a str> {
        let n = usize::try_from(self.uvar()?).ok()?;
        std::str::from_utf8(self.take(n)?).ok()
    }

    pub fn f64(&mut self) -> Option<f64> {
        Some(f64::from_le_bytes(self.take(8)?.try_into().ok()?))
    }

    /// Whether everything has been read.
    #[must_use]
    pub fn done(&self) -> bool {
        self.pos == self.buf.len()
    }
}

// ------------------------------------------------------------ client → server

#[derive(Debug, PartialEq)]
pub enum ClientMsg<'a> {
    /// Joining: display name, the browser's profile token (may be empty),
    /// chosen cosmetics, and optionally a friend to spawn next to.
    Join { name: &'a str, token: &'a str, hat: u8, trail: u8, near: u32 },
    /// Held direction plus a fallback direction (0 none, 1 up, 2 right,
    /// 3 down, 4 left), whether the jump key is held (`j`) and the detach
    /// key (`h`, shaking off a sticky bomb), and the input's sequence number
    /// for prediction. `k` acknowledges the newest snapshot tick decoded
    /// (the delta baseline).
    In { d: u8, s: u8, j: bool, h: bool, q: u16, k: u32 },
    Bomb,
    /// Action key: detonate remote bombs, or punch the bomb in front.
    Act,
    /// Gadget key: use the held gadget (mine, rocket, swap, drones).
    Gadget,
    /// Ability key: use the held ability. Which one is the server's
    /// business (the player's inventory), so the client can't name another.
    Ability,
    /// Withdraw a half-placed ability (a lone first portal).
    Cancel,
    /// Quick-chat emote.
    Emote { e: u8 },
    /// Client timestamp, echoed back in `pong` for latency measurement.
    Ping { c: f64 },
    /// Requested view half extents in tiles.
    View { w: u16, h: u16 },
}

impl<'a> ClientMsg<'a> {
    /// Parses a client frame without allocating; `None` if malformed.
    /// Out-of-range values are clamped.
    #[must_use]
    pub fn decode(bytes: &'a [u8]) -> Option<ClientMsg<'a>> {
        let mut r = Reader::new(bytes);
        let dir = |v: u8| if v <= 4 { v } else { 0 };
        let clamp = |v: u64, max: u64| v.min(max);
        Some(match r.u8()? {
            cop::JOIN => ClientMsg::Join {
                name: r.str()?,
                token: r.str()?,
                hat: r.u8()?,
                trail: r.u8()?,
                near: clamp(r.uvar()?, u64::from(u32::MAX)) as u32,
            },
            cop::IN => {
                let b = r.u8()?;
                ClientMsg::In {
                    d: dir(b & 7),
                    s: dir(b >> 3 & 7),
                    j: b & 64 != 0,
                    h: b & 128 != 0,
                    q: clamp(r.uvar()?, 0xffff) as u16,
                    k: clamp(r.uvar()?, u64::from(u32::MAX)) as u32,
                }
            }
            cop::BOMB => ClientMsg::Bomb,
            cop::ACT => ClientMsg::Act,
            cop::GADGET => ClientMsg::Gadget,
            cop::ABILITY => ClientMsg::Ability,
            cop::CANCEL => ClientMsg::Cancel,
            cop::EMOTE => ClientMsg::Emote { e: r.u8()?.min(15) },
            cop::PING => ClientMsg::Ping { c: r.f64()? },
            cop::VIEW => ClientMsg::View { w: clamp(r.uvar()?, 1000) as u16, h: clamp(r.uvar()?, 1000) as u16 },
            _ => return None,
        })
    }

    /// Encodes the message as a client would (bots, tests).
    #[must_use]
    pub fn encode(&self) -> Bytes {
        let mut buf = BytesMut::with_capacity(32);
        let mut w = Wire(&mut buf);
        match *self {
            ClientMsg::Join { name, token, hat, trail, near } => {
                w.u8(cop::JOIN).str(name).str(token).u8(hat).u8(trail).id(near);
            }
            ClientMsg::In { d, s, j, h, q, k } => {
                w.u8(cop::IN).u8(d & 7 | (s & 7) << 3 | u8::from(j) << 6 | u8::from(h) << 7).uvar(u64::from(q)).id(k);
            }
            ClientMsg::Bomb => {
                w.u8(cop::BOMB);
            }
            ClientMsg::Act => {
                w.u8(cop::ACT);
            }
            ClientMsg::Gadget => {
                w.u8(cop::GADGET);
            }
            ClientMsg::Ability => {
                w.u8(cop::ABILITY);
            }
            ClientMsg::Cancel => {
                w.u8(cop::CANCEL);
            }
            ClientMsg::Emote { e } => {
                w.u8(cop::EMOTE).u8(e);
            }
            ClientMsg::Ping { c } => {
                w.u8(cop::PING).f64(c);
            }
            ClientMsg::View { w: vw, h } => {
                w.u8(cop::VIEW).uvar(u64::from(vw)).uvar(u64::from(h));
            }
        }
        buf.freeze()
    }
}

// ------------------------------------------------------------ server → client

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
    Wire(arena).u8(op::PJ).id(id).str(name).u8(team).u8(hat).u8(trail);
    finish(arena)
}

/// A player left.
pub fn encode_pl(arena: &mut BytesMut, id: u32) -> Bytes {
    Wire(arena).u8(op::PL).id(id);
    finish(arena)
}

/// Someone was blasted at (x, y); `k` is the bomb owner if still online,
/// `bounty` whether the victim carried the bounty.
pub fn encode_kill(arena: &mut BytesMut, k: Option<u32>, v: u32, x: f32, y: f32, bounty: bool) -> Bytes {
    Wire(arena)
        .u8(op::KILL)
        .opt_id(k)
        .id(v)
        .ivar((x * 100.0).round() as i64)
        .ivar((y * 100.0).round() as i64)
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
    w.u8(op::LB).len(online).len(top.len());
    for (id, name, score, kills, deaths) in top {
        w.id(id).str(name).ivar(i64::from(score)).id(kills).id(deaths);
    }
    w.ivar(i64::from(teams.0)).ivar(i64::from(teams.1)).id(round_secs);
    finish(arena)
}

/// Static world changes this tick, sent reliably to everyone: tiles
/// (x, y, tile) and items (x, y, kind, 0 = gone). Snapshots carry only
/// moving things, so these must never be skipped.
pub fn encode_world(arena: &mut BytesMut, tiles: &[(i32, i32, u8)], items: &[(i32, i32, u8)]) -> Bytes {
    let mut w = Wire(arena);
    w.u8(op::WORLD);
    for list in [tiles, items] {
        w.len(list.len());
        for &(x, y, t) in list {
            w.coord(x).coord(y).u8(t);
        }
    }
    finish(arena)
}

/// Something happened to this player: a power-up (`f` = item code) or a
/// secret box outcome (`mystery`; see `Mystery::code`).
pub fn encode_fx(arena: &mut BytesMut, f: u8, mystery: bool) -> Bytes {
    Wire(arena).u8(op::FX).u8(f).bool(mystery);
    finish(arena)
}

/// A player showed a quick-chat emote.
pub fn encode_emote(arena: &mut BytesMut, id: u32, e: u8) -> Bytes {
    Wire(arena).u8(op::EMOTE).id(id).u8(e);
    finish(arena)
}

/// A player reached a kill streak.
pub fn encode_streak(arena: &mut BytesMut, id: u32, n: u32) -> Bytes {
    Wire(arena).u8(op::STREAK).id(id).id(n);
    finish(arena)
}

/// The hills currently scoring points: centres of 3x3 zones.
pub fn encode_hills(arena: &mut BytesMut, hills: &[(i32, i32)]) -> Bytes {
    let mut w = Wire(arena);
    w.u8(op::HILLS).len(hills.len());
    for &(x, y) in hills {
        w.coord(x).coord(y);
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
    w.u8(op::ROUND).len(mvp.len());
    for (id, name, score, kills) in mvp {
        w.id(id).str(name).ivar(i64::from(score)).id(kills);
    }
    w.ivar(i64::from(teams.0)).ivar(i64::from(teams.1)).u8(winner).id(next_secs);
    finish(arena)
}

/// A game event of `kind` (see [`ev`]) with its values.
pub fn encode_event(arena: &mut BytesMut, kind: u8, values: &[i64]) -> Bytes {
    let mut w = Wire(arena);
    w.u8(op::EVENT).u8(kind).len(values.len());
    for &v in values {
        w.ivar(v);
    }
    finish(arena)
}

pub fn encode_pong(arena: &mut BytesMut, c: f64) -> Bytes {
    Wire(arena).u8(op::PONG).f64(c);
    finish(arena)
}

/// The join was refused.
#[must_use]
pub fn encode_err(m: &str) -> Bytes {
    let mut buf = BytesMut::with_capacity(m.len() + 4);
    Wire(&mut buf).u8(op::ERR).str(m);
    buf.freeze()
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

/// The first message after joining: everything a client needs to start.
/// Sent once, so its body is plain `MessagePack` (via serde) after the opcode.
#[derive(Serialize)]
pub struct Welcome<'a> {
    pub id: u32,
    pub w: i32,
    pub h: i32,
    /// Run-length encoded tiles: (tile, count) pairs, row-major.
    pub map: Vec<(u8, u32)>,
    /// Region centres: (x, y as fractions of the map size, biome code);
    /// a cell takes the biome of the nearest centre.
    pub biomes: Vec<(f32, f32, u8)>,
    /// Every item on the map: (x, y, kind). Later changes come in `w`.
    pub items: Vec<(i32, i32, u8)>,
    pub rate: u32,
    /// Default half extents of the area of interest in tiles.
    pub aoi: (i32, i32),
    /// Largest half extents a client may request when zooming out.
    pub aoi_max: (i32, i32),
    /// Everyone online: (id, name, team, hat, trail).
    pub roster: Vec<(u32, &'a str, u8, u8, u8)>,
    pub arena: &'a str,
    /// "ffa" or "teams".
    pub mode: &'a str,
    pub team: u8,
    pub hills: Vec<(i32, i32)>,
    /// Seconds left in the current round.
    pub round: u32,
    /// True when an earlier session's score and power-ups were restored.
    pub resumed: bool,
    pub profile: Option<ProfileView>,
    /// Ability tuning the client needs to predict and display them.
    pub abilities: AbilityInfo,
}

/// Ability tuning sent once on join (ticks unless noted).
#[derive(Serialize, Default)]
pub struct AbilityInfo {
    /// Protocol version of the ability messages.
    pub v: u32,
    /// Cooldown per active ability: (item code, ticks).
    pub cooldowns: Vec<(u8, u64)>,
    pub wall: u64,
    pub gas: u64,
    pub gas_fuse: u64,
    /// Gas movement multiplier.
    pub gas_mult: f32,
    pub clone: u64,
    pub portal: u64,
    pub portal_wait: u64,
    pub sticky_fuse: u64,
    pub detach: u64,
    pub dash: u64,
    /// Cells a dash covers per tick.
    pub dash_step: f32,
    /// Item codes of abilities switched off.
    pub disabled: Vec<u8>,
}

impl Welcome<'_> {
    /// # Panics
    /// Never in practice: these types always serialize.
    #[must_use]
    pub fn encode(&self) -> Bytes {
        let mut buf = vec![op::WELCOME];
        rmp_serde::encode::write_named(&mut buf, self).expect("welcome always serializes");
        buf.into()
    }
}

/// The tick of a snapshot frame, read without decoding the rest (bots).
#[must_use]
pub fn peek_snapshot_tick(frame: &[u8]) -> Option<u64> {
    let mut r = Reader::new(frame);
    (r.u8()? == op::SNAP).then_some(())?;
    r.uvar()
}

/// The echoed timestamp of a pong frame (bots).
#[must_use]
pub fn peek_pong(frame: &[u8]) -> Option<f64> {
    let mut r = Reader::new(frame);
    (r.u8()? == op::PONG).then_some(())?;
    r.f64()
}

#[cfg(test)]
#[allow(clippy::many_single_char_names, reason = "short reader helpers keep the decoder close to the wire layout")]
pub mod testing {
    //! A reference decoder for server frames, mirroring the browser's,
    //! producing JSON values for assertions.

    use std::collections::HashMap;

    use serde_json::{Value, json};

    use super::{ME_LEN, MeState, Reader, op, snap};

    /// Decodes a non-snapshot server frame into a JSON object tagged `t`.
    ///
    /// # Panics
    /// On malformed input or a snapshot frame.
    #[must_use]
    pub fn decode(frame: &[u8]) -> Value {
        let mut r = Reader::new(frame);
        let id = |r: &mut Reader| r.uvar().unwrap();
        let s = |r: &mut Reader| r.str().unwrap().to_string();
        let i = |r: &mut Reader| r.ivar().unwrap();
        let u = |r: &mut Reader| r.u8().unwrap();
        let v = match r.u8().unwrap() {
            op::WELCOME => {
                let mut v: Value = rmp_serde::from_slice(&frame[1..]).unwrap();
                v["t"] = json!("welcome");
                return v;
            }
            op::ERR => json!({"t": "err", "m": s(&mut r)}),
            op::PJ => json!({"t": "pj", "id": id(&mut r), "name": s(&mut r), "team": u(&mut r), "hat": u(&mut r), "trail": u(&mut r)}),
            op::PL => json!({"t": "pl", "id": id(&mut r)}),
            op::KILL => {
                let k = id(&mut r);
                json!({"t": "kill", "k": k.checked_sub(1), "v": id(&mut r), "x": i(&mut r) as f64 / 100.0, "y": i(&mut r) as f64 / 100.0, "b": u(&mut r) != 0})
            }
            op::LB => {
                let n = id(&mut r);
                let top: Vec<Value> = (0..id(&mut r)).map(|_| json!([id(&mut r), s(&mut r), i(&mut r), id(&mut r), id(&mut r)])).collect();
                json!({"t": "lb", "n": n, "top": top, "teams": [i(&mut r), i(&mut r)], "r": id(&mut r)})
            }
            op::WORLD => {
                let list = |r: &mut Reader| (0..id(r)).map(|_| json!([id(r), id(r), u(r)])).collect::<Vec<_>>();
                json!({"t": "w", "tc": list(&mut r), "ic": list(&mut r)})
            }
            op::FX => json!({"t": "fx", "f": u(&mut r), "m": u(&mut r) != 0}),
            op::EMOTE => json!({"t": "emote", "id": id(&mut r), "e": u(&mut r)}),
            op::STREAK => json!({"t": "streak", "id": id(&mut r), "n": id(&mut r)}),
            op::HILLS => json!({"t": "hills", "h": (0..id(&mut r)).map(|_| json!([id(&mut r), id(&mut r)])).collect::<Vec<_>>()}),
            op::ROUND => {
                let mvp: Vec<Value> = (0..id(&mut r)).map(|_| json!([id(&mut r), s(&mut r), i(&mut r), id(&mut r)])).collect();
                json!({"t": "round", "mvp": mvp, "teams": [i(&mut r), i(&mut r)], "win": u(&mut r), "next": id(&mut r)})
            }
            op::PONG => json!({"t": "pong", "c": r.f64().unwrap()}),
            op::EVENT => {
                let kind = u(&mut r);
                json!({"t": "ev", "kind": kind, "v": (0..id(&mut r)).map(|_| i(&mut r)).collect::<Vec<_>>()})
            }
            other => panic!("not an event frame: opcode {other}"),
        };
        assert!(r.done(), "trailing bytes in {v}");
        v
    }

    type Entry = [i64; 5];

    /// Rebuilds full snapshots from deltas, remembering decoded ones by tick
    /// like the browser does.
    #[derive(Default)]
    pub struct SnapDecoder {
        seen: HashMap<u64, (Vec<Entry>, Vec<Entry>, MeState)>,
    }

    impl SnapDecoder {
        /// Decodes a snapshot frame into `{t, k, bk, p, b, e, me}` with full
        /// player and bomb lists (bombs carry their absolute detonation
        /// tick, 0 for remote). `None` if its base is unknown.
        ///
        /// # Panics
        /// On malformed input.
        #[allow(clippy::too_many_lines, reason = "mirrors the snapshot layout section by section")]
        pub fn decode(&mut self, frame: &[u8]) -> Option<Value> {
            let mut r = Reader::new(frame);
            assert_eq!(r.u8(), Some(op::SNAP));
            let k = r.uvar().unwrap();
            let gap = r.uvar().unwrap();
            let bk = if gap == 0 { 0 } else { k - gap };
            let (mut players, mut bombs, mut me) = if bk == 0 { (Vec::new(), Vec::new(), [0; ME_LEN]) } else { self.seen.get(&bk)?.clone() };
            let sections = r.u8().unwrap();
            let has = |bit: u8| sections & bit != 0;
            let ids = |r: &mut Reader| {
                let mut prev = 0;
                (0..r.uvar().unwrap()).map(|_| { prev += r.uvar().unwrap() as i64; prev }).collect::<Vec<_>>()
            };
            let mut new_players = Vec::new();
            if has(snap::PLAYERS) {
                let mut prev = 0;
                for _ in 0..r.uvar().unwrap() {
                    let h = r.uvar().unwrap();
                    prev += (h >> 4) as i64;
                    let mut e = players.iter().find(|e: &&Entry| e[0] == prev).copied().unwrap_or([prev, 0, 0, 0, 0]);
                    let look = |e: &mut Entry, b: u64| (e[3], e[4]) = ((b & 7) as i64, (b >> 3) as i64);
                    if h & snap::NEW != 0 {
                        (e[1], e[2]) = (r.ivar().unwrap(), r.ivar().unwrap());
                        look(&mut e, r.uvar().unwrap());
                    } else {
                        assert!(players.iter().any(|b| b[0] == prev), "delta for unknown player {prev}");
                        if h & snap::DX != 0 { e[1] += r.ivar().unwrap(); }
                        if h & snap::DY != 0 { e[2] += r.ivar().unwrap(); }
                        if h & snap::LOOK != 0 { look(&mut e, r.uvar().unwrap()); }
                    }
                    new_players.push(e);
                }
            }
            let gone = if has(snap::PLAYERS_GONE) { ids(&mut r) } else { vec![] };
            players.retain(|e| !gone.contains(&e[0]) && !new_players.iter().any(|n| n[0] == e[0]));
            players.extend(new_players);
            players.sort_unstable_by_key(|e| e[0]);
            let mut new_bombs = Vec::new();
            if has(snap::BOMBS) {
                let mut prev = 0;
                for _ in 0..r.uvar().unwrap() {
                    prev += r.uvar().unwrap() as i64;
                    let (x, y, f) = (r.uvar().unwrap() as i64, r.uvar().unwrap() as i64, r.u8().unwrap());
                    let at = if f & 2 != 0 { 0 } else { k as i64 + r.ivar().unwrap() };
                    new_bombs.push([prev, x, y, at, i64::from(f)]);
                }
            }
            let gone = if has(snap::BOMBS_GONE) { ids(&mut r) } else { vec![] };
            bombs.retain(|e| !gone.contains(&e[0]) && !new_bombs.iter().any(|n| n[0] == e[0]));
            bombs.extend(new_bombs);
            bombs.sort_unstable_by_key(|e| e[0]);
            let mut flames = Vec::new();
            if has(snap::FLAMES) {
                for _ in 0..r.uvar().unwrap() {
                    let (x, y, a, b) = (r.uvar().unwrap(), r.uvar().unwrap(), r.u8().unwrap(), r.u8().unwrap());
                    if a == 0xFF {
                        // Atomic blast: no arms, `b` is its radius.
                        flames.push(json!([x, y, [0, 0, 0, 0], r.uvar().unwrap(), b]));
                    } else {
                        flames.push(json!([x, y, [a & 15, a >> 4, b & 15, b >> 4], r.uvar().unwrap(), 0]));
                    }
                }
            }
            let mut drones = Vec::new();
            if has(snap::DRONES) {
                for _ in 0..r.uvar().unwrap() {
                    drones.push(json!([r.uvar().unwrap(), r.ivar().unwrap(), r.ivar().unwrap(), r.u8().unwrap()]));
                }
            }
            let mut extra = json!({});
            if has(snap::EXTRA) {
                let parts = r.u8().unwrap();
                let list = |r: &mut Reader, n: usize, f: &dyn Fn(&mut Reader) -> Value| (0..n).map(|_| f(r)).collect::<Vec<_>>();
                if parts & snap::GAS != 0 {
                    let n = r.uvar().unwrap() as usize;
                    extra["gas"] = json!(list(&mut r, n, &|r| {
                        let (id, x, y, a, b) = (r.uvar().unwrap(), r.uvar().unwrap(), r.uvar().unwrap(), r.u8().unwrap(), r.u8().unwrap());
                        json!([id, x, y, [a & 15, a >> 4, b & 15, b >> 4], r.uvar().unwrap()])
                    }));
                }
                if parts & snap::PORTALS != 0 {
                    let n = r.uvar().unwrap() as usize;
                    extra["portals"] = json!(list(&mut r, n, &|r| json!([r.uvar().unwrap(), r.uvar().unwrap(), r.uvar().unwrap(), r.uvar().unwrap(), r.uvar().unwrap(), r.uvar().unwrap()])));
                }
                if parts & snap::CLONES != 0 {
                    let n = r.uvar().unwrap() as usize;
                    extra["clones"] = json!(list(&mut r, n, &|r| json!([r.uvar().unwrap(), r.uvar().unwrap(), r.ivar().unwrap(), r.ivar().unwrap(), r.uvar().unwrap()])));
                }
                if parts & snap::DECOYS != 0 {
                    let n = r.uvar().unwrap() as usize;
                    extra["decoys"] = json!(list(&mut r, n, &|r| json!([r.uvar().unwrap(), r.uvar().unwrap(), r.uvar().unwrap(), r.ivar().unwrap()])));
                }
                if parts & snap::STUCK != 0 {
                    let n = r.uvar().unwrap() as usize;
                    extra["stuck"] = json!(list(&mut r, n, &|r| json!([r.uvar().unwrap(), r.uvar().unwrap()])));
                }
                if parts & snap::WORMS != 0 {
                    let n = r.uvar().unwrap() as usize;
                    extra["worms"] = json!(list(&mut r, n, &|r| {
                        let (id, flags, step, since) = (r.uvar().unwrap(), r.u8().unwrap(), r.uvar().unwrap(), r.uvar().unwrap());
                        let cells = (0..r.uvar().unwrap()).map(|_| json!([r.uvar().unwrap(), r.uvar().unwrap()])).collect::<Vec<_>>();
                        json!([id, flags, step, since, cells])
                    }));
                }
            }
            if has(snap::ME) {
                let mask = r.uvar().unwrap();
                for (i, v) in me.iter_mut().enumerate().take(ME_LEN) {
                    if mask >> i & 1 != 0 {
                        *v = r.ivar().unwrap();
                    }
                }
            }
            assert!(r.done(), "trailing bytes in snapshot {k}");
            self.seen.insert(k, (players.clone(), bombs.clone(), me));
            Some(json!({"t": "s", "k": k, "bk": bk, "p": players, "b": bombs, "e": flames, "d": drones, "x": extra, "me": me.to_vec()}))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::testing::decode;
    use super::*;
    use serde_json::json;

    #[test]
    fn client_messages_round_trip() {
        let msgs = [
            ClientMsg::Join { name: "Ann", token: "tok-123456", hat: 2, trail: 1, near: 9 },
            ClientMsg::Join { name: "Bö", token: "", hat: 0, trail: 0, near: 0 },
            ClientMsg::In { d: 3, s: 2, j: false, h: false, q: 513, k: 70000 },
            ClientMsg::In { d: 4, s: 0, j: true, h: false, q: 65535, k: u32::MAX },
            ClientMsg::Bomb,
            ClientMsg::Act,
            ClientMsg::In { d: 1, s: 0, j: false, h: true, q: 2, k: 3 },
            ClientMsg::Gadget,
            ClientMsg::Ability,
            ClientMsg::Cancel,
            ClientMsg::Emote { e: 3 },
            ClientMsg::Ping { c: 12.5 },
            ClientMsg::View { w: 20, h: 14 },
        ];
        for m in msgs {
            assert_eq!(ClientMsg::decode(&m.encode()), Some(m));
        }
        assert_eq!(ClientMsg::In { d: 3, s: 2, j: true, h: false, q: 1, k: 1 }.encode().len(), 4, "a held input is four bytes");
    }

    #[test]
    fn client_messages_are_validated() {
        assert_eq!(ClientMsg::decode(&[cop::IN, 7 | 6 << 3, 1, 1]), Some(ClientMsg::In { d: 0, s: 0, j: false, h: false, q: 1, k: 1 }), "bad dirs");
        assert_eq!(ClientMsg::decode(&[cop::IN, 0, 0xff, 0xff, 0x7f, 0]), Some(ClientMsg::In { d: 0, s: 0, j: false, h: false, q: 65535, k: 0 }), "seq clamped");
        assert_eq!(ClientMsg::decode(&[cop::IN, 2 | 64, 1, 1]), Some(ClientMsg::In { d: 2, s: 0, j: true, h: false, q: 1, k: 1 }), "jump bit");
        assert_eq!(ClientMsg::decode(&[cop::IN, 2 | 128, 1, 1]), Some(ClientMsg::In { d: 2, s: 0, j: false, h: true, q: 1, k: 1 }), "detach bit");
        assert_eq!(ClientMsg::decode(&[cop::EMOTE, 200]), Some(ClientMsg::Emote { e: 15 }));
        assert_eq!(ClientMsg::decode(&[cop::VIEW, 0xff, 0x7f, 5]), Some(ClientMsg::View { w: 1000, h: 5 }));
        assert_eq!(ClientMsg::decode(&[]), None);
        assert_eq!(ClientMsg::decode(&[0x82, 0xa1]), None, "old MessagePack frames are rejected");
        assert_eq!(ClientMsg::decode(&[cop::IN, 0]), None, "truncated");
        assert_eq!(ClientMsg::decode(&[cop::JOIN, 5, b'a']), None, "string past the end");
        assert_eq!(ClientMsg::decode(&[cop::JOIN, 2, 0xff, 0xfe, 0, 0, 0, 0]), None, "invalid UTF-8");
        assert_eq!(ClientMsg::decode(&[cop::IN, 0, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x01]), None, "overlong varint");
    }

    #[test]
    fn varints_round_trip() {
        let mut buf = BytesMut::new();
        let values = [0, 1, -1, 63, -64, 64, 127, 128, 300, -300, 1 << 40, i64::MAX, i64::MIN];
        {
            let mut w = Wire(&mut buf);
            for v in values {
                w.ivar(v);
            }
            w.uvar(u64::MAX);
        }
        let mut r = Reader::new(&buf);
        for v in values {
            assert_eq!(r.ivar(), Some(v));
        }
        assert_eq!(r.uvar(), Some(u64::MAX));
        assert!(r.done());
        let one_byte = |v: i64| {
            let mut b = BytesMut::new();
            Wire(&mut b).ivar(v);
            b.len() == 1
        };
        assert!(one_byte(63) && one_byte(-64) && !one_byte(64));
    }

    #[test]
    fn events_decode_to_what_was_sent() {
        let mut arena = BytesMut::with_capacity(1024);
        assert_eq!(decode(&encode_pj(&mut arena, 7, "Ann", 2, 3, 1)), json!({"t": "pj", "id": 7, "name": "Ann", "team": 2, "hat": 3, "trail": 1}));
        assert_eq!(decode(&encode_pl(&mut arena, 300)), json!({"t": "pl", "id": 300}));
        assert_eq!(
            decode(&encode_kill(&mut arena, None, 70000, 1.5, 2.25, true)),
            json!({"t": "kill", "k": null, "v": 70000, "x": 1.5, "y": 2.25, "b": true})
        );
        assert_eq!(decode(&encode_kill(&mut arena, Some(3), 4, 0.5, 0.5, false))["k"], json!(3));
        assert_eq!(decode(&encode_pong(&mut arena, 1.5)), json!({"t": "pong", "c": 1.5}));
        assert_eq!(decode(&encode_fx(&mut arena, 20, true)), json!({"t": "fx", "f": 20, "m": true}));
        assert_eq!(decode(&encode_emote(&mut arena, 5, 2)), json!({"t": "emote", "id": 5, "e": 2}));
        assert_eq!(decode(&encode_streak(&mut arena, 5, 3)), json!({"t": "streak", "id": 5, "n": 3}));
        assert_eq!(decode(&encode_hills(&mut arena, &[(3, 5), (9, 11)])), json!({"t": "hills", "h": [[3, 5], [9, 11]]}));
        assert_eq!(
            decode(&encode_world(&mut arena, &[(1, 2, 0)], &[(3, 4, 8), (5, 6, 0)])),
            json!({"t": "w", "tc": [[1, 2, 0]], "ic": [[3, 4, 8], [5, 6, 0]]})
        );
        let top = [(1, "a", -3, 0, 2), (2, "a-much-longer-name-than-thirty-one-bytes", 200, 5, 70000)];
        assert_eq!(
            decode(&encode_lb(&mut arena, 2, top.into_iter(), (4, -1), 299)),
            json!({"t": "lb", "n": 2, "top": [[1, "a", -3, 0, 2], [2, "a-much-longer-name-than-thirty-one-bytes", 200, 5, 70000]], "teams": [4, -1], "r": 299})
        );
        assert_eq!(
            decode(&encode_round(&mut arena, [(1, "a", 9, 4)].into_iter(), (10, 7), 1, 300)),
            json!({"t": "round", "mvp": [[1, "a", 9, 4]], "teams": [10, 7], "win": 1, "next": 300})
        );
        assert_eq!(decode(&encode_err("full")), json!({"t": "err", "m": "full"}));
        assert_eq!(peek_pong(&encode_pong(&mut arena, 1.5)), Some(1.5));
        assert_eq!(encode_pl(&mut arena, 5).len(), 2, "small events are a couple of bytes");
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
