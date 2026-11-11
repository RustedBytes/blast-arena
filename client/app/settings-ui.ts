// The settings menu: volume, zoom, language, art style and accessibility
// options, applied as they change.

import { ITEM_SPRITES } from '../assets.js';
import { byId as $, escapeHtml } from '../dom.js';
import { getLanguage, LANGUAGES, setLanguage, t } from '../i18n.js';
import { MINIMAP_MAX, MINIMAP_MIN } from '../settings.js';
import { buildEmoteWheel, invalidateHud } from './hud.js';
import { refreshLobbyLater } from './lobby.js';
import { audio, renderer, settings, tutorial } from './services.js';
import { setZoom } from './view.js';

// ------------------------------------------------------------- settings

export function toggleSettings(open = $('settings').classList.contains('hidden')) {
  $('settings').classList.toggle('hidden', !open);
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
  $('legend').innerHTML = ITEM_SPRITES.slice(1).map((s, i) =>
    `<span><img src="assets/${s}.svg" alt="">${escapeHtml(items[i + 1])}</span>`).join('');
}

function fillLanguageSelects() {
  for (const sel of [$('set-lang', HTMLSelectElement), $('join-lang', HTMLSelectElement)]) {
    sel.innerHTML = Object.entries(LANGUAGES).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
    sel.value = getLanguage();
  }
}

export function applySettings() {
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

export function applyLanguage(lang: string): void {
  setLanguage(lang);
  settings.set('lang', lang);
  fillLanguageSelects();
  buildLegend();
  buildEmoteWheel();
  $('lb-hint').textContent = t('holdTab', { k: 'Tab' });
  invalidateHud();
  refreshLobbyLater();
}

/** Calls `fn` with a settings control each time it changes. */
function control<T extends HTMLInputElement | HTMLSelectElement>(
  id: string, type: new () => T, event: 'input' | 'change', fn: (el: T) => void,
): void {
  const el = $(id, type);
  el.addEventListener(event, () => fn(el));
}

/** Wires the settings controls and applies the saved settings. */
export function setupSettingsUi(): void {
  settings.onChange(applySettings);
  applySettings();
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
}
