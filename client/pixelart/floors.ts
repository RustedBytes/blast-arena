// Seamless floors per biome: meadow grass, snow, desert sand, volcanic ash
// and dungeon flagstones.

import { at, crack, field, int, LAVA, N, pick, Pix, relief, rng, wrap } from '../pixelkit.js';
import { ASH, FLAGSTONE, FLOWERS, GRASS, SAND, SANDSTONE, SNOW, STONE } from './palette.js';

// ------------------------------------------------------------------- floors

/** Meadow grass. Kind 0: tufts; 1: pebbles and clover; 2: wildflowers. */
export function grass(seed: number, kind: number) {
  const rand = rng(seed), f = field(rand), p = new Pix();
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      p.set(x, y, pick(GRASS, at(f, x, y) * 0.8 + relief(f, x, y) * 0.9 + 0.1, x, y, 2, 4, 0.8));
    }
  }
  if (kind === 1) {
    // A darker clover patch and a couple of pebbles.
    const cx = int(rand, N), cy = int(rand, N);
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [-1, 0], [0, -1], [2, 1], [1, 2]]) p.wset(cx + dx, cy + dy, GRASS[2]);
    p.wset(cx, cy - 1, GRASS[4]);
    for (let i = 0; i < 2; i++) pebble(p, int(rand, N), int(rand, N), STONE, GRASS[1]);
  }
  for (let i = 0, n = kind === 0 ? 7 : 4; i < n; i++) tuft(p, int(rand, N), int(rand, N));
  if (kind === 2) {
    for (let i = 0; i < 3; i++) {
      const [petal, heart] = FLOWERS[int(rand, FLOWERS.length)];
      const x = int(rand, N), y = int(rand, N);
      p.wset(x + 1, y + 1, GRASS[1]);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) p.wset(x + dx, y + dy, petal);
      p.wset(x, y, heart);
    }
  }
  return p;
}

/** A little three-blade tuft, lit on its tips. */
function tuft(p: Pix, x: number, y: number) {
  p.wset(x, y + 1, GRASS[1]);
  p.wset(x + 1, y + 1, GRASS[1]);
  p.wset(x - 1, y, GRASS[4]);
  p.wset(x, y, GRASS[3]);
  p.wset(x + 1, y, GRASS[4]);
  p.wset(x - 1, y - 1, GRASS[5]);
  p.wset(x + 1, y - 1, GRASS[6]);
  p.wset(x, y - 2, GRASS[6]);
}

/** A 2x2 pebble with a highlight and a cast shadow. */
function pebble(p: Pix, x: number, y: number, ramp: readonly string[], shadow: string) {
  p.wset(x + 2, y + 1, shadow);
  p.wset(x + 1, y + 2, shadow);
  p.wset(x + 2, y + 2, shadow);
  p.wset(x, y, ramp[ramp.length - 2]);
  p.wset(x + 1, y, ramp[ramp.length - 3]);
  p.wset(x, y + 1, ramp[ramp.length - 3]);
  p.wset(x + 1, y + 1, ramp[ramp.length - 4]);
}

/** Wind-sculpted snow. Kind 1 adds a trail of little footprints. */
export function snow(seed: number, kind: number) {
  const rand = rng(seed), f = field(rand, [[2, 0.6], [4, 0.3], [8, 0.1]]), p = new Pix();
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      p.set(x, y, pick(SNOW, 0.55 + relief(f, x, y) * 2.2 + (at(f, x, y) - 0.5) * 0.3, x, y, 2, 5, 0.9));
    }
  }
  if (kind === 1) {
    const x = int(rand, N), y = int(rand, N);
    for (let k = 0; k < 5; k++) p.wset(x + k * 3, y + (k % 2) * 2, SNOW[2]);
  }
  // Glints catch the light.
  for (let i = 0; i < 3; i++) {
    const x = int(rand, N), y = int(rand, N);
    p.wset(x, y, '#ffffff');
    p.wset(x + 1, y + 1, '#b8ecff');
  }
  return p;
}

/** Desert sand with wind ripples. Kind 1 has a dry sprig instead of pebbles. */
export function sand(seed: number, kind: number) {
  const rand = rng(seed), f = field(rand), p = new Pix();
  const phase = rand() * Math.PI * 2;
  // Integer frequencies along x and y keep the ripples seamless.
  const h = (x: number, y: number) => Math.sin((2 * Math.PI * (x + 3 * y)) / N + phase + at(f, x, y) * 3);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const lit = h(x + 1, y + 1) - h(x - 1, y - 1);
      p.set(x, y, pick(SAND, 0.5 + lit * 0.3 + (at(f, x, y) - 0.5) * 0.3, x, y, 1, 5, 0.7));
    }
  }
  if (kind === 1) {
    const x = int(rand, N), y = int(rand, N);
    p.wset(x + 1, y + 1, SAND[1]);
    p.wset(x, y, '#7d6a2c');
    p.wset(x - 1, y - 1, '#a8963f');
    p.wset(x + 1, y - 1, '#a8963f');
    p.wset(x, y - 2, '#c9b45a');
  } else {
    for (let i = 0; i < 2; i++) pebble(p, int(rand, N), int(rand, N), SANDSTONE, SAND[1]);
  }
  return p;
}

