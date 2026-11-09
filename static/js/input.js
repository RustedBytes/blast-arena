// Keyboard and touch input. Only changes in the held direction are sent,
// plus a message per bomb press.

const KEY_DIRS = {
  ArrowUp: 1, KeyW: 1,
  ArrowRight: 2, KeyD: 2,
  ArrowDown: 3, KeyS: 3,
  ArrowLeft: 4, KeyA: 4,
};

export class Input {
  constructor(onDir, onBomb) {
    this.onDir = onDir;
    this.onBomb = onBomb;
    this.held = []; // most recently pressed direction last
    this.dir = 0;
    this.enabled = false;

    addEventListener('keydown', (e) => {
      if (!this.enabled) return;
      const d = KEY_DIRS[e.code];
      if (d) {
        e.preventDefault();
        if (!this.held.includes(d)) this.held.push(d);
        this.update();
      } else if (e.code === 'Space' || e.code === 'Enter') {
        e.preventDefault();
        if (!e.repeat) this.onBomb();
      }
    });
    addEventListener('keyup', (e) => {
      const d = KEY_DIRS[e.code];
      if (d) {
        this.held = this.held.filter((h) => h !== d);
        this.update();
      }
    });
    addEventListener('blur', () => this.clear());
    this.setupTouch();
  }

  update() {
    const d = this.held.length ? this.held[this.held.length - 1] : 0;
    if (d !== this.dir) {
      this.dir = d;
      this.onDir(d);
    }
  }

  clear() {
    this.held = [];
    this.update();
  }

  setupTouch() {
    const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
    if (!isTouch) return;
    document.body.classList.add('touch');
    document.getElementById('touch').classList.remove('hidden');

    for (const btn of document.querySelectorAll('#dpad button')) {
      const d = Number(btn.dataset.dir);
      const press = (e) => {
        e.preventDefault();
        btn.classList.add('active');
        if (!this.held.includes(d)) this.held.push(d);
        this.update();
      };
      const release = (e) => {
        e.preventDefault();
        btn.classList.remove('active');
        this.held = this.held.filter((h) => h !== d);
        this.update();
      };
      btn.addEventListener('pointerdown', press);
      btn.addEventListener('pointerup', release);
      btn.addEventListener('pointercancel', release);
      btn.addEventListener('pointerleave', release);
    }
    const bomb = document.getElementById('bomb-btn');
    bomb.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      bomb.classList.add('active');
      this.onBomb();
    });
    const up = () => bomb.classList.remove('active');
    bomb.addEventListener('pointerup', up);
    bomb.addEventListener('pointercancel', up);
  }
}
