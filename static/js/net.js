// Thin WebSocket wrapper over the binary protocol (protocol.js),
// dispatching decoded messages on their `t` field.

import { decodeServer, encodeClient } from './protocol.js';

export class Net {
  /** `snapshotBase(k)` returns the decoded snapshot for tick `k`, the base of deltas. */
  constructor(handlers, snapshotBase) {
    this.handlers = handlers;
    this.snapshotBase = snapshotBase;
    this.ws = null;
    this.ping = 0;
    this.bytesIn = 0;
    this.pingTimer = null;
  }

  /** Joins arena `arena` with the given join fields (name, token, hat, ...). */
  connect(arena, join) {
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
      let msg;
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
      this.handlers[msg.t]?.(msg);
    };
    ws.onclose = () => {
      clearInterval(this.pingTimer);
      if (this.ws === ws) {
        this.ws = null;
        this.handlers.close?.();
      }
    };
  }

  get open() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(encodeClient(obj));
  }

  close() {
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }
}
