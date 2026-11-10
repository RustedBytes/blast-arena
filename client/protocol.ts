// Compact binary wire protocol; mirrors src/protocol.rs (see there for the
// full layout). Every frame starts with a one-byte opcode; integers are
// LEB128 varints (signed ones zigzag encoded), strings are a varint length
// plus UTF-8, floats are little-endian f64. Snapshots are deltas against a
// snapshot this client acknowledged, so decoding one needs that base.

import { decode as decodeMsgpack } from './msgpack.js';

/** Four flame/gas arm lengths: up, down, left, right (each 0..15). */
export type Arms = readonly number[];
/** [id, x*100, y*100, facing, flags] */
export type PlayerEntry = [id: number, x: number, y: number, facing: number, flags: number];
/** [id, x, y, explode tick (0: remote), flags] */
export type BombEntry = [id: number, x: number, y: number, explodeTick: number, flags: number];
/** [x, y, arms, ticks left, nuke radius (0: normal blast)] */
export type FlameEntry = [x: number, y: number, arms: Arms, ticks: number, nuke: number];
/** [id, x, y, team], positions in tiles. */
export type DroneEntry = [id: number, x: number, y: number, team: number];
/** [id, x, y, arms, ticks left] */
export type GasEntry = [id: number, x: number, y: number, arms: Arms, ticks: number];
/** [id, x, y, owner, partner (0 waiting), ticks left] */
export type PortalEntry = [id: number, x: number, y: number, owner: number, partner: number, ticks: number];
/** [id, owner, x*100, y*100, facing, flags] */
export type CloneEntry = [id: number, owner: number, x: number, y: number, facing: number, flags: number];
/** [id, x, y, fuse ticks shown] */
export type DecoyEntry = [id: number, x: number, y: number, fuse: number];
/** [bomb id, carrier id] */
export type StuckEntry = [bomb: number, carrier: number];
/** [id, flags, ticks per step, ticks since the last step, [x0, y0, x1, y1, ...]] */
export type WormEntry = [id: number, flags: number, step: number, since: number, cells: number[]];
/** [id, x, y, from x, from y, flags, ticks per step, ticks since the last step, hp, max hp, ticks until the wound-up skill, skill direction] */
export type WardenEntry = [
  id: number, x: number, y: number, fromX: number, fromY: number, flags: number,
  step: number, since: number, hp: number, maxHp: number, windup: number, dir: number,
];
export interface GuardInfo {
  vault: [number, number, number, number];
  /** Ticks until the Warden returns (0: here). */
  back: number;
  warden: WardenEntry | null;
}
export interface Extras {
  gas: GasEntry[];
  portals: PortalEntry[];
  clones: CloneEntry[];
  decoys: DecoyEntry[];
  stuck: StuckEntry[];
  worms: WormEntry[];
  guard?: GuardInfo;
}

