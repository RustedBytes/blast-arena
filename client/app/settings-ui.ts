// The settings menu: volume, zoom, language, art style and accessibility
// options, applied as they change.

import { ITEM_SPRITES } from '../assets.js';
import { escapeHtml } from '../dom.js';
import { getLanguage, LANGUAGES, setLanguage, t } from '../i18n.js';
import { bombLabel, isBombKey, jumpLabel, setBombKey } from '../keymap.js';
import { MINIMAP_MAX, MINIMAP_MIN } from '../settings.js';
import { buildEmoteWheel, invalidateHud } from './hud.js';
import { refreshLobbyLater } from './lobby.js';
import { audio, renderer, settings } from './services.js';
import { showTutorial } from './controls.js';
import { setZoom } from './view.js';
import { ui } from './ui.js';

// ------------------------------------------------------------- settings

export function toggleSettings(open = ui.settings.root.classList.contains('hidden')) {
  ui.settings.root.classList.toggle('hidden', !open);
  audio.uiClick();
}

export function applyVisualSettings() {
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
  ui.settings.legend.innerHTML = ITEM_SPRITES.slice(1).map((s, i) =>
    `<span><img src="assets/${s}.svg" alt="">${escapeHtml(items[i + 1])}</span>`).join('');
}

function fillLanguageSelects() {
  for (const sel of [ui.settings.language, ui.join.language]) {
    sel.innerHTML = Object.entries(LANGUAGES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
    sel.value = getLanguage();
  }
}

export function applySettings() {
  audio.setMusicVolume(settings.get('music'));
  audio.setSfxVolume(settings.get('sfx'));
  audio.setMuted(settings.get('muted'));
  ui.hud.perf.classList.toggle('hidden', !settings.get('showFps'));
  const mapSize = Math.min(MINIMAP_MAX, Math.max(MINIMAP_MIN, settings.get('minimapSize')));
  document.documentElement.style.setProperty('--minimap', `${mapSize}px`);
  document.body.classList.toggle('no-minimap', !settings.get('showMinimap'));
  ui.settings.minimap.checked = settings.get('showMinimap');
  ui.settings.minimapSize.value = String(mapSize);
  ui.settings.minimapSize.disabled = !settings.get('showMinimap');
  renderer.lastMinimap = 0; // redraw at the new size right away
  ui.settings.music.value = String(settings.get('music'));
  ui.settings.sfx.value = String(settings.get('sfx'));
  ui.settings.muted.checked = settings.get('muted');
  ui.settings.fps.checked = settings.get('showFps');
  ui.settings.zoom.value = String(settings.get('zoom'));
  ui.settings.colorblind.checked = settings.get('colorblind');
  ui.settings.contrast.checked = settings.get('highContrast');
  ui.settings.style.value = settings.get('tileStyle');
  applyBombKey();
  applyVisualSettings();
}

/** The bomb / jump keys: input, and every key cap that names them. */
function applyBombKey(): void {
  setBombKey(settings.get('bombKey'));
  ui.settings.bombKey.value = settings.get('bombKey');
  for (const el of document.querySelectorAll<HTMLElement>('kbd[data-key="bomb"]')) el.textContent = bombLabel();
  for (const el of document.querySelectorAll<HTMLElement>('kbd[data-key="jump"]')) el.textContent = jumpLabel();
}

export function applyLanguage(lang: string): void {
  setLanguage(lang);
  settings.set('lang', lang);
  fillLanguageSelects();
  buildLegend();
  buildEmoteWheel();
  ui.hud.leaderboardHint.textContent = t('holdTab', { k: 'Tab' });
  invalidateHud();
  refreshLobbyLater();
}

/** Calls `fn` with a settings control each time it changes. */
function control<T extends HTMLInputElement | HTMLSelectElement>(el: T, event: 'input' | 'change', fn: (el: T) => void): void {
  el.addEventListener(event, () => fn(el));
}

/** Wires the settings controls and applies the saved settings. */
export function setupSettingsUi(): void {
  settings.onChange(applySettings);
  applySettings();
  control(ui.settings.music, 'input', (el) => settings.set('music', Number(el.value)));
  control(ui.settings.sfx, 'input', (el) => settings.set('sfx', Number(el.value)));
  control(ui.settings.zoom, 'input', (el) => setZoom(Number(el.value)));
  control(ui.settings.muted, 'change', (el) => settings.set('muted', el.checked));
  control(ui.settings.fps, 'change', (el) => settings.set('showFps', el.checked));
  control(ui.settings.minimap, 'change', (el) => settings.set('showMinimap', el.checked));
  control(ui.settings.minimapSize, 'input', (el) => settings.set('minimapSize', Number(el.value)));
  control(ui.settings.colorblind, 'change', (el) => settings.set('colorblind', el.checked));
  control(ui.settings.contrast, 'change', (el) => settings.set('highContrast', el.checked));
  control(ui.settings.style, 'change', (el) => settings.set('tileStyle', el.value === 'classic' ? 'classic' : 'pixel'));
  control(ui.settings.bombKey, 'change', (el) => { if (isBombKey(el.value)) settings.set('bombKey', el.value); });
  control(ui.settings.language, 'change', (el) => applyLanguage(el.value));
  control(ui.join.language, 'change', (el) => applyLanguage(el.value));
  ui.settings.close.addEventListener('click', () => toggleSettings(false));
  ui.hud.gear.addEventListener('click', () => toggleSettings(true));
  ui.settings.tutorialAgain.addEventListener('click', () => {
    toggleSettings(false);
    showTutorial();
  });
}
