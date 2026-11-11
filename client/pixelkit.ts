// Shared toolkit for the pixel-art generators (tiles in pixelart.ts,
// sprites in pixelsprites.ts): a 32x32 pixel buffer, seeded randomness,
// seamless noise, ordered dithering, and the shared lighting conventions.
// Light comes from the top left; ramps run dark to light and shift hue.
//
// The art is drawn at 32x32 per tile ("HD" pixel art): enough resolution
// for real form shading, selective outlines (sel-out) and small details,
// while every pixel stays a deliberate, hard-edged square. `shape` paints
// lit volumes from signed distance fields, `outline` wraps a finished
// sprite in a hue-aware outline.

import { context2d, makeCanvas } from './dom.js';

/** Art pixels per tile side. */
export const N = 32;
/** Scale of sprites drawn straight onto the game canvas (see `Pix.canvas`). */
export const UP = 2;

/** A seeded random source returning values in 0..1. */
export type Rand = () => number;
/** A colour as '#rrggbb' or '#rrggbbaa'; falsy values paint nothing. */
export type Hex = string | null | undefined | false;
/** An NxN scalar field (see `field`). */
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

/** An NxN RGBA pixel buffer. */
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

  /** Is (x, y) fully opaque (not empty and not a translucent shadow)? */
  solid(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < N && y < N && this.d[(y * N + x) * 4 + 3] === 255;
  }

  /** The colour at (x, y) as '#rrggbb' (alpha dropped). */
  get(x: number, y: number): string {
    const i = (wrap(y) * N + wrap(x)) * 4, d = this.d;
    return '#' + [d[i], d[i + 1], d[i + 2]].map((v) => v.toString(16).padStart(2, '0')).join('');
  }

  /** Clears a pixel. */
  clear(x: number, y: number): void {
    if (x < 0 || y < 0 || x >= N || y >= N) return;
    this.d[(y * N + x) * 4 + 3] = 0;
  }

  /**
   * The pixels as a canvas, optionally scaled up with hard edges. Sprites
   * drawn straight onto the game canvas use a 2x copy so that the browser's
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
 * Seamless value noise on the NxN torus: octaves of [cells, weight],
 * normalised to 0..1. Wrapping the lattice makes every tile tile.
 */
