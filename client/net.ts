// Thin WebSocket wrapper over the binary protocol (protocol.ts),
// dispatching decoded messages on their `t` field.

import { decodeServer, encodeClient } from './protocol.js';
import type { ClientMsg, JoinFields, ServerMsg, ServerMsgOf, SnapshotBase } from './protocol.js';

const PING_MS = 2000;

/** A handler per server message tag, plus `close` when the socket drops. */
export type NetHandlers = { [T in ServerMsg['t']]?: (msg: ServerMsgOf<T>) => void } & { close?: () => void };

export class Net {
  /** Round-trip time of the last ping, in ms. */
  ping = 0;
  /** Bytes received since the caller last reset it (for the network readout). */
  bytesIn = 0;
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | undefined;

  /** `snapshotBase(k)` returns the decoded snapshot for tick `k`, the base of deltas. */
  constructor(private readonly handlers: NetHandlers, private readonly snapshotBase: SnapshotBase) {}

  /** Joins arena `arena` with the given join fields (name, token, hat, ...). */
  connect(arena: number, join: JoinFields): void {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws?arena=${arena}`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      this.send({ t: 'join', ...join });
      this.pingTimer = setInterval(() => this.send({ t: 'ping', c: performance.now() }), PING_MS);
    };
    ws.onmessage = (ev: MessageEvent<unknown>) => {
      if (ev.data instanceof ArrayBuffer) this.receive(ev.data);
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

  send(msg: ClientMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(encodeClient(msg));
  }

  close(): void {
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }

  private receive(data: ArrayBuffer): void {
    this.bytesIn += data.byteLength;
    let msg: ServerMsg | null;
    try {
      msg = decodeServer(new Uint8Array(data), this.snapshotBase);
    } catch (e) {
      console.warn('dropping malformed frame', e);
      return;
    }
    if (!msg) return;
    if (msg.t === 'pong') this.ping = Math.round(performance.now() - msg.c);
    else this.dispatch(msg);
  }

  private dispatch(msg: Exclude<ServerMsg, { t: 'pong' }>): void {
    // TypeScript can't correlate the handler's parameter with the message's
    // own tag, so the lookup is widened here: `handlers[msg.t]` takes `msg`.
    const handler = this.handlers[msg.t] as ((m: ServerMsg) => void) | undefined;
    handler?.(msg);
  }
}
