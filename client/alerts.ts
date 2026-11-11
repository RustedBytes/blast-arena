// In-game alerts, in three kinds so they never fight for the same spot:
//
// - announcements: big cards at the top (a kill streak, a map event, a win),
//   one at a time from a short queue; more important ones go first, the
//   same alert again just refreshes, and a bar shows the time left;
// - toasts: small pills near the bottom for personal news (power-ups,
//   flags), a few at a time, newest at the bottom;
// - status pills: pinned under the round bar for as long as a situation
//   lasts (in the storm, in a nuke's zone, stunned...), with a live bar.
//
// Tones colour them: info, good, warn, danger, epic.

import { query, setChildren } from './dom.js';

const QUEUE_MAX = 4;
const TOASTS_MAX = 4;

export type Tone = 'info' | 'good' | 'warn' | 'danger' | 'epic';

export interface AnnounceOpts {
  text: string;
  /** A hint line. */
  sub?: string;
  /** Emoji, or an `assets/` sprite name prefixed with `img:`. */
  icon?: string;
  tone?: Tone;
  /** Milliseconds. */
  duration?: number;
  /** Higher first, interrupts lower. */
  priority?: number;
  /** The same key refreshes. */
  key?: string;
}
type Announcement = AnnounceOpts & Required<Pick<AnnounceOpts, 'tone' | 'duration' | 'priority' | 'key'>>;

export interface ToastOpts {
  icon?: string | null;
  tone?: Tone;
  duration?: number;
  /** A newer toast with the same key replaces this one. */
  key?: string;
}

export interface StatusOpts {
  icon?: string;
  tone?: Tone;
  /** 0..1 draws a bar; leave it out for none. */
  progress?: number;
}

interface Current { opts: Announcement; el: HTMLElement; bar: HTMLElement; timer?: ReturnType<typeof setTimeout> }
interface StatusPill { el: HTMLElement; msg: HTMLElement; bar: HTMLElement; text: string; tone: Tone; progress: number | null }

export class Alerts {
  private readonly top: HTMLElement;
  private readonly statusBox: HTMLElement;
  private readonly toastBox: HTMLElement;
  private readonly live: HTMLElement;
  private readonly queue: Announcement[] = [];
  private current: Current | null = null;
  private readonly statuses = new Map<string, StatusPill>();
  private readonly toasts = new Map<string, HTMLElement>();

  constructor(root: HTMLElement) {
    this.top = query(root, '.alerts-top');
    this.statusBox = query(root, '.alerts-status');
    this.toastBox = query(root, '.alerts-toasts');
    this.live = query(root, '.alerts-live');
  }

  /** A big announcement; see `AnnounceOpts`. */
  announce(opts: AnnounceOpts): void {
    const o: Announcement = { tone: 'info', duration: 2800, priority: 1, key: opts.text, ...opts };
    this.say(o.sub ? `${o.text}. ${o.sub}` : o.text);
    if (this.current?.opts.key === o.key) {
      // The same alert again: refresh it instead of queueing a copy.
      this.current.opts = o;
      this.fill(this.current.el, o);
      this.schedule(this.current);
      return;
    }
    const same = this.queue.findIndex((q) => q.key === o.key);
    if (same >= 0) this.queue.splice(same, 1);
    if (this.current && o.priority > this.current.opts.priority) {
      // Urgent: put the current one back and show this now.
      this.queue.unshift(this.current.opts);
      this.dismiss(true);
    }
    this.queue.push(o);
    this.queue.sort((a, b) => b.priority - a.priority);
    if (this.queue.length > QUEUE_MAX) this.queue.length = QUEUE_MAX;
    if (!this.current) this.next();
  }

  /** A small notice; see `ToastOpts`. */
  toast(text: string, opts: ToastOpts = {}): void {
    if (opts.key) this.toasts.get(opts.key)?.remove();
    const el = element('div', 'alert-toast');
    el.dataset.tone = opts.tone ?? 'good';
    el.append(...icon(opts.icon), element('span', 'alert-msg', text));
    this.toastBox.append(el);
    if (opts.key) this.toasts.set(opts.key, el);
    while (this.toastBox.children.length > TOASTS_MAX) this.toastBox.firstElementChild?.remove();
    setTimeout(() => {
      el.classList.add('leaving');
      setTimeout(() => el.remove(), 300);
    }, opts.duration ?? 2600);
    this.say(text);
  }

