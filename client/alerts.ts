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

const QUEUE_MAX = 4;
const TOASTS_MAX = 4;

export type Tone = 'info' | 'good' | 'warn' | 'danger' | 'epic' | 'mystery';

export interface AnnounceOpts {
  text: string;
  /** A hint line. */
  sub?: string | null;
  /** Emoji, or an `assets/` sprite name prefixed with `img:`. */
  icon?: string | null;
  tone?: Tone;
  /** Milliseconds. */
  duration?: number;
  /** Higher first, interrupts lower. */
  priority?: number;
  /** The same key refreshes. */
  key?: string;
}
type Announcement = AnnounceOpts & { tone: Tone; duration: number; priority: number; key: string };

export interface ToastOpts {
  icon?: string | null;
  tone?: Tone;
  duration?: number;
  /** Names the kind of notice (not used for de-duplication yet). */
  key?: string;
}
export interface StatusOpts { icon?: string | null; tone?: Tone; progress?: number | null }

interface Current { opts: Announcement; el: HTMLElement; timer?: ReturnType<typeof setTimeout> }
interface StatusPill { el: HTMLElement; text: string | null; tone: Tone | null; progress: number | null | undefined }

export class Alerts {
  root: HTMLElement;
  top: HTMLElement;
  statusBox: HTMLElement;
  toastBox: HTMLElement;
  live: HTMLElement;
  queue: Announcement[];
  current: Current | null;
  statuses: Map<string, StatusPill>;

  constructor(root: HTMLElement) {
    this.root = root;
    this.top = root.querySelector<HTMLElement>('.alerts-top')!;
    this.statusBox = root.querySelector<HTMLElement>('.alerts-status')!;
    this.toastBox = root.querySelector<HTMLElement>('.alerts-toasts')!;
    this.live = root.querySelector<HTMLElement>('.alerts-live')!;
    this.queue = [];
    this.current = null;
    this.statuses = new Map();
  }

  /**
   * A big announcement. `opts`: text, sub (a hint line), icon (emoji or an
   * `assets/` sprite name prefixed with `img:`), tone, duration (ms),
   * priority (higher first, interrupts lower), key (same key refreshes).
   */
  announce(opts: AnnounceOpts): void {
    const o: Announcement = { tone: 'info', duration: 2800, priority: 1, key: opts.text, ...opts };
    this.say(o.sub ? `${o.text}. ${o.sub}` : o.text);
    if (this.current && this.current.opts.key === o.key) {
      // The same alert again: refresh it instead of queueing a copy.
      this.fill(this.current.el, o);
      this.schedule(o.duration);
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

  next(): void {
    const o = this.queue.shift();
    if (!o) return;
    const el = document.createElement('div');
    el.className = 'alert-card';
    el.setAttribute('role', 'status');
    this.fill(el, o);
    this.top.append(el);
    this.current = { opts: o, el };
    this.schedule(o.duration);
  }

  schedule(duration: number): void {
    const c = this.current!;
    clearTimeout(c.timer);
    const bar = c.el.querySelector<HTMLElement>('.alert-bar i')!;
    // Restart the countdown bar.
    bar.style.transition = 'none';
    bar.style.transform = 'scaleX(1)';
    void bar.offsetWidth;
    bar.style.transition = `transform ${duration}ms linear`;
    bar.style.transform = 'scaleX(0)';
    c.timer = setTimeout(() => this.dismiss(false), duration);
  }

  dismiss(instant: boolean): void {
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

  fill(el: HTMLElement, o: Announcement): void {
    el.dataset.tone = o.tone;
    el.innerHTML = `${icon(o.icon)}<div class="alert-text"><div class="alert-title"></div>` +
      `${o.sub ? '<div class="alert-sub"></div>' : ''}</div><div class="alert-bar"><i></i></div>`;
    el.querySelector('.alert-title')!.textContent = o.text;
    if (o.sub) el.querySelector('.alert-sub')!.textContent = o.sub;
  }

  /** A small notice: text, icon, tone. */
  toast(text: string, opts: ToastOpts = {}): void {
    const el = document.createElement('div');
    el.className = 'alert-toast';
    el.dataset.tone = opts.tone ?? 'good';
    el.innerHTML = `${icon(opts.icon)}<span class="alert-msg"></span>`;
    el.querySelector('.alert-msg')!.textContent = text;
    this.toastBox.append(el);
    while (this.toastBox.children.length > TOASTS_MAX) (this.toastBox.firstChild as ChildNode).remove();
    setTimeout(() => {
      el.classList.add('leaving');
      setTimeout(() => el.remove(), 300);
    }, opts.duration ?? 2600);
    this.say(text);
  }

  /**
   * Shows or updates a pinned status (`key`) while a situation lasts;
   * `progress` (0..1) draws a bar. Cheap to call every frame: the DOM is
   * touched only when something visible changes.
   */
  status(key: string, text: string, opts: StatusOpts = {}): void {
    let s = this.statuses.get(key);
    const tone = opts.tone ?? 'danger';
    const progress = opts.progress == null ? null : Math.round(Math.max(0, Math.min(1, opts.progress)) * 50) / 50;
    if (!s) {
      const el = document.createElement('div');
      el.className = 'alert-status';
      el.innerHTML = `${icon(opts.icon)}<span class="alert-msg"></span><div class="alert-bar"><i></i></div>`;
      this.statusBox.append(el);
      s = { el, text: null, tone: null, progress: undefined };
      this.statuses.set(key, s);
      this.say(text);
    }
    if (s.text !== text) { s.text = text; s.el.querySelector('.alert-msg')!.textContent = text; }
    if (s.tone !== tone) { s.tone = tone; s.el.dataset.tone = tone; }
    if (s.progress !== progress) {
      s.progress = progress;
      const bar = s.el.querySelector<HTMLElement>('.alert-bar')!;
      bar.hidden = progress == null;
      if (progress != null) (bar.firstChild as HTMLElement).style.transform = `scaleX(${progress})`;
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
    this.toastBox.replaceChildren();
  }

  /** Screen readers hear alerts through a polite live region. */
  say(text: string): void {
    this.live.textContent = '';
    this.live.textContent = text;
  }
}

function icon(name: string | null | undefined): string {
  if (!name) return '';
  if (name.startsWith('img:')) return `<img class="alert-icon" src="assets/${name.slice(4)}.svg" alt="">`;
  return `<span class="alert-icon" aria-hidden="true">${name}</span>`;
}
