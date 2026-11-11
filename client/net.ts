// The connection to the game server over the binary protocol (protocol.ts),
// dispatching decoded messages on their `t` field. WebTransport is tried
// first (snapshots as datagrams, no head-of-line blocking); the WebSocket
// is the fallback.

import type { Link, LinkEvents, LinkKind } from './net/link.js';
import { openWebSocket } from './net/websocket.js';
import { openWebTransport } from './net/webtransport.js';
import { decodeServer, encodeClient } from './protocol.js';
import type { ClientMsg, JoinFields, ServerMsg, ServerMsgOf, SnapshotBase } from './protocol.js';

const PING_MS = 2000;

/** A handler per server message tag, plus `close` when the connection drops. */
export type NetHandlers = { [T in ServerMsg['t']]?: (msg: ServerMsgOf<T>) => void } & { close?: () => void };

export class Net {
  /** Round-trip time of the last ping, in ms. */
  ping = 0;
  /** Bytes received since the caller last reset it (for the network readout). */
  bytesIn = 0;
  /** The transport in use, or null while not connected. */
  transport: LinkKind | null = null;
  private link: Link | null = null;
  /** Bumped by every connect and close, so a superseded link's events are ignored. */
  private attempt = 0;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  /** Snapshots only count after this connection's welcome, and only if newer than the last. */
  private welcomed = false;
  private lastSnap = 0;

  /** `snapshotBase(k)` returns the decoded snapshot for tick `k`, the base of deltas. */
  constructor(private readonly handlers: NetHandlers, private readonly snapshotBase: SnapshotBase) {}

  /** Joins arena `arena` with the given join fields (name, token, hat, ...). */
  connect(arena: number, join: JoinFields): void {
    this.close();
    const attempt = this.attempt;
    const events: LinkEvents = {
      message: (data) => { if (attempt === this.attempt) this.receive(data); },
      close: () => { if (attempt === this.attempt) this.dropped(); },
    };
    const stale = (link: Link | null) => {
      if (attempt === this.attempt) return false;
      link?.close();
      return true;
    };
    void (async () => {
      let link = await openWebTransport(arena, events);
      if (stale(link)) return;
      if (!link) {
        try {
          link = await openWebSocket(arena, events);
        } catch {
          if (!stale(null)) this.dropped();
          return;
        }
        if (stale(link)) return;
      }
      this.link = link;
      this.transport = link.kind;
      this.welcomed = false;
      this.lastSnap = 0;
      this.send({ t: 'join', ...join });
      this.pingTimer = setInterval(() => { this.send({ t: 'ping', c: performance.now() }); }, PING_MS);
    })();
  }

  get open(): boolean {
    return this.link !== null;
  }

  send(msg: ClientMsg): void {
    this.link?.send(encodeClient(msg));
  }

  close(): void {
    this.attempt++;
    clearInterval(this.pingTimer);
    const link = this.link;
    this.link = null;
    this.transport = null;
    link?.close();
  }

  private dropped(): void {
    clearInterval(this.pingTimer);
    this.link = null;
    this.transport = null;
    this.handlers.close?.();
  }

  private receive(data: Uint8Array): void {
    this.bytesIn += data.byteLength;
    let msg: ServerMsg | null;
    try {
      msg = decodeServer(data, this.snapshotBase);
    } catch (e) {
      console.warn('dropping malformed frame', e);
      return;
    }
    if (!msg) return;
    if (msg.t === 'pong') {
      this.ping = Math.round(performance.now() - msg.c);
      return;
    }
    if (msg.t === 'welcome') this.welcomed = true;
    if (msg.t === 's') {
      // Datagrams can overtake the welcome or each other: skip stale ones.
      if (!this.welcomed || msg.k <= this.lastSnap) return;
      this.lastSnap = msg.k;
    }
    this.dispatch(msg);
  }

  private dispatch(msg: Exclude<ServerMsg, { t: 'pong' }>): void {
    // TypeScript can't correlate the handler's parameter with the message's
    // own tag, so the lookup is widened here: `handlers[msg.t]` takes `msg`.
    const handler = this.handlers[msg.t] as ((m: ServerMsg) => void) | undefined;
    handler?.(msg);
  }
}
