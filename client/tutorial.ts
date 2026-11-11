// A short interactive tutorial shown on the first game. Each step advances
// when the player does the thing it asks (or presses Next).

import { query } from './dom.js';
import { t } from './i18n.js';

// The event that completes each step.
const STEP_EVENTS = ['moved', 'bomb', 'pickup', 'zoom'] as const;
export type TutorialEvent = (typeof STEP_EVENTS)[number];
/** Tiles to walk before the movement step counts as done. */
const MOVE_GOAL = 2.5;

export class Tutorial {
  /** The current step, or -1 when the tutorial isn't showing. */
  private step = -1;
  private moved = 0;
  private readonly stepEl: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly bodyEl: HTMLElement;
  private readonly nextBtn: HTMLElement;
  private readonly skipBtn: HTMLElement;

  constructor(private readonly el: HTMLElement, private readonly onDone: () => void) {
    this.stepEl = query(el, '.tut-step');
    this.titleEl = query(el, '.tut-title');
    this.bodyEl = query(el, '.tut-body');
    this.nextBtn = query(el, '.tut-next');
    this.skipBtn = query(el, '.tut-skip');
    this.nextBtn.addEventListener('click', () => this.advance());
    this.skipBtn.addEventListener('click', () => this.finish());
  }

  start(): void {
    this.step = 0;
    this.moved = 0;
    this.render();
  }

  get active(): boolean {
    return this.step >= 0;
  }

  /** Something happened in the game; may complete the current step. */
  notify(event: TutorialEvent, amount = 1): void {
    if (!this.active) return;
    if (event === 'moved') {
      this.moved += amount;
      if (this.moved < MOVE_GOAL) return;
    }
    if (STEP_EVENTS[this.step] === event) this.advance();
  }

  private advance(): void {
    this.step++;
    if (this.step >= STEP_EVENTS.length) this.finish();
    else this.render();
  }

  private finish(): void {
    this.step = -1;
    this.el.classList.add('hidden');
    this.onDone();
  }

  private render(): void {
    const steps = t('tutorial');
    const [title, body] = steps[this.step] ?? ['', ''];
    this.stepEl.textContent = `${this.step + 1} / ${steps.length}`;
    this.titleEl.textContent = title;
    this.bodyEl.textContent = body;
    this.nextBtn.textContent = this.step === steps.length - 1 ? t('tutorialDone') : t('tutorialNext');
    this.skipBtn.textContent = t('tutorialSkip');
    this.el.classList.remove('hidden');
  }
}