const OP = {
  WELCOME: 1, ERR: 2, SNAP: 3, PJ: 4, PL: 5, KILL: 6, LB: 7, WORLD: 8,
  FX: 9, EMOTE: 10, STREAK: 11, HILLS: 12, ROUND: 13, PONG: 14, EVENT: 15,
};
/** Kinds of game events (`ev` messages); mirrors `protocol::ev`. */
export const EV = { SHRINK: 1, ANNOUNCE: 2, STRIKES: 3, LAVA: 4, FLAGS: 5, FLAG_NEWS: 6, SWAP: 7, ZONE: 8, ROYALE: 9, WINNER: 10, ABILITY: 11, WORM: 12, GUARD: 13 };
/** What a worm event reports (values: [what, x, y, player id + 1]); mirrors `game::worms::news`. */
export const WORM_NEWS = { ATE: 1, KILLED: 2, CUT: 3 };
/** What a Warden event reports (values: [what, x, y, player id + 1]); mirrors `game::guard::news`. */
export const GUARD_NEWS = { CRUSHED: 1, KILLED: 2, BACK: 3, SLAM: 4, LOB: 5 };
/** Warden flags in snapshots; mirrors `game::guard::flag`. */
export const GUARD_FLAG = { HUNTING: 1, SLAM: 2, CHARGE_WINDUP: 4, CHARGING: 8, SKIN: 16, ENRAGED: 32, HURT: 64 };
/** Worm flags in snapshots; mirrors `game::worms::flag`. */
export const WORM_FLAG = { CHASING: 1, EMERGING: 2, FAR: 4, LUNGE: 8, LURK: 16 };
/** Sub-kinds of ability events (values: [kind, tick, ...]); mirrors `game::abilities::ab`. */
export const AB = {
  ACTIVATED: 1, REJECTED: 2, COOLDOWN: 3, WALL_CREATED: 4, WALL_REMOVED: 5, GAS_CREATED: 6, GAS_EXPIRED: 7,
  GAS_IGNITED: 8, CLONE_SPAWNED: 9, CLONE_DESTROYED: 10, STICKY_ATTACHED: 11, STICKY_DETACHED: 12,
  PORTAL_CREATED: 13, PORTAL_LINKED: 14, PORTAL_DESTROYED: 15, TELEPORTED: 16, DASH_STARTED: 17, DASH_ENDED: 18,
};
const CLIENT_OP: Record<ClientMsg['t'], number> = { join: 1, in: 2, bomb: 3, act: 4, emote: 5, ping: 6, view: 7, gadget: 8, ability: 9, cancel: 10, look: 11 };
const NO_ARMS = Object.freeze([0, 0, 0, 0]);
const SECTION = { PLAYERS: 1, PLAYERS_GONE: 2, BOMBS: 4, BOMBS_GONE: 8, FLAMES: 16, ME: 32, DRONES: 64, EXTRA: 128 };
const EXTRA = { GAS: 1, PORTALS: 2, CLONES: 4, DECOYS: 8, STUCK: 16, WORMS: 32, GUARD: 64 };
const PLAYER = { DX: 1, DY: 2, LOOK: 4, NEW: 8 };

/** Order of the values in a snapshot's `me` block; mirrors the server. */
export const ME_FIELDS = ['ack', 'alive', 'active', 'shield', 'ghost', 'curse', 'curse_t', 'respawn', 'score', 'bombs',
  'range', 'speed', 'kick', 'pierce', 'remote', 'line', 'punch', 'killer', 'spec', 'aoi_w', 'aoi_h', 'team', 'streak',
  'nukes', 'jump', 'jump_cd', 'gadget', 'gadget_n', 'freeze', 'stomp', 'stun', 'blizzard', 'carrying', 'storm', 'storm_max',
  'ability', 'ability_n', 'ability_max', 'ability_cd', 'gas_bombs', 'sticky_bombs', 'stuck', 'detach', 'gassed', 'dash',
  'dash_dir', 'portal_wait'] as const;
export type MeField = (typeof ME_FIELDS)[number];
const ME_EMPTY: number[] = new Array<number>(ME_FIELDS.length).fill(0);

const ME_FLAGS = ['alive', 'kick', 'pierce', 'remote', 'line', 'punch', 'freeze', 'stomp'] as const;
type MeFlag = (typeof ME_FLAGS)[number];

/** The decoded `me` block (see `meObject`). */
export type Me = { [K in Exclude<MeField, MeFlag | 'killer' | 'spec'>]: number } & { [K in MeFlag]: boolean } & {
  killer: number | null;
  spec: number | null;
  aoi: [number, number];
};

/** A full snapshot rebuilt from a delta. */
export interface Snapshot {
  t: 's';
  k: number;
  /** Tick of the base snapshot (0: none). */
  bk: number;
  p: PlayerEntry[];
  rawB: BombEntry[];
  e: FlameEntry[];
  d: DroneEntry[];
  x: Extras;
  rawMe: number[];
}

export interface ProfileView {
  level: number; xp: number; next_xp: number; kills: number; deaths: number; wins: number; best_streak: number;
}

