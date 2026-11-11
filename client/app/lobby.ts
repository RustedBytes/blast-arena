// The lobby: arena list, profile with cosmetic unlocks, all-time
// leaderboard and the join form.

import { closest, escapeHtml, fireAndForget } from '../dom.js';
import { t } from '../i18n.js';
import { net } from './messages.js';
import { audio, params, settings, token } from './services.js';
import { connection, state } from './session.js';
import { applySettings } from './settings-ui.js';
import { ui } from './ui.js';
import { showTutorial } from './controls.js';

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
export function refreshLobbyLater(): void {
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
  return isObject(v) && typeof v.name === 'string' && numbersIn(v, ['level', 'xp', 'kills', 'wins']);
}

const listOf = <T>(item: (v: unknown) => v is T) => (v: unknown): v is T[] => Array.isArray(v) && v.every(item);

async function refreshLobby(): Promise<void> {
  if (!ui.join.screen.classList.contains('hidden') || !state) {
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
    ui.join.allTime.innerHTML = top.length
      ? top.slice(0, 10).map((r) => `<li><span>${escapeHtml(r.name)} · ${t('level', { n: r.level })}</span><span>${t('xpPoints', { n: r.xp })} · ${r.kills}K ${r.wins}★</span></li>`).join('')
      : `<li class="muted">${t('noRecords')}</li>`;
  } catch { /* ignore */ }
}

function renderArenas() {
  if (!arenas.some((a) => a.id === selectedArena)) selectedArena = arenas[0]?.id ?? 0;
  ui.join.arenaList.innerHTML = arenas.map((a) =>
    `<button type="button" class="arena ${a.id === selectedArena ? 'selected' : ''}" data-id="${a.id}">` +
    `<span><span class="a-name">${escapeHtml(a.name)}</span><br><span class="a-meta">${a.mode === 'teams' ? t('modeTeams') : a.mode === 'royale' ? t('modeRoyale') : a.mode === 'worms' ? t('modeWorms') : a.mode === 'rockets' ? t('modeRockets') : a.mode === 'dungeon' ? t('modeDungeon') : t('modeFfa')} · ${a.map}×${a.map}</span></span>` +
    `<span class="a-count">${t('arenaPlayers', { n: a.humans })} · 🤖${a.bots}</span></button>`).join('');
}

function renderProfile() {
  if (!profile) return;
  ui.join.profileLevel.textContent = t('level', { n: profile.level });
  ui.join.profileXp.textContent = t('xpProgress', { xp: profile.xp, next: profile.next_xp });
  const span = Math.max(1, profile.next_xp - profile.level_xp);
  ui.join.profileXpBar.style.width = `${Math.min(100, ((profile.xp - profile.level_xp) / span) * 100)}%`;
  ui.join.profileStats.textContent = t('profileStats', { k: profile.kills, w: profile.wins, s: profile.best_streak });
  picker(ui.join.hatPicker, profile, t('hats'), profile.hat_levels, 'hat');
  picker(ui.join.trailPicker, profile, t('trails'), profile.trail_levels, 'trail');
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

/** Wires the arena list and the join form. */
export function setupLobby(): void {
  ui.join.arenaList.addEventListener('click', (e) => {
    const b = closest(e.target, '.arena', HTMLButtonElement);
    if (!b) return;
    selectedArena = Number(b.dataset.id);
    settings.set('arena', selectedArena);
    renderArenas();
  });
  ui.join.name.value = (() => { try { return localStorage.getItem('blast-name') ?? ''; } catch { return ''; } })();
  ui.join.howToPlay.addEventListener('click', () => showTutorial());
  ui.join.form.addEventListener('submit', (e) => {
    e.preventDefault();
    // The first time, the tutorial comes first (nothing can hit you while you read).
    if (settings.get('tutorialDone')) join();
    else showTutorial(join);
  });
}

/** Joins the selected arena with the name and cosmetics from the lobby. */
function join(): void {
  const name = ui.join.name.value.trim() || 'Blaster';
  try { localStorage.setItem('blast-name', name); } catch { /* storage unavailable */ }
  audio.start(); // browsers only allow audio after a user gesture
  applySettings();
  ui.join.error.textContent = '';
  ui.join.play.disabled = true;
  const near = Number(params.get('near')) || 0;
  connection.joinInfo = {
    arena: selectedArena,
    join: { name, token, hat: settings.get('hat'), trail: settings.get('trail'), near },
  };
  connection.reconnectTry = -1;
  net.close();
  net.connect(connection.joinInfo.arena, connection.joinInfo.join);
}
