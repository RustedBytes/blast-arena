// Game events (`ev` messages): sudden death, map events, capture the flag,
// battle royale, abilities, worms and the Warden.

import type { Tone } from '../alerts.js';
import { ITEM_SPRITES } from '../assets.js';
import { t } from '../i18n.js';
import { AB, EV, GUARD_NEWS, WORM_NEWS } from '../protocol.js';
import type { EventMsg } from '../protocol.js';
import { updateCaptures } from './hud.js';
import { alerts, audio, renderer } from './services.js';
import { state } from './session.js';

// How each map event is announced: icon and tone, by kind.
const EVENT_LOOK: ([string, Tone] | null)[] = [null, ['☄️', 'danger'], ['❄️', 'info'], ['🌋', 'danger'], ['⚙️', 'warn'], ['🌍', 'danger']];

/** Game events: sudden death, map events, capture the flag, swaps. */
export function gameEvent(m: EventMsg): void {
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
      renderer.events.mapEvent(v[0], now, v[1] * 1000);
      if (v[0] === 5) audio.nuke(22, 0); // an earthquake: a deep rumble
      else audio.mystery();
      break;
    case EV.STRIKES:
      for (let i = 0; i + 2 < v.length; i += 3) renderer.events.addMeteor(v[i], v[i + 1], now + v[i + 2] * state.tickMs);
      break;
    case EV.LAVA:
      renderer.events.addLava(v.slice(2), now + v[0] * state.tickMs, v[1] * state.tickMs);
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
      renderer.effects.confetti();
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
        for (let i = 0; i < f.nPlayers; i++) if (f.players[i].id === id) renderer.effects.sparkle(f.players[i].x, f.players[i].y, true);
      }
      audio.curse();
      break;
  }
}

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
      renderer.effects.wormGulp(x, y);
      break;
    case GUARD_NEWS.SLAM:
      renderer.effects.wardenSlam(x, y, now, dist < 12);
      if (dist < 16) audio.explosion(dist, pan);
      break;
    case GUARD_NEWS.LOB:
      if (dist < 12) audio.bombPlaced();
      break;
    case GUARD_NEWS.KILLED:
      renderer.effects.wardenDown(x, y, now);
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
      renderer.effects.wormGulp(x, y);
      break;
    case WORM_NEWS.KILLED:
      renderer.effects.wormSplat(x, y, true);
      if (near) audio.kick();
      if (id === state.myId) alerts.toast(t('wormKilled'), { icon: '🪱', tone: 'good', key: 'worm-news' });
      break;
    case WORM_NEWS.CUT:
      renderer.effects.wormSplat(x, y, false);
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
      renderer.effects.crateBroken(x, y); // a puff of dust as it goes up
      if (dist(x, y) < 12) audio.kick();
      break;
    }
    case AB.WALL_REMOVED: {
      const [, x, y, destroyed] = a;
      if (destroyed) renderer.effects.crateBroken(x, y);
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
      renderer.effects.sparkle(...tile(x, y), true);
      audio.mystery();
      break;
    }
    case AB.CLONE_DESTROYED: {
      const [, x, y] = a;
      renderer.effects.sparkle(...tile(x, y), false);
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
      renderer.effects.sparkle(...tile(x, y), true);
      break;
    }
    case AB.PORTAL_LINKED: {
      const [, , owner, x, y] = a;
      renderer.effects.sparkle(...tile(x, y), true);
      if (owner === state.myId) audio.mystery();
      break;
    }
    case AB.TELEPORTED: {
      const [what, id, fx, fy, tx, ty] = a;
      renderer.effects.sparkle(...tile(fx, fy), true);
      renderer.effects.sparkle(...tile(tx, ty), true);
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