export interface AbilityInfo {
  v: number;
  /** Cooldown per active ability: [item code, ticks]. */
  cooldowns: [number, number][];
  wall: number; gas: number; gas_fuse: number; gas_mult: number; clone: number; portal: number;
  portal_wait: number; sticky_fuse: number; detach: number; dash: number; dash_step: number;
  /** Item codes of abilities switched off. */
  disabled: number[];
}

/** The first message after joining; mirrors `protocol::Welcome`. */
export interface WelcomeMsg {
  t: 'welcome';
  id: number; w: number; h: number;
  /** Run-length encoded tiles: [tile, count] pairs, row-major. */
  map: [number, number][];
  /** Region centres: [x, y as fractions of the map size, biome code]. */
  biomes: [number, number, number][];
  /** Every item on the map: [x, y, kind]. */
  items: [number, number, number][];
  rate: number;
  aoi: [number, number];
  aoi_max: [number, number];
  /** Everyone online: [id, name, team, hat, trail]. */
  roster: [number, string, number, number, number][];
  arena: string;
  mode: 'ffa' | 'teams';
  team: number;
  hills: [number, number][];
  round: number;
  resumed: boolean;
  profile: ProfileView | null;
  abilities: AbilityInfo;
}

export interface ErrMsg { t: 'err'; m: string }
export interface PlayerJoinMsg { t: 'pj'; id: number; name: string; team: number; hat: number; trail: number }
export interface PlayerLeaveMsg { t: 'pl'; id: number }
export interface KillMsg { t: 'kill'; k: number | null; v: number; x: number; y: number; b: boolean }
/** Leaderboard: top is [id, name, score, kills, streak]. */
export interface LeaderboardMsg { t: 'lb'; n: number; top: [number, string, number, number, number][]; teams: [number, number]; r: number }
/** World changes: tile and item cells as [x, y, value]. */
export interface WorldMsg { t: 'w'; tc: [number, number, number][]; ic: [number, number, number][] }
export interface FxMsg { t: 'fx'; f: number; m: boolean }
export interface EmoteMsg { t: 'emote'; id: number; e: number }
export interface StreakMsg { t: 'streak'; id: number; n: number }
export interface HillsMsg { t: 'hills'; h: [number, number][] }
/** Round end: mvp is [id, name, score, kills]. */
export interface RoundMsg { t: 'round'; mvp: [number, string, number, number][]; teams: [number, number]; win: number; next: number }
export interface PongMsg { t: 'pong'; c: number }
export interface EventMsg { t: 'ev'; kind: number; v: number[] }

export type ServerMsg = WelcomeMsg | ErrMsg | Snapshot | PlayerJoinMsg | PlayerLeaveMsg | KillMsg | LeaderboardMsg
  | WorldMsg | FxMsg | EmoteMsg | StreakMsg | HillsMsg | RoundMsg | PongMsg | EventMsg;
/** The server message with tag `T`. */
export type ServerMsgOf<T extends ServerMsg['t']> = Extract<ServerMsg, { t: T }>;

/** Join fields sent with the join message. */
export interface JoinFields { name: string; token?: string; hat?: number; trail?: number; near?: number }

export type ClientMsg =
  | ({ t: 'join' } & JoinFields)
  /** Input: direction, sequence, jump, hold, ack q and tick k. */
  | { t: 'in'; d: number; s: number; j?: boolean; h?: boolean; q?: number; k?: number }
  | { t: 'emote'; e: number }
  | { t: 'ping'; c: number }
  | { t: 'view'; w: number; h: number }
  | { t: 'look'; at: [number, number] | null }
  | { t: 'bomb' | 'act' | 'gadget' | 'ability' | 'cancel' };

/** Returns the snapshot for tick `k`, the base of deltas (or null/undefined if unknown). */
export type SnapshotBase = (k: number) => Snapshot | null | undefined;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

