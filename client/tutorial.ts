// The tutorial: a modal slide deck that explains the game in pictures,
// one idea per slide (moving, bombs, power-ups, the arena, modes, scoring).
// Back/Next, the dots, the arrow keys or a swipe move between slides; Esc or
// the close button ends it.

import type { Assets } from './assets.js';
import { query, setChildren } from './dom.js';
import { t } from './i18n.js';
import { drawIcon, drawScene, hasFire } from './tutorial/scene.js';
import { SLIDES } from './tutorial/slides.js';
import type { Icon, Slide } from './tutorial/slides.js';

/** Fire flickers at this many ms per frame. */
const FLICKER_MS = 140;
/** A horizontal swipe longer than this (CSS px) turns the page. */
const SWIPE_PX = 50;

export class Tutorial {
  private index = 0;
  private onClose: (() => void) | null = null;
  private flicker: ReturnType<typeof setInterval> | undefined;
  private returnFocus: HTMLElement | null = null;
  private swipeX: number | null = null;
  private readonly visual: HTMLElement;
  private readonly slideEl: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly bodyEl: HTMLElement;
  private readonly keysEl: HTMLElement;
  private readonly dots: HTMLElement;
  private readonly count: HTMLElement;
  private readonly back: HTMLButtonElement;
  private readonly next: HTMLButtonElement;
  private readonly close: HTMLButtonElement;

  /** `onDone` runs whenever the tutorial is closed (finished or skipped). */
  constructor(private readonly el: HTMLElement, private readonly assets: Assets, private readonly onDone: () => void) {
    this.visual = query(el, '.tut-visual');
    this.slideEl = query(el, '.tut-slide');
    this.titleEl = query(el, '.tut-title');
    this.bodyEl = query(el, '.tut-body');
    this.keysEl = query(el, '.tut-keys');
    this.dots = query(el, '.tut-dots');
    this.count = query(el, '.tut-count');
    this.back = query(el, '.tut-back', HTMLButtonElement);
    this.next = query(el, '.tut-next', HTMLButtonElement);
    this.close = query(el, '.tut-close', HTMLButtonElement);
    this.back.addEventListener('click', () => this.go(this.index - 1));
    this.next.addEventListener('click', () => {
      if (this.index === SLIDES.length - 1) this.hide();
      else this.go(this.index + 1);
    });
    this.close.addEventListener('click', () => this.hide());
    // Clicking the dimmed backdrop (not the card) closes it too.
    el.addEventListener('click', (e) => { if (e.target === el) this.hide(); });
    this.dots.addEventListener('click', (e) => {
      const dot = e.target instanceof HTMLElement ? e.target.closest<HTMLElement>('[data-slide]') : null;
      if (dot) this.go(Number(dot.dataset.slide));
    });
    addEventListener('keydown', (e) => this.key(e), true);
    el.addEventListener('pointerdown', (e) => { this.swipeX = e.clientX; });
    el.addEventListener('pointerup', (e) => {
      if (this.swipeX === null) return;
      const dx = e.clientX - this.swipeX;
      this.swipeX = null;
      if (Math.abs(dx) > SWIPE_PX) this.go(this.index + (dx < 0 ? 1 : -1));
    });
  }

  get active(): boolean {
    return !this.el.classList.contains('hidden');
  }

  /** Shows the tutorial from the first slide; `onClose` runs when it's closed. */
  open(onClose?: () => void): void {
    this.onClose = onClose ?? null;
    this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    this.index = 0;
    this.el.classList.remove('hidden');
    this.render(0);
    this.next.focus();
  }

  private hide(): void {
    if (!this.active) return;
    this.el.classList.add('hidden');
    clearInterval(this.flicker);
    this.onDone();
    const after = this.onClose;
    this.onClose = null;
    this.returnFocus?.focus();
    after?.();
  }

  private go(index: number): void {
    if (index < 0 || index >= SLIDES.length || index === this.index) return;
    const dir = index > this.index ? 1 : -1;
    this.index = index;
    this.render(dir);
  }

  private key(e: KeyboardEvent): void {
    if (!this.active) return;
    const handled = ['ArrowRight', 'ArrowLeft', 'Escape', 'PageDown', 'PageUp'];
    if (!handled.includes(e.key)) return;
    e.preventDefault();
    e.stopImmediatePropagation(); // the game's own keys stay quiet while reading
    if (e.key === 'ArrowRight' || e.key === 'PageDown') this.go(this.index + 1);
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') this.go(this.index - 1);
    else this.hide();
  }

  /** Shows the current slide; `dir` picks the slide-in direction (0: none). */
  private render(dir: number): void {
    const slide = SLIDES[this.index];
    const text = t('guide')[slide.id];
    this.titleEl.textContent = text.title;
    this.bodyEl.textContent = text.body;
    this.renderVisual(slide, 'labels' in text ? text.labels : []);
    setChildren(this.keysEl, ...(slide.keys ?? []).map((k) => {
      const kbd = document.createElement('kbd');
      kbd.textContent = k;
      return kbd;
    }));
    this.keysEl.hidden = !slide.keys;

    const ui = t('guideUi');
    const last = this.index === SLIDES.length - 1;
    this.back.textContent = ui.back;
    this.back.disabled = this.index === 0;
    this.next.textContent = last ? ui.done : ui.next;
    this.close.setAttribute('aria-label', ui.close);
    this.count.textContent = t('guideUi').slide.replace('{n}', String(this.index + 1)).replace('{total}', String(SLIDES.length));
    setChildren(this.dots, ...SLIDES.map((_, i) => {
      const dot = document.createElement('button');
      dot.type = 'button';
      dot.className = i === this.index ? 'tut-dot current' : 'tut-dot';
      dot.dataset.slide = String(i);
      dot.setAttribute('aria-label', String(i + 1));
      if (i === this.index) dot.setAttribute('aria-current', 'step');
      return dot;
    }));

    this.slideEl.classList.remove('from-left', 'from-right');
    if (dir) {
      this.slideEl.getBoundingClientRect(); // restart the slide-in animation
      this.slideEl.classList.add(dir > 0 ? 'from-right' : 'from-left');
    }
  }

  private renderVisual(slide: Slide, labels: readonly string[]): void {
    clearInterval(this.flicker);
    const v = slide.visual;
    if ('scene' in v) {
      const canvas = document.createElement('canvas');
      canvas.className = 'tut-scene';
      let frame = 0;
      drawScene(canvas, v.scene, this.assets, frame);
      setChildren(this.visual, canvas);
      if (hasFire(v.scene)) {
        this.flicker = setInterval(() => drawScene(canvas, v.scene, this.assets, ++frame), FLICKER_MS);
      }
      return;
    }
    const grid = document.createElement('div');
    grid.className = 'tut-icons';
    grid.append(...v.icons.map((icon) => this.iconFigure(icon, labels)));
    setChildren(this.visual, grid);
  }

  private iconFigure(icon: Icon, labels: readonly string[]): HTMLElement {
    const fig = document.createElement('figure');
    if ('emoji' in icon) {
      const span = document.createElement('span');
      span.className = 'tut-emoji';
      span.textContent = icon.emoji;
      span.setAttribute('aria-hidden', 'true');
      fig.append(span);
    } else {
      const canvas = document.createElement('canvas');
      drawIcon(canvas, icon.sprite, this.assets);
      fig.append(canvas);
    }
    const cap = document.createElement('figcaption');
    cap.textContent = 'item' in icon ? (t('items')[icon.item] ?? '') : (labels[icon.label] ?? '');
    fig.append(cap);
    return fig;
  }
}
