// English, German, French, Spanish, Italian, Polish and Ukrainian UI text.
// `t(key, params)` looks a string up in the current language; elements with data-i18n / data-i18n-placeholder /
// data-i18n-title attributes are translated by `applyI18n()`.

import { de } from './i18n/de.js';
import { en } from './i18n/en.js';
import { es } from './i18n/es.js';
import { fr } from './i18n/fr.js';
import { it } from './i18n/it.js';
import { pl } from './i18n/pl.js';
import { uk } from './i18n/uk.js';
import type { Strings } from './i18n/en.js';

export type { Strings };

const STRINGS = { en, uk, de, fr, es, it, pl };

export type StringKey = keyof Strings;
export type Lang = keyof typeof STRINGS;
type Params = Record<string, string | number | null | undefined>;
const TABLES: Record<Lang, Partial<Strings>> = STRINGS;

export const LANGUAGES: Record<Lang, string> = {
  en: 'English', de: 'Deutsch', fr: 'Français', es: 'Español', it: 'Italiano', pl: 'Polski', uk: 'Українська',
};
let lang: Lang = 'en';

/** A saved choice wins; otherwise the browser's language, if we have it. */
export function detectLanguage(saved: string | null | undefined): Lang {
  if (saved && isLang(saved)) return saved;
  const browser = (navigator.language || 'en').toLowerCase().slice(0, 2);
  return isLang(browser) ? browser : 'en';
}

function isLang(l: string): l is Lang {
  return Object.hasOwn(STRINGS, l);
}

export function setLanguage(l: string): void {
  lang = isLang(l) ? l : 'en';
  document.documentElement.lang = lang;
  applyI18n();
}

export function getLanguage(): Lang {
  return lang;
}

/** A string (or nested value such as an array) in the current language. */
export function t<K extends StringKey>(key: K, params?: Params): Strings[K] {
  const v = TABLES[lang][key] ?? STRINGS.en[key];
  if (params && typeof v === 'string') return fill(v, params) as Strings[K];
  return v;
}

/** A plain string by a key only known at run time (page markup); the key itself if there's none. */
export function text(key: string): string {
  const v: unknown = isStringKey(key) ? t(key) : undefined;
  return typeof v === 'string' ? v : key;
}

function isStringKey(key: string): key is StringKey {
  return Object.hasOwn(STRINGS.en, key);
}

/** Replaces `{name}` placeholders. */
function fill(template: string, params: Params): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? ''));
}

export function applyI18n(root: ParentNode = document): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n]')) el.textContent = text(el.dataset.i18n ?? '');
  for (const el of root.querySelectorAll<HTMLInputElement>('[data-i18n-placeholder]')) el.placeholder = text(el.dataset.i18nPlaceholder ?? '');
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-title]')) el.title = text(el.dataset.i18nTitle ?? '');
}