export function field(rand: Rand, octaves: readonly (readonly [number, number])[] = [[2, 0.45], [4, 0.28], [8, 0.17], [16, 0.1]]): Field {
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

// --------------------------------------------------------------- HD painting

/** A signed distance: negative inside a shape, in art pixels. */
export type Sdf = (x: number, y: number) => number;

/** Light direction (towards the light): from the top left, a little in front. */
const LIGHT = ((): readonly number[] => {
  const v = [-0.5, -0.66, 0.56], l = Math.hypot(v[0], v[1], v[2]);
  return v.map((c) => c / l);
})();

export const sdCircle = (cx: number, cy: number, r: number): Sdf => (x, y) => Math.hypot(x - cx, y - cy) - r;
/** An ellipse (approximate distance, exact on the axes; good enough to shade). */
export const sdEllipse = (cx: number, cy: number, rx: number, ry: number): Sdf => (x, y) => {
  const k = Math.hypot((x - cx) / rx, (y - cy) / ry);
  return (k - 1) * Math.min(rx, ry);
};
/** A box centred at (cx, cy) with half-sizes hx, hy and corner radius r. */
export const sdBox = (cx: number, cy: number, hx: number, hy: number, r = 0): Sdf => (x, y) => {
  const qx = Math.abs(x - cx) - hx + r, qy = Math.abs(y - cy) - hy + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};
/** A capsule from (ax, ay) to (bx, by) with radius r. */
export const sdCapsule = (ax: number, ay: number, bx: number, by: number, r: number): Sdf => (x, y) => {
  const px = x - ax, py = y - ay, dx = bx - ax, dy = by - ay;
  const h = clamp((px * dx + py * dy) / (dx * dx + dy * dy || 1), 0, 1);
  return Math.hypot(px - dx * h, py - dy * h) - r;
};
/** A capsule whose radius runs from ra at a to rb at b (a tapering limb). */
export const sdTaper = (ax: number, ay: number, bx: number, by: number, ra: number, rb: number): Sdf => (x, y) => {
  const px = x - ax, py = y - ay, dx = bx - ax, dy = by - ay;
  const h = clamp((px * dx + py * dy) / (dx * dx + dy * dy || 1), 0, 1);
  return Math.hypot(px - dx * h, py - dy * h) - lerp(ra, rb, h);
};
/** Union of shapes, smoothly blended over `k` pixels (0 = hard). */
export const sdUnion = (k: number, ...fs: Sdf[]): Sdf => (x, y) => {
  let d = fs[0](x, y);
  for (let i = 1; i < fs.length; i++) {
    const e = fs[i](x, y);
    if (k <= 0) { d = Math.min(d, e); continue; }
    const h = clamp(0.5 + 0.5 * (e - d) / k, 0, 1);
    d = lerp(e, d, h) - k * h * (1 - h);
  }
  return d;
};
/** Shape `a` with shape `b` cut away. */
export const sdCut = (a: Sdf, b: Sdf): Sdf => (x, y) => Math.max(a(x, y), -b(x, y));

export interface ShapeStyle {
  /** Ramp indices used for the shading (default 1 .. last). */
  lo?: number;
  hi?: number;
  /** How far in (pixels) the surface bends from its silhouette to face the viewer. */
  depth?: number;
  /** Overall brightness offset. */
  bias?: number;
  /** Light bounced up from the floor onto the bottom-right rim. */
  bounce?: number;
  /** Dither strength between shades (sprites keep it low for clean clusters). */
  dither?: number;
  /** Colour of the specular glint, where the surface faces the light. */
  spec?: Hex;
  /** How tightly the glint gathers (closer to 1 is smaller). */
  shine?: number;
  /** Paint only where this is true (clips the shape). */
  clip?: (x: number, y: number) => boolean;
}

/** How brightly a point of a shape is lit, 0..1, and how directly it faces the light. */
function lightAt(sdf: Sdf, X: number, Y: number, depth: number, bounce: number): [v: number, facing: number] {
  const d = sdf(X, Y);
  const gx = sdf(X + 0.5, Y) - sdf(X - 0.5, Y), gy = sdf(X, Y + 0.5) - sdf(X, Y - 0.5);
  const gl = Math.hypot(gx, gy) || 1;
  // 0 deep inside (facing the viewer) to 1 at the silhouette (side on).
  const tilt = 1 - clamp(-d / depth, 0, 1);
  const s = Math.sin(tilt * Math.PI / 2);
  const nx = (gx / gl) * s, ny = (gy / gl) * s, nz = Math.sqrt(Math.max(0, 1 - s * s));
  const lam = nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2];
  const rim = Math.max(0, (nx * 0.6 + ny * 0.8)) * s;
  return [clamp(0.16 + lam * 0.86 + rim * bounce, 0, 1), lam];
}

/**
 * Paints a lit volume: the inside of `sdf`, shaded from `ramp` as if it
 * bulged towards the viewer, lit from the top left, with bounced light on
 * the far rim and an optional specular glint.
 */
export function shape(p: Pix, sdf: Sdf, ramp: readonly string[], st: ShapeStyle = {}): void {
  const lo = st.lo ?? 1, hi = st.hi ?? ramp.length - 1;
  const depth = st.depth ?? 4, bounce = st.bounce ?? 0.35, dither = st.dither ?? 0.12, shine = st.shine ?? 0.975;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const X = x + 0.5, Y = y + 0.5;
      if (sdf(X, Y) > 0 || (st.clip && !st.clip(x, y))) continue;
      const [v, lam] = lightAt(sdf, X, Y, depth, bounce);
      p.set(x, y, st.spec && lam > shine ? st.spec : pick(ramp, clamp(v + (st.bias ?? 0), 0, 1), x, y, lo, hi, dither));
    }
  }
}

/** Fills the inside of `sdf` with one colour (or a colour per pixel). */
export function fill(p: Pix, sdf: Sdf, color: Hex | ((x: number, y: number) => Hex)): void {
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (sdf(x + 0.5, y + 0.5) <= 0) p.set(x, y, typeof color === 'function' ? color(x, y) : color);
    }
  }
}

/** A soft elliptical shadow on the ground, darker in the middle. */
export function groundShadow(p: Pix, cx: number, cy: number, rx: number, ry: number): void {
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const k = ((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2;
      if (k <= 0.45) p.set(x, y, '#140c2e80');
      else if (k <= 1) p.set(x, y, SHADOW);
    }
  }
}

