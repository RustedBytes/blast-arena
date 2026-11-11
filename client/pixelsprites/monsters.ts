// The monsters of the Dungeon arena at 32x32: slimes, skeletons and bats,
// two animation frames each.

import {
  fill, groundShadow, layer, line, Pix, sdBox, sdCapsule, sdCircle, sdEllipse, sdPoly, sdUnion, shape,
} from '../pixelkit.js';
import type { Sdf } from '../pixelkit.js';

// ----------------------------------------------------------------- monsters

/** Slime goo: deep teal shadows up to an acid-green highlight. */
const SLIME = ['#0d2a1c', '#14492a', '#1f6e35', '#33963c', '#58bd44', '#8fde5a', '#d4ff9a'];
const BONE = ['#2a2620', '#5a5244', '#8a8270', '#b8b09a', '#d8d0b8', '#ece6d2', '#fffbea'];
/** Bat fur and wing membrane: inky purples, lit towards lavender. */
const BAT = ['#120c1c', '#241a36', '#3a2a55', '#56407a', '#7a5ea3', '#a68bd0', '#d6c4f4'];

/**
 * A slime: a glossy dome of goo with big wet eyes and bubbles drifting
 * inside. Frame 1 is squashed flat and wide, mid-hop.
 */
export function slime(frame: number): Pix {
  const p = new Pix();
  const [rx, ry] = frame ? [14, 9] : [12, 11.5];
  const base = 28.5;
  groundShadow(p, 16, base, rx + 1, 2.4);
  const dome: Sdf = (x, y) => Math.max(sdEllipse(16, base, rx, ry)(x, y), y - base);
  layer(p, (q) => {
    shape(q, dome, SLIME, { lo: 1, hi: 5, depth: 6, bounce: 0.55 });
    const top = base - ry;
    // Bubbles inside the goo.
    for (const [bx, by, r] of [[22, base - 4, 1.6], [12, base - 2.5, 1.1], [19, base - 7, 0.9]] as const) {
      fill(q, sdCircle(bx, by, r), SLIME[5]);
      q.set(Math.floor(bx - r / 2), Math.floor(by - r / 2), SLIME[6]);
    }
    // A wet window highlight, top left.
    fill(q, sdEllipse(10.5, top + 4.5, 2.4, 1.4), SLIME[6]);
    q.set(8, top + 7, SLIME[6]); q.set(8, top + 8, SLIME[5]);
    // Eyes with a glint and a little mouth.
    const ey = top + ry * 0.48;
    for (const ex of [12.5, 19.5]) {
      fill(q, sdEllipse(ex, ey, 2.2, 2.8), '#f4fff0');
      fill(q, sdEllipse(ex + 0.6, ey + 0.6, 1.3, 1.9), '#0a140e');
      q.set(Math.floor(ex), Math.floor(ey - 1.2), '#ffffff');
    }
    line(14, Math.round(ey + 4), 17, Math.round(ey + 4), (x, y) => q.set(x, y, SLIME[0]));
  }, 0.62, 0.5);
  return p;
}

/**
 * A skeleton facing the viewer, red sparks in its eye sockets. The frames
 * are its two strides.
 */
export function skeleton(frame: number): Pix {
  const p = new Pix();
  groundShadow(p, 16, 29.5, 7.5, 1.8);
  const stride = frame & 1 ? 3.2 : 1.2;
  // Legs and pelvis.
  layer(p, (q) => {
    for (const s of [-1, 1]) {
      const fx = 16 + s * stride + s * 0.8;
      shape(q, sdUnion(0.5, sdCapsule(16 + s * 2, 23, fx, 28, 1.1)), BONE, { lo: 2, hi: 5, depth: 1 });
      shape(q, sdBox(fx + s * 0.8, 28.6, 1.8, 0.9, 0.5), BONE, { lo: 2, hi: 5, depth: 1 });
    }
    shape(q, sdBox(16, 22.5, 4, 1.6, 1), BONE, { lo: 2, hi: 5, depth: 1.5 });
  });
  // Spine, ribs and arms.
  layer(p, (q) => {
    shape(q, sdCapsule(16, 14, 16, 22, 1), BONE, { lo: 2, hi: 4, depth: 1 });
    for (const [y, w] of [[15, 5.2], [17.5, 4.9], [20, 3.8]] as const) {
      shape(q, sdUnion(0, sdCapsule(16 - w, y + 1, 16, y, 0.55), sdCapsule(16, y, 16 + w, y + 1, 0.55)), BONE, { lo: 3, hi: 6, depth: 0.6 });
    }
    const swing = frame & 1 ? 1.5 : -0.5;
    for (const s of [-1, 1]) {
      shape(q, sdUnion(0.5, sdCapsule(16 + s * 5.5, 15, 16 + s * 7, 19.5, 0.9), sdCapsule(16 + s * 7, 19.5, 16 + s * 6.5, 23 + swing * s, 0.9)), BONE, { lo: 2, hi: 5, depth: 1 });
      fill(q, sdCircle(16 + s * 6.5, 23.6 + swing * s, 1.3), BONE[4]);
    }
  });
  // The skull, with burning eyes.
  layer(p, (q) => {
    shape(q, sdUnion(1.2, sdCircle(16, 7.5, 6.6), sdBox(16, 12, 4.2, 2.4, 1.4)), BONE, { lo: 2, hi: 6, depth: 4, spec: BONE[6] });
    for (const s of [-1, 1]) {
      fill(q, sdEllipse(16 + s * 2.8, 8.2, 1.9, 2.1), '#141218');
      q.set(Math.floor(16 + s * 2.8), 8, '#ff4a3a');
      q.set(Math.floor(16 + s * 2.8) + (s < 0 ? 0 : -1), 9, '#a81e1a');
    }
    q.set(15, 10, '#141218'); q.set(16, 10, '#141218'); q.set(15, 11, BONE[1]);
    for (let x = 13; x <= 18; x++) q.set(x, 13, x % 2 ? BONE[1] : BONE[5]);
    q.set(12, 4, BONE[6]); q.set(13, 3, BONE[6]);
  });
  return p;
}

