// Thin WebSocket wrapper over the binary protocol (protocol.ts),
// dispatching decoded messages on their `t` field.

import { decodeServer, encodeClient } from './protocol.js';
import type { ClientMsg, JoinFields, ServerMsg, ServerMsgOf, SnapshotBase } from './protocol.js';

/** A handler per server message tag, plus `close` when the socket drops. */
export type NetHandlers = { [T in ServerMsg['t']]?: (msg: ServerMsgOf<T>) => void } & { close?: () => void };

export class Net {
  handlers: NetHandlers;
  snapshotBase: SnapshotBase;
  ws: WebSocket | null;
  ping: number;
  bytesIn: number;
  pingTimer: ReturnType<typeof setInterval> | undefined;

  /** `snapshotBase(k)` returns the decoded snapshot for tick `k`, the base of deltas. */
  constructor(handlers: NetHandlers, snapshotBase: SnapshotBase) {
    this.handlers = handlers;
    this.snapshotBase = snapshotBase;
    this.ws = null;
    this.ping = 0;
    this.bytesIn = 0;
    this.pingTimer = undefined;
  }

  /** Joins arena `arena` with the given join fields (name, token, hat, ...). */
  connect(arena: number | string, join: JoinFields): void {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws?arena=${arena}`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      this.send({ t: 'join', ...join });
      this.pingTimer = setInterval(() => this.send({ t: 'ping', c: performance.now() }), 2000);
    };
    ws.onmessage = (ev) => {
      if (!(ev.data instanceof ArrayBuffer)) return;
      this.bytesIn += ev.data.byteLength;
      let msg: ServerMsg | null;
      try {
        msg = decodeServer(new Uint8Array(ev.data), this.snapshotBase);
      } catch (e) {
        console.warn('dropping malformed frame', e);
        return;
      }
      if (!msg) return;
      if (msg.t === 'pong') {
        this.ping = Math.round(performance.now() - msg.c);
        return;
      }
      (this.handlers[msg.t] as ((m: ServerMsg) => void) | undefined)?.(msg);
    };
    ws.onclose = () => {
      clearInterval(this.pingTimer);
      if (this.ws === ws) {
        this.ws = null;
        this.handlers.close?.();
      }
    };
  }

  get open(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(obj: ClientMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(encodeClient(obj));
  }

  close(): void {
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }
}
