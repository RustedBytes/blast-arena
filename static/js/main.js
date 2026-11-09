import { Assets, ITEM_SPRITES, playerColors } from './assets.js';
import { GameAudio } from './audio.js';
import { LANGUAGES, applyI18n, detectLanguage, getLanguage, setLanguage, t } from './i18n.js';
import { Input } from './input.js';
import { Net } from './net.js';
import { Particles } from './particles.js';
import { Predictor } from './prediction.js';
import { EMOTES, Renderer } from './render.js';
import { Settings } from './settings.js';
import { Tutorial } from './tutorial.js';

const $ = (id) => document.getElementById(id);
const KILLFEED_SIZE = 5;
const VIEW_DEBOUNCE_MS = 200;
const RECONNECT_DELAYS = [500, 1500, 3000, 5000];
/** Order of the values in a snapshot's `me` array; mirrors the server. */
const ME_FIELDS = ['alive', 'bombs', 'active', 'range', 'speed', 'kick', 'pierce', 'remote', 'line', 'punch', 'ghost',
  'shield', 'curse', 'curse_t', 'score', 'respawn', 'killer', 'aoi', 'ack', 'team', 'streak', 'spec'];

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

const settings = new Settings();
setLanguage(detectLanguage(settings.get('lang')));
const audio = new GameAudio();
const assets = new Assets();
const particles = new Particles(2048);
const renderer = new Renderer($('game'), $('minimap'), assets, particles);
const predictor = new Predictor();
const tutorial = new Tutorial($('tutorial'), () => settings.set('tutorialDone', true));
let state = null;
let joinInfo = null;      // what we joined with, for reconnecting
let reconnectTry = -1;    // -1: not reconnecting

