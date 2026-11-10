// Compact binary wire protocol; mirrors src/protocol.rs (see there for the
// full layout). Every frame starts with a one-byte opcode; integers are
// LEB128 varints (signed ones zigzag encoded), strings are a varint length
// plus UTF-8, floats are little-endian f64. Snapshots are deltas against a
// snapshot this client acknowledged, so decoding one needs that base.

import { decode as decodeMsgpack } from './msgpack.js';

const OP = {
  WELCOME: 1, ERR: 2, SNAP: 3, PJ: 4, PL: 5, KILL: 6, LB: 7, WORLD: 8,
  FX: 9, EMOTE: 10, STREAK: 11, HILLS: 12, ROUND: 13, PONG: 14, EVENT: 15,
};
/** Kinds of game events (`ev` messages); mirrors `protocol::ev`. */
export const EV = { SHRINK: 1, ANNOUNCE: 2, STRIKES: 3, LAVA: 4, FLAGS: 5, FLAG_NEWS: 6, SWAP: 7, ZONE: 8, ROYALE: 9, WINNER: 10 };
const CLIENT_OP = { join: 1, in: 2, bomb: 3, act: 4, emote: 5, ping: 6, view: 7, gadget: 8 };
const NO_ARMS = Object.freeze([0, 0, 0, 0]);
const SECTION = { PLAYERS: 1, PLAYERS_GONE: 2, BOMBS: 4, BOMBS_GONE: 8, FLAMES: 16, ME: 32, DRONES: 64 };
const PLAYER = { DX: 1, DY: 2, LOOK: 4, NEW: 8 };

/** Order of the values in a snapshot's `me` block; mirrors the server. */
export const ME_FIELDS = ['ack', 'alive', 'active', 'shield', 'ghost', 'curse', 'curse_t', 'respawn', 'score', 'bombs',
  'range', 'speed', 'kick', 'pierce', 'remote', 'line', 'punch', 'killer', 'spec', 'aoi_w', 'aoi_h', 'team', 'streak',
  'nukes', 'jump', 'jump_cd', 'gadget', 'gadget_n', 'freeze', 'stomp', 'stun', 'blizzard', 'carrying', 'storm', 'storm_max'];
const ME_EMPTY = new Array(ME_FIELDS.length).fill(0);

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

class Reader {
  constructor(bytes) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.pos = 0;
  }

  u8() {
    if (this.pos >= this.bytes.length) throw new RangeError('protocol: truncated frame');
    return this.bytes[this.pos++];
  }

  /** Unsigned varint; plain arithmetic keeps values above 2^31 exact. */
  uvar() {
    let v = 0, mul = 1, b;
    do {
      b = this.u8();
      v += (b & 0x7f) * mul;
      mul *= 128;
    } while (b & 0x80);
    return v;
  }

  ivar() {
    const v = this.uvar();
    return v % 2 ? -(v + 1) / 2 : v / 2;
  }

  str() {
    const n = this.uvar();
    if (this.pos + n > this.bytes.length) throw new RangeError('protocol: truncated frame');
    const s = textDecoder.decode(this.bytes.subarray(this.pos, this.pos + n));
    this.pos += n;
    return s;
  }

  f64() {
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }

  list(n, item) {
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = item();
    return out;
  }
}

class Writer {
  constructor() {
    this.buf = new Uint8Array(64);
    this.pos = 0;
  }

  ensure(n) {
    if (this.pos + n <= this.buf.length) return;
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.pos + n));
    next.set(this.buf);
    this.buf = next;
  }

  u8(v) { this.ensure(1); this.buf[this.pos++] = v & 0xff; return this; }

  uvar(v) {
    v = Math.max(0, Math.floor(v)) || 0;
    while (v >= 128) {
      this.u8((v % 128) | 0x80);
      v = Math.floor(v / 128);
    }
    return this.u8(v);
  }

  str(s) {
    const bytes = textEncoder.encode(s);
    this.uvar(bytes.length);
    this.ensure(bytes.length);
    this.buf.set(bytes, this.pos);
    this.pos += bytes.length;
    return this;
  }

  f64(v) {
    this.ensure(8);
    new DataView(this.buf.buffer).setFloat64(this.pos, v, true);
    this.pos += 8;
    return this;
  }

  bytes() { return this.buf.subarray(0, this.pos); }
}

