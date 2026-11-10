// Player preferences, persisted in localStorage when available.

const KEY = 'blast-settings';
const DEFAULTS: SettingValues = {
  music: 0.35, sfx: 0.6, muted: false, showFps: true, zoom: 1,
  colorblind: false, highContrast: false, lang: '', hat: 0, trail: 0, arena: 0, tutorialDone: false,
  tileStyle: 'pixel', // or 'classic'
  showMinimap: true,
  minimapSize: 170, // CSS px, MINIMAP_MIN..MINIMAP_MAX
};

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
  tileStyle: 'pixel' | 'classic';
  showMinimap: boolean;
  minimapSize: number;
}

export type SettingKey = keyof SettingValues;
type Listener = <K extends SettingKey>(key: K, value: SettingValues[K]) => void;

/** Range of the minimap size setting, in CSS px. */
export const MINIMAP_MIN = 110;
export const MINIMAP_MAX = 280;

export class Settings {
  values: SettingValues;
  listeners: Listener[];

  constructor() {
    this.values = { ...DEFAULTS };
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}');
      const values = this.values as unknown as Record<string, unknown>;
      for (const k of Object.keys(DEFAULTS) as SettingKey[]) {
        if (typeof saved[k] === typeof DEFAULTS[k]) values[k] = saved[k];
      }
    } catch { /* storage unavailable or corrupt: keep defaults */ }
    this.listeners = [];
  }

  get<K extends SettingKey>(k: K): SettingValues[K] { return this.values[k]; }

  set<K extends SettingKey>(k: K, v: SettingValues[K]): void {
    if (this.values[k] === v) return;
    this.values[k] = v;
    try { localStorage.setItem(KEY, JSON.stringify(this.values)); } catch { /* not persisted */ }
    for (const fn of this.listeners) fn(k, v);
  }

  onChange(fn: (key: SettingKey, value: SettingValues[SettingKey]) => void): void { this.listeners.push(fn); }
}
