// Bombs (plain, pierce, atomic), the remote antenna, flames and scorch
// marks, drawn at 32x32.

import {
  at, field, fill, groundShadow, layer, line, N, Pix, rng, sdBox, sdCircle, sdPoly, shape, STEEL,
} from '../pixelkit.js';

// Bomb iron: navy shadows, lilac highlights.
export const IRON = ['#0b0a16', '#16162a', '#22233d', '#30344f', '#454c6b', '#6a7394', '#a9b3d1'];
export const RED_IRON = ['#1a0a10', '#3a0f18', '#5c1420', '#82202a', '#ad3236', '#d9584e', '#ffb09a'];
const URANIUM = ['#1a1400', '#3a2e00', '#6b5600', '#a68600', '#d9b21a', '#ffd23f', '#fff2a8'];
const FIRE = ['#3a0a12', '#8c1a10', '#d63a12', '#ff7a1a', '#ffb532', '#ffe46b', '#fff9d6'];
export const FUSE = ['#6b4a2a', '#c9a26b', '#e0bd84'];

// ------------------------------------------------------------------- bombs

const CX = 15, CY = 18.5, R = 10.5;

/**
 * A shaded iron sphere with a riveted steel cap, a twisted fuse with a
 * glowing tip, a window reflection and bounced light on the far rim.
 */
export function bomb(ramp: readonly string[], spiked: boolean): Pix {
  const p = new Pix();
  groundShadow(p, 16, 28.6, 11.5, 2.6);
  if (spiked) {
    // Steel spikes behind the shell, pointing out all round.
    layer(p, (q) => {
      for (let k = 0; k < 8; k++) {
        const a = (k / 8) * Math.PI * 2 + Math.PI / 8, c = Math.cos(a), s = Math.sin(a);
        const tip: [number, number] = [CX + c * (R + 4.5), CY + s * (R + 4.5)];
        const l: [number, number] = [CX + c * (R - 2) - s * 2.6, CY + s * (R - 2) + c * 2.6];
        const r: [number, number] = [CX + c * (R - 2) + s * 2.6, CY + s * (R - 2) - c * 2.6];
        shape(q, sdPoly([tip, l, r]), STEEL, { lo: 2, hi: 6, depth: 1.5 });
      }
    });
  }
  layer(p, (q) => {
    shape(q, sdCircle(CX, CY, R), ramp, { lo: 1, hi: 5, depth: 7, bounce: 0.5 });
    // A soft window reflection and a hard glint.
    fill(q, sdCircle(10.5, 13.5, 2.6), (x, y) => (x + y < 23 ? ramp[6] : ramp[5]));
    q.set(9, 12, '#ffffff'); q.set(10, 12, '#ffffff'); q.set(9, 13, '#ffffff');
    q.set(14, 11, ramp[5]); q.set(15, 10, ramp[5]);
    // A faint band of reflected floor along the bottom.
    for (let x = 9; x <= 19; x++) if (q.solid(x, 27)) q.set(x, 27, ramp[3]);
  });
  // The steel cap, set into the top right of the shell.
  layer(p, (q) => {
    shape(q, sdBox(21, 9.5, 3.6, 2.6, 1.2), STEEL, { lo: 2, hi: 6, depth: 2 });
    for (let x = 18; x <= 24; x++) q.set(x, 10, STEEL[2]);
    q.set(19, 8, STEEL[6]); q.set(23, 11, STEEL[1]);
  });
  // The fuse: a twisted cord with a glowing tip.
  line(22, 6, 24, 3, (x, y) => { p.set(x, y, (x + y) % 2 ? FUSE[1] : FUSE[0]); p.set(x + 1, y, (x + y) % 2 ? FUSE[0] : FUSE[2]); });
  line(24, 3, 27, 2, (x, y) => { p.set(x, y, (x + y) % 2 ? FUSE[1] : FUSE[0]); p.set(x, y + 1, FUSE[0]); });
  for (const [x, y, c] of [[28, 1, '#ffe46b'], [28, 2, '#ff7a1a'], [29, 1, '#fff9d6'], [27, 1, '#ffb532'], [29, 0, '#ffb53280'], [30, 2, '#ff7a1a80']] as const) p.set(x, y, c);
  return p;
}

/** The atomic bomb: a fat yellow bomb with a black radiation trefoil. */
export function nukeBomb() {
  const p = bomb(URANIUM, false);
  const ink = (x: number, y: number) => {
    const dx = x + 0.5 - CX, dy = y + 0.5 - CY, d = Math.hypot(dx, dy);
    if (d < 1.6) return true;
    if (d < 2.6 || d > 6.6) return false;
    const a = (Math.atan2(dy, dx) * 180) / Math.PI + 360;
    return [270, 30, 150].some((c) => Math.abs(((a - c + 540) % 360) - 180) < 30);
  };
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (ink(x, y)) p.set(x, y, ink(x - 1, y - 1) ? URANIUM[0] : URANIUM[1]);
  return p;
}