/** Encodes a client message `{t, ...fields}`. */
export function encodeClient(m) {
  const w = new Writer().u8(CLIENT_OP[m.t]);
  switch (m.t) {
    case 'join': w.str(m.name).str(m.token ?? '').u8(m.hat ?? 0).u8(m.trail ?? 0).uvar(m.near ?? 0); break;
    case 'in': w.u8((m.d & 7) | ((m.s & 7) << 3) | (m.j ? 64 : 0)).uvar(m.q ?? 0).uvar(m.k ?? 0); break;
    case 'emote': w.u8(m.e); break;
    case 'ping': w.f64(m.c); break;
    case 'view': w.uvar(m.w).uvar(m.h); break;
    case 'bomb': case 'act': case 'gadget': break;
    default: throw new Error(`protocol: unknown client message ${m.t}`);
  }
  return w.bytes();
}

/** Sorted id list sent as gaps. */
function ids(r) {
  let prev = 0;
  return r.list(r.uvar(), () => (prev += r.uvar()));
}

/**
 * Rebuilds a full snapshot from a delta. `baseFor(k)` returns the decoded
 * snapshot for tick `k` (or null). Returns null if the base is unknown;
 * the server then falls back to full snapshots, since we don't ack.
 */
function decodeSnapshot(r, baseFor) {
  const k = r.uvar();
  const gap = r.uvar();
  const bk = gap ? k - gap : 0;
  const base = bk ? baseFor(bk) : null;
  if (bk && !base) return null;
  const sections = r.u8();

  const players = new Map();
  for (const e of base?.p ?? []) players.set(e[0], e);
  if (sections & SECTION.PLAYERS) {
    let id = 0;
    for (let n = r.uvar(); n > 0; n--) {
      const h = r.uvar();
      const flags = h % 16;
      id += Math.floor(h / 16);
      if (flags & PLAYER.NEW) {
        const x = r.ivar(), y = r.ivar(), look = r.uvar();
        players.set(id, [id, x, y, look & 7, look >> 3]);
      } else {
        const old = players.get(id);
        if (!old) throw new Error(`protocol: delta for unknown player ${id}`);
        const e = old.slice(); // base entries stay untouched for later deltas
        if (flags & PLAYER.DX) e[1] += r.ivar();
        if (flags & PLAYER.DY) e[2] += r.ivar();
        if (flags & PLAYER.LOOK) { const look = r.uvar(); e[3] = look & 7; e[4] = look >> 3; }
        players.set(id, e);
      }
    }
  }
  if (sections & SECTION.PLAYERS_GONE) for (const id of ids(r)) players.delete(id);

  const bombs = new Map();
  for (const e of base?.rawB ?? []) bombs.set(e[0], e);
  if (sections & SECTION.BOMBS) {
    let id = 0;
    for (let n = r.uvar(); n > 0; n--) {
      id += r.uvar();
      const x = r.uvar(), y = r.uvar(), f = r.u8();
      bombs.set(id, [id, x, y, f & 2 ? 0 : k + r.ivar(), f]);
    }
  }
  if (sections & SECTION.BOMBS_GONE) for (const id of ids(r)) bombs.delete(id);

  const flames = sections & SECTION.FLAMES
    ? r.list(r.uvar(), () => {
      const x = r.uvar(), y = r.uvar(), a = r.u8(), b = r.u8();
      // [x, y, arms, ticks left, nuke radius]; arm byte 0xFF marks an
      // atomic blast, whose second byte is its radius.
      if (a === 0xff) return [x, y, NO_ARMS, r.uvar(), b];
      return [x, y, [a & 15, a >> 4, b & 15, b >> 4], r.uvar(), 0];
    })
    : [];

  // [id, x, y, team] per drone in view, positions in tiles.
  const drones = sections & SECTION.DRONES
    ? r.list(r.uvar(), () => [r.uvar(), r.ivar() / 100, r.ivar() / 100, r.u8()])
    : [];

  const rawMe = (base?.rawMe ?? ME_EMPTY).slice();
  if (sections & SECTION.ME) {
    const mask = r.uvar();
    // The mask can exceed 32 bits, so no bitwise operators on it.
    for (let i = 0, m = mask; i < rawMe.length; i++, m = Math.floor(m / 2)) if (m % 2) rawMe[i] = r.ivar();
  }
  return { t: 's', k, bk, p: Array.from(players.values()), rawB: Array.from(bombs.values()), e: flames, d: drones, rawMe };
}