/** Darkens towards a cool ink (shadows lean blue-purple). */
export const shadeOf = (hex: string, t: number): string => mix(hex.slice(0, 7), '#140a26', t);
/** Lightens towards a warm cream (highlights lean yellow). */
export const lightOf = (hex: string, t: number): string => mix(hex.slice(0, 7), '#fff6d8', t);

/**
 * Wraps every opaque region in a one-pixel selective outline: each outline
 * pixel is a darkened version of the colour it borders rather than flat
 * black, and lighter on the lit (top-left) side, so outlines read as the
 * edge of a lit form instead of a stroke. Only orthogonal neighbours count,
 * which keeps corners rounded. Translucent pixels (shadows) are covered.
 */
export function outline(p: Pix, dark = 0.72, lit = 0.5): void {
  const src = new Pix();
  src.d.set(p.d);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (src.solid(x, y)) continue;
      // Prefer the neighbour below or right: this pixel is then on the lit side.
      const litSide = src.solid(x, y + 1) || src.solid(x + 1, y);
      const nb = src.solid(x, y + 1) ? [x, y + 1] : src.solid(x + 1, y) ? [x + 1, y] : src.solid(x, y - 1) ? [x, y - 1] : src.solid(x - 1, y) ? [x - 1, y] : null;
      if (!nb) continue;
      p.set(x, y, shadeOf(src.get(nb[0], nb[1]), litSide ? lit : dark));
    }
  }
}

/**
 * Darkens pixels of `p` where they touch transparency on the bottom-right:
 * the inner edge of a form turning away from the light.
 */
export function innerShade(p: Pix, t = 0.25): void {
  const src = new Pix();
  src.d.set(p.d);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (!src.solid(x, y)) continue;
      if (!src.solid(x + 1, y) || !src.solid(x, y + 1)) p.set(x, y, shadeOf(src.get(x, y), t));
    }
  }
}

/** Paints a bitmap twice the size: each character becomes a 2x2 block. */
export function bitmap2(p: Pix, rows: readonly string[], colors: Record<string, Hex>, ox = 0, oy = 0, flip = false): void {
  const w = Math.max(...rows.map((r) => r.length));
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const c = row[x];
      if (c === ' ') continue;
      const bx = ox + (flip ? w - 1 - x : x) * 2, by = oy + y * 2;
      p.set(bx, by, colors[c]); p.set(bx + 1, by, colors[c]);
      p.set(bx, by + 1, colors[c]); p.set(bx + 1, by + 1, colors[c]);
    }
  });
}

/** A polygon (any winding); exact distance. */
export const sdPoly = (pts: readonly (readonly [number, number])[]): Sdf => (x, y) => {
  let d = Infinity, s = 1;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [ax, ay] = pts[j], [bx, by] = pts[i];
    const ex = bx - ax, ey = by - ay, wx = x - ax, wy = y - ay;
    const h = clamp((wx * ex + wy * ey) / (ex * ex + ey * ey || 1), 0, 1);
    d = Math.min(d, Math.hypot(wx - ex * h, wy - ey * h));
    const c1 = y >= ay, c2 = y < by, c3 = ex * wy > ey * wx;
    if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) s = -s;
  }
  return s * d;
};
/** A ring of radius r and half-thickness w. */
export const sdRing = (cx: number, cy: number, r: number, w: number, sy = 1): Sdf => (x, y) => Math.abs(Math.hypot(x - cx, (y - cy) / sy) - r) - w;

/** Composites `src` over `dst` (alpha blended). */
export function over(dst: Pix, src: Pix): void {
  const a = src.d, b = dst.d;
  for (let i = 0; i < a.length; i += 4) {
    const sa = a[i + 3] / 255;
    if (!sa) continue;
    const da = b[i + 3] / 255, oa = sa + da * (1 - sa);
    for (let k = 0; k < 3; k++) b[i + k] = (a[i + k] * sa + b[i + k] * da * (1 - sa)) / oa;
    b[i + 3] = oa * 255;
  }
}

/** A layer: paints into a fresh buffer, outlines it, and composites it onto `p`. */
export function layer(p: Pix, paint: (q: Pix) => void, dark = 0.72, lit = 0.5): void {
  const q = new Pix();
  paint(q);
  outline(q, dark, lit);
  over(p, q);
}
