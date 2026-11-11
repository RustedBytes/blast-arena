// The in-game HUD: power-up stats, timers, status alerts, toasts, the
// emote wheel and the invite button.

import type { StatusOpts } from '../alerts.js';
import { itemSprite } from '../assets.js';
import type { SpriteName } from '../assets.js';
import { escapeHtml, closest, fireAndForget, query, setTrailingText } from '../dom.js';
import { getLanguage, t } from '../i18n.js';
import { BOLT_COLORS } from '../protocol.js';
import type { Me } from '../protocol.js';
import { EMOTES } from '../render.js';
import { sendEmote } from './controls.js';
import { alerts, renderer } from './services.js';
import { game, state } from './session.js';
import { ui } from './ui.js';

/** A small notice; `kind` '' (good news), 'mystery' or 'curse'; `icon` a sprite name. */
export function toast(text: string, icon: string | null, kind: '' | 'mystery' | 'curse' | 'info'): void {
  const tone = kind === 'curse' ? 'danger' : kind === 'mystery' ? 'epic' : kind === 'info' ? 'info' : 'good';
  alerts.toast(text, { icon: icon ? `img:${icon}` : null, tone });
}

/**
 * Pinned alerts for situations that last: in the storm, in a nuke's zone,
 * at the sudden-death edge, stunned, carrying a flag. Called every frame;
 * the alerts only touch the page when something changes.
 */
export function updateStatusAlerts(now: number): void {
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
  ui.touch.detach.classList.toggle('hidden', !stuck);
  show('gas', alive && me.gassed > 0, t('inGas'), { icon: 'img:pu_gas', tone: 'warn' });
  document.body.classList.toggle('in-gas', alive && me.gassed > 0);
  const wait = alive ? me.portal_wait : 0;
  show('portal', wait > 0, t('portalWaiting', { n: Math.ceil(wait * st.tickMs / 1000) }),
    { icon: 'img:pu_portal', tone: 'info', progress: wait / (st.abilities?.portal_wait ?? 100) });
  show('flag', alive && !!me.carrying, t('carryFlag'), { icon: '🚩', tone: 'info' });
  document.body.classList.toggle('in-storm', alive && me.storm > 0);
}

// -------------------------------------------------------------- HUD

let hudKey = '';

/** Hearts at the last update, to notice them coming back (0 while dead). */
let lastHp = 0;

