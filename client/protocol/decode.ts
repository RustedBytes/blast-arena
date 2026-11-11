// Decodes server frames: a one-byte opcode, then that message's fields.

import { decode as decodeMsgpack } from '../msgpack.js';
import { Reader } from './reader.js';
import { decodeSnapshot } from './snapshot.js';
import type { LeaderboardMsg, RoundMsg, ServerMsg, SnapshotBase } from './types.js';
import { parseWelcome } from './welcome.js';

const OP = {
  WELCOME: 1, ERR: 2, SNAP: 3, PJ: 4, PL: 5, KILL: 6, LB: 7, WORLD: 8,
  FX: 9, EMOTE: 10, STREAK: 11, HILLS: 12, ROUND: 13, PONG: 14, EVENT: 15,
} as const;

/** Decodes a server frame into `{t, ...fields}`; null if it can't be used. */
export function decodeServer(bytes: Uint8Array, baseFor: SnapshotBase): ServerMsg | null {
  const r = new Reader(bytes);
  const op = r.u8();
  switch (op) {
    case OP.WELCOME: return parseWelcome(decodeMsgpack(bytes.subarray(1)));
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
