// Snapped marks for pixel mode: rings, ovals and dashed rectangles made of
// art-pixel squares, plus a tint cache for white sprites.

import { context2d, makeCanvas } from '../dom.js';
import { N } from '../pixelkit.js';

/** A pixel flag: grey pole plus cloth tinted to `color`. `(x, y)` is the pole's foot. */
export function drawPixelFlag(ctx: CanvasRenderingContext2D, pole: HTMLCanvasElement, cloth: readonly HTMLCanvasElement[], x: number, y: number, h: number, color: string, sec: number): void {
  const frame = tintOf(cloth[Math.floor(sec * 6) % cloth.length], color);
  const s = h * 1.35;
  ctx.drawImage(pole, x - s * 0.28, y - s * 0.92, s, s);
  ctx.drawImage(frame, x - s * 0.28, y - s * 0.92, s, s);
}

/** One art pixel in screen pixels at the current tile size. */
export const artPx = (T: number): number => Math.max(1, Math.round(T / N));

const tinted = new WeakMap<HTMLCanvasElement, Map<string, HTMLCanvasElement>>();

/** `src` recoloured to `color`, keeping its alpha. */
export function tintOf(src: HTMLCanvasElement, color: string): HTMLCanvasElement {
  let m = tinted.get(src);
  if (!m) tinted.set(src, m = new Map());
  let c = m.get(color);
  if (!c) {
    c = makeCanvas(src.width, src.height);
    const g = context2d(c);
    g.drawImage(src, 0, 0);
    g.globalCompositeOperation = 'source-in';
    g.fillStyle = color;
    g.fillRect(0, 0, c.width, c.height);
    m.set(color, c);
  }
  return c;
}

/** A circle of squares. `gap` skips every other step when greater than 0. */
export function pixelRing(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string, T: number, gap = 0): void {
  const u = artPx(T);
  const n = Math.max(8, Math.round((2 * Math.PI * Math.max(r, u)) / (u * (gap ? 1.6 : 1))));
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    if (gap && i % 2 === 1) continue;
    const a = (i / n) * Math.PI * 2;
    const x = Math.round((cx + Math.cos(a) * r) / u) * u;
    const y = Math.round((cy + Math.sin(a) * r) / u) * u;
    ctx.rect(x, y, u, u);
  }
  ctx.fill();
}

/** A filled oval of squares, or just its rim when `ring` is set. */
export function pixelOval(ctx: CanvasRenderingContext2D, cx: number, cy: number, rx: number, ry: number, color: string, T: number, ring = false): void {
  const u = artPx(T);
  const nx = Math.max(1, Math.ceil(rx / u)), ny = Math.max(1, Math.ceil(ry / u));
  const ox = Math.round(cx / u) * u, oy = Math.round(cy / u) * u;
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let iy = -ny; iy <= ny; iy++) {
    for (let ix = -nx; ix <= nx; ix++) {
      const k = (ix * u / rx) ** 2 + (iy * u / ry) ** 2;
      if (k <= 1 && (!ring || k >= 0.45)) ctx.rect(ox + ix * u, oy + iy * u, u, u);
    }
  }
  ctx.fill();
}

/** A rectangle outline of squares. `phase` walks the gaps. */
export function pixelDashRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, color: string, T: number, phase = 0): void {
  const u = artPx(T);
  ctx.fillStyle = color;
  ctx.beginPath();
  const span = 2 * (Math.round(w / u) + Math.round(h / u));
  const on = 2, off = 2;
  for (let i = 0; i < span; i++) {
    if ((i + phase) % (on + off) >= on) continue;
    const d = i;
    const W = Math.round(w / u), H = Math.round(h / u);
    let ix: number, iy: number;
    if (d < W) { ix = d; iy = 0; }
    else if (d < W + H) { ix = W; iy = d - W; }
    else if (d < W + H + W) { ix = W - (d - W - H); iy = H; }
    else { ix = 0; iy = H - (d - 2 * W - H); }
    ctx.rect(Math.round(x / u) * u + ix * u, Math.round(y / u) * u + iy * u, u, u);
  }
  ctx.fill();
}
