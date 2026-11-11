// Blood drops left behind by wounded players (the dungeon arena): a small
// ring buffer of splats on the floor that darken and fade over a few seconds.

/** How many drops are kept, and how long one lasts (ms). */
const DROPS = 384;
const LIFE = 6000;

export class BloodTrail {
  private readonly x = new Float32Array(DROPS);
  private readonly y = new Float32Array(DROPS);
  private readonly t = new Float64Array(DROPS).fill(-1e9);
  /** Size of each drop, as a fraction of a tile. */
  private readonly r = new Float32Array(DROPS);
  private head = 0;

  /** A drop near (x, y), in tiles. */
  add(x: number, y: number, now: number): void {
    const i = this.head;
    this.x[i] = x + (Math.random() - 0.5) * 0.35;
    this.y[i] = y + (Math.random() - 0.5) * 0.25;
    this.t[i] = now;
    this.r[i] = 0.04 + Math.random() * 0.05;
    this.head = (i + 1) % DROPS;
  }

  /** Forgets every drop (a new map). */
  reset(): void {
    this.t.fill(-1e9);
  }

  draw(ctx: CanvasRenderingContext2D, now: number, camX: number, camY: number, T: number, W: number, H: number): void {
    for (let i = 0; i < DROPS; i++) {
      const age = now - this.t[i];
      if (age >= LIFE || age < 0) continue;
      const px = this.x[i] * T - camX, py = this.y[i] * T - camY;
      if (px < -T || py < -T || px > W + T || py > H + T) continue;
      const k = age / LIFE;
      // Fresh blood is bright; it dries darker, then fades.
      ctx.fillStyle = k < 0.25 ? '#b3121e' : '#6e0b12';
      ctx.globalAlpha = 0.85 * (1 - k * k);
      const r = this.r[i] * T;
      ctx.beginPath();
      ctx.ellipse(px, py, r * 1.3, r, 0, 0, 6.2832);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}