// A persistent random token identifies this browser's profile.
const token = (() => {
  try {
    let tok = localStorage.getItem('blast-token');
    if (!tok) {
      tok = crypto.randomUUID ? crypto.randomUUID() : `t-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      localStorage.setItem('blast-token', tok);
    }
    return tok;
  } catch {
    return '';
  }
})();
const params = new URLSearchParams(location.search);

// Explosions seen in the previous snapshot, to spot new ones (two sets
// swapped each snapshot).
let seenExplosions = new Set();
let nextExplosions = new Set();

/** The decoded snapshot for server tick `k`, if still in the ring. */
function findSnapshot(k) {
  const ring = state.snaps;
  for (let i = ring.len - 1; i >= 0; i--) {
    const s = ring.get(i);
    if (s.k === k) return s;
    if (s.k < k) break;
  }
  return null;
}

/** Applies a delta (changed entries, removed ids) to a base list of [id, ...] entries. */
function applyDelta(base, changed, removed) {
  const byId = new Map();
  for (const e of base) byId.set(e[0], e);
  for (const id of removed) byId.delete(id);
  for (const e of changed) byId.set(e[0], e);
  return Array.from(byId.values());
}

function rebuildItems() {
  state.items.length = 0;
  for (const [idx, kind] of state.itemMap) state.items.push([idx % state.map.w, Math.floor(idx / state.map.w), kind]);
}

const net = new Net({
  welcome(m) {
    const tiles = new Uint8Array(m.w * m.h);
    let i = 0;
    for (const [tile, n] of m.map) {
      tiles.fill(tile, i, i + n);
      i += n;
    }
    const rosterInfo = new Map();
    for (const [id, name, team, hat, trail] of m.roster) rosterInfo.set(id, { name, team, hat, trail });
    state = {
      myId: m.id,
      arena: joinInfo.arena,
      arenaName: m.arena,
      mode: m.mode,
      team: m.team,
      map: { w: m.w, h: m.h, tiles },
      aoi: m.aoi,
      aoiMax: m.aoi_max ?? m.aoi,
      tickMs: 1000 / m.rate,
      rosterInfo,
      snaps: new SnapRing(32),
      offset: null,
      me: null,
      mine: null,
      self: { x: m.w / 2, y: m.h / 2 },
      focus: { x: m.w / 2, y: m.h / 2 },
      zoom: settings.get('zoom'),
      zoomTarget: settings.get('zoom'),
      itemMap: new Map(),
      items: [],
      explosions: [],
      hills: m.hills,
      emotes: new Map(),
      bombCells: new Set(),
      lastLb: '',
      roundSecs: m.round,
      movedAt: null,
    };
    for (const [x, y, k] of m.items) state.itemMap.set(y * m.w + x, k);
    rebuildItems();
    seenExplosions.clear();
    predictor.active = false;
    renderer.resetMap(state.map);
    applyVisualSettings();
    $('join').classList.add('hidden');
    $('reconnecting').classList.add('hidden');
    $('hud').classList.remove('hidden');
    $('team-scores').classList.toggle('hidden', m.mode !== 'teams');
    $('play').disabled = false;
    reconnectTry = -1;
    input.enabled = true;
    resize();
    if (m.resumed) toast(t('welcomeBack'), null, 'mystery');
    if (!settings.get('tutorialDone')) tutorial.start();
  },

  s(m) {
    if (!state) return;
    const now = performance.now();
    // A delta snapshot lists only what changed since snapshot `bk` (one we
    // acknowledged); rebuild the full lists from it.
    let players = m.p, rawBombs = m.b;
    if (m.bk) {
      const base = findSnapshot(m.bk);
      if (!base) return; // can't decode; the server falls back to a full snapshot
      players = applyDelta(base.p, m.p, m.pr);
      rawBombs = applyDelta(base.rawB, m.b, m.br);
    }
    m.p = players;
    m.rawB = rawBombs;
    // Bombs carry their absolute detonation tick; derive the fuse left.
    m.b = rawBombs.map(([id, x, y, at, f]) => [id, x, y, f & 2 ? 99 : Math.max(0, at - m.k), f]);
    state.lastK = m.k;
    // The player's own state arrives as a positional array (see ME_FIELDS).
    const me = {};
    for (let i = 0; i < ME_FIELDS.length; i++) me[ME_FIELDS[i]] = m.me[i];
    m.me = me;
    // Map server ticks onto local time, smoothing out network jitter.
    const est = now / state.tickMs - m.k;
    state.offset = state.offset === null || Math.abs(est - state.offset) > 10 ? est : state.offset + (est - state.offset) * 0.05;
    state.snaps.push(m);

    state.bombCells.clear();
    for (const b of m.b) state.bombCells.add(b[2] * state.map.w + b[1]);

    const prevMe = state.me;
    state.me = m.me;
    let mine = null;
    for (let i = 0; i < m.p.length; i++) if (m.p[i][0] === state.myId) { mine = m.p[i]; break; }
    state.mine = mine;
    if (mine && m.me.alive) {
      const mx = mine[1] / 100, my = mine[2] / 100;
      if (!predictor.active || !prevMe?.alive) {
        predictor.reset(mx, my);
        state.self.x = mx;
        state.self.y = my;
        if (prevMe && !prevMe.alive) renderer.spawnBeam(mx, my, now);
      } else {
        predictor.reconcile(mx, my, (mine[4] & 1) !== 0, m.me.ack, state);
      }
    } else if (!m.me.alive) {
      predictor.active = false;
    }

    // New explosions: effects, shake and positional sound.
    nextExplosions.clear();
    for (const e of m.e) {
      const key = (m.k + e[3]) * 1e6 + e[1] * 1000 + e[0];
      nextExplosions.add(key);
      if (!seenExplosions.has(key)) {
        const dx = e[0] + 0.5 - state.focus.x, dy = e[1] + 0.5 - state.focus.y;
        const d = Math.hypot(dx, dy);
        renderer.explosion(e[0], e[1], e[2], now, d);
        audio.explosion(d, Math.max(-1, Math.min(1, dx / 10)));
      }
    }
    [seenExplosions, nextExplosions] = [nextExplosions, seenExplosions];

    if (prevMe && m.me.active > prevMe.active) {
      audio.bombPlaced();
      tutorial.notify('bomb');
    }
    // The music intensifies while a bomb is close.
    let nearest = Infinity;
    for (const b of m.b) nearest = Math.min(nearest, Math.abs(b[1] + 0.5 - state.self.x) + Math.abs(b[2] + 0.5 - state.self.y));
    audio.setIntensity(nearest < 4 ? 1 : 0);
    updateHud(m.me);
  },

  /** Reliable world changes: tiles and items. */
  w(m) {
    if (!state) return;
    const map = state.map;
    for (const [x, y, tile] of m.tc) {
      const idx = y * map.w + x;
      if ((map.tiles[idx] === 2 || map.tiles[idx] === 9) && tile !== map.tiles[idx]) renderer.crateBroken(x, y);
      map.tiles[idx] = tile;
      renderer.invalidateTile(map, x, y);
    }
    for (const [x, y, kind] of m.ic) {
      const idx = y * map.w + x;
      if (kind) state.itemMap.set(idx, kind); else state.itemMap.delete(idx);
    }
    if (m.ic.length) rebuildItems();
  },

  pj(m) { state?.rosterInfo.set(m.id, { name: m.name, team: m.team, hat: m.hat, trail: m.trail }); },
  pl(m) { state?.rosterInfo.delete(m.id); },

  fx(m) {
    if (!state) return;
    const what = t('items')[m.f] ?? '?';
    const curse = m.f >= 30 && m.f !== 32;
    const icon = m.f <= 12 ? ITEM_SPRITES[m.f] : 'pu_mystery';
    toast(m.m ? t('secretBox', { what }) : what, icon, m.m ? (curse ? 'curse' : 'mystery') : '');
    renderer.sparkle(state.self.x, state.self.y, m.m);
    if (curse) audio.curse();
    else if (m.m) audio.mystery();
    else audio.pickup();
    tutorial.notify('pickup');
  },

  kill(m) {
    if (!state) return;
    const now = performance.now();
    const info = state.rosterInfo.get(m.v);
    const colors = playerColors(m.v, info?.team ?? 0, settings.get('colorblind'));
    renderer.death(m.x, m.y, now, colors, 3);
    if (m.v === state.myId) audio.death();
    const name = (id) => escapeHtml(state.rosterInfo.get(id)?.name ?? '???');
    const el = document.createElement('div');
    el.className = 'kill';
    if (m.k === state.myId || m.v === state.myId) el.classList.add('mine');
    el.innerHTML = m.k === null || m.k === undefined
      ? t('wasBlasted', { v: `<b class="v">${name(m.v)}</b>` })
      : m.k === m.v
        ? t('blewUp', { v: `<b class="v">${name(m.v)}</b>` })
        : `<b class="k">${name(m.k)}</b> 💥 <b class="v">${name(m.v)}</b>${m.b ? ' 🎯' : ''}`;
    const feed = $('killfeed');
    feed.prepend(el);
    while (feed.children.length > KILLFEED_SIZE) feed.lastChild.remove();
    setTimeout(() => el.remove(), 6000);
    if (m.b && m.k === state.myId) banner(t('bountyKill'));
  },

  lb(m) {
    if (!state) return;
    $('online').textContent = t('online', { n: m.n });
    state.roundSecs = m.r;
    $('round-time').textContent = `⏱ ${Math.floor(m.r / 60)}:${String(m.r % 60).padStart(2, '0')}`;
    const ts = $('team-scores');
    ts.querySelector('.red').textContent = m.teams[0];
    ts.querySelector('.blue').textContent = m.teams[1];
    const key = m.top.map((e) => e.join()).join('|');
    if (key === state.lastLb) return;
    state.lastLb = key;
    $('lb-list').innerHTML = m.top
      .map(([id, name, score, kills, deaths]) => {
        const team = state.rosterInfo.get(id)?.team ?? 0;
        return `<li class="${id === state.myId ? 'me' : ''} team-${team}"><div class="row"><span class="n">${escapeHtml(name)}</span>` +
          `<span class="s"><span class="kd">${kills}K ${deaths}D · </span>${score}</span></div></li>`;
      })
      .join('');
  },

  emote(m) {
    if (!state) return;
    state.emotes.set(m.id, { e: m.e, until: performance.now() + 2500 });
  },

  streak(m) {
    if (!state) return;
    const name = state.rosterInfo.get(m.id)?.name ?? '?';
    banner(t('streak', { name, n: m.n }));
  },

  hills(m) {
    if (state) state.hills = m.h;
  },

  round(m) {
    if (!state) return;
    const list = $('round-mvp');
    list.innerHTML = m.mvp.map(([, name, score, kills]) => `<li>${escapeHtml(name)} — ${score} (${kills}K)</li>`).join('');
    $('round-winner').textContent = m.win ? t('teamWins', { team: m.win === 1 ? t('red') : t('blue') }) : (m.mvp[0] ? `${t('mvp')}: ${m.mvp[0][1]}` : '');
    $('round-over').classList.remove('hidden');
    renderer.confetti(state);
    audio.mystery();
    setTimeout(() => $('round-over').classList.add('hidden'), 6000);
  },

  err(m) {
    $('join-error').textContent = m.m === 'server is full, try again later' ? t('fullServer') : m.m;
    reconnectTry = -1;
  },

  close() {
    input.enabled = false;
    input.clear();
    const wasPlaying = state !== null;
    state = null;
    predictor.active = false;
    $('hud').classList.add('hidden');
    $('settings').classList.add('hidden');
    // An unexpected drop mid-game: try to reconnect (the server keeps our
    // progress for 30 s).
    if ((wasPlaying || reconnectTry >= 0) && joinInfo && reconnectTry + 1 < RECONNECT_DELAYS.length) {
      reconnectTry++;
      $('reconnecting').classList.remove('hidden');
      setTimeout(() => net.connect(joinInfo.arena, joinInfo.join), RECONNECT_DELAYS[reconnectTry]);
      return;
    }
    reconnectTry = -1;
    $('reconnecting').classList.add('hidden');
    $('join').classList.remove('hidden');
    $('play').disabled = false;
    if (!$('join-error').textContent) $('join-error').textContent = t('disconnected');
    refreshLobby();
  },
});

const input = new Input({
  onDir: () => {},
  onBomb: () => {
    net.send({ t: 'bomb' });
  },
  onAct: () => net.send({ t: 'act' }),
  onEmote: (e) => sendEmote(e),
  onZoom: (factor) => {
    setZoom((state?.zoomTarget ?? settings.get('zoom')) * factor);
    tutorial.notify('zoom');
  },
  onAction(name, down) {
    if (name === 'board') $('leaderboard').classList.toggle('expanded', down);
    else if (name === 'mute') settings.set('muted', !settings.get('muted'));
    else if (name === 'fps') settings.set('showFps', !settings.get('showFps'));
    else if (name === 'zoomReset') setZoom(1);
    else if (name === 'menu') toggleSettings();
    else if (name === 'emoteWheel') $('emote-wheel').classList.toggle('hidden');
  },
});

function sendEmote(e) {
  net.send({ t: 'emote', e });
  $('emote-wheel').classList.add('hidden');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
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

function banner(text) {
  const b = $('banner');
  b.textContent = text;
  b.classList.remove('hidden');
  // Restart the animation.
  b.style.animation = 'none';
  void b.offsetWidth;
  b.style.animation = '';
  clearTimeout(banner.timer);
  banner.timer = setTimeout(() => b.classList.add('hidden'), 2600);
}

// ------------------------------------------------------------------- zoom

let viewTimer = 0;
function setZoom(z) {
  let zz = Math.min(renderer.maxZoom ?? 2.2, Math.max(renderer.minZoom ?? 0.4, z));
  if (!Number.isFinite(zz)) zz = 1;
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
  const key = [me.bombs, me.active, me.range, me.speed, me.kick, me.pierce, me.remote, me.line, me.punch, me.score, me.alive,
    me.respawn, Math.ceil(me.shield / 10), Math.ceil(me.ghost / 10), me.curse, Math.ceil(me.curse_t / 10), me.spec, getLanguage()].join();
  if (key === hudKey) return;
  hudKey = key;
  $('st-bombs').textContent = `${me.bombs - me.active}/${me.bombs}`;
  $('st-range').textContent = me.range;
  $('st-speed').textContent = me.speed;
  for (const k of ['kick', 'pierce', 'remote', 'line', 'punch']) $(`st-${k}`).classList.toggle('off', !me[k]);
  $('st-score').textContent = me.score;
  const tickS = state.tickMs / 1000;
  timer($('st-shield'), me.alive && me.shield > 0, me.shield * tickS, 6);
  timer($('st-ghost'), me.ghost > 0, me.ghost * tickS, 6);
  timer($('st-curse'), me.curse !== 0, me.curse_t * tickS, me.curse === 1 ? 8 : me.curse === 2 ? 6 : 8);
  $('st-curse').title = t('curses')[me.curse] ?? '';

  $('dead').classList.toggle('hidden', me.alive);
  if (!me.alive) {
    const killer = me.killer;
    const name = (id) => state.rosterInfo.get(id)?.name ?? '?';
    $('dead-msg').textContent = killer === state.myId
      ? t('youBlewUp')
      : killer != null ? t('blastedBy', { name: name(killer) }) : t('youWereBlasted');
    $('dead-timer').textContent = t('respawning', { n: Math.ceil(me.respawn * tickS) }) +
      (me.spec ? ` · ${t('watching', { name: name(me.spec) })}` : '');
  }
}

function timer(el, on, seconds, total) {
  el.classList.toggle('hidden', !on);
  if (!on) return;
  el.lastChild.textContent = Math.ceil(seconds);
  el.style.setProperty('--p', Math.min(1, seconds / total).toFixed(2));
}

function buildEmoteWheel() {
  const labels = t('emotes');
  $('emote-wheel').innerHTML = EMOTES.map((e, i) =>
    `<button data-e="${i}" title="${escapeHtml(labels[i])}">${e}<kbd>${i + 1}</kbd></button>`).join('');
}
$('emote-wheel').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b) sendEmote(Number(b.dataset.e));
});
$('emote-toggle').addEventListener('click', () => $('emote-wheel').classList.toggle('hidden'));
$('invite').addEventListener('click', async () => {
  if (!state) return;
  const url = `${location.origin}${location.pathname}?arena=${state.arena}&near=${state.myId}`;
  try { await navigator.clipboard.writeText(url); } catch { prompt(t('invite'), url); return; }
  toast(t('inviteCopied'), null, '');
});

// ------------------------------------------------------------- settings

function toggleSettings(open = $('settings').classList.contains('hidden')) {
  $('settings').classList.toggle('hidden', !open);
  audio.uiClick();
}

function applyVisualSettings() {
  const cb = settings.get('colorblind'), hc = settings.get('highContrast');
  const style = settings.get('tileStyle') === 'classic' ? 'classic' : 'pixel';
  if (renderer.colorblind !== cb || renderer.highContrast !== hc || renderer.tileStyle !== style) {
    renderer.colorblind = cb;
    renderer.highContrast = hc;
    renderer.tileStyle = style;
    renderer.invalidateAll();
  }
}

function buildLegend() {
  const items = t('items');
  $('legend').innerHTML = ITEM_SPRITES.slice(1).map((s, i) =>
    `<span><img src="assets/${s}.svg" alt="">${escapeHtml(items[i + 1])}</span>`).join('');
}

function fillLanguageSelects() {
  for (const sel of [$('set-lang'), $('join-lang')]) {
    sel.innerHTML = Object.entries(LANGUAGES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
    sel.value = getLanguage();
  }
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
  $('set-colorblind').checked = settings.get('colorblind');
  $('set-contrast').checked = settings.get('highContrast');
  $('set-style').value = settings.get('tileStyle');
  applyVisualSettings();
}

function applyLanguage(lang) {
  setLanguage(lang);
  settings.set('lang', lang);
  fillLanguageSelects();
  buildLegend();
  buildEmoteWheel();
  $('lb-hint').textContent = t('holdTab', { k: 'Tab' });
  hudKey = '';
  refreshLobby();
}

settings.onChange(applySettings);
applySettings();

$('set-music').addEventListener('input', (e) => settings.set('music', Number(e.target.value)));
$('set-sfx').addEventListener('input', (e) => settings.set('sfx', Number(e.target.value)));
$('set-zoom').addEventListener('input', (e) => setZoom(Number(e.target.value)));
$('set-muted').addEventListener('change', (e) => settings.set('muted', e.target.checked));
$('set-fps').addEventListener('change', (e) => settings.set('showFps', e.target.checked));
$('set-colorblind').addEventListener('change', (e) => settings.set('colorblind', e.target.checked));
$('set-contrast').addEventListener('change', (e) => settings.set('highContrast', e.target.checked));
$('set-style').addEventListener('change', (e) => settings.set('tileStyle', e.target.value));
$('set-lang').addEventListener('change', (e) => applyLanguage(e.target.value));
$('join-lang').addEventListener('change', (e) => applyLanguage(e.target.value));
$('settings-close').addEventListener('click', () => toggleSettings(false));
$('gear').addEventListener('click', () => toggleSettings(true));
$('tutorial-again').addEventListener('click', () => {
  toggleSettings(false);
  tutorial.start();
});

// ---------------------------------------------------------------- lobby

let arenas = [];
let selectedArena = Number(params.get('arena') ?? settings.get('arena')) || 0;
let profile = null;

async function refreshLobby() {
  if (!$('join').classList.contains('hidden') || !state) {
    try {
      arenas = await (await fetch('/api/arenas')).json();
      renderArenas();
    } catch { /* server unreachable: keep the old list */ }
  }
  try {
    profile = await (await fetch(`/api/profile?token=${encodeURIComponent(token)}`)).json();
    renderProfile();
  } catch { /* no profile service */ }
  try {
    const top = await (await fetch('/api/leaderboard')).json();
    $('alltime').innerHTML = top.length
      ? top.slice(0, 10).map((r) => `<li><span>${escapeHtml(r.name)} · ${t('level', { n: r.level })}</span><span>${r.kills}K ${r.wins}★</span></li>`).join('')
      : `<li class="muted">${t('noRecords')}</li>`;
  } catch { /* ignore */ }
}

function renderArenas() {
  if (!arenas.some((a) => a.id === selectedArena)) selectedArena = arenas[0]?.id ?? 0;
  $('arena-list').innerHTML = arenas.map((a) =>
    `<button type="button" class="arena ${a.id === selectedArena ? 'selected' : ''}" data-id="${a.id}">` +
    `<span><span class="a-name">${escapeHtml(a.name)}</span><br><span class="a-meta">${a.mode === 'teams' ? t('modeTeams') : t('modeFfa')} · ${a.map}×${a.map}</span></span>` +
    `<span class="a-count">${t('arenaPlayers', { n: a.humans })} · 🤖${a.bots}</span></button>`).join('');
}
$('arena-list').addEventListener('click', (e) => {
  const b = e.target.closest('.arena');
  if (!b) return;
  selectedArena = Number(b.dataset.id);
  settings.set('arena', selectedArena);
  renderArenas();
});

function renderProfile() {
  if (!profile) return;
  $('pf-level').textContent = t('level', { n: profile.level });
  $('pf-xp').textContent = t('xpProgress', { xp: profile.xp, next: profile.next_xp });
  const span = Math.max(1, profile.next_xp - profile.level_xp);
  $('pf-xpbar').style.width = `${Math.min(100, ((profile.xp - profile.level_xp) / span) * 100)}%`;
  $('pf-stats').textContent = t('profileStats', { k: profile.kills, w: profile.wins, s: profile.best_streak });
  picker($('hat-picker'), t('hats'), profile.hat_levels, 'hat');
  picker($('trail-picker'), t('trails'), profile.trail_levels, 'trail');
}

function picker(el, names, levels, key) {
  const current = settings.get(key);
  el.innerHTML = names.map((n, i) => {
    const locked = profile.level < levels[i];
    const title = locked ? t('lockedAt', { n: levels[i] }) : n;
    return `<button type="button" data-v="${i}" class="${i === current && !locked ? 'selected' : ''}" ${locked ? 'disabled' : ''} title="${escapeHtml(title)}">${escapeHtml(n)}${locked ? ' 🔒' : ''}</button>`;
  }).join('');
  el.onclick = (e) => {
    const b = e.target.closest('button');
    if (!b || b.disabled) return;
    settings.set(key, Number(b.dataset.v));
    renderProfile();
  };
}

// ----------------------------------------------------------------- loop

let last = performance.now();
let perfTime = 0, perfFrames = 0, perfWork = 0;
// Every input message also acknowledges the newest decoded snapshot (`k`),
// which the server uses as the base for delta snapshots.
const sendInput = (d, s, q) => net.send({ t: 'in', d, s, q, k: state?.lastK ?? 0 });
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  input.pollGamepad();
  particles.update(dt);
  if (!state || state.snaps.len === 0) return;
  const t0 = performance.now();

  // Inputs (and snapshot acks) go out at 20 Hz even while dead.
  predictor.update(dt, input.current, state, sendInput);
  // Local player: predicted. Dead: the camera follows whoever we watch.
  if (state.me?.alive && predictor.active) {
    const px = state.self.x, py = state.self.y;
    predictor.render(state.self);
    tutorial.notify('moved', Math.abs(state.self.x - px) + Math.abs(state.self.y - py));
    state.focus.x = state.self.x;
    state.focus.y = state.self.y;
  } else if (state.me && !state.me.alive && state.me.spec) {
    const f = renderer.frame;
    for (let i = 0; i < f.nPlayers; i++) {
      if (f.players[i].id === state.me.spec) {
        const k = 1 - Math.exp(-dt * 6);
        state.focus.x += (f.players[i].x - state.focus.x) * k;
        state.focus.y += (f.players[i].y - state.focus.y) * k;
      }
    }
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
  const near = Number(params.get('near')) || 0;
  joinInfo = {
    arena: selectedArena,
    join: { name, token, hat: settings.get('hat'), trail: settings.get('trail'), near },
  };
  reconnectTry = -1;
  net.close();
  net.connect(joinInfo.arena, joinInfo.join);
});

// With ?debug, expose internals for testing from the browser console.
if (params.has('debug')) {
  window.__blast = { get state() { return state; }, predictor, net };
}

applyLanguage(getLanguage());
applyI18n();
setInterval(() => { if (!state) refreshLobby(); }, 4000);
assets.load().then(() => requestAnimationFrame(frame));
