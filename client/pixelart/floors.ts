// Seamless floors per biome at 32x32: meadow grass, snow, desert sand,
// volcanic ash, dungeon flagstones and the starfield deck plates of space.

import { at, crack, field, int, LAVA, N, pick, Pix, relief, rng, wrap } from '../pixelkit.js';
import type { Rand } from '../pixelkit.js';
import { ASH, DECK, FLAGSTONE, NEON, FLOWERS, GRASS, SAND, SANDSTONE, SNOW, STONE } from './palette.js';

// ------------------------------------------------------------------- floors

/** Meadow grass. Kind 0: tufts; 1: pebbles and clover; 2: wildflowers. */
export function grass(seed: number, kind: number) {
  const rand = rng(seed), f = field(rand), fine = field(rand, [[8, 0.4], [16, 0.6]]), p = new Pix();
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      // Broad light and shade from the large noise, blade texture from the fine.
      const v = at(f, x, y) * 0.7 + relief(f, x, y) * 1.2 + (at(fine, x, y) - 0.5) * 0.45 + 0.12;
      p.set(x, y, pick(GRASS, v, x, y, 2, 4, 0.7));
    }
  }
  if (kind === 1) {
    // A darker clover patch and a few pebbles.
    const cx = int(rand, N), cy = int(rand, N);
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [-1, 0], [0, -1], [2, 1], [1, 2], [3, 0], [3, 1], [-2, 2], [-1, 2]]) p.wset(cx + dx, cy + dy, GRASS[2]);
    for (const [dx, dy] of [[0, -1], [-1, 0], [3, 0]]) p.wset(cx + dx, cy + dy, GRASS[5]);
    for (let i = 0; i < 3; i++) pebble(p, int(rand, N), int(rand, N), STONE, GRASS[1], rand);
  }
  for (let i = 0, n = kind === 0 ? 16 : 9; i < n; i++) tuft(p, int(rand, N), int(rand, N), rand);
  if (kind === 2) {
    for (let i = 0; i < 5; i++) {
      const [petal, heart] = FLOWERS[int(rand, FLOWERS.length)];
      const x = int(rand, N), y = int(rand, N);
      p.wset(x + 1, y + 2, GRASS[1]); p.wset(x + 2, y + 1, GRASS[1]); p.wset(x, y + 2, GRASS[1]);
      p.wset(x, y + 3, GRASS[4]);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) p.wset(x + dx, y + dy, petal);
      p.wset(x - 1, y - 1, petal + 'a0');
      p.wset(x, y, heart);
    }
  }
  return p;
}

/** A tuft of blades, dark at the root and lit on the tips. */
function tuft(p: Pix, x: number, y: number, rand: Rand) {
  p.wset(x - 1, y + 1, GRASS[1]);
  p.wset(x, y + 1, GRASS[1]);
  p.wset(x + 1, y + 1, GRASS[1]);
  const blades = 2 + int(rand, 2);
  for (let b = 0; b < blades; b++) {
    const lean = b - (blades - 1) / 2, h = 2 + int(rand, 3);
    for (let k = 0; k < h; k++) {
      const bx = x + Math.round(lean * (k / h) * 1.6), by = y - k;
      p.wset(bx, by, GRASS[k === h - 1 ? (lean > 0 ? 5 : 6) : k === 0 ? 3 : 4]);
    }
  }
}

/** A pebble with a highlight and a cast shadow. */
function pebble(p: Pix, x: number, y: number, ramp: readonly string[], shadow: string, rand: Rand) {
  const big = rand() < 0.5;
  const s = big ? 3 : 2;
  for (let dy = 0; dy <= s; dy++) for (let dx = 0; dx <= s; dx++) if (dx + dy > 0 && !(dx === s && dy === s && big)) p.wset(x + dx + 1, y + dy + 1, shadow);
  for (let dy = 0; dy < s; dy++) {
    for (let dx = 0; dx < s; dx++) {
      if (big && ((dx === 0 && dy === 0) || (dx === s - 1 && dy === s - 1))) continue;
      const k = ramp.length - 2 - dx - dy;
      p.wset(x + dx, y + dy, ramp[Math.max(1, k)]);
    }
  }
  p.wset(x + (big ? 1 : 0), y, ramp[ramp.length - 1]);
}