export function updateHud(me: Me): void {
  const state = game();
  // A heart came back (healing over time, or a heart power-up): sparkle.
  if (me.alive && me.hp_max && lastHp > 0 && me.hp > lastHp) {
    renderer.effects.sparkle(state.self.x, state.self.y, me.hp - lastHp > 1);
    if (me.hp - lastHp === 1) alerts.toast(t('healed'), { icon: '❤️', tone: 'good', key: 'heal' });
  }
  lastHp = me.alive ? me.hp : 0;
  const key = [me.bombs, me.active, me.range, me.speed, me.kick, me.pierce, me.remote, me.line, me.punch, me.score, me.alive,
    me.respawn, Math.ceil(me.shield / 10), Math.ceil(me.ghost / 10), me.curse, Math.ceil(me.curse_t / 10), me.spec, me.nukes,
    me.gadget, me.gadget_n, me.freeze, me.stomp, me.stun, me.carrying, me.storm,
    me.ability, me.ability_n, me.ability_max, Math.ceil(me.ability_cd / 2), me.gas_bombs, me.sticky_bombs,
    me.hp, me.hp_max, me.blaster, Math.ceil(me.overdrive / 10), getLanguage()].join();
  if (key === hudKey) return;
  hudKey = key;
  ui.stats.bombs.textContent = `${me.bombs - me.active}/${me.bombs}`;
  ui.stats.range.textContent = String(me.range);
  ui.stats.speed.textContent = String(me.speed);
  for (const k of ['kick', 'pierce', 'remote', 'line', 'punch'] as const) ui.stats.flags[k].classList.toggle('off', !me[k]);
  ui.stats.score.textContent = String(me.score);
  // Hearts against monster bites (dungeon arena only).
  const hearts = ui.stats.hearts;
  hearts.classList.toggle('hidden', !me.hp_max || !me.alive);
  if (me.hp_max) {
    hearts.textContent = '♥'.repeat(Math.max(0, me.hp)) + '♡'.repeat(Math.max(0, me.hp_max - me.hp));
    hearts.classList.toggle('low', me.hp <= 1);
  }
  // The blaster's colour (cosmos arena only).
  const bl = ui.stats.blaster;
  bl.classList.toggle('hidden', !me.blaster || !me.alive);
  if (me.blaster) {
    const [core, glow] = BOLT_COLORS[me.blaster] ?? BOLT_COLORS[1];
    bl.style.setProperty('--bolt-core', core);
    bl.style.setProperty('--bolt', glow);
    bl.title = t('blasters')[me.blaster] ?? '';
  }
  ui.stats.nuke.classList.toggle('hidden', !me.nukes);
  for (const k of ['freeze', 'stomp'] as const) ui.stats.flags[k].classList.toggle('off', !me[k]);
  const g = ui.stats.gadget;
  g.classList.toggle('hidden', !me.gadget_n);
  if (me.gadget_n) {
    setStatIcon(g, itemSprite(me.gadget));
    setTrailingText(g, `×${me.gadget_n}`);
    g.title = `${t('items')[me.gadget] ?? ''} (Q)`;
  }
  setTrailingText(ui.stats.nuke, me.nukes > 1 ? `×${me.nukes}` : '');
  // The active ability: charges, and a sweep while the next one recharges.
  const ab = ui.stats.ability;
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
  const mod = ui.stats.modifier;
  const modN = me.gas_bombs || me.sticky_bombs;
  mod.classList.toggle('hidden', !modN);
  if (modN) {
    const name = me.gas_bombs ? 'pu_gas' : 'pu_sticky';
    setStatIcon(mod, name);
    setTrailingText(mod, `×${modN}`);
    mod.title = t('items')[me.gas_bombs ? 22 : 24] ?? '';
  }
  const tickS = state.tickMs / 1000;
  timer(ui.stats.stun, me.stun > 0, me.stun * tickS, 1);
  timer(ui.stats.shield, me.alive && me.shield > 0, me.shield * tickS, 6);
  timer(ui.stats.ghost, me.ghost > 0, me.ghost * tickS, 6);
  timer(ui.stats.overdrive, me.alive && me.overdrive > 0, me.overdrive * tickS, 8);
  timer(ui.stats.curse, me.curse !== 0, me.curse_t * tickS, me.curse === 1 ? 8 : me.curse === 2 ? 6 : 8);
  ui.stats.curse.title = t('curses')[me.curse] ?? '';

  ui.dead.root.classList.toggle('hidden', me.alive);
  if (!me.alive) {
    const killer = me.killer;
    const name = (id: number): string => state.rosterInfo.get(id)?.name ?? '?';
    const out = me.respawn * tickS > 3600; // royale: out until the next match
    ui.dead.root.classList.toggle('out', out);
    ui.dead.message.textContent = killer === state.myId
      ? t('youBlewUp')
      : killer != null ? t('blastedBy', { name: name(killer) }) : out ? t('outTitle')
        : state.crushedByWarden ? t('youWereCrushed')
          : state.bittenBy ? t('monsterBit')[state.bittenBy - 1] ?? t('youWereBlasted')
          : state.eatenByWorm ? t('youWereEaten') : t('youWereBlasted');
    ui.dead.timer.textContent = (out ? t('outOfMatch') : t('respawning', { n: Math.ceil(me.respawn * tickS) })) +
      (me.spec ? ` · ${t('watching', { name: name(me.spec) })}` : '');
  }
}

/** Battle royale: players left and the zone's timer, in place of the round clock. */
export function updateRoyaleHud(now: number): void {
  if (state?.mode !== 'royale') return;
  const r = state.royale, z = state.zone;
  let text = '';
  if (r && !r.on) text = t('nextMatch', { n: Math.max(0, Math.ceil((r.nextAt - now) / 1000)) });
  else if (z?.state === 0) text = t('zoneNext', { n: Math.max(0, Math.ceil((z.end - now) / 1000)) });
  else if (z?.state === 1) text = t('zoneClosingShort');
  ui.hud.roundTime.textContent = `👤 ${r?.alive ?? '?'} · ${text}`;
}

/** Capture-the-flag captures next to the team scores. */
export function updateCaptures() {
  const el = ui.hud.ctfCaptures;
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

export function buildEmoteWheel() {
  const labels = t('emotes');
  ui.hud.emoteWheel.innerHTML = EMOTES.map((e, i) =>
    `<button data-e="${i}" title="${escapeHtml(labels[i])}">${e}<kbd>${i + 1}</kbd></button>`).join('');
}

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

/** Wires the emote wheel and the invite button. */
export function setupHud(): void {
  ui.hud.emoteWheel.addEventListener('click', (e) => {
    const b = closest(e.target, 'button', HTMLButtonElement);
    if (b) sendEmote(Number(b.dataset.e));
  });
  ui.hud.emoteToggle.addEventListener('click', () => ui.hud.emoteWheel.classList.toggle('hidden'));
  ui.hud.invite.addEventListener('click', () => fireAndForget(invite(), 'invite'));
}

/** The next HUD update redraws everything (the language changed). */
export function invalidateHud(): void {
  hudKey = '';
}
