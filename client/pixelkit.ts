// Shared toolkit for the pixel-art generators (tiles in pixelart.ts,
// sprites in pixelsprites.ts): a 16x16 pixel buffer, seeded randomness,
// seamless noise, ordered dithering, and the shared lighting conventions.
// Light comes from the top left; ramps run dark to light and shift hue.

import { context2d, makeCanvas } from './dom.js';

export const N = 16;
/** Scale of sprites drawn straight onto the game canvas (see `Pix.canvas`). */
export const X4 = 4;

/** A seeded random source returning values in 0..1. */
export type Rand = () => number;
/** A colour as '#rrggbb' or '#rrggbbaa'; falsy values paint nothing. */
export type Hex = string | null | undefined | false;
/** A 16x16 scalar field (see `field`). */
export type Field = Float32Array;
export type Plot = (x: number, y: number, i?: number) => void;

/** Translucent cool shadow: tints instead of blackening what it covers. */
export const SHADOW = '#140c2e66';
export const STEEL = ['#16181f', '#272b36', '#3c4352', '#5a6475', '#808ca0', '#aeb9c9', '#e1e8f0'];
export const LAVA = ['#5c140e', '#a8281a', '#e8541c', '#ff9a2e', '#ffd66b', '#fff4c2'];

// ------------------------------------------------------------------- basics

export function rng(seed: number): Rand {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const wrap = (v: number): number => ((v % N) + N) % N;
export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smooth = (t: number): number => t * t * (3 - 2 * t);
export const int = (rand: Rand, n: number): number => Math.floor(rand() * n);

const rgbCache = new Map<string, readonly number[]>();
/** '#rrggbb' or '#rrggbbaa' as [r, g, b, a]. */
export function rgb(hex: string): readonly number[] {
  let c = rgbCache.get(hex);
  if (!c) {
    const n = parseInt(hex.slice(1), 16);
    c = hex.length === 9
      ? [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
      : [(n >>> 16) & 255, (n >>> 8) & 255, n & 255, 255];
    rgbCache.set(hex, c);
  }
  return c;
}

/** A 16x16 RGBA pixel buffer. */
export class Pix {
  d: Uint8ClampedArray;

  constructor() {
    this.d = new Uint8ClampedArray(N * N * 4);
  }

  set(x: number, y: number, hex: Hex): void {
    if (x < 0 || y < 0 || x >= N || y >= N || !hex) return;
    const c = rgb(hex), i = (y * N + x) * 4;
    this.d[i] = c[0]; this.d[i + 1] = c[1]; this.d[i + 2] = c[2]; this.d[i + 3] = c[3];
  }

  /** Sets a pixel, wrapping around the edges (for seamless floors). */
  wset(x: number, y: number, hex: Hex): void {
    this.set(wrap(x), wrap(y), hex);
  }

  filled(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < N && y < N && this.d[(y * N + x) * 4 + 3] > 0;
  }

  /**
   * The pixels as a canvas, optionally scaled up with hard edges. Sprites
   * drawn straight onto the game canvas use a 4x copy so that the browser's
   * smoothing, when it scales them to the tile size, stays crisp.
   */
  canvas(scale = 1): HTMLCanvasElement {
    const c = makeCanvas(N);
    context2d(c).putImageData(new ImageData(new Uint8ClampedArray(this.d), N, N), 0, 0);
    if (scale === 1) return c;
    const big = makeCanvas(N * scale);
    const g = context2d(big);
    g.imageSmoothingEnabled = false;
    g.drawImage(c, 0, 0, N * scale, N * scale);
    return big;
  }
}

// 4x4 ordered dither, centred on zero.
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
export const bayer = (x: number, y: number): number => BAYER[(y & 3) * 4 + (x & 3)] / 16 - 0.46875;

/**
 * Picks a ramp colour for a value in 0..1, mapped onto ramp[lo..hi].
 * Ordered dithering softens the steps between shades.
 */
export function pick(ramp: readonly string[], v: number, x: number, y: number, lo = 0, hi = ramp.length - 1, dither = 1): string {
  const k = lo + v * (hi - lo) + bayer(x, y) * dither;
  return ramp[clamp(Math.round(k), lo, hi)];
}

/**
 * Seamless value noise on the 16x16 torus: octaves of [cells, weight],
 * normalised to 0..1. Wrapping the lattice makes every tile tile.
 */
export function field(rand: Rand, octaves: readonly (readonly [number, number])[] = [[2, 0.5], [4, 0.3], [8, 0.2]]): Field {
  const out = new Float32Array(N * N);
  for (const [L, w] of octaves) {
    const g = Array.from({ length: L * L }, rand);
    const cell = N / L;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const fx = x / cell, fy = y / cell;
        const ix = Math.floor(fx), iy = Math.floor(fy);
        const tx = smooth(fx - ix), ty = smooth(fy - iy);
        const x1 = (ix + 1) % L, y1 = (iy + 1) % L;
        const top = lerp(g[iy * L + ix], g[iy * L + x1], tx);
        const bottom = lerp(g[y1 * L + ix], g[y1 * L + x1], tx);
        out[y * N + x] += w * lerp(top, bottom, ty);
      }
    }
  }
  let lo = Infinity, hi = -Infinity;
  for (const v of out) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  for (let i = 0; i < out.length; i++) out[i] = (out[i] - lo) / (hi - lo || 1);
  return out;
}

export const at = (f: ArrayLike<number>, x: number, y: number): number => f[wrap(y) * N + wrap(x)];
/** Slope towards the light: positive where the surface faces the top left. */
export const relief = (f: ArrayLike<number>, x: number, y: number): number => at(f, x + 1, y + 1) - at(f, x - 1, y - 1);

/** Pixels on a straight line, inclusive. */
export function line(x0: number, y0: number, x1: number, y1: number, plot: Plot): void {
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    plot(x0, y0);
    if (x0 === x1 && y0 === y1) return;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

/** A wandering crack of `len` steps, heading mostly down and right. */
export function crack(rand: Rand, x: number, y: number, len: number, plot: Plot): void {
  for (let i = 0; i < len; i++) {
    plot(x, y, i);
    const r = rand();
    if (r < 0.45) x++;
    else if (r < 0.9) y++;
    else { x++; y++; }
  }
}

/** Blends two '#rrggbb' colours: t = 0 gives `a`, 1 gives `b`. */
export function mix(a: string, b: string, t: number): string {
  const ca = rgb(a), cb = rgb(b);
  const h = (i: number): string => Math.round(lerp(ca[i], cb[i], t)).toString(16).padStart(2, '0');
  return `#${h(0)}${h(1)}${h(2)}`;
}

let probeCtx: CanvasRenderingContext2D | null = null;
/** Any CSS colour (hsl(), color-mix(), names) as '#rrggbb'. */
export function cssColor(css: string): string {
  const probe = (probeCtx ??= context2d(makeCanvas(1), { willReadFrequently: true }));
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = '#000';
  probe.fillStyle = css;
  probe.fillRect(0, 0, 1, 1);
  const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

/**
 * Paints a bitmap: one string per row, one character per pixel, coloured
 * through `colors` (a space is transparent). `flip` mirrors it.
 */
export function bitmap(p: Pix, rows: readonly string[], colors: Record<string, Hex>, ox = 0, oy = 0, flip = false): void {
  const w = Math.max(...rows.map((r) => r.length));
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const c = row[x];
      if (c !== ' ') p.set(ox + (flip ? w - 1 - x : x), oy + y, colors[c]);
    }
  });
}
