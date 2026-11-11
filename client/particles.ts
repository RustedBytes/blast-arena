// Fixed-size particle pool stored as struct-of-arrays in typed arrays. Live
// particles are kept packed at the front (a dead one is replaced by the
// last), so updating and drawing touch only live ones. Drawing groups them
// by colour and (quantized) opacity and fills each group as one path, so a
// frame costs a few dozen canvas state changes instead of one per particle.
// Nothing here allocates per frame.

export const P_SPARK = 0;   // additive, shrinks, gravity-free
export const P_SMOKE = 1;   // grows and fades, drifts up
export const P_DEBRIS = 2;  // squares with gravity
export const P_STAR = 3;    // twinkling additive stars (pickups, secret box)
export const P_CURSE = 4;   // purple swirl motes

// Colours indexed by the `color` argument of emit().
export const COLORS: readonly string[] = [
  '#fff6c0', '#ffd23f', '#ff8a1f', '#ff3b0a', // 0-3 fire
  '#5a5a66', '#8a8a96',                       // 4-5 smoke
  '#a46a33', '#c98a4b',                       // 6-7 wood
  '#7ff6ff', '#ffffff', '#ffd34a', '#ff7af0',  // 8-11 stars
  '#b06bff', '#7a3fd6',                       // 12-13 curse
  '#8fd14f', '#5aa02a',                       // 14-15 gas
  '#4affc8',                                  // 16 dash
  '#c94a66', '#ff9a8a',                       // 17-18 worm
  '#c9b48a',                                  // 19 footstep dust
  '#7ee05a', '#c8ff8a',                       // 20-21 slime
  '#e8e2cf', '#a8a08a',                       // 22-23 bone
  '#4a3a6a', '#8a6ab0',                       // 24-25 bat
];


// Opacity is quantized into this many levels for batching.
const LEVELS = 12;
const BUCKETS = 2 * COLORS.length * LEVELS;
const NONE = 0xffff;

export class Particles {
  /** Draw as pixel art (set by the renderer from the art style). */
  pixel = false;
  /** Live particles, packed at the front of the arrays. */
  count = 0;
  private readonly x: Float32Array;
  private readonly y: Float32Array;
  private readonly vx: Float32Array;
  private readonly vy: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly size: Float32Array;
  private readonly kind: Uint8Array;
  private readonly color: Uint8Array;
  // Draw batching scratch: a bucket per (blend, colour, opacity level).
  private readonly bucketOf: Uint16Array;
  private readonly order: Uint16Array;
  private readonly start = new Int32Array(BUCKETS + 1);
  private readonly fill = new Int32Array(BUCKETS);

  constructor(private readonly cap = 2048) {
    this.x = new Float32Array(cap);
    this.y = new Float32Array(cap);
    this.vx = new Float32Array(cap);
    this.vy = new Float32Array(cap);
    this.life = new Float32Array(cap);
    this.maxLife = new Float32Array(cap);
    this.size = new Float32Array(cap);
    this.kind = new Uint8Array(cap);
    this.color = new Uint8Array(cap);
    this.bucketOf = new Uint16Array(cap);
    this.order = new Uint16Array(cap);
  }

  /** Positions and sizes are in tiles; velocities in tiles per second. */
  emit(kind: number, x: number, y: number, vx: number, vy: number, life: number, size: number, color: number): void {
    if (this.count === this.cap) return; // pool full: drop the effect
    const i = this.count++;
    this.x[i] = x; this.y[i] = y; this.vx[i] = vx; this.vy[i] = vy;
    this.life[i] = life; this.maxLife[i] = life; this.size[i] = size;
    this.kind[i] = kind; this.color[i] = color;
  }

