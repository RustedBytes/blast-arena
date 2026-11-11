// The welcome message: plain MessagePack decoded without a schema, so it's
// checked here before the rest of the client relies on its types.

import type { MsgMap, MsgValue } from '../msgpack.js';
import type { ArenaMode, WelcomeMsg } from './types.js';

class WelcomeError extends Error {
  constructor(what: string) {
    super(`protocol: bad welcome message (${what})`);
  }
}

const isMap = (v: MsgValue | undefined): v is MsgMap =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Uint8Array);

function num(m: MsgMap, k: string): number {
  const v = m[k];
  if (typeof v !== 'number') throw new WelcomeError(k);
  return v;
}

function str(m: MsgMap, k: string): string {
  const v = m[k];
  if (typeof v !== 'string') throw new WelcomeError(k);
  return v;
}

function list(m: MsgMap, k: string): MsgValue[] {
  const v = m[k];
  if (!Array.isArray(v)) throw new WelcomeError(k);
  return v;
}

/** A list of number tuples of length `n` (cells, map runs, regions...). */
function tuples<T extends number[]>(m: MsgMap, k: string, n: T['length']): T[] {
  return list(m, k).map((e) => {
    if (!Array.isArray(e) || e.length !== n || !e.every((x) => typeof x === 'number')) throw new WelcomeError(k);
    return e as T;
  });
}

function pair(m: MsgMap, k: string): [number, number] {
  const v = m[k];
  if (!Array.isArray(v) || v.length !== 2) throw new WelcomeError(k);
  const [a, b] = v;
  if (typeof a !== 'number' || typeof b !== 'number') throw new WelcomeError(k);
  return [a, b];
}

function numbers<K extends string>(m: MsgValue | undefined, what: string, keys: readonly K[]): Record<K, number> {
  if (!isMap(m)) throw new WelcomeError(what);
  const out = {} as Record<K, number>;
  for (const k of keys) out[k] = num(m, k);
  return out;
}

const ARENA_MODES: readonly ArenaMode[] = ['ffa', 'teams', 'royale', 'worms'];
const isArenaMode = (v: string): v is ArenaMode => (ARENA_MODES as readonly string[]).includes(v);

export function parseWelcome(body: MsgValue): WelcomeMsg {
  if (!isMap(body)) throw new WelcomeError('body');
  const mode = str(body, 'mode');
  if (!isArenaMode(mode)) throw new WelcomeError('mode');
  const roster = list(body, 'roster').map((e): WelcomeMsg['roster'][number] => {
    if (!Array.isArray(e)) throw new WelcomeError('roster');
    const [id, name, team, hat, trail] = e;
    if (typeof id !== 'number' || typeof name !== 'string' || typeof team !== 'number' || typeof hat !== 'number' || typeof trail !== 'number') {
      throw new WelcomeError('roster');
    }
    return [id, name, team, hat, trail];
  });
  const ab = body.abilities;
  if (!isMap(ab)) throw new WelcomeError('abilities');
  const disabled = list(ab, 'disabled');
  const resumed = body.resumed;
  if (typeof resumed !== 'boolean') throw new WelcomeError('resumed');
  const profile = body.profile ?? null;
  return {
    t: 'welcome',
    id: num(body, 'id'), w: num(body, 'w'), h: num(body, 'h'),
    map: tuples(body, 'map', 2), biomes: tuples(body, 'biomes', 3), items: tuples(body, 'items', 3),
    rate: num(body, 'rate'), aoi: pair(body, 'aoi'), aoi_max: pair(body, 'aoi_max'),
    roster, arena: str(body, 'arena'), mode, team: num(body, 'team'), hills: tuples(body, 'hills', 2),
    round: num(body, 'round'), resumed,
    profile: profile === null ? null : numbers(profile, 'profile', ['level', 'xp', 'next_xp', 'kills', 'deaths', 'wins', 'best_streak']),
    abilities: {
      ...numbers(ab, 'abilities', ['v', 'wall', 'gas', 'gas_fuse', 'gas_mult', 'clone', 'portal', 'portal_wait', 'sticky_fuse', 'detach', 'dash', 'dash_step']),
      cooldowns: tuples(ab, 'cooldowns', 2),
      disabled: disabled.map((d) => {
        if (typeof d !== 'number') throw new WelcomeError('abilities.disabled');
        return d;
      }),
    },
  };
}
