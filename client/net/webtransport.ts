// The WebTransport link (HTTP/3 over QUIC): reliable messages go both ways
// on one stream as length-prefixed frames (4-byte little-endian length),
// and the server sends snapshots as datagrams, so a lost packet never
// holds back newer ones. See src/wt.rs.

import type { Link, LinkEvents } from './link.js';

/** Time to wait for a WebTransport session before using the WebSocket. */
const CONNECT_TIMEOUT_MS = 3000;
/** Remembers, for this tab, that WebTransport failed, so reconnects don't wait for it again. */
const FAILED_KEY = 'blast-wt-failed';

interface TransportInfo {
  webtransport: { port: number; hashes: string[] } | null;
}

/** `?transport=websocket` forces the WebSocket; `?transport=webtransport` retries WebTransport after a failure. */
const forced = new URLSearchParams(location.search).get('transport');

function failedBefore(): boolean {
  try { return sessionStorage.getItem(FAILED_KEY) === '1'; } catch { return false; }
}

function rememberFailure(): void {
  try { sessionStorage.setItem(FAILED_KEY, '1'); } catch { /* storage blocked: retry next time */ }
}

function hexBytes(hex: string): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Splits the stream back into messages. */
class Frames {
  private buf = new Uint8Array(0);

  push(chunk: Uint8Array, out: (msg: Uint8Array) => void): void {
    let buf = chunk;
    if (this.buf.length) {
      buf = new Uint8Array(this.buf.length + chunk.length);
      buf.set(this.buf);
      buf.set(chunk, this.buf.length);
    }
    let at = 0;
    while (buf.length - at >= 4) {
      const len = new DataView(buf.buffer, buf.byteOffset + at, 4).getUint32(0, true);
      if (buf.length - at - 4 < len) break;
      out(buf.subarray(at + 4, at + 4 + len));
      at += 4 + len;
    }
    this.buf = buf.slice(at);
  }
}

async function readAll(stream: ReadableStream<Uint8Array>, each: (chunk: Uint8Array) => void): Promise<void> {
  const reader = stream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    each(value);
  }
}

/** Where the server's WebTransport endpoint is, or null if it has none. */
async function endpoint(): Promise<TransportInfo['webtransport']> {
  const res = await fetch('/api/transport', { cache: 'no-store' });
  if (!res.ok) return null;
  const info = await res.json() as TransportInfo;
  return info.webtransport;
}

/**
 * Opens a WebTransport session to arena `arena`, or resolves null when
 * this browser, network or server can't, so the caller uses the WebSocket.
 */
export async function openWebTransport(arena: number, events: LinkEvents): Promise<Link | null> {
  if (forced === 'websocket' || typeof WebTransport === 'undefined') return null;
  if (forced !== 'webtransport' && failedBefore()) return null;
  let wt: WebTransport | null = null;
  const timer = setTimeout(() => wt?.close(), CONNECT_TIMEOUT_MS);
  try {
    const at = await endpoint();
    if (!at) return null;
    const options: WebTransportOptions = {};
    if (at.hashes.length) options.serverCertificateHashes = at.hashes.map((h) => ({ algorithm: 'sha-256', value: hexBytes(h) }));
    // Guarded above: browsers without WebTransport never get here.
    // eslint-disable-next-line compat/compat
    wt = new WebTransport(`https://${location.hostname}:${at.port}/wt?arena=${arena}`, options);
    await wt.ready;
    const stream = await wt.createBidirectionalStream();
    clearTimeout(timer);
    const session = wt;
    const writer = stream.writable.getWriter();
    const frames = new Frames();
    let open = true;
    const ended = () => {
      if (!open) return;
      open = false;
      events.close();
    };
    void session.closed.then(ended, ended);
    // The DOM types leave these streams untyped; they carry byte arrays.
    const datagrams = session.datagrams.readable as ReadableStream<Uint8Array>;
    const reliable = stream.readable as ReadableStream<Uint8Array>;
    readAll(datagrams, (d) => { events.message(d); }).catch(ended);
    readAll(reliable, (chunk) => { frames.push(chunk, (m) => { events.message(m); }); }).then(ended, ended);
    return {
      kind: 'webtransport',
      send: (data) => {
        if (!open) return;
        const frame = new Uint8Array(4 + data.length);
        new DataView(frame.buffer).setUint32(0, data.length, true);
        frame.set(data, 4);
        writer.write(frame).catch(ended);
      },
      close: () => {
        open = false;
        session.close();
      },
    };
  } catch (e) {
    clearTimeout(timer);
    wt?.close();
    console.info('WebTransport unavailable, using WebSocket:', e);
    rememberFailure();
    return null;
  }
}
