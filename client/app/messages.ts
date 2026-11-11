// Handles messages from the server: the welcome, snapshots, world changes,
// kills, scores and the connection closing (with reconnects).

import { ITEM_SPRITES, playerColors } from '../assets.js';
import { escapeHtml, query } from '../dom.js';
import { t } from '../i18n.js';
import { Net } from '../net.js';
import { BOMB_FLAG, hasFlag, meObject, PLAYER_FLAG } from '../protocol.js';
import { NUKE_SHOW_TICKS } from '../render.js';
import type { BombView, GameSnapshot, GameState, RosterInfo } from '../state.js';
import { input } from './controls.js';
import { gameEvent, MONSTER_ICONS } from './events.js';
import { toast, updateHud } from './hud.js';
import { refreshLobbyLater } from './lobby.js';
import { alerts, audio, predictor, renderer, settings } from './services.js';
import { connection, CROWDED_MAP_CELLS, CROWDED_PLAYERS, findSnapshot, newsworthy, rebuildItems, setState, SnapRing, state } from './session.js';
import { applyVisualSettings } from './settings-ui.js';
import { forgetLook, resize } from './view.js';
import { ui } from './ui.js';

const KILLFEED_SIZE = 5;
const RECONNECT_DELAYS = [500, 1500, 3000, 5000];
// Remote entities are drawn this far behind the newest snapshot, at least
// (ticks); the delay grows with measured network jitter.
const INTERP_MIN_TICKS = 1.15;
const INTERP_MARGIN_TICKS = 0.15;
// Death replay: starts this much game time before the death (played at
// REPLAY_RATE, see render.ts) and runs until respawn.
const REPLAY_TICKS = 40;

// Explosions seen in the previous snapshot, to spot new ones (two sets
// swapped each snapshot).
let seenExplosions = new Set();
let nextExplosions = new Set();

