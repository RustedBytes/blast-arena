// Fixed-size particle pool stored as struct-of-arrays in typed arrays, with
// a free list. Emitting and updating never allocate, so effects create no
// garbage-collector pressure.

export const P_SPARK = 0;   // additive, shrinks, gravity-free
export const P_SMOKE = 1;   // grows and fades, drifts up
export const P_DEBRIS = 2;  // squares with gravity
export const P_STAR = 3;    // twinkling additive stars (pickups, secret box)
export const P_CURSE = 4;   // purple swirl motes

// Colours indexed by the `color` argument of emit().
export const COLORS = [
  '#fff6c0', '#ffd23f', '#ff8a1f', '#ff3b0a', // 0-3 fire
  '#5a5a66', '#8a8a96',                       // 4-5 smoke
  '#a46a33', '#c98a4b',                       // 6-7 wood
  '#7ff6ff', '#ffffff', '#ffd34a', '#ff7af0',  // 8-11 stars
  '#b06bff', '#7a3fd6',                       // 12-13 curse
];

export class Particles {
  constructor(capacity = 2048) {
    this.cap = capacity;
    this.x = new Float32Array(capacity);
    this.y = new Float32Array(capacity);
    this.vx = new Float32Array(capacity);
    this.vy = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.size = new Float32Array(capacity);
    this.kind = new Uint8Array(capacity);
    this.color = new Uint8Array(capacity);
    this.alive = new Uint8Array(capacity);
    this.free = new Int32Array(capacity);
    this.freeTop = capacity;
    for (let i = 0; i < capacity; i++) this.free[i] = capacity - 1 - i;
    this.count = 0;
    /** Draw as pixel art (set by the renderer from the art style). */
    this.pixel = false;
  }

  /** Positions and sizes are in tiles; velocities in tiles per second. */
  emit(kind, x, y, vx, vy, life, size, color) {
    if (this.freeTop === 0) return; // pool full: drop the effect
    const i = this.free[--this.freeTop];
    this.x[i] = x; this.y[i] = y; this.vx[i] = vx; this.vy[i] = vy;
    this.life[i] = life; this.maxLife[i] = life; this.size[i] = size;
    this.kind[i] = kind; this.color[i] = color; this.alive[i] = 1;
    this.count++;
  }

  /** A burst of `n` particles in random directions. */
  burst(kind, x, y, n, speed, life, size, color, colorSpread = 1) {
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.4 + Math.random() * 0.6);
      this.emit(kind, x, y, Math.cos(a) * s, Math.sin(a) * s, life * (0.6 + Math.random() * 0.4), size,
        color + Math.floor(Math.random() * colorSpread));
    }
  }

  update(dt) {
    const { x, y, vx, vy, life, kind, alive } = this;
    for (let i = 0; i < this.cap; i++) {
      if (!alive[i]) continue;
      life[i] -= dt;
      if (life[i] <= 0) {
        alive[i] = 0;
        this.free[this.freeTop++] = i;
        this.count--;
        continue;
      }
      const k = kind[i];
      if (k === P_DEBRIS) vy[i] += 9 * dt;
      else if (k === P_SMOKE) { vy[i] -= 0.6 * dt; vx[i] *= 0.98; }
      else if (k === P_SPARK) { vx[i] *= 0.94; vy[i] *= 0.94; }
      else if (k === P_CURSE) { const t = life[i] * 6; vx[i] = Math.cos(t) * 0.6; vy[i] -= 0.3 * dt; }
      x[i] += vx[i] * dt;
      y[i] += vy[i] * dt;
    }
  }

  /**
   * Pixel-art particles: squares snapped to the art-pixel grid (16 per
   * tile), shrinking in whole art pixels, so effects match the sprites.
   */
  pixelParticle(ctx, k, t, px, py, size, T, life) {
    const u = T / 16;
    const cx = Math.round(px / u) * u, cy = Math.round(py / u) * u;
    if (k === P_STAR) {
      // A plus sign that twinkles.
      ctx.globalAlpha = t * (0.6 + 0.4 * Math.sin(life * 30));
      const n = t > 0.5 ? 2 : 1;
      ctx.fillRect(cx - u / 2, cy - (n + 0.5) * u, u, (2 * n + 1) * u);
      ctx.fillRect(cx - (n + 0.5) * u, cy - u / 2, (2 * n + 1) * u, u);
      return;
    }
    // Everything else is a square, sized in whole art pixels.
    let n;
    if (k === P_SMOKE) {
      ctx.globalAlpha = t * 0.5;
      n = size * 16 * (1.6 - t) * 1.4;
    } else if (k === P_DEBRIS) {
      ctx.globalAlpha = Math.min(1, t * 2);
      n = size * 16;
    } else {
      ctx.globalAlpha = k === P_CURSE ? t * 0.8 : t;
      n = size * 16 * (k === P_SPARK ? t : 1) * 1.6;
    }
    const s = Math.max(1, Math.round(n)) * u;
    ctx.fillRect(cx - s / 2, cy - s / 2, s, s);
  }

  /** Draws normal-blended particles, then additive ones in a second pass. */
  draw(ctx, camX, camY, T) {
    if (this.count === 0) return;
    this.pass(ctx, camX, camY, T, false);
    ctx.globalCompositeOperation = 'lighter';
    this.pass(ctx, camX, camY, T, true);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  pass(ctx, camX, camY, T, additive) {
    const { x, y, life, maxLife, size, kind, color, alive } = this;
    for (let i = 0; i < this.cap; i++) {
      if (!alive[i]) continue;
      const k = kind[i];
      const isAdd = k === P_SPARK || k === P_STAR;
      if (isAdd !== additive) continue;
      const t = life[i] / maxLife[i]; // 1 → 0
      const px = x[i] * T - camX, py = y[i] * T - camY;
      ctx.fillStyle = COLORS[color[i]];
      if (this.pixel) {
        this.pixelParticle(ctx, k, t, px, py, size[i], T, life[i]);
        continue;
      }
      if (k === P_SMOKE) {
        ctx.globalAlpha = t * 0.55;
        const r = size[i] * T * (1.6 - t);
        ctx.beginPath(); ctx.arc(px, py, r, 0, 6.2832); ctx.fill();
      } else if (k === P_DEBRIS) {
        ctx.globalAlpha = Math.min(1, t * 2);
        const s = size[i] * T;
        ctx.fillRect(px - s / 2, py - s / 2, s, s);
      } else if (k === P_STAR) {
        ctx.globalAlpha = t * (0.6 + 0.4 * Math.sin(life[i] * 30));
        const s = size[i] * T * (0.5 + t);
        ctx.fillRect(px - s / 2, py - s / 8, s, s / 4);
        ctx.fillRect(px - s / 8, py - s / 2, s / 4, s);
      } else {
        ctx.globalAlpha = k === P_CURSE ? t * 0.8 : t;
        const r = size[i] * T * (k === P_SPARK ? t : 1);
        ctx.beginPath(); ctx.arc(px, py, Math.max(0.5, r), 0, 6.2832); ctx.fill();
      }
    }
  }
}