/** Antenna and LED drawn over a remote bomb, in two blink states. */
export function antenna(on: boolean): Pix {
  const p = new Pix();
  line(9, 9, 6, 3, (x, y) => { p.set(x, y, STEEL[5]); p.set(x + 1, y, STEEL[3]); });
  if (on) for (let y = 0; y <= 5; y++) for (let x = 2; x <= 8; x++) if (Math.hypot(x - 5, y - 2) < 3.4) p.set(x, y, '#4aa3e070');
  for (const [x, y, c] of [[4, 1, on ? '#e8fbff' : '#3a5a7a'], [5, 1, on ? '#bff0ff' : '#2a4a6a'], [4, 2, on ? '#7fd4ff' : '#2a4a6a'], [5, 2, on ? '#4aa3e0' : '#1a2a40']] as const) p.set(x, y, c);
  return p;
}

// ------------------------------------------------------------------- flames

/**
 * Fire banded by a distance metric `q` (in art pixels): hot white at the
 * core, through yellow and orange, to a dark red rim. Noise per frame
 * makes it flicker.
 */
function fire(q: (x: number, y: number) => number): Pix {
  const p = new Pix();
  const bands = [3, 5.6, 8, 10, 11.8, 13.2];
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const v = q(x + 0.5, y + 0.5);
      const i = bands.findIndex((b) => v < b);
      if (i >= 0) p.set(x, y, FIRE[6 - i]);
    }
  }
  return p;
}

/** Three flicker frames each of the flame centre, arm and end. */
export function flames() {
  const frames: { center: Pix[]; arm: Pix[]; end: Pix[] } = { center: [], arm: [], end: [] };
  const c = N / 2;
  for (let f = 0; f < 3; f++) {
    const rand = rng(101 + f);
    const n = field(rand, [[4, 0.45], [8, 0.35], [16, 0.2]]);
    const wob = (x: number, y: number) => (at(n, Math.floor(x), Math.floor(y)) - 0.5) * 3.6;
    // Seamless along the arm: whole sine waves per tile.
    const tongue = (x: number): number => Math.sin((2 * Math.PI * 2 * x) / N + f * 2.1) * 1.6 + Math.sin((2 * Math.PI * 5 * x) / N + f) * 0.6;
    const across = (y: number): number => Math.abs(y - c) * 1.75;
    frames.arm.push(fire((x, y) => across(y) + tongue(x) + wob(x, y)));
    // A round fireball that also opens into the four arms.
    frames.center.push(fire((x, y) => {
      const d = Math.hypot(x - c, y - c);
      return Math.min(d, 1.75 * Math.min(Math.abs(x - c), Math.abs(y - c)) + 1.2) + wob(x, y);
    }));
    // The end tapers to a rounded tip on the right (the renderer rotates it).
    frames.end.push(fire((x, y) => Math.hypot(Math.max(0, x - 12) * 1.4, across(y)) + tongue(x) * 0.6 + wob(x, y)));
  }
  // Embers flicking off the fire.
  frames.center.forEach((p, f) => {
    const rand = rng(301 + f);
    for (let i = 0; i < 5; i++) {
      const a = rand() * Math.PI * 2, r = 12 + rand() * 3;
      const x = Math.round(c + Math.cos(a) * r), y = Math.round(c + Math.sin(a) * r);
      if (!p.filled(x, y)) p.set(x, y, i % 2 ? FIRE[4] : FIRE[3]);
    }
  });
  return frames;
}

/** A soot splat with radiating streaks and dying embers; transparent around it. */
export function scorch() {
  const rand = rng(77), n = field(rand), p = new Pix(), c = N / 2 - 0.5;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const d = Math.hypot(x - c, y - c) + (at(n, x, y) - 0.5) * 6;
      const odd = (x + y) % 2 === 0;
      if (d < 6) p.set(x, y, at(n, x * 3, y * 3) > 0.6 ? '#1e1416e8' : '#120c10e8');
      else if (d < 9.5) p.set(x, y, '#1e1416c8');
      else if (d < 12 && odd) p.set(x, y, '#2a1c1aa0');
      else if (d < 14 && odd && (x * 7 + y * 3) % 3 === 0) p.set(x, y, '#2a1c1a80');
    }
  }
  for (let i = 0; i < 9; i++) {
    const a = (i / 9) * Math.PI * 2 + rand() * 0.5, len = 12 + rand() * 3.5;
    for (let r = 7; r < len; r += 1) p.set(Math.round(c + Math.cos(a) * r), Math.round(c + Math.sin(a) * r), r > len - 2 ? '#1a121470' : '#1a1214b8');
  }
  // Embers still glowing in the soot.
  for (const [x, y, k] of [[14, 14, 3], [15, 14, 4], [18, 17, 3], [13, 18, 2], [19, 13, 2]] as const) p.set(x, y, FIRE[k] + 'b0');
  p.set(15, 15, '#ff7a1a90');
  return p;
}