class Reader {
  bytes: Uint8Array;
  view: DataView;
  pos: number;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.pos = 0;
  }

  u8(): number {
    if (this.pos >= this.bytes.length) throw new RangeError('protocol: truncated frame');
    return this.bytes[this.pos++];
  }

  /** Unsigned varint; plain arithmetic keeps values above 2^31 exact. */
  uvar(): number {
    let v = 0, mul = 1, b: number;
    do {
      b = this.u8();
      v += (b & 0x7f) * mul;
      mul *= 128;
    } while (b & 0x80);
    return v;
  }

  ivar(): number {
    const v = this.uvar();
    return v % 2 ? -(v + 1) / 2 : v / 2;
  }

  str(): string {
    const n = this.uvar();
    if (this.pos + n > this.bytes.length) throw new RangeError('protocol: truncated frame');
    const s = textDecoder.decode(this.bytes.subarray(this.pos, this.pos + n));
    this.pos += n;
    return s;
  }

  f64(): number {
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }

  list<T>(n: number, item: () => T): T[] {
    const out = new Array<T>(n);
    for (let i = 0; i < n; i++) out[i] = item();
    return out;
  }
}

class Writer {
  buf: Uint8Array;
  pos: number;

  constructor() {
    this.buf = new Uint8Array(64);
    this.pos = 0;
  }

  ensure(n: number): void {
    if (this.pos + n <= this.buf.length) return;
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.pos + n));
    next.set(this.buf);
    this.buf = next;
  }

  u8(v: number): this { this.ensure(1); this.buf[this.pos++] = v & 0xff; return this; }

  uvar(v: number): this {
    v = Math.max(0, Math.floor(v)) || 0;
    while (v >= 128) {
      this.u8((v % 128) | 0x80);
      v = Math.floor(v / 128);
    }
    return this.u8(v);
  }

  str(s: string): this {
    const bytes = textEncoder.encode(s);
    this.uvar(bytes.length);
    this.ensure(bytes.length);
    this.buf.set(bytes, this.pos);
    this.pos += bytes.length;
    return this;
  }

  f64(v: number): this {
    this.ensure(8);
    new DataView(this.buf.buffer).setFloat64(this.pos, v, true);
    this.pos += 8;
    return this;
  }

  bytes(): Uint8Array { return this.buf.subarray(0, this.pos); }
}

/** Encodes a client message `{t, ...fields}`. */
export function encodeClient(m: ClientMsg): Uint8Array {
  const w = new Writer().u8(CLIENT_OP[m.t]);
  switch (m.t) {
    case 'join': w.str(m.name).str(m.token ?? '').u8(m.hat ?? 0).u8(m.trail ?? 0).uvar(m.near ?? 0); break;
    case 'in': w.u8((m.d & 7) | ((m.s & 7) << 3) | (m.j ? 64 : 0) | (m.h ? 128 : 0)).uvar(m.q ?? 0).uvar(m.k ?? 0); break;
    case 'emote': w.u8(m.e); break;
    case 'ping': w.f64(m.c); break;
    case 'view': w.uvar(m.w).uvar(m.h); break;
    // The cell to watch, each + 1; 0, 0 is back to your own player.
    case 'look': w.uvar(m.at ? m.at[0] + 1 : 0).uvar(m.at ? m.at[1] + 1 : 0); break;
    case 'bomb': case 'act': case 'gadget': case 'ability': case 'cancel': break;
    default: throw new Error(`protocol: unknown client message ${(m as { t: string }).t}`);
  }
  return w.bytes();
}

/** Sorted id list sent as gaps. */
function ids(r: Reader): number[] {
  let prev = 0;
  return r.list(r.uvar(), () => (prev += r.uvar()));
}

/**
 * Rebuilds a full snapshot from a delta. `baseFor(k)` returns the decoded
 * snapshot for tick `k` (or null). Returns null if the base is unknown;
 * the server then falls back to full snapshots, since we don't ack.
 */
