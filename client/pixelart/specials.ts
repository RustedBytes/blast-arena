// Special tiles at 32x32: ice, conveyor belts and teleport pads.

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
      if (d >= 8 && d <= 11 && at(streak, x, y) > 0.3) c = d === 8 ? ICE[6] : d < 11 ? ICE[5] : ICE[4];
      else if ((d === 22 || d === 23) && at(streak, x, y) > 0.45) c = d === 22 ? ICE[5] : ICE[4];
      else c = pick(ICE, 0.35 + (at(f, x, y) - 0.5) * 0.7, x, y, 2, 4, 0.7);
      p.set(x, y, c);
    }
  }
  for (let i = 0; i < 3; i++) {
    crack(rand, int(rand, N), int(rand, N), 8 + int(rand, 6), (x: number, y: number) => {
      p.wset(x, y, ICE[6]);
      p.wset(x, y + 1, ICE[1]);
    });
  }
  // Bubbles trapped in the ice, lit on top.
  for (let i = 0; i < 4; i++) {
    const x = int(rand, N), y = int(rand, N);
    p.wset(x, y, ICE[6]); p.wset(x + 1, y, ICE[4]); p.wset(x, y + 1, ICE[3]); p.wset(x + 1, y + 1, ICE[1]);
  }
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
      const rivet = x % 16 === 6;
      if (y === 0) c = STEEL[5];
      else if (y === 1) c = rivet ? STEEL[6] : STEEL[4];
      else if (y === 2) c = rivet ? STEEL[2] : STEEL[3];
      else if (y === N - 3) c = rivet ? STEEL[6] : STEEL[3];
      else if (y === N - 2) c = rivet ? STEEL[2] : STEEL[2];
      else if (y === N - 1) c = STEEL[1];
      else if (y === 3 || y === 4 || y === N - 4) c = RUBBER[0];
      else if (x % 8 === 0) c = RUBBER[0]; // gap between slats
      else if (x % 8 === 1) c = RUBBER[4]; // leading edge catches the light
      else if (x % 8 === 7) c = RUBBER[1];
      else if ((x + y) % 4 === 0 && x % 8 > 2) c = RUBBER[1]; // tread
      else c = y < N / 2 ? RUBBER[3] : RUBBER[2];
      p.set(x, y, c);
    }
  }
  return p;
}

/** A stone ring around a swirling portal, with glowing runes. Transparent outside. */
export function teleport(seed: number) {
  const rand = rng(seed), p = new Pix(), c = N / 2 - 0.5;
  const twist = rand() * Math.PI;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const dx = x - c, dy = y - c, d = Math.hypot(dx, dy);
      if (d > 15.2) continue;
      if (d > 14.4) {
        p.set(x, y, STONE[1]); // outline
      } else if (d > 11.2) {
        const lit = -(dx + dy) / (d * Math.SQRT2); // 1 facing the top left
        const seg = Math.floor(((Math.atan2(dy, dx) + Math.PI) / (Math.PI * 2)) * 12 + 0.5) % 12;
        const joint = Math.abs(((Math.atan2(dy, dx) + Math.PI) / (Math.PI * 2)) * 12 - Math.round(((Math.atan2(dy, dx) + Math.PI) / (Math.PI * 2)) * 12)) < 0.07;
        p.set(x, y, joint ? STONE[2] : STONE[clamp(Math.round(4 + lit * 2 + (d > 13.6 ? -0.6 : d < 12 ? 0.4 : 0) + (seg % 3) * 0.2), 2, 7)]);
      } else if (d > 9.6) {
        const lit = (dx + dy) / (d * Math.SQRT2); // the inner wall faces the other way
        p.set(x, y, STONE[clamp(Math.round(2 + lit), 1, 3)]);
      } else {
        const swirl = 0.5 + 0.5 * Math.sin(3 * Math.atan2(dy, dx) + d * 0.7 + twist);
        p.set(x, y, d < 2.2 ? (d < 1.2 ? '#ffffff' : PORTAL[6]) : pick(PORTAL, swirl * 0.55 + (1 - d / 9.6) * 0.6, x, y, 1, 6, 0.6));
      }
    }
  }
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4 + Math.PI / 12;
    const rx = Math.round(c + Math.cos(a) * 12.8), ry = Math.round(c + Math.sin(a) * 12.8);
    p.set(rx, ry, '#d8fdff'); p.set(rx + 1, ry, RUNE); p.set(rx, ry + 1, RUNE); p.set(rx + 1, ry + 1, '#3aa8c0');
  }
  // Motes drifting in the portal.
  for (let i = 0; i < 4; i++) {
    const a = rand() * Math.PI * 2, r = 3 + rand() * 5;
    p.set(Math.round(c + Math.cos(a) * r), Math.round(c + Math.sin(a) * r), PORTAL[6]);
  }
  // Drop shadow on the floor, down and to the right.
  for (let y = N - 1; y >= 0; y--) {
    for (let x = N - 1; x >= 0; x--) {
      if (!p.filled(x, y) && (p.filled(x - 1, y - 1) || p.filled(x - 2, y - 2))) p.set(x, y, SHADOW);
    }
  }
  return p;
}
