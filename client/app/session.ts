// The game in progress: its state, the snapshot ring and the connection.

import type { JoinFields } from '../protocol.js';
import type { GameSnapshot, GameState, SnapshotRing } from '../state.js';

/** The game in progress, or null in the lobby. */
export let state: GameState | null = null;

export function setState(next: GameState | null): void {
  state = next;
}

/** What we joined with (for reconnecting), and the reconnect attempt (-1: not reconnecting). */
export const connection: { joinInfo: { arena: number; join: JoinFields } | null; reconnectTry: number } = {
  joinInfo: null,
  reconnectTry: -1,
};

/** Fixed-capacity ring of snapshots, oldest first. */
export class SnapRing implements SnapshotRing {
  buf: GameSnapshot[];
  cap: number;
  head: number;
  len: number;

  constructor(capacity = 32) {
    this.buf = new Array<GameSnapshot>(capacity);
    this.cap = capacity;
    this.head = 0;
    this.len = 0;
  }
  push(s: GameSnapshot): void {
    if (this.len < this.cap) this.buf[(this.head + this.len++) % this.cap] = s;
    else { this.buf[this.head] = s; this.head = (this.head + 1) % this.cap; }
  }
  get(i: number): GameSnapshot { return this.buf[(this.head + i) % this.cap]; }
  latest(): GameSnapshot { return this.get(this.len - 1); }
}

/** The current game; only called while one is running. */
export function game(): GameState {
  if (!state) throw new Error('no game running');
  return state;
}

/** The decoded snapshot for server tick `k`, if still in the ring. */
export function findSnapshot(k: number): GameSnapshot | null {
  if (!state) return null;
  const ring = state.snaps;
  for (let i = ring.len - 1; i >= 0; i--) {
    const s = ring.get(i);
    if (s.k === k) return s;
    if (s.k < k) break;
  }
  return null;
}

export function rebuildItems(): void {
  if (!state) return;
  state.items.length = 0;
  for (const [idx, kind] of state.itemMap) state.items.push([idx % state.map.w, Math.floor(idx / state.map.w), kind]);
}
