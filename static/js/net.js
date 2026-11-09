// Thin WebSocket wrapper: JSON in, JSON out, dispatching on the `t` field.

export class Net {
  constructor(handlers) {
    this.handlers = handlers;
    this.ws = null;
    this.ping = 0;
    this.bytesIn = 0;
    this.pingTimer = null;
  }

  connect(name) {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.send({ t: 'join', name });
      this.pingTimer = setInterval(() => this.send({ t: 'ping', c: performance.now() }), 2000);
    };
    ws.onmessage = (ev) => {
      this.bytesIn += ev.data.length;
      const msg = JSON.parse(ev.data);
      if (msg.t === 'pong') {
        this.ping = Math.round(performance.now() - msg.c);
        return;
      }
      this.handlers[msg.t]?.(msg);
    };
    ws.onclose = () => {
      clearInterval(this.pingTimer);
      if (this.ws === ws) this.handlers.close?.();
    };
  }

  send(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  close() {
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }
}
