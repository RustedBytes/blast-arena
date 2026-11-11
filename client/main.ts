import { Alerts } from './alerts.js';
import { Assets, ITEM_SPRITES, itemSprite, playerColors } from './assets.js';
import type { SpriteName } from './assets.js';
import { GameAudio } from './audio.js';
import { LANGUAGES, applyI18n, detectLanguage, getLanguage, setLanguage, t } from './i18n.js';
import { Input } from './input.js';
import { Net } from './net.js';
import { Particles } from './particles.js';
import { Predictor } from './prediction.js';
import { AB, BOMB_FLAG, EV, GUARD_NEWS, PLAYER_FLAG, WORM_NEWS, hasFlag, meObject } from './protocol.js';
import { EMOTES, NUKE_SHOW_TICKS, Renderer } from './render.js';
import { MINIMAP_MAX, MINIMAP_MIN, Settings } from './settings.js';
import { Tutorial } from './tutorial.js';

import { byId as $, closest, fireAndForget, query, setTrailingText } from './dom.js';
import type { BombView, GameSnapshot, GameState, RosterInfo, SnapshotRing } from './state.js';
import type { Me } from './protocol.js';
import type { JoinFields } from './protocol.js';
import type { StatusOpts, Tone } from './alerts.js';
const KILLFEED_SIZE = 5;
const VIEW_DEBOUNCE_MS = 200;
const RECONNECT_DELAYS = [500, 1500, 3000, 5000];
// Remote entities are drawn this far behind the newest snapshot, at least
// (ticks); the delay grows with measured network jitter.
const INTERP_MIN_TICKS = 1.15;
const INTERP_MARGIN_TICKS = 0.15;
// Death replay: starts this much game time before the death (played at
// REPLAY_RATE, see render.ts) and runs until respawn.
const REPLAY_TICKS = 40;

/** Fixed-capacity ring of snapshots, oldest first. */
class SnapRing implements SnapshotRing {
  buf: GameSnapshot[];
  cap: number;
  head: number;
  len: number;

  constructor(capacity = 32) {
    this.buf = new Array<GameSnapshot>(capacity);
    this.cap = capacity;
    this.head = 0;
    this.len = 0;
  }
  push(s: GameSnapshot): void {
    if (this.len < this.cap) this.buf[(this.head + this.len++) % this.cap] = s;
    else { this.buf[this.head] = s; this.head = (this.head + 1) % this.cap; }
  }
  get(i: number): GameSnapshot { return this.buf[(this.head + i) % this.cap]; }
  latest(): GameSnapshot { return this.get(this.len - 1); }
}

// How each map event is announced: icon and tone, by kind.
const EVENT_LOOK: ([string, Tone] | null)[] = [null, ['☄️', 'danger'], ['❄️', 'info'], ['🌋', 'danger'], ['⚙️', 'warn'], ['🌍', 'danger']];

const settings = new Settings();
const alerts = new Alerts($('alerts'));
setLanguage(detectLanguage(settings.get('lang')));
const audio = new GameAudio();
const assets = new Assets();
const particles = new Particles(2048);
const renderer = new Renderer($('game', HTMLCanvasElement), $('minimap', HTMLCanvasElement), assets, particles);
const predictor = new Predictor();
const tutorial = new Tutorial($('tutorial'), () => settings.set('tutorialDone', true));
let state: GameState | null = null;
let joinInfo: { arena: number; join: JoinFields } | null = null;      // what we joined with, for reconnecting
let reconnectTry = -1;    // -1: not reconnecting