/**
 * Volcanic basalt: cooled columns (a seamless Voronoi pattern on the
 * torus). Kind 0, the common one, is calm with a few loose embers; kind 1
 * has lava glowing in one crack.
 */
export function ash(seed: number, kind: number) {
  const rand = rng(seed), lavaF = field(rand), p = new Pix();
  const pts = Array.from({ length: 6 }, () => [rand() * N, rand() * N, rand()]);
  const edge = new Uint8Array(N * N), cell = new Float32Array(N * N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let d1 = Infinity, d2 = Infinity, tone = 0;
      for (const [px, py, t] of pts) {
        const dx = Math.min(Math.abs(x - px), N - Math.abs(x - px));
        const dy = Math.min(Math.abs(y - py), N - Math.abs(y - py));
        const d = Math.hypot(dx, dy);
        if (d < d1) { d2 = d1; d1 = d; tone = t; } else if (d < d2) d2 = d;
      }
      edge[y * N + x] = d2 - d1 < 1.1 ? 1 : 0;
      cell[y * N + x] = tone;
    }
  }
  const isEdge = (x: number, y: number) => edge[wrap(y) * N + wrap(x)] === 1;
  const lavaAt = kind === 0 ? 2 : 0.84;
  const isLava = (x: number, y: number) => isEdge(x, y) && at(lavaF, x, y) > lavaAt;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (isLava(x, y)) {
        p.set(x, y, at(lavaF, x, y) > lavaAt + 0.08 ? LAVA[3] : LAVA[2]);
      } else if (isEdge(x, y)) {
        p.set(x, y, ASH[0]);
      } else if (isLava(x - 1, y) || isLava(x + 1, y) || isLava(x, y - 1) || isLava(x, y + 1)) {
        p.set(x, y, '#6b2a22'); // lava light on the rock
      } else if (isEdge(x - 1, y) || isEdge(x, y - 1)) {
        p.set(x, y, ASH[4]); // top-left rim of a column catches the light
      } else if (isEdge(x + 1, y) || isEdge(x, y + 1)) {
        p.set(x, y, ASH[1]);
      } else {
        p.set(x, y, pick(ASH, cell[y * N + x] * 0.6 + (at(lavaF, x, y) - 0.5) * 0.3 + 0.2, x, y, 2, 4, 0.6));
      }
    }
  }
  if (kind === 0) {
    for (let i = 0; i < 2; i++) p.wset(int(rand, N), int(rand, N), LAVA[2]);
  }
  return p;
}

/**
 * Dungeon flagstones: worn slabs in staggered courses with dark joints.
 * Kind 1 has a crack and a scatter of bone; kind 2 a patch of damp moss.
 */
export function crypt(seed: number, kind: number) {
  const rand = rng(seed), f = field(rand), p = new Pix();
  // Two courses of 8 rows; the lower course is shifted half a slab.
  const slab = (x: number, y: number): number => {
    const row = Math.floor(wrap(y) / 8);
    return row * 2 + Math.floor(wrap(x + row * 4) / 8);
  };
  const tone = [rand(), rand(), rand(), rand()];
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const joint = wrap(y) % 8 === 7 || wrap(x + Math.floor(wrap(y) / 8) * 4) % 8 === 7;
      if (joint) {
        p.set(x, y, FLAGSTONE[1]);
        continue;
      }
      // Slab edges catch the light top-left and fall into shade bottom-right.
      const rimTop = wrap(y - 1) % 8 === 7 || wrap(x - 1 + Math.floor(wrap(y) / 8) * 4) % 8 === 7;
      const v = 0.45 + tone[slab(x, y)] * 0.2 + relief(f, x, y) * 0.7 + (at(f, x, y) - 0.5) * 0.2 + (rimTop ? 0.14 : 0);
      p.set(x, y, pick(FLAGSTONE, v, x, y, 3, 5, 0.6));
    }
  }
  if (kind === 1) {
    crack(rand, 2 + int(rand, 6), 1 + int(rand, 4), 6, (x: number, y: number) => p.wset(x, y, FLAGSTONE[1]));
    // A little bone and a skull-pale pebble.
    const bx = int(rand, N), by = int(rand, N);
    for (let k = 0; k < 3; k++) p.wset(bx + k, by, '#cfc6ae');
    p.wset(bx - 1, by - 1, '#cfc6ae');
    p.wset(bx - 1, by + 1, '#cfc6ae');
    p.wset(bx + 3, by - 1, '#cfc6ae');
    p.wset(bx + 3, by + 1, '#cfc6ae');
    p.wset(bx + 1, by + 1, FLAGSTONE[1]);
  }
  if (kind === 2) {
    const mx = int(rand, N), my = int(rand, N);
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -3; dx <= 3; dx++) {
        if (dx * dx / 9 + dy * dy / 4 <= 1 && rand() < 0.7) p.wset(mx + dx, my + dy, rand() < 0.5 ? '#25402e' : '#2f5236');
      }
    }
  }
  return p;
}
