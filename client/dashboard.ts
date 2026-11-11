// Live server dashboard: polls /api/stats and draws simple line charts of
// the last 10 minutes.

import { byId as $, context2d, fireAndForget } from './dom.js';

const POLL_MS = 2000;
const HISTORY = 300; // samples (10 minutes)
const COLORS = ['#ffb02e', '#56b4e9', '#6ff2a0', '#ff7af0', '#f0e442', '#ff5a4a'];

/** One arena in `/api/stats`. */
interface ArenaStats {
  name: string; mode: string; map: number; players: number; humans: number; bots: number; bombs: number;
  tick_ms: number; max_tick_ms: number; round_secs: number; deaths: number; bytes_out: number;
}
interface Stats { cpu_percent: number; memory_mb: number; uptime_s: number; arenas: ArenaStats[] }
interface ArenaHistory { players: number[]; humans: number[]; tick: number[]; kbs: number[] }
interface Line { name: string; values: number[]; color: string }

const history: { t: number[]; arenas: Record<string, ArenaHistory>; cpu: number[]; mem: number[] } = { t: [], arenas: {}, cpu: [], mem: [] };
let lastBytes: Record<string, number> | null = null, lastTime = 0;

function push(arr: number[], v: number): void {
  arr.push(v);
  if (arr.length > HISTORY) arr.shift();
}

/** Checks the shape of `/api/stats` before trusting it. */
function isStats(v: unknown): v is Stats {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Partial<Record<keyof Stats, unknown>>;
  return typeof s.cpu_percent === 'number' && typeof s.memory_mb === 'number' && typeof s.uptime_s === 'number'
    && Array.isArray(s.arenas);
}

async function poll(): Promise<void> {
  let s: Stats;
  try {
    const body: unknown = await (await fetch('/api/stats', { cache: 'no-store' })).json();
    if (!isStats(body)) throw new Error('unexpected /api/stats response');
    s = body;
  } catch {
    $('status').textContent = 'server unreachable';
    return;
  }
  const now = performance.now();
  $('status').textContent = `updated ${new Date().toLocaleTimeString()}`;
  push(history.t, now);
  push(history.cpu, s.cpu_percent);
  push(history.mem, s.memory_mb);
  const bytes: Record<string, number> = {};
  for (const a of s.arenas) {
    const h = history.arenas[a.name] ??= { players: [], humans: [], tick: [], kbs: [] };
    while (h.players.length < history.t.length - 1) { // arena appeared later
      h.players.push(0); h.humans.push(0); h.tick.push(0); h.kbs.push(0);
    }
    push(h.players, a.players);
    push(h.humans, a.humans);
    push(h.tick, a.tick_ms);
    const prev = lastBytes?.[a.name];
    const dt = (now - lastTime) / 1000;
    push(h.kbs, prev !== undefined && dt > 0 ? (a.bytes_out - prev) / 1024 / dt : 0);
    bytes[a.name] = a.bytes_out;
  }
  lastBytes = bytes;
  lastTime = now;

  const sum = (f: (a: ArenaStats) => number): string => String(s.arenas.reduce((n, a) => n + f(a), 0));
  $('k-players').textContent = sum((a) => a.players);
  $('k-humans').textContent = sum((a) => a.humans);
  $('k-tick').textContent = Math.max(0, ...s.arenas.map((a) => a.tick_ms)).toFixed(2);
  $('k-net').textContent = Object.values(history.arenas).reduce((n, h) => n + (h.kbs.at(-1) ?? 0), 0).toFixed(1);
  $('k-cpu').textContent = s.cpu_percent.toFixed(1);
  $('k-mem').textContent = s.memory_mb.toFixed(1);
  const up = s.uptime_s;
  $('k-up').textContent = `${Math.floor(up / 3600)}h ${Math.floor((up % 3600) / 60)}m`;
  $('arenas').innerHTML = s.arenas.map((a) =>
    `<tr><td>${a.name}</td><td>${a.mode}</td><td>${a.map}×${a.map}</td><td>${a.humans}</td><td>${a.bots}</td><td>${a.bombs}</td>` +
    `<td>${a.tick_ms.toFixed(2)}</td><td>${a.max_tick_ms.toFixed(2)}</td><td>${Math.floor(a.round_secs / 60)}:${String(a.round_secs % 60).padStart(2, '0')}</td><td>${a.deaths}</td></tr>`).join('');
  draw();
}

function series(key: keyof ArenaHistory): Line[] {
  return Object.entries(history.arenas).map(([name, h], i) => ({ name, values: h[key], color: COLORS[i % COLORS.length] }));
}

function draw(): void {
  chart('players', series('players'), 'count');
  chart('tick', series('tick'), 'ms');
  chart('net', series('kbs'), 'KB/s');
  chart('sys', [
    { name: 'CPU %', values: history.cpu, color: COLORS[0] },
    { name: 'Memory MB', values: history.mem, color: COLORS[1] },
  ]);
}

function chart(id: string, lines: Line[], unit = ''): void {
  const c = $(`c-${id}`, HTMLCanvasElement);
  const dpr = devicePixelRatio || 1;
  const w = c.clientWidth * dpr, h = c.clientHeight * dpr;
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const g = context2d(c);
  g.clearRect(0, 0, w, h);
  const pad = 34 * dpr;
  const max = Math.max(1, ...lines.flatMap((l) => l.values)) * 1.15;
  g.strokeStyle = '#2a3650';
  g.fillStyle = '#8e9bb0';
  g.font = `${11 * dpr}px system-ui`;
  g.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = h - 14 * dpr - (h - 24 * dpr) * (i / 4);
    g.beginPath(); g.moveTo(pad, y); g.lineTo(w, y); g.stroke();
    g.fillText((max * i / 4).toFixed(max < 10 ? 1 : 0), 2 * dpr, y + 4 * dpr);
  }
  for (const l of lines) {
    if (l.values.length < 2) continue;
    g.strokeStyle = l.color;
    g.lineWidth = 2 * dpr;
    g.beginPath();
    l.values.forEach((v, i) => {
      const x = pad + (w - pad) * (i / (HISTORY - 1));
      const y = h - 14 * dpr - (h - 24 * dpr) * (v / max);
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    });
    g.stroke();
  }
  $(`l-${id}`).innerHTML = lines.map((l) =>
    `<span><i style="background:${l.color}"></i>${l.name}: ${(l.values.at(-1) ?? 0).toFixed(unit === 'count' ? 0 : 1)} ${unit === 'count' ? '' : unit}</span>`).join('');
}

const pollNow = (): void => fireAndForget(poll(), 'stats poll');
pollNow();
setInterval(pollNow, POLL_MS);
addEventListener('resize', draw);