/** Wind-sculpted snow. Kind 1 adds a trail of little footprints. */
export function snow(seed: number, kind: number) {
  const rand = rng(seed), f = field(rand, [[2, 0.5], [4, 0.3], [8, 0.12], [16, 0.08]]), p = new Pix();
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      p.set(x, y, pick(SNOW, 0.55 + relief(f, x, y) * 3.2 + (at(f, x, y) - 0.5) * 0.3, x, y, 2, 5, 0.8));
    }
  }
  if (kind === 1) {
    // Footprints: little ovals, shaded on their upper lip.
    const x = int(rand, N), y = int(rand, N);
    for (let k = 0; k < 5; k++) {
      const fx = x + k * 6, fy = y + (k % 2) * 4;
      p.wset(fx, fy, SNOW[1]); p.wset(fx + 1, fy, SNOW[1]);
      p.wset(fx, fy + 1, SNOW[2]); p.wset(fx + 1, fy + 1, SNOW[2]);
      p.wset(fx, fy + 2, SNOW[3]); p.wset(fx + 1, fy + 2, SNOW[4]);
    }
  }
  // Glints catch the light.
  for (let i = 0; i < 6; i++) {
    const x = int(rand, N), y = int(rand, N);
    p.wset(x, y, '#ffffff');
    if (i % 2) { p.wset(x + 1, y, '#e8f8ff'); p.wset(x - 1, y, '#e8f8ff'); p.wset(x, y - 1, '#e8f8ff'); p.wset(x, y + 1, '#e8f8ff'); }
    else p.wset(x + 1, y + 1, '#b8ecff');
  }
  return p;
}

/** Desert sand with wind ripples. Kind 1 has a dry sprig instead of pebbles. */
export function sand(seed: number, kind: number) {
  const rand = rng(seed), f = field(rand), p = new Pix();
  const phase = rand() * Math.PI * 2;
  // Integer frequencies along x and y keep the ripples seamless.
  const h = (x: number, y: number) => Math.sin((2 * Math.PI * (2 * x + 5 * y)) / N + phase + at(f, x, y) * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const lit = h(x + 1, y + 1) - h(x - 1, y - 1);
      p.set(x, y, pick(SAND, 0.5 + lit * 0.22 + (at(f, x, y) - 0.5) * 0.35, x, y, 1, 5, 0.6));
    }
  }
  // A scatter of darker grains.
  for (let i = 0; i < 14; i++) p.wset(int(rand, N), int(rand, N), i % 3 ? SAND[2] : SAND[5]);
  if (kind === 1) {
    // A dry sprig.
    const x = int(rand, N), y = int(rand, N);
    for (let k = 0; k < 5; k++) { p.wset(x, y - k, k ? '#8a7a34' : '#5a4a20'); p.wset(x + 1, y + 1 - k, SAND[1]); }
    for (const s of [-1, 1]) for (let k = 1; k <= 3; k++) p.wset(x + s * k, y - 2 - k, k === 3 ? '#c9b45a' : '#a8963f');
  } else {
    for (let i = 0; i < 3; i++) pebble(p, int(rand, N), int(rand, N), SANDSTONE, SAND[1], rand);
  }
  return p;
}

/**
 * Volcanic basalt: cooled columns (a seamless Voronoi pattern on the
 * torus). Kind 0, the common one, is calm with a few loose embers; kind 1
 * has lava glowing in one crack.
 */
