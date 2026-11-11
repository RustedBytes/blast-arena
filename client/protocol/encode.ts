// Encodes client messages, each a one-byte opcode plus its fields.

import type { ClientMsg } from './types.js';

const CLIENT_OP: Record<ClientMsg['t'], number> = { join: 1, in: 2, bomb: 3, act: 4, emote: 5, ping: 6, view: 7, gadget: 8, ability: 9, cancel: 10, look: 11 };

const textEncoder = new TextEncoder();

class Writer {
  private buf = new Uint8Array(64);
  private pos = 0;

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