  /**
   * Shows or updates a pinned status (`key`) while a situation lasts.
   * Cheap to call every frame: the DOM is touched only when something
   * visible changes.
   */
  status(key: string, text: string, opts: StatusOpts = {}): void {
    const tone = opts.tone ?? 'danger';
    const progress = opts.progress === undefined ? null : Math.round(Math.max(0, Math.min(1, opts.progress)) * 50) / 50;
    let s = this.statuses.get(key);
    if (!s) {
      const el = element('div', 'alert-status');
      const msg = element('span', 'alert-msg', text);
      const bar = element('div', 'alert-bar');
      bar.append(element('i'));
      el.append(...icon(opts.icon), msg, bar);
      el.dataset.tone = tone;
      bar.hidden = true;
      this.statusBox.append(el);
      s = { el, msg, bar, text, tone, progress: null };
      this.statuses.set(key, s);
      this.say(text);
    }
    if (s.text !== text) { s.text = text; s.msg.textContent = text; }
    if (s.tone !== tone) { s.tone = tone; s.el.dataset.tone = tone; }
    if (s.progress !== progress) {
      s.progress = progress;
      s.bar.hidden = progress === null;
      const fill = s.bar.firstElementChild;
      if (progress !== null && fill instanceof HTMLElement) fill.style.transform = `scaleX(${progress})`;
    }
  }

  /** Removes a pinned status, if shown. */
  clear(key: string): void {
    const s = this.statuses.get(key);
    if (!s) return;
    this.statuses.delete(key);
    s.el.classList.add('leaving');
    setTimeout(() => s.el.remove(), 220);
  }

  /** Removes everything (leaving a game). */
  reset(): void {
    this.queue.length = 0;
    if (this.current) this.dismiss(true);
    for (const key of [...this.statuses.keys()]) this.clear(key);
    setChildren(this.toastBox);
    this.toasts.clear();
  }

  private next(): void {
    const o = this.queue.shift();
    if (!o) return;
    const el = element('div', 'alert-card');
    el.setAttribute('role', 'status');
    const bar = this.fill(el, o);
    this.top.append(el);
    this.current = { opts: o, el, bar };
    this.schedule(this.current);
  }

  /** (Re)starts the countdown of the current card. */
  private schedule(c: Current): void {
    clearTimeout(c.timer);
    const bar = c.bar;
    bar.style.transition = 'none';
    bar.style.transform = 'scaleX(1)';
    bar.getBoundingClientRect(); // force a reflow, so the transition below starts from full
    bar.style.transition = `transform ${c.opts.duration}ms linear`;
    bar.style.transform = 'scaleX(0)';
    c.timer = setTimeout(() => this.dismiss(false), c.opts.duration);
  }

  private dismiss(instant: boolean): void {
    const c = this.current;
    if (!c) return;
    clearTimeout(c.timer);
    this.current = null;
    if (instant) c.el.remove();
    else {
      c.el.classList.add('leaving');
      setTimeout(() => c.el.remove(), 260);
    }
    setTimeout(() => this.next(), instant ? 0 : 180);
  }

  /** Fills an announcement card; returns its countdown bar. */
  private fill(el: HTMLElement, o: Announcement): HTMLElement {
    el.dataset.tone = o.tone;
    const text = element('div', 'alert-text');
    text.append(element('div', 'alert-title', o.text));
    if (o.sub) text.append(element('div', 'alert-sub', o.sub));
    const bar = element('div', 'alert-bar');
    const fill = element('i');
    bar.append(fill);
    setChildren(el, ...icon(o.icon), text, bar);
    return fill;
  }

  /** Screen readers hear alerts through a polite live region. */
  private say(text: string): void {
    this.live.textContent = '';
    this.live.textContent = text;
  }
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

/** The icon node(s) for an alert: none, an `assets/` sprite (`img:name`) or an emoji. */
function icon(name: string | null | undefined): HTMLElement[] {
  if (!name) return [];
  if (name.startsWith('img:')) {
    const img = element('img', 'alert-icon');
    img.src = `assets/${name.slice(4)}.svg`;
    img.alt = '';
    return [img];
  }
  const span = element('span', 'alert-icon', name);
  span.setAttribute('aria-hidden', 'true');
  return [span];
}