export function ash(seed: number, kind: number) {
  const rand = rng(seed), lavaF = field(rand), grit = field(rand, [[16, 1]]), p = new Pix();
  const pts = Array.from({ length: 9 }, () => [rand() * N, rand() * N, rand()]);
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
      edge[y * N + x] = d2 - d1 < 1.3 ? 1 : 0;
      cell[y * N + x] = tone;
    }
  }
  const isEdge = (x: number, y: number) => edge[wrap(y) * N + wrap(x)] === 1;
  const lavaAt = kind === 0 ? 2 : 0.8;
  const isLava = (x: number, y: number) => isEdge(x, y) && at(lavaF, x, y) > lavaAt;
  const near = (x: number, y: number, r: number) => {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (Math.abs(dx) + Math.abs(dy) <= r && isLava(x + dx, y + dy)) return true;
    return false;
  };
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (isLava(x, y)) {
        p.set(x, y, at(lavaF, x, y) > lavaAt + 0.1 ? LAVA[4] : at(lavaF, x, y) > lavaAt + 0.04 ? LAVA[3] : LAVA[2]);
      } else if (isEdge(x, y)) {
        p.set(x, y, ASH[0]);
      } else if (near(x, y, 1)) {
        p.set(x, y, '#7a3022'); // lava light on the rock
      } else if (near(x, y, 2)) {
        p.set(x, y, '#4a2226');
      } else if (isEdge(x - 1, y) || isEdge(x, y - 1)) {
        p.set(x, y, ASH[5]); // top-left rim of a column catches the light
      } else if (isEdge(x - 2, y) || isEdge(x, y - 2)) {
        p.set(x, y, ASH[4]);
      } else if (isEdge(x + 1, y) || isEdge(x, y + 1)) {
        p.set(x, y, ASH[1]);
      } else {
        p.set(x, y, pick(ASH, cell[y * N + x] * 0.5 + (at(grit, x, y) - 0.5) * 0.35 + 0.25, x, y, 2, 4, 0.5));
      }
    }
  }
  if (kind === 0) {
    for (let i = 0; i < 3; i++) {
      const x = int(rand, N), y = int(rand, N);
      p.wset(x, y, LAVA[3]); p.wset(x + 1, y, LAVA[1]); p.wset(x, y + 1, LAVA[1]);
    }
  }
  return p;
}

/**
 * Dungeon flagstones: worn slabs in staggered courses with dark joints.
 * Kind 1 has a crack and a scatter of bone; kind 2 a patch of damp moss.
 */
export function crypt(seed: number, kind: number) {
  const rand = rng(seed), f = field(rand), p = new Pix();
  const S = N / 2;
  // Two courses of 16 rows; the lower course is shifted half a slab.
  const shift = (y: number) => Math.floor(wrap(y) / S) * (S / 2);
  const slab = (x: number, y: number): number => {
    const row = Math.floor(wrap(y) / S);
    return row * 2 + Math.floor(wrap(x + shift(y)) / S);
  };
  const tone = [rand(), rand(), rand(), rand()];
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const jy = wrap(y) % S, jx = wrap(x + shift(y)) % S;
      if (jy === S - 1 || jx === S - 1) {
        p.set(x, y, FLAGSTONE[0]);
        continue;
      }
      // Slab edges are bevelled: lit top-left, shaded bottom-right.
      const bevel = jy === 0 || jx === 0 ? 0.2 : jy === S - 2 || jx === S - 2 ? -0.2 : 0;
      const v = 0.45 + tone[slab(x, y)] * 0.2 + relief(f, x, y) * 1 + (at(f, x * 2, y * 2) - 0.5) * 0.25 + bevel;
      p.set(x, y, pick(FLAGSTONE, v, x, y, 2, 6, 0.5));
    }
  }
  // Chips knocked out of the corners.
  for (let i = 0; i < 3; i++) {
    const x = int(rand, N), y = int(rand, N);
    p.wset(x, y, FLAGSTONE[1]); p.wset(x + 1, y, FLAGSTONE[2]); p.wset(x + 1, y + 1, FLAGSTONE[5]);
  }
  if (kind === 1) {
    crack(rand, 4 + int(rand, 12), 2 + int(rand, 8), 12, (x: number, y: number) => { p.wset(x, y, FLAGSTONE[0]); p.wset(x + 1, y + 1, FLAGSTONE[5]); });
    // A little bone and a skull-pale pebble.
    const bx = int(rand, N), by = int(rand, N);
    for (let k = 0; k < 6; k++) { p.wset(bx + k, by, '#e6dcc0'); p.wset(bx + k, by + 1, '#a89e86'); }
    for (const dx of [-1, 6]) { p.wset(bx + dx, by - 1, '#e6dcc0'); p.wset(bx + dx, by + 2, '#cfc6ae'); p.wset(bx + dx, by, '#cfc6ae'); p.wset(bx + dx, by + 1, '#a89e86'); }
    for (let k = 0; k < 7; k++) p.wset(bx + k, by + 2, FLAGSTONE[1]);
  }
  if (kind === 2) {
    const mx = int(rand, N), my = int(rand, N);
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -6; dx <= 6; dx++) {
        if (dx * dx / 36 + dy * dy / 16 <= 1 && rand() < 0.7) p.wset(mx + dx, my + dy, rand() < 0.4 ? '#25402e' : rand() < 0.5 ? '#2f5236' : '#3d6a40');
      }
    }
  }
  return p;
}

