// Special tiles: ice, conveyor belts and teleport pads.

import { at, clamp, crack, field, int, N, pick, Pix, rng, SHADOW, STEEL } from '../pixelkit.js';
import { ICE, PORTAL, RUBBER, RUNE, STONE } from './palette.js';

// ---------------------------------------------------------------- specials

/** Seamless ice: diagonal shine bands, white fractures, trapped bubbles. */
export function ice(seed: number) {
  const rand = rng(seed), f = field(rand, [[2, 0.7], [4, 0.3]]), streak = field(rand), p = new Pix();
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const d = (x + y) % N;
      let c;
      if ((d === 4 || d === 5) && at(streak, x, y) > 0.3) c = d === 4 ? ICE[5] : ICE[4];
      else if (d === 11 && at(streak, x, y) > 0.45) c = ICE[4];
      else c = pick(ICE, 0.35 + (at(f, x, y) - 0.5) * 0.6, x, y, 2, 3, 0.9);
      p.set(x, y, c);
    }
  }
  for (let i = 0; i < 2; i++) {
    crack(rand, int(rand, N), int(rand, N), 5 + int(rand, 3), (x: number, y: number) => {
      p.wset(x, y, ICE[6]);
      p.wset(x, y + 1, ICE[1]);
    });
  }
  for (let i = 0; i < 2; i++) p.wset(int(rand, N), int(rand, N), ICE[1]);
  return p;
}

/**
 * A belt running left to right between riveted rails. The renderer
 * rotates it and animates chevrons on top. Seamless along the belt.
 */
export function conveyor() {
  const p = new Pix();
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let c;
      if (y === 0) c = STEEL[5];
      else if (y === 1) c = x % 8 === 3 ? STEEL[6] : STEEL[3];
      else if (y === N - 2) c = x % 8 === 3 ? STEEL[5] : STEEL[3];
      else if (y === N - 1) c = STEEL[1];
      else if (y === 2 || y === N - 3) c = RUBBER[0];
      else if (x % 4 === 0) c = RUBBER[0]; // gap between slats
      else if (x % 4 === 1) c = RUBBER[4]; // leading edge catches the light
      else c = y < N / 2 ? RUBBER[3] : RUBBER[2];
      p.set(x, y, c);
    }
  }
  return p;
}

/** A stone ring around a swirling portal, with glowing runes. Transparent outside. */
export function teleport(seed: number) {
  const rand = rng(seed), p = new Pix(), c = 7.5;
  const twist = rand() * Math.PI;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const dx = x - c, dy = y - c, d = Math.hypot(dx, dy);
      if (d > 7.6) continue;
      if (d > 5.6) {
        const lit = -(dx + dy) / (d * Math.SQRT2); // 1 facing the top left
        p.set(x, y, d > 7 && lit < 0 ? STONE[1] : STONE[clamp(Math.round(4 + lit * 2), 2, 7)]);
      } else if (d > 4.8) {
        const lit = (dx + dy) / (d * Math.SQRT2); // the inner wall faces the other way
        p.set(x, y, STONE[clamp(Math.round(2 + lit), 1, 3)]);
      } else {
        const swirl = 0.5 + 0.5 * Math.sin(3 * Math.atan2(dy, dx) + d * 1.4 + twist);
        p.set(x, y, d < 1.1 ? PORTAL[6] : pick(PORTAL, swirl * 0.55 + (1 - d / 4.8) * 0.6, x, y, 1, 6, 0.8));
      }
    }
  }
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4;
    p.set(Math.round(c + Math.cos(a) * 6.6), Math.round(c + Math.sin(a) * 6.6), k % 2 ? RUNE : '#d8fdff');
  }
  // Drop shadow on the floor, down and to the right.
  for (let y = N - 1; y >= 0; y--) {
    for (let x = N - 1; x >= 0; x--) {
      if (!p.filled(x, y) && p.filled(x - 1, y - 1)) p.set(x, y, SHADOW);
    }
  }
  return p;
}