function decodeSnapshot(r: Reader, baseFor: SnapshotBase): Snapshot | null {
  const k = r.uvar();
  const gap = r.uvar();
  const bk = gap ? k - gap : 0;
  const base = bk ? baseFor(bk) : null;
  if (bk && !base) return null;
  const sections = r.u8();

  const players = new Map<number, PlayerEntry>();
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
        const e = old.slice() as PlayerEntry; // base entries stay untouched for later deltas
        if (flags & PLAYER.DX) e[1] += r.ivar();
        if (flags & PLAYER.DY) e[2] += r.ivar();
        if (flags & PLAYER.LOOK) { const look = r.uvar(); e[3] = look & 7; e[4] = look >> 3; }
        players.set(id, e);
      }
    }
  }
  if (sections & SECTION.PLAYERS_GONE) for (const id of ids(r)) players.delete(id);

  const bombs = new Map<number, BombEntry>();
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
    ? r.list(r.uvar(), (): FlameEntry => {
      const x = r.uvar(), y = r.uvar(), a = r.u8(), b = r.u8();
      // [x, y, arms, ticks left, nuke radius]; arm byte 0xFF marks an
      // atomic blast, whose second byte is its radius.
      if (a === 0xff) return [x, y, NO_ARMS, r.uvar(), b];
      return [x, y, [a & 15, a >> 4, b & 15, b >> 4], r.uvar(), 0];
    })
    : [];

  // [id, x, y, team] per drone in view, positions in tiles.
  const drones = sections & SECTION.DRONES
    ? r.list(r.uvar(), (): DroneEntry => [r.uvar(), r.ivar() / 100, r.ivar() / 100, r.u8()])
    : [];

  // Ability objects in view, sent whole every snapshot (see protocol::snap).
  const x: Extras = { gas: [], portals: [], clones: [], decoys: [], stuck: [], worms: [] };
  if (sections & SECTION.EXTRA) {
    const parts = r.u8();
    // [id, x, y, arms, ticks left]
    if (parts & EXTRA.GAS) x.gas = r.list(r.uvar(), (): GasEntry => {
      const id = r.uvar(), cx = r.uvar(), cy = r.uvar(), a = r.u8(), b = r.u8();
      return [id, cx, cy, [a & 15, a >> 4, b & 15, b >> 4], r.uvar()];
    });
    // [id, x, y, owner, partner (0 waiting), ticks left]
    if (parts & EXTRA.PORTALS) x.portals = r.list(r.uvar(), (): PortalEntry => [r.uvar(), r.uvar(), r.uvar(), r.uvar(), r.uvar(), r.uvar()]);
    // [id, owner, x*100, y*100, facing, flags]: shaped like a player entry after the id
    if (parts & EXTRA.CLONES) x.clones = r.list(r.uvar(), (): CloneEntry => {
      const id = r.uvar(), owner = r.uvar(), cx = r.ivar(), cy = r.ivar(), look = r.uvar();
      return [id, owner, cx, cy, look & 7, Math.floor(look / 8)];
    });
    // [id, x, y, fuse ticks shown]
    if (parts & EXTRA.DECOYS) x.decoys = r.list(r.uvar(), (): DecoyEntry => [r.uvar(), r.uvar(), r.uvar(), r.ivar()]);
    // [bomb id, carrier id]
    if (parts & EXTRA.STUCK) x.stuck = r.list(r.uvar(), (): StuckEntry => [r.uvar(), r.uvar()]);
    // [id, flags, ticks per step, ticks since the last step, [x0, y0, x1, y1, ...]]:
    // cells head first, then the cell the tail just left (only the head
    // for a worm out of view).
    // The vault and its Warden: { vault: [x0, y0, x1, y1], back: ticks until
    // the Warden returns (0: here), warden: [id, x, y, from x, from y,
    // flags, ticks per step, ticks since the last step, hp, max hp, ticks
    // until the wound-up skill, skill direction] or null }.
    if (parts & EXTRA.GUARD) {
      const vault: GuardInfo['vault'] = [r.uvar(), r.uvar(), r.uvar(), r.uvar()], back = r.uvar();
      const list = r.list(r.uvar(), (): WardenEntry => [r.uvar(), r.uvar(), r.uvar(), r.uvar(), r.uvar(), r.u8(), r.uvar(), r.uvar(), r.u8(), r.u8(), r.uvar(), r.u8()]);
      x.guard = { vault, back, warden: list[0] ?? null };
    }
    if (parts & EXTRA.WORMS) x.worms = r.list(r.uvar(), (): WormEntry => {
      const id = r.uvar(), flags = r.u8(), step = r.uvar(), since = r.uvar();
      const cells = r.list(r.uvar(), () => [r.uvar(), r.uvar()]).flat();
      return [id, flags, step, since, cells];
    });
  }

  const rawMe = (base?.rawMe ?? ME_EMPTY).slice();
  if (sections & SECTION.ME) {
    const mask = r.uvar();
    // The mask can exceed 32 bits, so no bitwise operators on it.
    for (let i = 0, m = mask; i < rawMe.length; i++, m = Math.floor(m / 2)) if (m % 2) rawMe[i] = r.ivar();
  }
  return { t: 's', k, bk, p: Array.from(players.values()), rawB: Array.from(bombs.values()), e: flames, d: drones, x, rawMe };
}