  /** A burst of `n` particles in random directions. */
  burst(kind: number, x: number, y: number, n: number, speed: number, life: number, size: number, color: number, colorSpread = 1): void {
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2;
      const s = speed * (0.4 + Math.random() * 0.6);
      this.emit(kind, x, y, Math.cos(a) * s, Math.sin(a) * s, life * (0.6 + Math.random() * 0.4), size,
        color + Math.floor(Math.random() * colorSpread));
    }
  }

  /** Moves particle `j` into slot `i`. */
  private move(j: number, i: number): void {
    this.x[i] = this.x[j]; this.y[i] = this.y[j]; this.vx[i] = this.vx[j]; this.vy[i] = this.vy[j];
    this.life[i] = this.life[j]; this.maxLife[i] = this.maxLife[j]; this.size[i] = this.size[j];
    this.kind[i] = this.kind[j]; this.color[i] = this.color[j];
  }

  update(dt: number): void {
    const { x, y, vx, vy, life, kind } = this;
    let i = 0;
    while (i < this.count) {
      life[i] -= dt;
      if (life[i] <= 0) {
        // Swap-remove: the last live particle takes this slot (and is
        // updated on the next pass of the loop).
        this.move(--this.count, i);
        continue;
      }
      const k = kind[i];
      if (k === P_DEBRIS) vy[i] += 9 * dt;
      else if (k === P_SMOKE) { vy[i] -= 0.6 * dt; vx[i] *= 0.98; }
      else if (k === P_SPARK) { vx[i] *= 0.94; vy[i] *= 0.94; }
      else if (k === P_CURSE) { const t = life[i] * 6; vx[i] = Math.cos(t) * 0.6; vy[i] -= 0.3 * dt; }
      x[i] += vx[i] * dt;
      y[i] += vy[i] * dt;
      i++;
    }
  }

  /** Opacity of particle `i` (0..1), as the shapes below draw it. */
  private alpha(i: number): number {
    const k = this.kind[i], t = this.life[i] / this.maxLife[i];
    if (k === P_STAR) return t * (0.6 + 0.4 * Math.sin(this.life[i] * 30));
    if (k === P_SMOKE) return t * (this.pixel ? 0.5 : 0.55);
    if (k === P_DEBRIS) return Math.min(1, t * 2);
    return k === P_CURSE ? t * 0.8 : t;
  }

  /** Adds particle `i`'s shape to the current path. */
  private shape(ctx: CanvasRenderingContext2D, i: number, camX: number, camY: number, T: number): void {
    const k = this.kind[i], life = this.life[i], t = life / this.maxLife[i], size = this.size[i];
    const px = this.x[i] * T - camX, py = this.y[i] * T - camY;
    if (this.pixel) {
      // Pixel art: squares snapped to the art-pixel grid (16 per tile),
      // sized in whole art pixels, so effects match the sprites.
      const u = T / 16;
      const cx = Math.round(px / u) * u, cy = Math.round(py / u) * u;
      if (k === P_STAR) {
        // A plus sign that twinkles.
        const n = t > 0.5 ? 2 : 1;
        ctx.rect(cx - u / 2, cy - (n + 0.5) * u, u, (2 * n + 1) * u);
        ctx.rect(cx - (n + 0.5) * u, cy - u / 2, (2 * n + 1) * u, u);
        return;
      }
      let n: number;
      if (k === P_SMOKE) n = size * 16 * (1.6 - t) * 1.4;
      else if (k === P_DEBRIS) n = size * 16;
      else n = size * 16 * (k === P_SPARK ? t : 1) * 1.6;
      const s = Math.max(1, Math.round(n)) * u;
      ctx.rect(cx - s / 2, cy - s / 2, s, s);
      return;
    }
    if (k === P_SMOKE) {
      const r = size * T * (1.6 - t);
      ctx.moveTo(px + r, py);
      ctx.arc(px, py, r, 0, 6.2832);
    } else if (k === P_DEBRIS) {
      const s = size * T;
      ctx.rect(px - s / 2, py - s / 2, s, s);
    } else if (k === P_STAR) {
      const s = size * T * (0.5 + t);
      ctx.rect(px - s / 2, py - s / 8, s, s / 4);
      ctx.rect(px - s / 8, py - s / 2, s / 4, s);
    } else {
      const r = Math.max(0.5, size * T * (k === P_SPARK ? t : 1));
      ctx.moveTo(px + r, py);
      ctx.arc(px, py, r, 0, 6.2832);
    }
  }

  /**
   * Normal-blended particles first, then additive ones (sparks, stars). Each
   * (colour, opacity level) group is filled as a single path; particles off
   * screen are skipped.
   */
  draw(ctx: CanvasRenderingContext2D, camX: number, camY: number, T: number): void {
    const n = this.count;
    if (n === 0) return;
    const { bucketOf, order, start, fill, kind, color, x, y } = this;
    const W = ctx.canvas.width, H = ctx.canvas.height, m = T * 2;
    // Counting sort of the visible particles by bucket.
    start.fill(0);
    for (let i = 0; i < n; i++) {
      const px = x[i] * T - camX, py = y[i] * T - camY;
      if (px < -m || py < -m || px > W + m || py > H + m) { bucketOf[i] = NONE; continue; }
      const k = kind[i];
      const add = k === P_SPARK || k === P_STAR ? 1 : 0;
      const a = this.alpha(i);
      const level = Math.max(0, Math.min(LEVELS - 1, Math.round(a * LEVELS) - 1));
      if (a <= 0.5 / LEVELS) { bucketOf[i] = NONE; continue; } // invisible
      const b = (add * COLORS.length + color[i]) * LEVELS + level;
      bucketOf[i] = b;
      start[b + 1]++;
    }
    for (let b = 0; b < BUCKETS; b++) { start[b + 1] += start[b]; fill[b] = start[b]; }
    for (let i = 0; i < n; i++) if (bucketOf[i] !== NONE) order[fill[bucketOf[i]]++] = i;

    let blend = 0;
    for (let b = 0; b < BUCKETS; b++) {
      const s0 = start[b], s1 = start[b + 1];
      if (s0 === s1) continue;
      const add = b >= COLORS.length * LEVELS ? 1 : 0;
      if (add !== blend) { blend = add; ctx.globalCompositeOperation = 'lighter'; }
      ctx.fillStyle = COLORS[Math.floor(b / LEVELS) % COLORS.length];
      ctx.globalAlpha = ((b % LEVELS) + 1) / LEVELS;
      ctx.beginPath();
      for (let j = s0; j < s1; j++) this.shape(ctx, order[j], camX, camY, T);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }
}
