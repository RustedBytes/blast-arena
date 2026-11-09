import { Assets, ITEM_SPRITES } from './assets.js';
import { GameAudio } from './audio.js';
import { Input } from './input.js';
import { Net } from './net.js';
import { Particles } from './particles.js';
import { Renderer } from './render.js';
import { Settings } from './settings.js';

const $ = (id) => document.getElementById(id);
const KILLFEED_SIZE = 5;
const VIEW_DEBOUNCE_MS = 200;

/** Fixed-capacity ring of snapshots, oldest first. */
class SnapRing {
  constructor(capacity = 32) {
    this.buf = new Array(capacity);
    this.cap = capacity;
    this.head = 0;
    this.len = 0;
  }
  push(s) {
    if (this.len < this.cap) this.buf[(this.head + this.len++) % this.cap] = s;
    else { this.buf[this.head] = s; this.head = (this.head + 1) % this.cap; }
  }
  get(i) { return this.buf[(this.head + i) % this.cap]; }
  latest() { return this.get(this.len - 1); }
}

// What each `fx` code means for the toast.
const FX = {
  1: ['+1 Bomb', 1], 2: ['+1 Range', 2], 3: ['+1 Speed', 3], 4: ['Kick bombs!', 4],
  5: ['Shield!', 5], 6: ['Pierce bombs!', 6], 7: ['Full fire!', 7],
  20: ['Jackpot! +1 bomb, range & speed', 8], 30: ['Cursed: slowed down', 8], 31: ['Cursed: no bombs', 8],
};

const settings = new Settings();
const audio = new GameAudio();
const assets = new Assets();
const particles = new Particles(2048);
const renderer = new Renderer($('game'), $('minimap'), assets, particles);
let state = null;

// Explosions seen in the previous snapshot, to spot new ones (two sets
// swapped each snapshot, so nothing is allocated).
let seenExplosions = new Set();
let nextExplosions = new Set();

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
      aoiMax: m.aoi_max ?? m.aoi,
      tickMs: 1000 / m.rate,
      roster: new Map(m.roster),
      snaps: new SnapRing(32),
      offset: null,
      me: null,
      mine: null,
      self: { x: m.w / 2, y: m.h / 2 },
      zoom: settings.get('zoom'),
      zoomTarget: settings.get('zoom'),
      items: [],
      explosions: [],
      lastLb: '',
    };
    seenExplosions.clear();
    renderer.resetMap();
    $('join').classList.add('hidden');
    $('hud').classList.remove('hidden');
    $('play').disabled = false;
    input.enabled = true;
    resize();
  },

  s(m) {
    if (!state) return;
    const now = performance.now();
    const map = state.map;
    for (const [x, y, t] of m.tc) {
      const idx = y * map.w + x;
      if (map.tiles[idx] === 2 && t === 0) renderer.crateBroken(x, y);
      map.tiles[idx] = t;
      renderer.invalidateTile(map, x, y);
    }
    // Map server ticks onto local time, smoothing out network jitter.
    const est = now / state.tickMs - m.k;
    state.offset = state.offset === null || Math.abs(est - state.offset) > 10 ? est : state.offset + (est - state.offset) * 0.05;
    state.snaps.push(m);

    const prevMe = state.me;
    state.me = m.me;
    let mine = null;
    for (let i = 0; i < m.p.length; i++) if (m.p[i][0] === state.myId) { mine = m.p[i]; break; }
    state.mine = mine;
    if (mine) {
      const mx = mine[1] / 100, my = mine[2] / 100;
      if (!prevMe?.alive || Math.hypot(mx - state.self.x, my - state.self.y) > 2) {
        state.self.x = mx;
        state.self.y = my;
        if (prevMe && !prevMe.alive) renderer.spawnBeam(mx, my, now);
      }
    }

    // New explosions: effects, shake and sound scaled by distance.
    nextExplosions.clear();
    for (const e of m.e) {
      const key = (m.k + e[3]) * 1e6 + e[1] * 1000 + e[0];
      nextExplosions.add(key);
      if (!seenExplosions.has(key)) {
        const d = Math.hypot(e[0] + 0.5 - state.self.x, e[1] + 0.5 - state.self.y);
        renderer.explosion(e[0], e[1], e[2], now, d);
        audio.explosion(d);
      }
    }
    [seenExplosions, nextExplosions] = [nextExplosions, seenExplosions];

    if (prevMe && m.me.active > prevMe.active) audio.bombPlaced();
    // The music intensifies while a bomb is close.
    let nearest = Infinity;
    for (const b of m.b) nearest = Math.min(nearest, Math.abs(b[1] + 0.5 - state.self.x) + Math.abs(b[2] + 0.5 - state.self.y));
    audio.setIntensity(nearest < 4 ? 1 : 0);
    updateHud(m.me);
  },

  pj(m) { state?.roster.set(m.id, m.name); },
  pl(m) { state?.roster.delete(m.id); },

  fx(m) {
    if (!state) return;
    const [text, icon] = FX[m.f] ?? ['?', 8];
    const curse = m.f >= 30;
    toast(m.m ? `Secret box: ${text}` : text, ITEM_SPRITES[icon], m.m ? (curse ? 'curse' : 'mystery') : '');
    renderer.sparkle(state.self.x, state.self.y, m.m);
    if (curse) audio.curse();
    else if (m.m) audio.mystery();
    else audio.pickup();
  },

  kill(m) {
    if (!state) return;
    renderer.death(m.x, m.y, performance.now());
    if (m.v === state.myId) audio.death();
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
    const key = m.top.map((e) => e.join()).join('|');
    if (key === state.lastLb) return;
    state.lastLb = key;
    $('lb-list').innerHTML = m.top
      .map(([id, name, score, kills, deaths]) =>
        `<li class="${id === state.myId ? 'me' : ''}"><div class="row"><span class="n">${escapeHtml(name)}</span>` +
        `<span class="s"><span class="kd">${kills}K ${deaths}D · </span>${score}</span></div></li>`)
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
    $('settings').classList.add('hidden');
    $('join').classList.remove('hidden');
    $('play').disabled = false;
    if (!$('join-error').textContent) $('join-error').textContent = 'Disconnected from server.';
  },
});