/** The `me` block as a named object, with booleans, ids and the view size restored. */
export function meObject(raw) {
  const me = {};
  for (let i = 0; i < ME_FIELDS.length; i++) me[ME_FIELDS[i]] = raw[i];
  for (const k of ['alive', 'kick', 'pierce', 'remote', 'line', 'punch', 'freeze', 'stomp']) me[k] = me[k] !== 0;
  me.killer = me.killer ? me.killer - 1 : null;
  me.spec = me.spec ? me.spec - 1 : null;
  me.aoi = [me.aoi_w, me.aoi_h];
  return me;
}

/** Decodes a server frame into `{t, ...fields}`; null if it can't be used. */
export function decodeServer(bytes, baseFor) {
  const r = new Reader(bytes);
  const op = r.u8();
  switch (op) {
    case OP.WELCOME: return { ...decodeMsgpack(bytes.subarray(1)), t: 'welcome' };
    case OP.ERR: return { t: 'err', m: r.str() };
    case OP.SNAP: return decodeSnapshot(r, baseFor);
    case OP.PJ: return { t: 'pj', id: r.uvar(), name: r.str(), team: r.u8(), hat: r.u8(), trail: r.u8() };
    case OP.PL: return { t: 'pl', id: r.uvar() };
    case OP.KILL: {
      const k = r.uvar();
      return { t: 'kill', k: k ? k - 1 : null, v: r.uvar(), x: r.ivar() / 100, y: r.ivar() / 100, b: r.u8() !== 0 };
    }
    case OP.LB: {
      const n = r.uvar();
      const top = r.list(r.uvar(), () => [r.uvar(), r.str(), r.ivar(), r.uvar(), r.uvar()]);
      return { t: 'lb', n, top, teams: [r.ivar(), r.ivar()], r: r.uvar() };
    }
    case OP.WORLD: {
      const cell = () => [r.uvar(), r.uvar(), r.u8()];
      const tc = r.list(r.uvar(), cell);
      return { t: 'w', tc, ic: r.list(r.uvar(), cell) };
    }
    case OP.FX: return { t: 'fx', f: r.u8(), m: r.u8() !== 0 };
    case OP.EMOTE: return { t: 'emote', id: r.uvar(), e: r.u8() };
    case OP.STREAK: return { t: 'streak', id: r.uvar(), n: r.uvar() };
    case OP.HILLS: return { t: 'hills', h: r.list(r.uvar(), () => [r.uvar(), r.uvar()]) };
    case OP.ROUND: {
      const mvp = r.list(r.uvar(), () => [r.uvar(), r.str(), r.ivar(), r.uvar()]);
      return { t: 'round', mvp, teams: [r.ivar(), r.ivar()], win: r.u8(), next: r.uvar() };
    }
    case OP.PONG: return { t: 'pong', c: r.f64() };
    case OP.EVENT: {
      const kind = r.u8();
      return { t: 'ev', kind, v: r.list(r.uvar(), () => r.ivar()) };
    }
    default: return null;
  }
}
