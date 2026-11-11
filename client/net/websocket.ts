// The WebSocket link: everything over one ordered TCP connection. The
// fallback for browsers or networks without WebTransport.

import type { Link, LinkEvents } from './link.js';

/** Opens a WebSocket to arena `arena`; rejects if it never opens. */
export function openWebSocket(arena: number, events: LinkEvents): Promise<Link> {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws?arena=${arena}`);
  ws.binaryType = 'arraybuffer';
  return new Promise((resolve, reject) => {
    let opened = false;
    ws.onopen = () => {
      opened = true;
      resolve({
        kind: 'websocket',
        send: (data) => { if (ws.readyState === WebSocket.OPEN) ws.send(data); },
        close: () => { ws.close(); },
      });
    };
    ws.onmessage = (ev: MessageEvent<unknown>) => {
      if (ev.data instanceof ArrayBuffer) events.message(new Uint8Array(ev.data));
    };
    ws.onclose = () => {
      if (opened) events.close();
      else reject(new Error('WebSocket closed before opening'));
    };
  });
}