const input = new Input({
  onDir: (d, s) => net.send({ t: 'in', d, s }),
  onBomb: () => net.send({ t: 'bomb' }),
  onZoom: (factor) => setZoom((state?.zoomTarget ?? settings.get('zoom')) * factor),
  onAction(name, down) {
    if (name === 'board') $('leaderboard').classList.toggle('expanded', down);
    else if (name === 'mute') settings.set('muted', !settings.get('muted'));
    else if (name === 'fps') settings.set('showFps', !settings.get('showFps'));
    else if (name === 'zoomReset') setZoom(1);
    else if (name === 'menu') toggleSettings();
  },
});

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function toast(text, icon, kind) {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.innerHTML = `${icon ? `<img src="assets/${icon}.svg" alt="">` : ''}<span></span>`;
  el.lastChild.textContent = text;
  const box = $('toasts');
  box.append(el);
  while (box.children.length > 3) box.firstChild.remove();
  setTimeout(() => el.remove(), 2300);
}

// ------------------------------------------------------------------- zoom

let viewTimer = 0;
function setZoom(z) {
  const zz = Math.min(renderer.maxZoom ?? 2.2, Math.max(renderer.minZoom ?? 0.4, z));
  if (state) state.zoomTarget = zz;
  settings.set('zoom', zz);
  $('set-zoom').value = zz;
  requestView();
}

/** Tells the server how much of the arena this client's zoom needs. */
function requestView() {
  clearTimeout(viewTimer);
  viewTimer = setTimeout(() => {
    if (!state) return;
    const [w, h] = renderer.viewHalfExtents(Math.min(state.zoom, state.zoomTarget));
    net.send({ t: 'view', w, h });
  }, VIEW_DEBOUNCE_MS);
}

function resize() {
  if (!state) return;
  renderer.resize(state.aoi, state.aoiMax);
  $('set-zoom').min = renderer.minZoom.toFixed(2);
  $('set-zoom').max = renderer.maxZoom;
  setZoom(state.zoomTarget);
}
addEventListener('resize', resize);

// -------------------------------------------------------------- HUD

