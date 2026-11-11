// Overlays composed per cell: block shadows and soft biome borders.

import { N, Pix, rng, SHADOW } from '../pixelkit.js';

// ---------------------------------------------------------------- overlays

/**
 * Shadow a raised neighbour casts on a floor cell. Bits of `mask`: 1 = a
 * block to the north, 2 = to the west, 4 = to the north-west. Coverage is
 * combined before painting, so overlapping shadows never double up.
 */
export function shadow(mask: number) {
  const p = new Pix();
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let cov = 0; // 3 = solid, 2 and 1 = dithered fringe, denser to sparser
      const fall = (d: number, across: number) => (d <= 4 ? (across <= 1 ? 2 : 3) : d === 5 ? 2 : d === 6 ? 1 : 0);
      if (mask & 1) cov = Math.max(cov, fall(y, x));
      if (mask & 2) cov = Math.max(cov, fall(x, y));
      if (mask & 4) cov = Math.max(cov, x <= 4 && y <= 4 ? 3 : 0);
      if (cov === 3 || (cov === 2 && (x + y) % 2 === 0) || (cov === 1 && x % 2 === 0 && y % 2 === 0)) p.set(x, y, SHADOW);
    }
  }
  return p;
}

/**
 * A neighbouring biome's floor spilling over one edge of a cell, with a
 * wavy, seamless border line. `dir`: 0 north, 1 east, 2 south, 3 west.
 */
export function fringe(source: Pix, border: string, dir: number, seed: number) {
  const rand = rng(seed), p = new Pix();
  const a = rand() * Math.PI * 2, b = rand() * Math.PI * 2;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const along = dir % 2 === 0 ? x : y;
      const dist = [y, N - 1 - x, N - 1 - y, x][dir];
      // Whole waves per tile, so neighbouring cells on the same border line up.
      const depth = 3.6 + 1.8 * Math.sin((2 * Math.PI * along) / N + a) + 1.2 * Math.sin((6 * Math.PI * along) / N + b) + 0.5 * Math.sin((10 * Math.PI * along) / N + a * 2);
      if (dist < depth - 1) {
        const i = (y * N + x) * 4, s = source.d;
        p.d[i] = s[i]; p.d[i + 1] = s[i + 1]; p.d[i + 2] = s[i + 2]; p.d[i + 3] = 255;
      } else if (dist < depth) {
        p.set(x, y, border);
      }
    }
  }
  return p;
}
