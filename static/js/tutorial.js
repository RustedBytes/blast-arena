// A short interactive tutorial shown on the first game. Each step advances
// when the player does the thing it asks (or presses Next).

import { t } from './i18n.js';

// The event that completes each step.
const STEP_EVENTS = ['moved', 'bomb', 'pickup', 'zoom'];

export class Tutorial {
  constructor(el, onDone) {
    this.el = el;
    this.onDone = onDone;
    this.step = -1;
    this.moved = 0;
    el.querySelector('.tut-next').addEventListener('click', () => this.advance());
    el.querySelector('.tut-skip').addEventListener('click', () => this.finish());
  }

  start() {
    this.step = 0;
    this.moved = 0;
    this.render();
  }

  get active() {
    return this.step >= 0;
  }

  /** Something happened in the game; may complete the current step. */
  notify(event, amount = 1) {
    if (!this.active) return;
    if (event === 'moved') {
      this.moved += amount;
      if (this.moved < 2.5) return;
    }
    if (STEP_EVENTS[this.step] === event) this.advance();
  }

  advance() {
    this.step++;
    if (this.step >= STEP_EVENTS.length) this.finish();
    else this.render();
  }

  finish() {
    this.step = -1;
    this.el.classList.add('hidden');
    this.onDone();
  }

  render() {
    const steps = t('tutorial');
    const [title, body] = steps[this.step];
    this.el.querySelector('.tut-step').textContent = `${this.step + 1} / ${steps.length}`;
    this.el.querySelector('.tut-title').textContent = title;
    this.el.querySelector('.tut-body').textContent = body;
    const last = this.step === steps.length - 1;
    this.el.querySelector('.tut-next').textContent = last ? t('tutorialDone') : t('tutorialNext');
    this.el.querySelector('.tut-skip').textContent = t('tutorialSkip');
    this.el.classList.remove('hidden');
  }
}