/**
 * Space deck plates: dark glass panels over a starfield, in a 2x2 grid of
 * 16-pixel plates with faint seams. Kind 1 has a glowing nebula wisp; kind
 * 2 a lit floor vent.
 */
export function space(seed: number, kind: number) {
  const rand = rng(seed), f = field(rand, [[2, 0.5], [4, 0.3], [8, 0.2]]), p = new Pix();
  const S = N / 2;
  const seamAt = (x: number, y: number) => wrap(x) % S === S - 1 || wrap(y) % S === S - 1;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const lip = wrap(x) % S === 0 || wrap(y) % S === 0;
      const under = wrap(x) % S === S - 2 || wrap(y) % S === S - 2;
      if (seamAt(x, y)) p.set(x, y, DECK[0]);
      else p.set(x, y, pick(DECK, at(f, x, y) * 0.45 + (lip ? 0.4 : under ? 0 : 0.12), x, y, 1, 4, 0.6));
    }
  }
  // Bolts in the plate corners.
  for (const [x, y] of [[1, 1], [S + 1, 1], [1, S + 1], [S + 1, S + 1]]) { p.set(x, y, DECK[5]); p.set(x + 1, y + 1, DECK[0]); }
  // Stars shine through the glass: a few dim, some bright with a twinkle.
  for (let i = 0; i < 12; i++) {
    const x = int(rand, N), y = int(rand, N);
    if (seamAt(x, y)) continue;
    p.set(x, y, i < 2 ? '#e8f0ff' : i < 6 ? '#8a96c8' : '#4a5a98');
    if (i === 0) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (!seamAt(x + dx, y + dy)) p.wset(x + dx, y + dy, '#6a7ab8');
  }
  if (kind === 1) {
    // A wisp of nebula.
    const cx = int(rand, N), cy = int(rand, N);
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -8; dx <= 8; dx++) {
        const k = dx * dx / 64 + dy * dy / 16;
        if (k <= 1 && rand() < 0.75 - k * 0.4) p.wset(cx + dx, cy + dy + Math.round(dx / 3), k < 0.3 ? '#4a2a7a' : rand() < 0.5 ? '#3a2466' : '#2a2a70');
      }
    }
  }
  if (kind === 2) {
    // A small vent with a cyan glow.
    const vx = 4 + int(rand, 2) * S, vy = 4 + int(rand, 2) * S;
    for (let k = 0; k < 8; k++) {
      for (const r of [0, 2, 4]) { p.set(vx + k, vy + r, DECK[0]); p.set(vx + k, vy + r + 1, k % 2 ? NEON[0] : NEON[1]); }
      p.set(vx + k, vy + 6, DECK[0]);
    }
    for (let k = -1; k <= 8; k++) { p.set(vx + k, vy - 1, DECK[5]); p.set(vx + k, vy + 7, DECK[2]); }
  }
  return p;
}
