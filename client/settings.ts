// Player preferences, persisted in localStorage when available.

import { isBombKey } from './keymap.js';
import type { BombKey } from './keymap.js';

export type TileStyle = 'pixel' | 'classic';

export interface SettingValues {
  music: number;
  sfx: number;
  muted: boolean;
  showFps: boolean;
  zoom: number;
  colorblind: boolean;
  highContrast: boolean;
  lang: string;
  hat: number;
  trail: number;
  arena: number;
  tutorialDone: boolean;
  tileStyle: TileStyle;
  showMinimap: boolean;
  /** CSS px, MINIMAP_MIN..MINIMAP_MAX. */
  minimapSize: number;
  /** The bomb / rocket key: F (Space jumps) or Space (F jumps). */
  bombKey: BombKey;
}

export type SettingKey = keyof SettingValues;
export type SettingListener = (key: SettingKey) => void;

/** Range of the minimap size setting, in CSS px. */
export const MINIMAP_MIN = 110;
export const MINIMAP_MAX = 280;

const KEY = 'blast-settings';
const DEFAULTS: Readonly<SettingValues> = {
  music: 0.35, sfx: 0.6, muted: false, showFps: true, zoom: 1,
  colorblind: false, highContrast: false, lang: '', hat: 0, trail: 0, arena: 0, tutorialDone: false,
  tileStyle: 'pixel',
  showMinimap: true,
  minimapSize: 170,
  bombKey: 'f',
};

const isTileStyle = (v: unknown): v is TileStyle => v === 'pixel' || v === 'classic';

/** Saved values that still fit their setting; anything else keeps the default. */
function restore(saved: unknown): SettingValues {
  const out: SettingValues = { ...DEFAULTS };
  if (typeof saved !== 'object' || saved === null) return out;
  const raw = saved as Partial<Record<SettingKey, unknown>>;
  const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);
  out.music = num(raw.music, out.music);
  out.sfx = num(raw.sfx, out.sfx);
  out.muted = bool(raw.muted, out.muted);
  out.showFps = bool(raw.showFps, out.showFps);
  out.zoom = num(raw.zoom, out.zoom);
  out.colorblind = bool(raw.colorblind, out.colorblind);
  out.highContrast = bool(raw.highContrast, out.highContrast);
  out.lang = typeof raw.lang === 'string' ? raw.lang : out.lang;
  out.hat = num(raw.hat, out.hat);
  out.trail = num(raw.trail, out.trail);
  out.arena = num(raw.arena, out.arena);
  out.tutorialDone = bool(raw.tutorialDone, out.tutorialDone);
  out.tileStyle = isTileStyle(raw.tileStyle) ? raw.tileStyle : out.tileStyle;
  out.showMinimap = bool(raw.showMinimap, out.showMinimap);
  out.minimapSize = num(raw.minimapSize, out.minimapSize);
  out.bombKey = isBombKey(raw.bombKey) ? raw.bombKey : out.bombKey;
  return out;
}

export class Settings {
  private readonly values: SettingValues;
  private readonly listeners: SettingListener[] = [];

  constructor() {
    let saved: unknown = null;
    try {
      saved = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    } catch { /* storage unavailable or corrupt: keep defaults */ }
    this.values = restore(saved);
  }

  get<K extends SettingKey>(k: K): SettingValues[K] {
    return this.values[k];
  }

  set<K extends SettingKey>(k: K, v: SettingValues[K]): void {
    if (this.values[k] === v) return;
    this.values[k] = v;
    try { localStorage.setItem(KEY, JSON.stringify(this.values)); } catch { /* not persisted */ }
    for (const fn of this.listeners) fn(k);
  }

  /** Calls `fn` with the key of every setting that changes. */
  onChange(fn: SettingListener): void {
    this.listeners.push(fn);
  }
}