/**
 * A bat, wings spread: frame 0 with the wings raised, frame 1 with them
 * swept down. It hovers, so its shadow is small and far below.
 */
export function bat(frame: number): Pix {
  const p = new Pix();
  groundShadow(p, 16, 29.5, 6, 1.5);
  const shoulder: [number, number] = [13, 13];
  const tip: [number, number] = frame ? [0.5, 22] : [0.5, 2.5];
  const knuckles: [number, number][] = frame ? [[4, 26], [8.5, 25]] : [[2, 18], [6.5, 20]];
  const wingPoly = sdPoly([shoulder, tip, knuckles[0], knuckles[1], [12.5, 20]]);
  // The scalloped trailing edge: bites out of the membrane between the fingers.
  const bites = [
    sdCircle((tip[0] + knuckles[0][0]) / 2 + 1.2, (tip[1] + knuckles[0][1]) / 2 + (frame ? 0 : 1.2), 2.6),
    sdCircle((knuckles[0][0] + knuckles[1][0]) / 2 + 0.5, (knuckles[0][1] + knuckles[1][1]) / 2 + 1.2, 2.2),
    sdCircle((knuckles[1][0] + 12.5) / 2 + 0.5, (knuckles[1][1] + 20) / 2 + 1, 2),
  ];
  const wing: Sdf = (x, y) => Math.max(wingPoly(x, y), ...bites.map((b) => -b(x, y)));
  layer(p, (q) => {
    for (const flip of [false, true]) {
      const w: Sdf = flip ? (x, y) => wing(32 - x, y) : wing;
      shape(q, w, BAT, { lo: 1, hi: flip ? 3 : 4, depth: 3, bounce: 0.2 });
      // Finger bones from the shoulder to the tip and knuckles.
      for (const [ex, ey] of [tip, ...knuckles]) {
        line(shoulder[0], shoulder[1], Math.round(ex), Math.round(ey), (x, y) => {
          const X = flip ? 31 - x : x;
          if (w(X + 0.5, y + 0.5) < -0.3) q.set(X, y, flip ? BAT[4] : BAT[5]);
        });
      }
    }
  });
  // The furry body, ears, red eyes and fangs.
  layer(p, (q) => {
    shape(q, sdUnion(1, sdEllipse(16, 16.5, 4.2, 5.6), sdPoly([[12.2, 13], [12.6, 6.5], [15, 11.5]]), sdPoly([[19.8, 13], [19.4, 6.5], [17, 11.5]])), BAT, { lo: 1, hi: 5, depth: 3 });
    fill(q, sdEllipse(16, 19, 2.4, 2.6), BAT[3]);
    for (const ex of [14, 17]) { q.set(ex, 14, '#ff5a4a'); q.set(ex + 1, 14, '#ffb0a0'); q.set(ex, 15, '#a81e1a'); q.set(ex + 1, 15, '#ff5a4a'); }
    q.set(15, 17, '#f4f0ff'); q.set(16, 17, '#f4f0ff'); q.set(15, 18, '#c8c0e0');
    q.set(13, 8, BAT[5]); q.set(13, 9, BAT[4]);
  });
  return p;
}

/** Every monster sprite as [kind - 1][frame]. */
export function monsterSprites(): Pix[][] {
  return [[slime(0), slime(1)], [skeleton(0), skeleton(1)], [bat(0), bat(1)]];
}
