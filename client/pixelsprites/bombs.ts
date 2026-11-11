// Bombs (plain, pierce, atomic), the remote antenna, flames and scorch marks.

import { at, bitmap, clamp, field, N, Pix, rng, SHADOW, STEEL } from '../pixelkit.js';

// Bomb iron: navy shadows, lilac highlights.
export const IRON = ['#0b0a16', '#16162a', '#22233d', '#30344f', '#454c6b', '#6a7394', '#a9b3d1'];
export const RED_IRON = ['#1a0a10', '#3a0f18', '#5c1420', '#82202a', '#ad3236', '#d9584e', '#ffb09a'];
const URANIUM = ['#1a1400', '#3a2e00', '#6b5600', '#a68600', '#d9b21a', '#ffd23f', '#fff2a8'];
const FIRE = ['#3a0a12', '#8c1a10', '#d63a12', '#ff7a1a', '#ffb532', '#ffe46b', '#fff9d6'];
export const FUSE = ['#6b4a2a', '#c9a26b', '#e0bd84'];

// ------------------------------------------------------------------- bombs

/** A shaded sphere bomb with a cap, a fuse and a shadow on the ground. */
export function bomb(ramp: readonly string[], spiked: boolean): Pix {
  const p = new Pix();
  // Ground shadow first, so the body paints over it.
  for (let y = 12; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (((x - 7.5) / 5.5) ** 2 + ((y - 14) / 1.6) ** 2 <= 1) p.set(x, y, SHADOW);
    }
  }
  const cx = 7, cy = 9, r = 5.6;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy);
      if (d > r) continue;
      if (d > r - 1) { p.set(x, y, ramp[0]); continue; }
      // Lambert-ish shading towards the top-left light, with a cool rim on the far side.
      const lit = -(0.6 * dx + 0.8 * dy) / r;
      let k = clamp(Math.round(2.6 + lit * 2.4), 1, 5);
      if (d > r - 2 && dx + dy > 2) k = 2;
      p.set(x, y, ramp[k]);
    }
  }
  // Specular glint.
  p.set(4, 6, ramp[6]);
  p.set(5, 6, ramp[6]);
  p.set(4, 7, ramp[6]);
  p.set(4, 6, '#ffffff');
  // Metal cap and the fuse.
  bitmap(p, ['oxxo', 'oxyo'], { o: STEEL[1], x: STEEL[5], y: STEEL[3] }, 8, 3);
  bitmap(p, ['  b', ' a ', 'a  '], { a: FUSE[1], b: FUSE[2] }, 10, 0);
  if (spiked) {
    // Pierce bombs carry steel spikes.
    for (const [x, y] of [[0, 9], [1, 9], [13, 9], [14, 9], [2, 4], [3, 5], [12, 14], [11, 13]]) p.set(x, y, STEEL[5]);
    p.set(1, 9, STEEL[3]);
    p.set(13, 9, STEEL[3]);
  }
  return p;
}

/** The atomic bomb: a fat yellow bomb with a black radiation trefoil. */
export function nukeBomb() {
  const p = bomb(URANIUM, false);
  const cx = 7, cy = 9;
  for (const [dx, dy] of [[0, 0], [-2, -2], [-1, -2], [-2, -1], [1, -2], [2, -2], [2, -1], [-1, 2], [0, 2], [1, 2]]) {
    p.set(cx + dx, cy + dy, URANIUM[0]);
  }
  return p;
}

/** Antenna and LED drawn over a remote bomb, in two blink states. */
export function antenna(on: boolean): Pix {
  const p = new Pix();
  if (on) for (const [x, y] of [[3, 0], [2, 1], [4, 1], [3, 2]]) p.set(x, y, '#4aa3e0b0');
  p.set(4, 2, STEEL[5]);
  p.set(5, 3, STEEL[4]);
  p.set(3, 1, on ? '#bff0ff' : '#2a4a6a');
  return p;
}

// ------------------------------------------------------------------- flames

/**
 * Fire banded by a distance metric `q`: hot white at the core, through
 * yellow and orange, to a dark red rim. Noise per frame makes it flicker.
 */
function fire(q: (x: number, y: number) => number): Pix {
  const p = new Pix();
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const v = q(x, y);
      const k = v < 1.6 ? 6 : v < 2.8 ? 5 : v < 4 ? 4 : v < 5 ? 3 : v < 5.9 ? 2 : v < 6.6 ? 1 : -1;
      if (k >= 0) p.set(x, y, FIRE[k]);
    }
  }
  return p;
}

/** Three flicker frames each of the flame centre, arm and end. */
export function flames() {
  const frames: { center: Pix[]; arm: Pix[]; end: Pix[] } = { center: [], arm: [], end: [] };
  for (let f = 0; f < 3; f++) {
    const rand = rng(101 + f);
    const n = field(rand, [[4, 0.6], [8, 0.4]]);
    const wob = (x: number, y: number) => (at(n, x, y) - 0.5) * 1.8;
    // Seamless along the arm: whole sine waves per tile.
    const tongue = (x: number): number => Math.sin((2 * Math.PI * 2 * x) / N + f * 2.1) * 0.9;
    const across = (y: number): number => Math.abs(y - 7.5) * 1.75;
    frames.arm.push(fire((x: number, y: number) => across(y) + tongue(x) + wob(x, y)));
    // A round fireball that also opens into the four arms.
    frames.center.push(fire((x: number, y: number) => {
      const d = Math.hypot(x - 7.5, y - 7.5);
      return Math.min(d, 1.75 * Math.min(Math.abs(x - 7.5), Math.abs(y - 7.5)) + 0.6) + wob(x, y);
    }));
    // The end tapers to a rounded tip on the right (the renderer rotates it).
    frames.end.push(fire((x: number, y: number) => Math.hypot(Math.max(0, x - 6) * 1.4, across(y)) + tongue(x) * 0.6 + wob(x, y)));
  }
  return frames;
}

/** A soot splat with radiating streaks; transparent around it. */
export function scorch() {
  const rand = rng(77), n = field(rand), p = new Pix();
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const d = Math.hypot(x - 7.5, y - 7.5) + (at(n, x, y) - 0.5) * 3;
      const odd = (x + y) % 2 === 0;
      if (d < 3.5) p.set(x, y, '#120c10e0');
      else if (d < 5) p.set(x, y, '#1e1416c0');
      else if (d < 6.2 && odd) p.set(x, y, '#2a1c1aa0');
      else if (d < 7.2 && odd && (x * 7 + y * 3) % 3 === 0) p.set(x, y, '#2a1c1a80');
    }
  }
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + rand() * 0.5;
    for (let r = 4; r < 7.5; r += 1) p.set(Math.round(7.5 + Math.cos(a) * r), Math.round(7.5 + Math.sin(a) * r), '#1a1214b0');
  }
  p.set(7, 7, '#ff7a1a90');
  p.set(9, 8, '#ffb53270');
  return p;
}