/** The `me` block as a named object, with booleans, ids and the view size restored. */
export function meObject(raw: readonly number[]): Me {
  const me: Record<string, unknown> = {};
  for (let i = 0; i < ME_FIELDS.length; i++) me[ME_FIELDS[i]] = raw[i];
  for (const k of ME_FLAGS) me[k] = me[k] !== 0;
  const killer = me.killer as number, spec = me.spec as number;
  me.killer = killer ? killer - 1 : null;
  me.spec = spec ? spec - 1 : null;
  me.aoi = [me.aoi_w, me.aoi_h];
  return me as Me;
}

/** Decodes a server frame into `{t, ...fields}`; null if it can't be used. */
export function decodeServer(bytes: Uint8Array, baseFor: SnapshotBase): ServerMsg | null {
  const r = new Reader(bytes);
  const op = r.u8();
  switch (op) {
    case OP.WELCOME: return { ...(decodeMsgpack(bytes.subarray(1)) as unknown as Omit<WelcomeMsg, 't'>), t: 'welcome' };
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
      const top = r.list(r.uvar(), (): LeaderboardMsg['top'][number] => [r.uvar(), r.str(), r.ivar(), r.uvar(), r.uvar()]);
      return { t: 'lb', n, top, teams: [r.ivar(), r.ivar()] as [number, number], r: r.uvar() };
    }
    case OP.WORLD: {
      const cell = (): [number, number, number] => [r.uvar(), r.uvar(), r.u8()];
      const tc = r.list(r.uvar(), cell);
      return { t: 'w', tc, ic: r.list(r.uvar(), cell) };
    }
    case OP.FX: return { t: 'fx', f: r.u8(), m: r.u8() !== 0 };
    case OP.EMOTE: return { t: 'emote', id: r.uvar(), e: r.u8() };
    case OP.STREAK: return { t: 'streak', id: r.uvar(), n: r.uvar() };
    case OP.HILLS: return { t: 'hills', h: r.list(r.uvar(), (): [number, number] => [r.uvar(), r.uvar()]) };
    case OP.ROUND: {
      const mvp = r.list(r.uvar(), (): RoundMsg['mvp'][number] => [r.uvar(), r.str(), r.ivar(), r.uvar()]);
      return { t: 'round', mvp, teams: [r.ivar(), r.ivar()] as [number, number], win: r.u8(), next: r.uvar() };
    }
    case OP.PONG: return { t: 'pong', c: r.f64() };
    case OP.EVENT: {
      const kind = r.u8();
      return { t: 'ev', kind, v: r.list(r.uvar(), () => r.ivar()) };
    }
    default: return null;
  }
}