// A persistent random token identifies this browser's profile.
const token = (() => {
  try {
    let tok = localStorage.getItem('blast-token');
    if (!tok) {
      tok = 'randomUUID' in crypto ? crypto.randomUUID() : `t-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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
function findSnapshot(k: number): GameSnapshot | null {
  if (!state) return null;
  const ring = state.snaps;
  for (let i = ring.len - 1; i >= 0; i--) {
    const s = ring.get(i);
    if (s.k === k) return s;
    if (s.k < k) break;
  }
  return null;
}

function rebuildItems(): void {
  if (!state) return;
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
    const rosterInfo = new Map<number, RosterInfo>();
    for (const [id, name, team, hat, trail] of m.roster) rosterInfo.set(id, { name, team, hat, trail });
    state = {
      myId: m.id,
      arena: joinInfo?.arena ?? 0,
      arenaName: m.arena,
      mode: m.mode,
      team: m.team,
      map: { w: m.w, h: m.h, tiles, biomes: m.biomes },
      aoi: m.aoi,
      aoiMax: m.aoi_max,
      tickMs: 1000 / m.rate,
      rosterInfo,
      snaps: new SnapRing(100),
      sd: null,        // sudden death: { cx, cy, r, nextAt }
      flags: null,     // capture the flag: [{ base, state, pos, carrier }] x2
      captures: [0, 0],
      replay: null,    // death replay: { from, t0 }
      offset: null,
      // Adaptive interpolation delay for remote entities, in ticks: one
      // tick between snapshots plus the recent worst-case lateness.
      lateness: 0,
      interpDelay: 2,
      interpTarget: 2,
      me: null,
      mine: null,
      self: { x: m.w / 2, y: m.h / 2 },
      focus: { x: m.w / 2, y: m.h / 2 },
      look: null, // the map spot watched from the minimap, if any
      lookFrom: null,
      lookBlend: 0,
      zone: null,      // battle royale zone: { state, start, end, from, to, phase }
      royale: null,    // battle royale match: { alive, on, nextAt }
      zoom: settings.get('zoom'),
      zoomTarget: settings.get('zoom'),
      itemMap: new Map(),
      items: [],
      explosions: [],
      hills: m.hills,
      emotes: new Map(),
      bombCells: new Set(),
      wormMeals: new Set(), // players a worm just ate (their kill message follows)
      eatenByWorm: false,
      wardenMeals: new Set(), // players the Warden just crushed (likewise)
      crushedByWarden: false,
      lastLb: '',
      roundSecs: m.round,
      movedAt: null,
      // Ability tuning from the server (ticks; see protocol::AbilityInfo).
      abilities: m.abilities,
    };
    // A new game watches your own player (the server too).
    lookDrag = null;
    $('look-pill').classList.add('hidden');
    net.send({ t: 'look', at: null });
    for (const [x, y, k] of m.items) state.itemMap.set(y * m.w + x, k);
    rebuildItems();
    seenExplosions.clear();
    predictor.active = false;
    renderer.resetMap(state.map);
    applyVisualSettings();
    $('join').classList.add('hidden');
    $('reconnecting').classList.add('hidden');
    $('hud').classList.remove('hidden');
    $('vignette').classList.remove('hidden');
    $('team-scores').classList.toggle('hidden', m.mode !== 'teams');
    $('play', HTMLButtonElement).disabled = false;
    reconnectTry = -1;
    input.enabled = true;
    resize();
    if (m.resumed) toast(t('welcomeBack'), null, 'mystery');
    if (!settings.get('tutorialDone')) tutorial.start();
  },

  s(raw) {
    if (!state) return;
    const now = performance.now();
    // The decoder has already rebuilt full lists from the delta (see
    // protocol.ts). Bombs carry their absolute detonation tick; derive the
    // fuse left.
    const m: GameSnapshot = {
      ...raw,
      b: raw.rawB.map(([id, x, y, at, f]): BombView => [id, x, y, hasFlag(f, BOMB_FLAG.REMOTE) ? 99 : Math.max(0, at - raw.k), f]),
      me: meObject(raw.rawMe),
    };
    state.lastK = m.k;
    // Map server ticks onto local time. The offset follows the earliest
    // arrivals (quickly down, slowly up), so `est - offset` is how late this
    // snapshot is; a decaying peak of that sets the interpolation delay.
    const est = now / state.tickMs - m.k;
    if (state.offset === null || Math.abs(est - state.offset) > 10) {
      state.offset = est;
      state.lateness = 0.5;
    } else {
      const dev = est - state.offset;
      state.offset += dev < 0 ? dev * 0.3 : dev * 0.01;
      state.lateness = Math.max(state.lateness * 0.97, Math.max(0, dev));
    }
    state.interpTarget = Math.min(4, Math.max(INTERP_MIN_TICKS, 1 + state.lateness + INTERP_MARGIN_TICKS));
    state.snaps.push(m);

    state.bombCells.clear();
    // Hidden mines (flag 32) don't block anyone, so they're not obstacles;
    // nor do sticky bombs riding on someone.
    const stuck = new Set(m.x.stuck.map((s) => s[0]));
    for (const b of m.b) if (!hasFlag(b[4], BOMB_FLAG.MINE) && !stuck.has(b[0])) state.bombCells.add(b[2] * state.map.w + b[1]);

    const prevMe = state.me;
    state.me = m.me;
    const myId = state.myId;
    const mine = m.p.find((e) => e[0] === myId) ?? null;
    state.mine = mine;
    if (mine && m.me.alive) {
      const mx = mine[1] / 100, my = mine[2] / 100;
      if (!predictor.active || !prevMe?.alive) {
        predictor.reset(mx, my, mine[3]);
        state.self.x = mx;
        state.self.y = my;
        if (prevMe && !prevMe.alive) renderer.spawnBeam(mx, my, now);
      } else {
        predictor.reconcile(mx, my, hasFlag(mine[4], PLAYER_FLAG.MOVING), mine[3], m.me.ack, state, input.current);
      }
    } else if (!m.me.alive) {
      predictor.active = false;
    }
    // Death replay: watch the last moments again, slowly, until respawn.
    if (prevMe?.alive && !m.me.alive) state.replay = { from: m.k - REPLAY_TICKS, t0: now };
    else if (m.me.alive) state.replay = null;

    // New explosions: effects, shake and positional sound.
    nextExplosions.clear();
    for (const e of m.e) {
      const key = (m.k + e[3]) * 1e6 + e[1] * 1000 + e[0];
      nextExplosions.add(key);
      if (!seenExplosions.has(key)) {
        const dx = e[0] + 0.5 - state.focus.x, dy = e[1] + 0.5 - state.focus.y;
        const d = Math.hypot(dx, dy);
        const pan = Math.max(-1, Math.min(1, dx / 10));
        if (e[4]) {
          // Atomic blast; `age` > 0 if it went off before we could see it.
          const age = Math.max(0, NUKE_SHOW_TICKS - e[3] - 1) * state.tickMs / 1000;
          renderer.nuke(e[0], e[1], e[4], now, d, state.map, age);
          if (age < 0.5) audio.nuke(d, pan);
        } else {
          renderer.explosion(e[0], e[1], e[2], now, d);
          audio.explosion(d, pan);
        }
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
      if ((map.tiles[idx] === 2 || map.tiles[idx] === 9) && tile !== map.tiles[idx] && tile !== 1) renderer.crateBroken(x, y);
      map.tiles[idx] = tile;
      renderer.invalidateTile(map, x, y);
      renderer.updateSpecial(x, y, tile);
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
    const curse = m.f >= 110 && m.f !== 112;
    const icon = m.f < ITEM_SPRITES.length ? ITEM_SPRITES[m.f] : 'pu_mystery';
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
    const st = state;
    const name = (id: number): string => escapeHtml(st.rosterInfo.get(id)?.name ?? '???');
    // A worm's meal is announced (EV.WORM) just before the kill.
    const eaten = state.wormMeals.delete(m.v);
    if (m.v === state.myId) state.eatenByWorm = eaten;
    // So is the Warden's (EV.GUARD).
    const crushed = state.wardenMeals.delete(m.v);
    if (m.v === state.myId) state.crushedByWarden = crushed;
    const el = document.createElement('div');
    el.className = 'kill';
    if (m.k === state.myId || m.v === state.myId) el.classList.add('mine');
    el.innerHTML = crushed
      ? `🗿 ${t('wasCrushed', { v: `<b class="v">${name(m.v)}</b>` })}`
      : eaten
      ? `🪱 ${t('wasEaten', { v: `<b class="v">${name(m.v)}</b>` })}`
      : m.k === null
      ? t('wasBlasted', { v: `<b class="v">${name(m.v)}</b>` })
      : m.k === m.v
        ? t('blewUp', { v: `<b class="v">${name(m.v)}</b>` })
        : `<b class="k">${name(m.k)}</b> 💥 <b class="v">${name(m.v)}</b>${m.b ? ' 🎯' : ''}`;
    const feed = $('killfeed');
    feed.prepend(el);
    while (feed.children.length > KILLFEED_SIZE) feed.lastElementChild?.remove();
    setTimeout(() => el.remove(), 6000);
    if (m.b && m.k === state.myId) alerts.announce({ text: t('bountyKill'), icon: '🎯', tone: 'epic', priority: 2 });
  },

  lb(m) {
    if (!state) return;
    $('online').textContent = t('online', { n: m.n });
    state.roundSecs = m.r;
    if (state.mode !== 'royale') $('round-time').textContent = `⏱ ${Math.floor(m.r / 60)}:${String(m.r % 60).padStart(2, '0')}`;
    const ts = $('team-scores');
    query(ts, '.red').textContent = String(m.teams[0]);
    query(ts, '.blue').textContent = String(m.teams[1]);
    const key = m.top.map((e) => e.join()).join('|');
    if (key === state.lastLb) return;
    state.lastLb = key;
    const st = state;
    $('lb-list').innerHTML = m.top
      .map(([id, name, score, kills, deaths]) => {
        const team = st.rosterInfo.get(id)?.team ?? 0;
        return `<li class="${id === st.myId ? 'me' : ''} team-${team}"><div class="row"><span class="n">${escapeHtml(name)}</span>` +
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
    alerts.announce({ text: t('streak', { name, n: m.n }), icon: '🔥', tone: m.id === state.myId ? 'epic' : 'warn', key: `streak${m.id}` });
  },

  hills(m) {
    if (state) state.hills = m.h;
  },

  /** Game events: sudden death, map events, capture the flag, swaps. */
  ev(m) {
    if (!state) return;
    const now = performance.now();
    const v = m.v;
    switch (m.kind) {
      case EV.SHRINK: {
        const was = state.sd;
        state.sd = v[4] ? { cx: v[0], cy: v[1], r: v[2], nextAt: now + v[3] * state.tickMs } : null;
        if (state.sd && !was) {
          alerts.announce({ text: t('suddenDeath'), sub: t('suddenDeathHint'), icon: '⏳', tone: 'danger', priority: 3, duration: 4000 });
          audio.curse();
        }
        break;
      }
      case EV.ANNOUNCE:
        {
          const [icon, tone] = EVENT_LOOK[v[0]] ?? ['❗', 'warn'];
          alerts.announce({ text: t('mapEvents')[v[0]] ?? '!', sub: t('mapEventHints')[v[0]], icon, tone, priority: 2, duration: 3800 });
        }
        renderer.mapEvent(v[0], now, v[1] * 1000);
        if (v[0] === 5) audio.nuke(22, 0); // an earthquake: a deep rumble
        else audio.mystery();
        break;
      case EV.STRIKES:
        for (let i = 0; i + 2 < v.length; i += 3) renderer.addMeteor(v[i], v[i + 1], now + v[i + 2] * state.tickMs);
        break;
      case EV.LAVA:
        renderer.addLava(v.slice(2), now + v[0] * state.tickMs, v[1] * state.tickMs);
        break;
      case EV.FLAGS:
        state.flags = [0, 1].map((k) => {
          const o = k * 6;
          return { base: [v[o], v[o + 1]], state: v[o + 2], pos: [v[o + 3], v[o + 4]], carrier: v[o + 5] - 1 };
        });
        state.captures = [v[12], v[13]];
        updateCaptures();
        break;
      case EV.FLAG_NEWS: {
        const [what, team, pid] = v;
        const name = state.rosterInfo.get(pid - 1)?.name ?? '';
        const flag = team === 1 ? t('red') : t('blue');
        const news = t('flagNews')[what]?.replace('{name}', name).replace('{flag}', flag) ?? '';
        if (what === 4) {
          alerts.announce({ text: news, icon: '🚩', tone: 'epic', priority: 2, duration: 3500 });
          audio.mystery();
        } else {
          alerts.toast(news, { icon: '🚩', tone: what === 1 ? 'warn' : 'info' });
          audio.pickup();
        }
        break;
      }
      case EV.ZONE: {
        const c = (k: number) => ({ x: v[k] / 100, y: v[k + 1] / 100, r: v[k + 2] / 100 });
        const was = state.zone?.state;
        state.zone = { state: v[0], start: now, end: now + v[1] * state.tickMs, from: c(2), to: c(5), phase: v[8] };
        if (v[0] === 1 && was !== 1) {
          alerts.announce({ text: t('zoneClosing'), sub: t('zoneHint'), icon: '🌀', tone: 'warn', priority: 2, duration: 3500 });
          audio.curse();
        }
        break;
      }
      case EV.ROYALE:
        state.royale = { alive: v[0], on: v[1] === 1, nextAt: now + v[2] * state.tickMs };
        break;
      case EV.WINNER: {
        const id = v[0] - 1;
        const name = state.rosterInfo.get(id)?.name ?? '?';
        alerts.announce({
          text: id < 0 ? t('nobodyWins') : id === state.myId ? t('youWin') : t('winnerIs', { name }),
          icon: id < 0 ? '💀' : '🏆', tone: id === state.myId ? 'good' : 'epic', priority: 4, duration: 4500,
        });
        audio.mystery();
        renderer.confetti();
        break;
      }
      case EV.ABILITY:
        abilityEvent(v);
        break;
      case EV.WORM:
        wormEvent(v);
        break;
      case EV.GUARD:
        guardEvent(v);
        break;
      case EV.SWAP:
        for (const id of v) {
          const f = renderer.frame;
          for (let i = 0; i < f.nPlayers; i++) if (f.players[i].id === id) renderer.sparkle(f.players[i].x, f.players[i].y, true);
        }
        audio.curse();
        break;
    }
  },

  round(m) {
    if (!state) return;
    const list = $('round-mvp');
    list.innerHTML = m.mvp.map(([, name, score, kills]) => `<li>${escapeHtml(name)} — ${score} (${kills}K)</li>`).join('');
    $('round-winner').textContent = m.win ? t('teamWins', { team: m.win === 1 ? t('red') : t('blue') }) : (m.mvp[0] ? `${t('mvp')}: ${m.mvp[0][1]}` : '');
    $('round-over').classList.remove('hidden');
    renderer.confetti();
    audio.mystery();
    setTimeout(() => $('round-over').classList.add('hidden'), 6000);
  },

  err(m) {
    $('join-error').textContent = m.m === 'server is full, try again later' ? t('fullServer') : m.m;
    reconnectTry = -1;
  },

  close() {
    alerts.reset();
    input.enabled = false;
    input.clear();
    const wasPlaying = state !== null;
    state = null;
    predictor.active = false;
    $('hud').classList.add('hidden');
    $('vignette').classList.add('hidden');
    $('settings').classList.add('hidden');
    // An unexpected drop mid-game: try to reconnect (the server keeps our
    // progress for 30 s).
    if ((wasPlaying || reconnectTry >= 0) && joinInfo && reconnectTry + 1 < RECONNECT_DELAYS.length) {
      reconnectTry++;
      $('reconnecting').classList.remove('hidden');
      const info = joinInfo;
      setTimeout(() => net.connect(info.arena, info.join), RECONNECT_DELAYS[reconnectTry]);
      return;
    }
    reconnectTry = -1;
    $('reconnecting').classList.add('hidden');
    $('join').classList.remove('hidden');
    $('play', HTMLButtonElement).disabled = false;
    if (!$('join-error').textContent) $('join-error').textContent = t('disconnected');
    refreshLobbyLater();
  },
}, (k) => (state ? findSnapshot(k) : null));

const input = new Input({
  // Send a changed direction immediately instead of at the next 50 ms step.
  onDir: () => { if (state) predictor.inputChanged(input.current, sendInput); },
  onBomb: () => {
    stopLooking();
    net.send({ t: 'bomb' });
  },
  onAct: () => { stopLooking(); net.send({ t: 'act' }); },
  onGadget: () => { stopLooking(); net.send({ t: 'gadget' }); },
  onAbility: () => { stopLooking(); net.send({ t: 'ability' }); },
  onCancel: () => net.send({ t: 'cancel' }),
  onEmote: (e) => sendEmote(e),
  onZoom: (factor) => {
    setZoom((state?.zoomTarget ?? settings.get('zoom')) * factor);
    tutorial.notify('zoom');
  },
  onAction(name, down) {
    if (name === 'board') $('leaderboard').classList.toggle('expanded', down);
    else if (name === 'mute') settings.set('muted', !settings.get('muted'));
    else if (name === 'fps') settings.set('showFps', !settings.get('showFps'));
    else if (name === 'minimap') settings.set('showMinimap', !settings.get('showMinimap'));
    else if (name === 'zoomReset') setZoom(1);
    else if (name === 'menu') toggleSettings();
    else $('emote-wheel').classList.toggle('hidden'); // 'emoteWheel'
  },
});

/** The vault's Warden (EV.GUARD): effects, sounds and notices. */
function guardEvent([what, x, y, who]: number[]): void {
  if (!state) return;
  const st = state;
  const id = who - 1;
  const now = performance.now();
  const dist = Math.hypot(x + 0.5 - state.focus.x, y + 0.5 - state.focus.y);
  const pan = Math.max(-1, Math.min(1, (x + 0.5 - state.focus.x) / 10));
  const name = (pid: number): string => st.rosterInfo.get(pid)?.name ?? '?';
  switch (what) {
    case GUARD_NEWS.CRUSHED:
      state.wardenMeals.add(id);
      renderer.wormGulp(x, y);
      break;
    case GUARD_NEWS.SLAM:
      renderer.wardenSlam(x, y, now, dist < 12);
      if (dist < 16) audio.explosion(dist, pan);
      break;
    case GUARD_NEWS.LOB:
      if (dist < 12) audio.bombPlaced();
      break;
    case GUARD_NEWS.KILLED:
      renderer.wardenDown(x, y, now);
      if (dist < 20) audio.nuke(dist, pan);
      if (id === state.myId) alerts.announce({ text: t('wardenSlainByYou'), icon: '🗿', tone: 'epic', priority: 2 });
      else alerts.toast(id >= 0 ? t('wardenSlain', { name: name(id) }) : t('wardenFell'), { icon: '🗿', tone: 'warn', key: 'warden' });
      break;
    case GUARD_NEWS.BACK:
      alerts.toast(t('wardenBack'), { icon: '🗿', tone: 'info', key: 'warden' });
      break;
  }
}

/** Worms arena news (EV.WORM): effects, sounds and notices. */
function wormEvent([what, x, y, who]: number[]): void {
  if (!state) return;
  const id = who - 1;
  const near = Math.hypot(x + 0.5 - state.focus.x, y + 0.5 - state.focus.y) < 14;
  switch (what) {
    case WORM_NEWS.ATE:
      state.wormMeals.add(id);
      renderer.wormGulp(x, y);
      break;
    case WORM_NEWS.KILLED:
      renderer.wormSplat(x, y, true);
      if (near) audio.kick();
      if (id === state.myId) alerts.toast(t('wormKilled'), { icon: '🪱', tone: 'good', key: 'worm-news' });
      break;
    case WORM_NEWS.CUT:
      renderer.wormSplat(x, y, false);
      if (near) audio.kick();
      if (id === state.myId) alerts.toast(t('wormCut'), { icon: '✂️', tone: 'info', key: 'worm-news' });
      break;
  }
}

/** Ability events (EV.ABILITY): effects, sounds and notices. */
function abilityEvent(v: number[]): void {
  if (!state) return;
  const st = state;
  const [kind, , ...a] = v;
  const tile = (x: number, y: number): [number, number] => [x + 0.5, y + 0.5];
  const dist = (x: number, y: number): number => Math.hypot(x + 0.5 - st.focus.x, y + 0.5 - st.focus.y);
  const pan = (x: number): number => Math.max(-1, Math.min(1, (x + 0.5 - st.focus.x) / 10));
  switch (kind) {
    case AB.REJECTED: {
      const [item, reason] = a;
      const name = t('abilityNames')[item] ?? '';
      alerts.toast(`${name}: ${t('abilityRejected')[reason] ?? '?'}`, { icon: `img:${ITEM_SPRITES[item] ?? 'pu_mystery'}`, tone: 'warn', key: 'ability-rejected' });
      audio.uiClick();
      break;
    }
    case AB.WALL_CREATED: {
      const [, , x, y] = a;
      renderer.crateBroken(x, y); // a puff of dust as it goes up
      if (dist(x, y) < 12) audio.kick();
      break;
    }
    case AB.WALL_REMOVED: {
      const [, x, y, destroyed] = a;
      if (destroyed) renderer.crateBroken(x, y);
      break;
    }
    case AB.GAS_CREATED: {
      const [, , x, y] = a;
      if (dist(x, y) < 12) audio.curse();
      break;
    }
    case AB.GAS_IGNITED: {
      const [, x, y] = a;
      audio.explosion(dist(x, y), pan(x));
      if (dist(x, y) < 4) alerts.toast(t('gasIgnited'), { icon: '🔥', tone: 'danger', key: 'gas-ignited' });
      break;
    }
    case AB.CLONE_SPAWNED: {
      const [, , x, y] = a;
      renderer.sparkle(...tile(x, y), true);
      audio.mystery();
      break;
    }
    case AB.CLONE_DESTROYED: {
      const [, x, y] = a;
      renderer.sparkle(...tile(x, y), false);
      break;
    }
    case AB.STICKY_ATTACHED: {
      const [, target, , x, y] = a;
      if (target === state.myId) audio.curse();
      else if (dist(x, y) < 12) audio.kick();
      break;
    }
    case AB.STICKY_DETACHED: {
      const [, target] = a;
      if (target === state.myId) audio.pickup();
      break;
    }
    case AB.PORTAL_CREATED: {
      const [, , x, y] = a;
      renderer.sparkle(...tile(x, y), true);
      break;
    }
    case AB.PORTAL_LINKED: {
      const [, , owner, x, y] = a;
      renderer.sparkle(...tile(x, y), true);
      if (owner === state.myId) audio.mystery();
      break;
    }
    case AB.TELEPORTED: {
      const [what, id, fx, fy, tx, ty] = a;
      renderer.sparkle(...tile(fx, fy), true);
      renderer.sparkle(...tile(tx, ty), true);
      if (what === 0 && id === state.myId) audio.mystery();
      else if (dist(fx, fy) < 10 || dist(tx, ty) < 10) audio.pickup();
      break;
    }
    case AB.DASH_STARTED: {
      const [id, , x, y] = a;
      if (id === state.myId || dist(x, y) < 10) audio.jump();
      break;
    }
    default: break;
  }
}

function sendEmote(e: number): void {
  net.send({ t: 'emote', e });
  $('emote-wheel').classList.add('hidden');
}

function escapeHtml(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** A small notice; `kind` '' (good news), 'mystery' or 'curse'; `icon` a sprite name. */
function toast(text: string, icon: string | null, kind: '' | 'mystery' | 'curse' | 'info'): void {
  const tone = kind === 'curse' ? 'danger' : kind === 'mystery' ? 'epic' : kind === 'info' ? 'info' : 'good';
  alerts.toast(text, { icon: icon ? `img:${icon}` : null, tone });
}

/**
 * Pinned alerts for situations that last: in the storm, in a nuke's zone,
 * at the sudden-death edge, stunned, carrying a flag. Called every frame;
 * the alerts only touch the page when something changes.
 */
function updateStatusAlerts(now: number): void {
  if (!state?.me) return;
  const st = state, me = state.me;
  const alive = me.alive;
  const show = (key: string, on: boolean, text: string, opts: StatusOpts): void => (on ? alerts.status(key, text, opts) : alerts.clear(key));
  show('storm', alive && me.storm > 0, t('inStorm'),
    { icon: '🌀', tone: 'danger', progress: 1 - me.storm / Math.max(1, me.storm_max) });
  const nuke = alive ? renderer.inNukeZone : null;
  show('nuke', !!nuke, t('nukeRun', { n: Math.ceil((nuke?.fuse ?? 0) * 0.05) }),
    { icon: '☢️', tone: 'danger', progress: (nuke?.fuse ?? 0) / 70 });
  const sd = st.sd;
  let edge = false;
  if (alive && sd) {
    const ring = Math.max(Math.abs(Math.floor(st.self.x) - sd.cx), Math.abs(Math.floor(st.self.y) - sd.cy));
    edge = ring >= sd.r - 1;
  }
  show('sd', edge, t('moveInward'), { icon: '⏳', tone: 'danger', progress: Math.max(0, (sd?.nextAt ?? now) - now) / 2000 });
  show('stun', alive && me.stun > 0, t('stunned'), { icon: '💫', tone: 'warn' });
  // A sticky bomb on you: how long it has, and how far the shake-off got.
  const touch = document.body.classList.contains('touch');
  const stuck = alive && me.stuck > 0;
  const detachTotal = st.abilities?.detach ?? 16;
  show('stuck', stuck, t(touch ? 'stuckTouch' : 'stuckOn', { n: Math.ceil(me.stuck * st.tickMs / 1000) }),
    { icon: 'img:pu_sticky', tone: 'danger', progress: me.detach / detachTotal });
  $('detach-btn').classList.toggle('hidden', !stuck);
  show('gas', alive && me.gassed > 0, t('inGas'), { icon: 'img:pu_gas', tone: 'warn' });
  document.body.classList.toggle('in-gas', alive && me.gassed > 0);
  const wait = alive ? me.portal_wait : 0;
  show('portal', wait > 0, t('portalWaiting', { n: Math.ceil(wait * st.tickMs / 1000) }),
    { icon: 'img:pu_portal', tone: 'info', progress: wait / (st.abilities?.portal_wait ?? 100) });
  show('flag', alive && !!me.carrying, t('carryFlag'), { icon: '🚩', tone: 'info' });
  document.body.classList.toggle('in-storm', alive && me.storm > 0);
}

// ------------------------------------------------------------------- zoom

let viewTimer = 0;
function setZoom(z: number): void {
  let zz = Math.min(renderer.maxZoom, Math.max(renderer.minZoom, z));
  if (!Number.isFinite(zz)) zz = 1;
  if (state) state.zoomTarget = zz;
  settings.set('zoom', zz);
  $('set-zoom', HTMLInputElement).value = String(zz);
  requestView();
}

// ------------------------------------------------------- watching the map
// Dragging (or clicking) the minimap moves its view box: the camera goes
// there and the server sends what's around it. The pill, or moving,
// jumping, bombing or using an item, brings the camera back.
const LOOK_SEND_MS = 100;
let lookDrag: { dx: number; dy: number } | null = null; // { dx, dy }: where the box was grabbed, in tiles from its centre
let lookSentAt = 0;

/** The current game; only called while one is running. */
function game(): GameState {
  if (!state) throw new Error('no game running');
  return state;
}
let lookTimer = 0;

/** The map position (in tiles) under a pointer event on the minimap. */
function minimapPoint(e: PointerEvent): [number, number] {
  const state = game();
  const r = $('minimap').getBoundingClientRect();
  const scale = r.width / Math.max(state.map.w, state.map.h);
  return [(e.clientX - r.left) / scale, (e.clientY - r.top) / scale];
}

function lookAt(x: number, y: number): void {
  const state = game();
  // Only as far as the camera can go, so the box on the minimap is where
  // the view really is (and grabbing it never makes it jump).
  const T = renderer.T || 1;
  const hw = renderer.canvas.width / T / 2, hh = renderer.canvas.height / T / 2;
  const fit = (v: number, half: number, size: number): number => (2 * half >= size ? size / 2 : Math.max(half, Math.min(size - half, v)));
  state.look = { x: fit(x, hw, state.map.w), y: fit(y, hh, state.map.h) };
  $('look-pill').classList.remove('hidden');
  renderer.lastMinimap = 0; // the box moves at once, not at the next refresh
  sendLook();
}

/** Tells the server where we watch, at most every `LOOK_SEND_MS`. */
function sendLook() {
  clearTimeout(lookTimer);
  const wait = LOOK_SEND_MS - (performance.now() - lookSentAt);
  if (wait > 0) {
    lookTimer = setTimeout(sendLook, wait);
    return;
  }
  lookSentAt = performance.now();
  const l = state?.look;
  net.send({ t: 'look', at: l ? [Math.floor(l.x), Math.floor(l.y)] : null });
}

function stopLooking() {
  if (!state?.look) return;
  state.look = null;
  lookDrag = null;
  $('minimap').classList.remove('dragging');
  $('look-pill').classList.add('hidden');
  renderer.lastMinimap = 0;
  lookSentAt = 0; // right away
  sendLook();
}

$('minimap').addEventListener('pointerdown', (e) => {
  if (!state || e.button !== 0) return;
  e.preventDefault();
  const [x, y] = minimapPoint(e);
  // Grabbing the box keeps it under the pointer; clicking elsewhere centres it there.
  const T = renderer.T || 1;
  const vw = renderer.canvas.width / T, vh = renderer.canvas.height / T;
  const cx = renderer.camX / T + vw / 2, cy = renderer.camY / T + vh / 2;
  const grabbed = Math.abs(x - cx) <= vw / 2 && Math.abs(y - cy) <= vh / 2;
  lookDrag = grabbed ? { dx: cx - x, dy: cy - y } : { dx: 0, dy: 0 };
  $('minimap').classList.add('dragging');
  try {
    $('minimap').setPointerCapture(e.pointerId); // keep dragging outside the minimap
  } catch { /* a pointer that's already gone: just this click */ }
  lookAt(x + lookDrag.dx, y + lookDrag.dy);
});
$('minimap').addEventListener('pointermove', (e) => {
  if (!lookDrag || !state) return;
  const [x, y] = minimapPoint(e);
  lookAt(x + lookDrag.dx, y + lookDrag.dy);
});
for (const end of ['pointerup', 'pointercancel']) {
  $('minimap').addEventListener(end, () => {
    lookDrag = null;
    $('minimap').classList.remove('dragging');
  });
}
$('look-pill').addEventListener('click', stopLooking);

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
  $('set-zoom', HTMLInputElement).min = renderer.minZoom.toFixed(2);
  $('set-zoom', HTMLInputElement).max = String(renderer.maxZoom);
  setZoom(state.zoomTarget);
}
addEventListener('resize', resize);
// Moving the window to a screen with another pixel ratio (or browser zoom)
// changes devicePixelRatio, which doesn't always fire 'resize'.
(function watchDpr() {
  matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener('change', () => { resize(); watchDpr(); }, { once: true });
})();

// -------------------------------------------------------------- HUD

let hudKey = '';
function updateHud(me: Me): void {
  const state = game();
  const key = [me.bombs, me.active, me.range, me.speed, me.kick, me.pierce, me.remote, me.line, me.punch, me.score, me.alive,
    me.respawn, Math.ceil(me.shield / 10), Math.ceil(me.ghost / 10), me.curse, Math.ceil(me.curse_t / 10), me.spec, me.nukes,
    me.gadget, me.gadget_n, me.freeze, me.stomp, me.stun, me.carrying, me.storm,
    me.ability, me.ability_n, me.ability_max, Math.ceil(me.ability_cd / 2), me.gas_bombs, me.sticky_bombs,
    getLanguage()].join();
  if (key === hudKey) return;
  hudKey = key;
  $('st-bombs').textContent = `${me.bombs - me.active}/${me.bombs}`;
  $('st-range').textContent = String(me.range);
  $('st-speed').textContent = String(me.speed);
  for (const k of ['kick', 'pierce', 'remote', 'line', 'punch'] as const) $(`st-${k}`).classList.toggle('off', !me[k]);
  $('st-score').textContent = String(me.score);
  $('st-nuke').classList.toggle('hidden', !me.nukes);
  for (const k of ['freeze', 'stomp'] as const) $(`st-${k}`).classList.toggle('off', !me[k]);
  const g = $('st-gadget');
  g.classList.toggle('hidden', !me.gadget_n);
  if (me.gadget_n) {
    setStatIcon(g, itemSprite(me.gadget));
    setTrailingText(g, `×${me.gadget_n}`);
    g.title = `${t('items')[me.gadget] ?? ''} (Q)`;
  }
  setTrailingText($('st-nuke'), me.nukes > 1 ? `×${me.nukes}` : '');
  // The active ability: charges, and a sweep while the next one recharges.
  const ab = $('st-ability');
  ab.classList.toggle('hidden', !me.ability);
  if (me.ability) {
    setStatIcon(ab, itemSprite(me.ability));
    setTrailingText(ab, me.ability_max > 1 ? `${me.ability_n}/${me.ability_max}` : '');
    const cd = state.abilities?.cooldowns.find((c) => c[0] === me.ability)?.[1] ?? 1;
    ab.style.setProperty('--cd', me.ability_cd > 0 ? Math.min(1, me.ability_cd / Math.max(1, cd)).toFixed(3) : '0');
    ab.classList.toggle('empty', me.ability_n === 0);
    ab.title = `${t('items')[me.ability] ?? ''} (R)` + (me.ability_cd > 0 ? ` · ${Math.ceil(me.ability_cd * state.tickMs / 1000)} s` : '');
  }
  // Bomb modifiers: the next bombs are gas or sticky bombs.
  const mod = $('st-modifier');
  const modN = me.gas_bombs || me.sticky_bombs;
  mod.classList.toggle('hidden', !modN);
  if (modN) {
    const name = me.gas_bombs ? 'pu_gas' : 'pu_sticky';
    setStatIcon(mod, name);
    setTrailingText(mod, `×${modN}`);
    mod.title = t('items')[me.gas_bombs ? 22 : 24] ?? '';
  }
  const tickS = state.tickMs / 1000;
  timer($('st-stun'), me.stun > 0, me.stun * tickS, 1);
  timer($('st-shield'), me.alive && me.shield > 0, me.shield * tickS, 6);
  timer($('st-ghost'), me.ghost > 0, me.ghost * tickS, 6);
  timer($('st-curse'), me.curse !== 0, me.curse_t * tickS, me.curse === 1 ? 8 : me.curse === 2 ? 6 : 8);
  $('st-curse').title = t('curses')[me.curse] ?? '';

  $('dead').classList.toggle('hidden', me.alive);
  if (!me.alive) {
    const killer = me.killer;
    const name = (id: number): string => state.rosterInfo.get(id)?.name ?? '?';
    const out = me.respawn * tickS > 3600; // royale: out until the next match
    $('dead').classList.toggle('out', out);
    $('dead-msg').textContent = killer === state.myId
      ? t('youBlewUp')
      : killer != null ? t('blastedBy', { name: name(killer) }) : out ? t('outTitle')
        : state.crushedByWarden ? t('youWereCrushed')
          : state.eatenByWorm ? t('youWereEaten') : t('youWereBlasted');
    $('dead-timer').textContent = (out ? t('outOfMatch') : t('respawning', { n: Math.ceil(me.respawn * tickS) })) +
      (me.spec ? ` · ${t('watching', { name: name(me.spec) })}` : '');
  }
}

/** Battle royale: players left and the zone's timer, in place of the round clock. */
function updateRoyaleHud(now: number): void {
  if (state?.mode !== 'royale') return;
  const r = state.royale, z = state.zone;
  let text = '';
  if (r && !r.on) text = t('nextMatch', { n: Math.max(0, Math.ceil((r.nextAt - now) / 1000)) });
  else if (z?.state === 0) text = t('zoneNext', { n: Math.max(0, Math.ceil((z.end - now) / 1000)) });
  else if (z?.state === 1) text = t('zoneClosingShort');
  $('round-time').textContent = `👤 ${r?.alive ?? '?'} · ${text}`;
}

/** Capture-the-flag captures next to the team scores. */
function updateCaptures() {
  const el = $('ctf-caps');
  if (!state?.flags) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  query(el, '.red').textContent = String(state.captures[0]);
  query(el, '.blue').textContent = String(state.captures[1]);
}

/** Points a HUD stat's icon at a sprite (only touching the image when it changes). */
function setStatIcon(el: HTMLElement, name: SpriteName): void {
  if (el.dataset.icon === name) return;
  el.dataset.icon = name;
  query(el, 'img', HTMLImageElement).src = `assets/${name}.svg`;
}

function timer(el: HTMLElement, on: boolean, seconds: number, total: number): void {
  el.classList.toggle('hidden', !on);
  if (!on) return;
  setTrailingText(el, String(Math.ceil(seconds)));
  el.style.setProperty('--p', Math.min(1, seconds / total).toFixed(2));
}

function buildEmoteWheel() {
  const labels = t('emotes');
  $('emote-wheel').innerHTML = EMOTES.map((e, i) =>
    `<button data-e="${i}" title="${escapeHtml(labels[i])}">${e}<kbd>${i + 1}</kbd></button>`).join('');
}
$('emote-wheel').addEventListener('click', (e) => {
  const b = closest(e.target, 'button', HTMLButtonElement);
  if (b) sendEmote(Number(b.dataset.e));
});
$('emote-toggle').addEventListener('click', () => $('emote-wheel').classList.toggle('hidden'));
/** Copies a link that joins this arena near us (or shows it, if copying isn't allowed). */
async function invite(): Promise<void> {
  if (!state) return;
  const url = `${location.origin}${location.pathname}?arena=${state.arena}&near=${state.myId}`;
  try {
    await navigator.clipboard.writeText(url);
  } catch {
    prompt(t('invite'), url);
    return;
  }
  alerts.toast(t('inviteCopied'), { icon: '🔗', tone: 'info' });
}
$('invite').addEventListener('click', () => fireAndForget(invite(), 'invite'));

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
  for (const sel of [$('set-lang', HTMLSelectElement), $('join-lang', HTMLSelectElement)]) {
    sel.innerHTML = Object.entries(LANGUAGES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
    sel.value = getLanguage();
  }
}

function applySettings() {
  audio.setMusicVolume(settings.get('music'));
  audio.setSfxVolume(settings.get('sfx'));
  audio.setMuted(settings.get('muted'));
  $('perf').classList.toggle('hidden', !settings.get('showFps'));
  const mapSize = Math.min(MINIMAP_MAX, Math.max(MINIMAP_MIN, settings.get('minimapSize')));
  document.documentElement.style.setProperty('--minimap', `${mapSize}px`);
  document.body.classList.toggle('no-minimap', !settings.get('showMinimap'));
  $('set-minimap', HTMLInputElement).checked = settings.get('showMinimap');
  $('set-minimap-size', HTMLInputElement).value = String(mapSize);
  $('set-minimap-size', HTMLInputElement).disabled = !settings.get('showMinimap');
  renderer.lastMinimap = 0; // redraw at the new size right away
  $('set-music', HTMLInputElement).value = String(settings.get('music'));
  $('set-sfx', HTMLInputElement).value = String(settings.get('sfx'));
  $('set-muted', HTMLInputElement).checked = settings.get('muted');
  $('set-fps', HTMLInputElement).checked = settings.get('showFps');
  $('set-zoom', HTMLInputElement).value = String(settings.get('zoom'));
  $('set-colorblind', HTMLInputElement).checked = settings.get('colorblind');
  $('set-contrast', HTMLInputElement).checked = settings.get('highContrast');
  $('set-style', HTMLSelectElement).value = settings.get('tileStyle');
  applyVisualSettings();
}

function applyLanguage(lang: string): void {
  setLanguage(lang);
  settings.set('lang', lang);
  fillLanguageSelects();
  buildLegend();
  buildEmoteWheel();
  $('lb-hint').textContent = t('holdTab', { k: 'Tab' });
  hudKey = '';
  refreshLobbyLater();
}

settings.onChange(applySettings);
applySettings();

/** Calls `fn` with a settings control each time it changes. */
function control<T extends HTMLInputElement | HTMLSelectElement>(
  id: string, type: new () => T, event: 'input' | 'change', fn: (el: T) => void,
): void {
  const el = $(id, type);
  el.addEventListener(event, () => fn(el));
}

control('set-music', HTMLInputElement, 'input', (el) => settings.set('music', Number(el.value)));
control('set-sfx', HTMLInputElement, 'input', (el) => settings.set('sfx', Number(el.value)));
control('set-zoom', HTMLInputElement, 'input', (el) => setZoom(Number(el.value)));
control('set-muted', HTMLInputElement, 'change', (el) => settings.set('muted', el.checked));
control('set-fps', HTMLInputElement, 'change', (el) => settings.set('showFps', el.checked));
control('set-minimap', HTMLInputElement, 'change', (el) => settings.set('showMinimap', el.checked));
control('set-minimap-size', HTMLInputElement, 'input', (el) => settings.set('minimapSize', Number(el.value)));
control('set-colorblind', HTMLInputElement, 'change', (el) => settings.set('colorblind', el.checked));
control('set-contrast', HTMLInputElement, 'change', (el) => settings.set('highContrast', el.checked));
control('set-style', HTMLSelectElement, 'change', (el) => settings.set('tileStyle', el.value === 'classic' ? 'classic' : 'pixel'));
control('set-lang', HTMLSelectElement, 'change', (el) => applyLanguage(el.value));
control('join-lang', HTMLSelectElement, 'change', (el) => applyLanguage(el.value));
$('settings-close').addEventListener('click', () => toggleSettings(false));
$('gear').addEventListener('click', () => toggleSettings(true));
$('tutorial-again').addEventListener('click', () => {
  toggleSettings(false);
  tutorial.start();
});

// ---------------------------------------------------------------- lobby

/** An arena in `/api/arenas` (see `api::ArenaInfo`). */
interface ArenaInfo { id: number; name: string; mode: string; map: number; humans: number; bots: number }
/** `/api/profile` (see `api::ProfileResponse`). */
interface Profile {
  level: number; xp: number; level_xp: number; next_xp: number; kills: number; deaths: number; wins: number;
  best_streak: number; games: number; hat: number; trail: number; hat_levels: number[]; trail_levels: number[];
}
/** A row of `/api/leaderboard`. */
interface LeaderRow { name: string; level: number; xp: number; kills: number; deaths: number; wins: number; best_streak: number }

let arenas: ArenaInfo[] = [];
let selectedArena = Number(params.get('arena') ?? settings.get('arena')) || 0;
let profile: Profile | null = null;

/** Refreshes the lobby lists in the background. */
function refreshLobbyLater(): void {
  fireAndForget(refreshLobby(), 'lobby refresh');
}

/** Fetches JSON and checks its shape; throws on a network error or an unexpected body. */
async function fetchJson<T>(url: string, guard: (v: unknown) => v is T): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const body: unknown = await res.json();
  if (!guard(body)) throw new Error(`${url}: unexpected response`);
  return body;
}

type Fields<T> = Partial<Record<keyof T, unknown>>;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const numbersIn = (v: Record<string, unknown>, keys: readonly string[]): boolean => keys.every((k) => typeof v[k] === 'number');
const isNumberList = (v: unknown): v is number[] => Array.isArray(v) && v.every((x) => typeof x === 'number');

function isArenaInfo(v: unknown): v is ArenaInfo {
  if (!isObject(v)) return false;
  const a: Fields<ArenaInfo> = v;
  return typeof a.name === 'string' && typeof a.mode === 'string' && numbersIn(v, ['id', 'map', 'humans', 'bots']);
}

function isProfile(v: unknown): v is Profile {
  if (!isObject(v)) return false;
  const p: Fields<Profile> = v;
  return numbersIn(v, ['level', 'xp', 'level_xp', 'next_xp', 'kills', 'wins', 'best_streak'])
    && isNumberList(p.hat_levels) && isNumberList(p.trail_levels);
}

function isLeaderRow(v: unknown): v is LeaderRow {
  return isObject(v) && typeof v.name === 'string' && numbersIn(v, ['level', 'kills', 'wins']);
}

const listOf = <T>(item: (v: unknown) => v is T) => (v: unknown): v is T[] => Array.isArray(v) && v.every(item);

async function refreshLobby(): Promise<void> {
  if (!$('join').classList.contains('hidden') || !state) {
    try {
      arenas = await fetchJson('/api/arenas', listOf(isArenaInfo));
      renderArenas();
    } catch { /* server unreachable: keep the old list */ }
  }
  try {
    profile = await fetchJson(`/api/profile?token=${encodeURIComponent(token)}`, isProfile);
    renderProfile();
  } catch { /* no profile service */ }
  try {
    const top = await fetchJson('/api/leaderboard', listOf(isLeaderRow));
    $('alltime').innerHTML = top.length
      ? top.slice(0, 10).map((r) => `<li><span>${escapeHtml(r.name)} · ${t('level', { n: r.level })}</span><span>${r.kills}K ${r.wins}★</span></li>`).join('')
      : `<li class="muted">${t('noRecords')}</li>`;
  } catch { /* ignore */ }
}

function renderArenas() {
  if (!arenas.some((a) => a.id === selectedArena)) selectedArena = arenas[0]?.id ?? 0;
  $('arena-list').innerHTML = arenas.map((a) =>
    `<button type="button" class="arena ${a.id === selectedArena ? 'selected' : ''}" data-id="${a.id}">` +
    `<span><span class="a-name">${escapeHtml(a.name)}</span><br><span class="a-meta">${a.mode === 'teams' ? t('modeTeams') : a.mode === 'royale' ? t('modeRoyale') : a.mode === 'worms' ? t('modeWorms') : t('modeFfa')} · ${a.map}×${a.map}</span></span>` +
    `<span class="a-count">${t('arenaPlayers', { n: a.humans })} · 🤖${a.bots}</span></button>`).join('');
}
$('arena-list').addEventListener('click', (e) => {
  const b = closest(e.target, '.arena', HTMLButtonElement);
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
  picker($('hat-picker'), profile, t('hats'), profile.hat_levels, 'hat');
  picker($('trail-picker'), profile, t('trails'), profile.trail_levels, 'trail');
}

function picker(el: HTMLElement, pf: Profile, names: readonly string[], levels: readonly number[], key: 'hat' | 'trail'): void {
  const current = settings.get(key);
  el.innerHTML = names.map((n, i) => {
    const locked = pf.level < levels[i];
    const title = locked ? t('lockedAt', { n: levels[i] }) : n;
    return `<button type="button" data-v="${i}" class="${i === current && !locked ? 'selected' : ''}" ${locked ? 'disabled' : ''} title="${escapeHtml(title)}">${escapeHtml(n)}${locked ? ' 🔒' : ''}</button>`;
  }).join('');
  el.onclick = (e) => {
    const b = closest(e.target, 'button', HTMLButtonElement);
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
const sendInput = (d: number, s: number, j: boolean, q: number): void => net.send({ t: 'in', d, s, j, h: input.current.h, q, k: state?.lastK ?? 0 });
predictor.onJump = () => audio.jump();
function frame(now: number): void {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  input.pollGamepad();
  particles.update(dt);
  if (!state || state.snaps.len === 0) return;
  const t0 = performance.now();

  // Inputs (and snapshot acks) go out at 20 Hz even while dead.
  predictor.update(dt, input.current, state, sendInput);
  // Ease the remote interpolation delay toward its target (a few % time
  // stretch, invisible) so a jitter spike never makes things jump.
  const dd = state.interpTarget - state.interpDelay;
  state.interpDelay += Math.sign(dd) * Math.min(Math.abs(dd), dt * (dd > 0 ? 2 : 0.6));
  // Local player: predicted. Dead: the camera follows whoever we watch.
  if (state.me?.alive && predictor.active) {
    const px = state.self.x, py = state.self.y;
    predictor.render(state.self, input.current, state, dt);
    state.selfJump = predictor.jumpDir;
    tutorial.notify('moved', Math.abs(state.self.x - px) + Math.abs(state.self.y - py));
    state.focus.x = state.self.x;
    state.focus.y = state.self.y;
  } else if (state.me && !state.me.alive && (state.me.spec || state.replay)) {
    // Dead: watch whoever got you (in the replay too), or your own last moments.
    const f = renderer.frame;
    const watch = state.replay ? (state.me.killer ?? state.myId) : state.me.spec;
    for (let i = 0; i < f.nPlayers; i++) {
      if (f.players[i].id === watch) {
        const k = 1 - Math.exp(-dt * 6);
        state.focus.x += (f.players[i].x - state.focus.x) * k;
        state.focus.y += (f.players[i].y - state.focus.y) * k;
      }
    }
  }
  // Watching another part of the map: the camera glides there (and
  // follows the pointer while dragging); moving or jumping comes back,
  // gliding home from wherever the view was.
  if (state.look && !state.replay) {
    if (input.current.d || input.current.j) stopLooking();
    else {
      // The view has a camera of its own (`lookFrom`): the focus is put
      // back on the player every frame, so it can't glide by itself. A
      // fresh look starts the camera where the view is now.
      if (state.lookBlend < 1 || !state.lookFrom) state.lookFrom = { x: state.focus.x, y: state.focus.y };
      const k = lookDrag ? 1 : 1 - Math.exp(-dt * 10);
      state.lookFrom.x += (state.look.x - state.lookFrom.x) * k;
      state.lookFrom.y += (state.look.y - state.lookFrom.y) * k;
      state.focus.x = state.lookFrom.x;
      state.focus.y = state.lookFrom.y;
      state.lookBlend = 1;
    }
  }
  if (!state.look && state.lookBlend > 0 && state.lookFrom) {
    state.lookBlend = Math.max(0, state.lookBlend - dt * 5);
    const b = state.lookBlend * state.lookBlend;
    state.focus.x += (state.lookFrom.x - state.focus.x) * b;
    state.focus.y += (state.lookFrom.y - state.focus.y) * b;
  }
  state.zoom += (state.zoomTarget - state.zoom) * (1 - Math.exp(-dt * 12));
  renderer.draw(state, now, dt);
  updateStatusAlerts(now);

  perfWork += performance.now() - t0;
  perfFrames++;
  perfTime += dt;
  if (perfTime >= 0.5) {
    const fps = perfFrames / perfTime;
    const el = $('fps');
    el.textContent = `${Math.round(fps)} FPS · ${(perfWork / perfFrames).toFixed(1)} ms · ${Math.round(state.interpDelay * state.tickMs)} ms buf`;
    el.classList.toggle('slow', fps < 50);
    updateRoyaleHud(now);
    $('netinfo').textContent = `ping ${net.ping} ms · ${(net.bytesIn / 1024 / perfTime).toFixed(1)} KB/s · ${particles.count} fx`;
    net.bytesIn = 0;
    perfTime = perfFrames = perfWork = 0;
  }
}

$('name', HTMLInputElement).value = (() => { try { return localStorage.getItem('blast-name') ?? ''; } catch { return ''; } })();
$('join-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('name', HTMLInputElement).value.trim() || 'Blaster';
  try { localStorage.setItem('blast-name', name); } catch { /* storage unavailable */ }
  audio.start(); // browsers only allow audio after a user gesture
  applySettings();
  $('join-error').textContent = '';
  $('play', HTMLButtonElement).disabled = true;
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
declare global {
  interface Window { __blast?: unknown }
}
if (params.has('debug')) {
  window.__blast = { get state() { return state; }, predictor, net, audio, input, renderer, alerts };
}

applyLanguage(getLanguage());
applyI18n();
setInterval(() => { if (!state) refreshLobbyLater(); }, 4000);
assets.load().then(
  () => requestAnimationFrame(frame),
  (e: unknown) => console.error('could not load the game art', e),
);
