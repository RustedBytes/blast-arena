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
      let cov = 0; // 2 = solid, 1 = dithered fringe
      if (mask & 1) cov = Math.max(cov, y <= 2 ? (x === 0 ? 1 : 2) : y === 3 ? 1 : 0);
      if (mask & 2) cov = Math.max(cov, x <= 2 ? (y === 0 ? 1 : 2) : x === 3 ? 1 : 0);
      if (mask & 4) cov = Math.max(cov, x <= 2 && y <= 2 ? 2 : 0);
      if (cov === 2 || (cov === 1 && (x + y) % 2 === 0)) p.set(x, y, SHADOW);
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
      const depth = 1.8 + 0.9 * Math.sin((2 * Math.PI * along) / N + a) + 0.6 * Math.sin((6 * Math.PI * along) / N + b);
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