let hudKey = '';
function updateHud(me) {
  const key = [me.bombs, me.active, me.range, me.speed, me.kick, me.pierce, me.score, me.alive, me.respawn,
    Math.ceil(me.shield / 10), me.curse, Math.ceil(me.curse_t / 10)].join();
  if (key === hudKey) return;
  hudKey = key;
  $('st-bombs').textContent = `${me.bombs - me.active}/${me.bombs}`;
  $('st-range').textContent = me.range;
  $('st-speed').textContent = me.speed;
  $('st-kick').classList.toggle('off', !me.kick);
  $('st-pierce').classList.toggle('off', !me.pierce);
  $('st-score').textContent = me.score;
  const tickS = state.tickMs / 1000;
  timer($('st-shield'), me.alive && me.shield > 0, me.shield * tickS, 6);
  timer($('st-curse'), me.curse !== 0, me.curse_t * tickS, me.curse === 1 ? 8 : 6);
  $('st-curse').title = me.curse === 1 ? 'Cursed: slowed' : 'Cursed: no bombs';

  $('dead').classList.toggle('hidden', me.alive);
  if (!me.alive) {
    const killer = me.killer;
    $('dead-msg').textContent = killer === state.myId
      ? 'You blew yourself up!'
      : killer != null ? `Blasted by ${state.roster.get(killer) ?? 'someone'}` : 'You were blasted!';
    $('dead-timer').textContent = `Respawning in ${Math.ceil(me.respawn * tickS)}…`;
  }
}

function timer(el, on, seconds, total) {
  el.classList.toggle('hidden', !on);
  if (!on) return;
  el.lastChild.textContent = Math.ceil(seconds);
  el.style.setProperty('--p', Math.min(1, seconds / total).toFixed(2));
}

// ------------------------------------------------------------- settings

function toggleSettings(open = $('settings').classList.contains('hidden')) {
  $('settings').classList.toggle('hidden', !open);
  audio.uiClick();
}

function applySettings() {
  audio.setMusicVolume(settings.get('music'));
  audio.setSfxVolume(settings.get('sfx'));
  audio.setMuted(settings.get('muted'));
  $('perf').classList.toggle('hidden', !settings.get('showFps'));
  $('set-music').value = settings.get('music');
  $('set-sfx').value = settings.get('sfx');
  $('set-muted').checked = settings.get('muted');
  $('set-fps').checked = settings.get('showFps');
  $('set-zoom').value = settings.get('zoom');
}
settings.onChange(applySettings);
applySettings();

$('set-music').addEventListener('input', (e) => settings.set('music', Number(e.target.value)));
$('set-sfx').addEventListener('input', (e) => settings.set('sfx', Number(e.target.value)));
$('set-zoom').addEventListener('input', (e) => setZoom(Number(e.target.value)));
$('set-muted').addEventListener('change', (e) => settings.set('muted', e.target.checked));
$('set-fps').addEventListener('change', (e) => settings.set('showFps', e.target.checked));
$('settings-close').addEventListener('click', () => toggleSettings(false));
$('gear').addEventListener('click', () => toggleSettings(true));

// ----------------------------------------------------------------- loop

let last = performance.now();
let perfTime = 0, perfFrames = 0, perfWork = 0;
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  input.pollGamepad();
  particles.update(dt);
  if (!state || state.snaps.len === 0) return;
  const t0 = performance.now();

  // Ease the local player towards the latest authoritative position, and
  // the zoom towards its target.
  const mine = state.mine;
  if (mine) {
    const k = 1 - Math.exp(-dt * 22);
    state.self.x += (mine[1] / 100 - state.self.x) * k;
    state.self.y += (mine[2] / 100 - state.self.y) * k;
  }
  state.zoom += (state.zoomTarget - state.zoom) * (1 - Math.exp(-dt * 12));
  renderer.draw(state, now, dt);

  perfWork += performance.now() - t0;
  perfFrames++;
  perfTime += dt;
  if (perfTime >= 0.5) {
    const fps = perfFrames / perfTime;
    const el = $('fps');
    el.textContent = `${Math.round(fps)} FPS · ${(perfWork / perfFrames).toFixed(1)} ms`;
    el.classList.toggle('slow', fps < 50);
    $('netinfo').textContent = `ping ${net.ping} ms · ${(net.bytesIn / 1024 / perfTime).toFixed(1)} KB/s · ${particles.count} fx`;
    net.bytesIn = 0;
    perfTime = perfFrames = perfWork = 0;
  }
}

$('name').value = (() => { try { return localStorage.getItem('blast-name') ?? ''; } catch { return ''; } })();
$('join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('name').value.trim() || 'Blaster';
  try { localStorage.setItem('blast-name', name); } catch { /* storage unavailable */ }
  audio.start(); // browsers only allow audio after a user gesture
  applySettings();
  $('join-error').textContent = '';
  $('play').disabled = true;
  net.close();
  net.connect(name);
});

assets.load().then(() => requestAnimationFrame(frame));
