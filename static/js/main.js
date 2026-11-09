import { Assets } from './assets.js';
import { Net } from './net.js';
import { Input } from './input.js';
import { Renderer } from './render.js';

const $ = (id) => document.getElementById(id);
const MAX_SNAPS = 30;
const KILLFEED_SIZE = 5;

const assets = new Assets();
const renderer = new Renderer($('game'), $('minimap'), assets);
let state = null;

const net = new Net({
  welcome(m) {
    const tiles = new Uint8Array(m.w * m.h);
    let i = 0;
    for (const [t, n] of m.map) {
      tiles.fill(t, i, i + n);
      i += n;
    }
    state = {
      myId: m.id,
      map: { w: m.w, h: m.h, tiles },
      aoi: m.aoi,
      tickMs: 1000 / m.rate,
      roster: new Map(m.roster),
      snaps: [],
      offset: null,
      me: null,
      self: { x: m.w / 2, y: m.h / 2 },
      effects: [],
      leaderboard: [],
      lastKeys: '',
    };
    $('join').classList.add('hidden');
    $('hud').classList.remove('hidden');
    $('play').disabled = false;
    input.enabled = true;
    renderer.resize(state.aoi);
  },

  s(m) {
    if (!state) return;
    const now = performance.now();
    for (const [x, y, t] of m.tc) {
      const idx = y * state.map.w + x;
      if (state.map.tiles[idx] === 2 && t === 0) {
        state.effects.push({ kind: 'debris', x: x + 0.5, y: y + 0.5, start: now, duration: 500, seed: Math.random() * 6 });
      }
      state.map.tiles[idx] = t;
    }
    // Map server ticks onto local time, smoothing out network jitter.
    const est = now / state.tickMs - m.k;
    state.offset = state.offset === null || Math.abs(est - state.offset) > 10 ? est : state.offset + (est - state.offset) * 0.05;

    state.snaps.push(m);
    if (state.snaps.length > MAX_SNAPS) state.snaps.shift();
    const wasAlive = state.me?.alive;
    state.me = m.me;
    const mine = m.p.find((p) => p[0] === state.myId);
    if (mine && (!wasAlive || Math.hypot(mine[1] / 100 - state.self.x, mine[2] / 100 - state.self.y) > 2)) {
      state.self = { x: mine[1] / 100, y: mine[2] / 100 };
    }
    updateHud(m.me);
  },

  pj(m) { state?.roster.set(m.id, m.name); },
  pl(m) { state?.roster.delete(m.id); },

  kill(m) {
    if (!state) return;
    state.effects.push({ kind: 'death', x: m.x, y: m.y, start: performance.now(), duration: 800, seed: Math.random() * 6 });
    const name = (id) => escapeHtml(state.roster.get(id) ?? '???');
    const el = document.createElement('div');
    el.className = 'kill';
    if (m.k === state.myId || m.v === state.myId) el.classList.add('mine');
    el.innerHTML = m.k === null || m.k === undefined
      ? `<b class="v">${name(m.v)}</b> was blasted`
      : m.k === m.v
        ? `<b class="v">${name(m.v)}</b> blew themselves up`
        : `<b class="k">${name(m.k)}</b> 💥 <b class="v">${name(m.v)}</b>`;
    const feed = $('killfeed');
    feed.prepend(el);
    while (feed.children.length > KILLFEED_SIZE) feed.lastChild.remove();
    setTimeout(() => el.remove(), 6000);
  },

  lb(m) {
    if (!state) return;
    $('online').textContent = `${m.n} online`;
    const list = $('lb-list');
    const keys = m.top.map((e) => e.join()).join('|');
    if (keys === state.lastKeys) return;
    state.lastKeys = keys;
    list.innerHTML = m.top
      .map(([id, name, score]) =>
        `<li class="${id === state.myId ? 'me' : ''}"><span class="n">${escapeHtml(name)}</span><span class="s">${score}</span></li>`)
      .join('');
  },

  err(m) {
    $('join-error').textContent = m.m;
  },

  close() {
    input.enabled = false;
    input.clear();
    state = null;
    $('hud').classList.add('hidden');
    $('join').classList.remove('hidden');
    $('play').disabled = false;
    if (!$('join-error').textContent) $('join-error').textContent = 'Disconnected from server.';
  },
});

const input = new Input(
  (d) => net.send({ t: 'in', d }),
  () => net.send({ t: 'bomb' }),
);

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

let hudKey = '';
function updateHud(me) {
  const key = [me.bombs, me.active, me.range, me.speed, me.kick, me.score, me.alive, me.respawn].join();
  if (key === hudKey) return;
  hudKey = key;
  $('st-bombs').textContent = `${me.bombs - me.active}/${me.bombs}`;
  $('st-range').textContent = me.range;
  $('st-speed').textContent = me.speed;
  $('st-kick').textContent = me.kick ? '✓' : '–';
  $('st-kick-wrap').classList.toggle('off', !me.kick);
  $('st-score').textContent = me.score;

  $('dead').classList.toggle('hidden', me.alive);
  if (!me.alive) {
    const killer = me.killer;
    $('dead-msg').textContent = killer === state.myId
      ? 'You blew yourself up!'
      : killer != null ? `Blasted by ${state.roster.get(killer) ?? 'someone'}` : 'You were blasted!';
    $('dead-timer').textContent = `Respawning in ${Math.ceil(me.respawn * state.tickMs / 1000)}…`;
  }
}

let last = performance.now();
let netTimer = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (!state || state.snaps.length === 0) return;

  // Ease the local player towards the latest authoritative position.
  const latest = state.snaps[state.snaps.length - 1];
  const mine = latest.p.find((p) => p[0] === state.myId);
  if (mine) {
    const k = 1 - Math.exp(-dt * 22);
    state.self.x += (mine[1] / 100 - state.self.x) * k;
    state.self.y += (mine[2] / 100 - state.self.y) * k;
  }
  renderer.draw(state, now);

  netTimer += dt;
  if (netTimer > 1) {
    $('netinfo').textContent = `ping ${net.ping} ms · ${(net.bytesIn / 1024 / netTimer).toFixed(1)} KB/s`;
    net.bytesIn = 0;
    netTimer = 0;
  }
}

addEventListener('resize', () => state && renderer.resize(state.aoi));

$('name').value = (() => { try { return localStorage.getItem('blast-name') ?? ''; } catch { return ''; } })();
$('join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('name').value.trim() || 'Blaster';
  try { localStorage.setItem('blast-name', name); } catch { /* storage unavailable */ }
  $('join-error').textContent = '';
  $('play').disabled = true;
  net.close();
  net.connect(name);
});

assets.load().then(() => requestAnimationFrame(frame));
