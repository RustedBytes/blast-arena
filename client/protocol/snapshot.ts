// Snapshots: deltas against a snapshot this client acknowledged, rebuilt
// into full lists, and the `me` block of the local player.

import { BOMB_FLAG, hasFlag, ME_FIELDS } from './constants.js';
import { Reader } from './reader.js';
import type { BombEntry, CloneEntry, DecoyEntry, DroneEntry, Extras, FlameEntry, GasEntry, GuardInfo, Me, MeField, MeFlag, PlayerEntry, PortalEntry, Snapshot, SnapshotBase, StuckEntry, WardenEntry, WormEntry } from './types.js';

const NO_ARMS = Object.freeze([0, 0, 0, 0]);
const SECTION = { PLAYERS: 1, PLAYERS_GONE: 2, BOMBS: 4, BOMBS_GONE: 8, FLAMES: 16, ME: 32, DRONES: 64, EXTRA: 128 } as const;
const EXTRA = { GAS: 1, PORTALS: 2, CLONES: 4, DECOYS: 8, STUCK: 16, WORMS: 32, GUARD: 64 } as const;
const PLAYER = { DX: 1, DY: 2, LOOK: 4, NEW: 8 } as const;

const ME_EMPTY: readonly number[] = new Array<number>(ME_FIELDS.length).fill(0);
/** Index of each field in the `me` block. */
const ME_INDEX = new Map<MeField, number>(ME_FIELDS.map((f, i) => [f, i]));

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
export function decodeSnapshot(r: Reader, baseFor: SnapshotBase): Snapshot | null {
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
        const e: PlayerEntry = [...old]; // base entries stay untouched for later deltas
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
      bombs.set(id, [id, x, y, hasFlag(f, BOMB_FLAG.REMOTE) ? 0 : k + r.ivar(), f]);
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
  const n = (f: MeField): number => raw[ME_INDEX.get(f) ?? -1] ?? 0;
  const flag = (f: MeFlag): boolean => n(f) !== 0;
  /** Ids are sent + 1, so 0 means none. */
  const id = (f: 'killer' | 'spec'): number | null => (n(f) ? n(f) - 1 : null);
  return {
    ack: n('ack'), alive: flag('alive'), active: n('active'), shield: n('shield'), ghost: n('ghost'), curse: n('curse'),
    curse_t: n('curse_t'), respawn: n('respawn'), score: n('score'), bombs: n('bombs'), range: n('range'), speed: n('speed'),
    kick: flag('kick'), pierce: flag('pierce'), remote: flag('remote'), line: flag('line'), punch: flag('punch'),
    killer: id('killer'), spec: id('spec'), aoi_w: n('aoi_w'), aoi_h: n('aoi_h'), aoi: [n('aoi_w'), n('aoi_h')],
    team: n('team'), streak: n('streak'), nukes: n('nukes'), jump: n('jump'), jump_cd: n('jump_cd'), gadget: n('gadget'),
    gadget_n: n('gadget_n'), freeze: flag('freeze'), stomp: flag('stomp'), stun: n('stun'), blizzard: n('blizzard'),
    carrying: n('carrying'), storm: n('storm'), storm_max: n('storm_max'), ability: n('ability'), ability_n: n('ability_n'),
    ability_max: n('ability_max'), ability_cd: n('ability_cd'), gas_bombs: n('gas_bombs'), sticky_bombs: n('sticky_bombs'),
    stuck: n('stuck'), detach: n('detach'), gassed: n('gassed'), dash: n('dash'), dash_dir: n('dash_dir'),
    portal_wait: n('portal_wait'),
  };
}
