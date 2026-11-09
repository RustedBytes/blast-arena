// Player preferences, persisted in localStorage when available.

const KEY = 'blast-settings';
const DEFAULTS = { music: 0.35, sfx: 0.6, muted: false, showFps: true, zoom: 1 };

export class Settings {
  constructor() {
    this.values = { ...DEFAULTS };
    try {
      const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}');
      for (const k of Object.keys(DEFAULTS)) {
        if (typeof saved[k] === typeof DEFAULTS[k]) this.values[k] = saved[k];
      }
    } catch { /* storage unavailable or corrupt: keep defaults */ }
    this.listeners = [];
  }

  get(k) { return this.values[k]; }

  set(k, v) {
    if (this.values[k] === v) return;
    this.values[k] = v;
    try { localStorage.setItem(KEY, JSON.stringify(this.values)); } catch { /* not persisted */ }
    for (const fn of this.listeners) fn(k, v);
  }

  onChange(fn) { this.listeners.push(fn); }
}