export const net = new Net({
  welcome(m) {
    const tiles = new Uint8Array(m.w * m.h);
    let i = 0;
    for (const [tile, n] of m.map) {
      tiles.fill(tile, i, i + n);
      i += n;
    }
    const rosterInfo = new Map<number, RosterInfo>();
    for (const [id, name, team, hat, trail] of m.roster) rosterInfo.set(id, { name, team, hat, trail });
    const state: GameState = {
      myId: m.id,
      arena: connection.joinInfo?.arena ?? 0,
      arenaName: m.arena,
      mode: m.mode,
      team: m.team,
      map: { w: m.w, h: m.h, tiles, biomes: m.biomes },
      crowded: m.roster.length >= CROWDED_PLAYERS || m.w * m.h >= CROWDED_MAP_CELLS,
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
      monsterMeals: new Map(), // players a monster just bit, by kind (likewise)
      bittenBy: 0,
      lastLb: '',
      roundSecs: m.round,
      movedAt: null,
      // Ability tuning from the server (ticks; see protocol::AbilityInfo).
      abilities: m.abilities,
    };
    setState(state);
    // A new game watches your own player (the server too).
    forgetLook();
    for (const [x, y, k] of m.items) state.itemMap.set(y * m.w + x, k);
    rebuildItems();
    seenExplosions.clear();
    predictor.active = false;
    renderer.resetMap(state.map);
    applyVisualSettings();
    ui.join.screen.classList.add('hidden');
    ui.reconnecting.classList.add('hidden');
    ui.hud.root.classList.remove('hidden');
    ui.vignette.classList.remove('hidden');
    ui.hud.teamScores.classList.toggle('hidden', m.mode !== 'teams');
    // Rockets arena: the bomb key fires a rocket, so the key help says so.
    // (Swapping the i18n key keeps it right across a language change.)
    const bombHelp = document.querySelector<HTMLElement>('[data-i18n="helpBomb"], [data-i18n="helpRocket"]');
    if (bombHelp) {
      bombHelp.dataset.i18n = m.mode === 'rockets' ? 'helpRocket' : 'helpBomb';
      bombHelp.textContent = t(bombHelp.dataset.i18n as 'helpBomb' | 'helpRocket');
    }
    ui.join.play.disabled = false;
    connection.reconnectTry = -1;
    input.enabled = true;
    resize();
    if (m.resumed) toast(t('welcomeBack'), null, 'mystery');
    else if (m.mode === 'rockets') toast(t('rocketsHint'), null, 'info');
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
        if (prevMe && !prevMe.alive) renderer.effects.spawnBeam(mx, my, now);
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
          renderer.effects.nuke(e[0], e[1], e[4], now, d, state.map, age);
          if (age < 0.5) audio.nuke(d, pan);
        } else {
          renderer.effects.explosion(e[0], e[1], e[2], now, d);
          audio.explosion(d, pan);
        }
      }
    }
    [seenExplosions, nextExplosions] = [nextExplosions, seenExplosions];

    if (prevMe && m.me.active > prevMe.active) {
      audio.bombPlaced();
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
      if ((map.tiles[idx] === 2 || map.tiles[idx] === 9) && tile !== map.tiles[idx] && tile !== 1) renderer.effects.crateBroken(x, y);
      map.tiles[idx] = tile;
      renderer.invalidateTile(map, x, y);
      renderer.tiles.updateSpecial(x, y, tile);
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
    renderer.effects.sparkle(state.self.x, state.self.y, m.m);
    if (curse) audio.curse();
    else if (m.m) audio.mystery();
    else audio.pickup();
  },

  kill(m) {
    if (!state) return;
    const now = performance.now();
    const info = state.rosterInfo.get(m.v);
    const colors = playerColors(m.v, info?.team ?? 0, settings.get('colorblind'));
    const mine = m.k === state.myId || m.v === state.myId;
    // In a crowded arena, deaths out of sight are neither drawn nor listed.
    const seen = mine || newsworthy(m.x, m.y);
    if (seen) renderer.effects.death(m.x, m.y, now, colors, 3);
    if (m.v === state.myId) audio.death();
    const st = state;
    const name = (id: number): string => escapeHtml(st.rosterInfo.get(id)?.name ?? '???');
    // A worm's meal is announced (EV.WORM) just before the kill.
    const eaten = state.wormMeals.delete(m.v);
    if (m.v === state.myId) state.eatenByWorm = eaten;
    // So is the Warden's (EV.GUARD).
    const crushed = state.wardenMeals.delete(m.v);
    if (m.v === state.myId) state.crushedByWarden = crushed;
    // And a monster's bite (EV.MONSTER), with the monster's kind.
    const bitten = state.monsterMeals.get(m.v) ?? 0;
    state.monsterMeals.delete(m.v);
    if (m.v === state.myId) state.bittenBy = bitten;
    if (!seen) return;
    const el = document.createElement('div');
    el.className = 'kill';
    if (m.k === state.myId || m.v === state.myId) el.classList.add('mine');
    el.innerHTML = crushed
      ? `🗿 ${t('wasCrushed', { v: `<b class="v">${name(m.v)}</b>` })}`
      : bitten
      ? `${MONSTER_ICONS[bitten - 1] ?? '👹'} ${(t('monsterBitFeed')[bitten - 1] ?? '{v}').replace('{v}', `<b class="v">${name(m.v)}</b>`)}`
      : eaten
      ? `🪱 ${t('wasEaten', { v: `<b class="v">${name(m.v)}</b>` })}`
      : m.k === null
      ? t('wasBlasted', { v: `<b class="v">${name(m.v)}</b>` })
      : m.k === m.v
        ? t('blewUp', { v: `<b class="v">${name(m.v)}</b>` })
        : `<b class="k">${name(m.k)}</b> 💥 <b class="v">${name(m.v)}</b>${m.b ? ' 🎯' : ''}`;
    const feed = ui.hud.killfeed;
    feed.prepend(el);
    while (feed.children.length > KILLFEED_SIZE) feed.lastElementChild?.remove();
    setTimeout(() => el.remove(), 6000);
    if (m.b && m.k === state.myId) alerts.announce({ text: t('bountyKill'), icon: '🎯', tone: 'epic', priority: 2 });
  },

  lb(m) {
    if (!state) return;
    ui.hud.online.textContent = t('online', { n: m.n });
    state.roundSecs = m.r;
    state.crowded = m.n >= CROWDED_PLAYERS || state.map.w * state.map.h >= CROWDED_MAP_CELLS;
    if (state.mode !== 'royale') ui.hud.roundTime.textContent = `⏱ ${Math.floor(m.r / 60)}:${String(m.r % 60).padStart(2, '0')}`;
    const ts = ui.hud.teamScores;
    query(ts, '.red').textContent = String(m.teams[0]);
    query(ts, '.blue').textContent = String(m.teams[1]);
    const key = m.top.map((e) => e.join()).join('|');
    if (key === state.lastLb) return;
    state.lastLb = key;
    const st = state;
    ui.hud.leaderboardList.innerHTML = m.top
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
    if (m.id !== state.myId && state.crowded) {
      // Only streaks of players in view; there are too many otherwise.
      const f = renderer.frame;
      let near = false;
      for (let i = 0; i < f.nPlayers; i++) if (f.players[i].id === m.id) near = newsworthy(f.players[i].x, f.players[i].y);
      if (!near) return;
    }
    const name = state.rosterInfo.get(m.id)?.name ?? '?';
    alerts.announce({ text: t('streak', { name, n: m.n }), icon: '🔥', tone: m.id === state.myId ? 'epic' : 'warn', key: `streak${m.id}` });
  },

  hills(m) {
    if (state) state.hills = m.h;
  },

  ev(m) { gameEvent(m); },

  round(m) {
    if (!state) return;
    const list = ui.round.mvp;
    list.innerHTML = m.mvp.map(([, name, score, kills]) => `<li>${escapeHtml(name)} — ${score} (${kills}K)</li>`).join('');
    ui.round.winner.textContent = m.win ? t('teamWins', { team: m.win === 1 ? t('red') : t('blue') }) : (m.mvp[0] ? `${t('mvp')}: ${m.mvp[0][1]}` : '');
    ui.round.root.classList.remove('hidden');
    renderer.effects.confetti();
    audio.mystery();
    setTimeout(() => ui.round.root.classList.add('hidden'), 6000);
  },

  err(m) {
    ui.join.error.textContent = m.m === 'server is full, try again later' ? t('fullServer') : m.m;
    connection.reconnectTry = -1;
  },

  close() {
    alerts.reset();
    input.enabled = false;
    input.clear();
    const wasPlaying = state !== null;
    setState(null);
    predictor.active = false;
    ui.hud.root.classList.add('hidden');
    ui.vignette.classList.add('hidden');
    ui.settings.root.classList.add('hidden');
    // An unexpected drop mid-game: try to reconnect (the server keeps our
    // progress for 30 s).
    if ((wasPlaying || connection.reconnectTry >= 0) && connection.joinInfo && connection.reconnectTry + 1 < RECONNECT_DELAYS.length) {
      connection.reconnectTry++;
      ui.reconnecting.classList.remove('hidden');
      const info = connection.joinInfo;
      setTimeout(() => net.connect(info.arena, info.join), RECONNECT_DELAYS[connection.reconnectTry]);
      return;
    }
    connection.reconnectTry = -1;
    ui.reconnecting.classList.add('hidden');
    ui.join.screen.classList.remove('hidden');
    ui.join.play.disabled = false;
    if (!ui.join.error.textContent) ui.join.error.textContent = t('disconnected');
    refreshLobbyLater();
  },
}, (k) => (state ? findSnapshot(k) : null));
