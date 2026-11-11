// The worms of the Worms arena at 32x32: body segments, the saddle band,
// tail, head (calm, angry, lunging) and the burrowing mound.

import { at, fill, field, groundShadow, layer, line, Pix, rng, sdCircle, sdEllipse, sdTaper, shape } from '../pixelkit.js';
import type { Sdf } from '../pixelkit.js';

// ------------------------------------------------------------------- worms

// Worm flesh: plum shadows up to a pale coral highlight.
const WORM = ['#1d0818', '#3d1030', '#651a45', '#922a55', '#c2465f', '#ea7476', '#ffbfa3'];
const DIRT = ['#1a0f08', '#2a1a10', '#4a2f1a', '#6e4826', '#94673a', '#b98b55', '#d8b07a'];
// The saddle band (clitellum): swollen, paler, warmer.
const BAND = ['#2a0c18', '#6b2236', '#a8434d', '#d86a62', '#f39a83', '#ffd2b4'];

/** Moist flesh: a lit ball with muscle rings pressed into it. */
function flesh(q: Pix, ball: Sdf, ramp: readonly string[], rings: (x: number) => boolean) {
  shape(q, ball, ramp, { lo: 1, hi: ramp.length - 2, depth: 6, bounce: 0.5, spec: ramp[ramp.length - 1], shine: 0.99 });
  // Rings: a darker groove with a lit lip just right of it.
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      if (ball(x + 0.5, y + 0.5) > -1.2) continue;
      if (rings(x)) q.set(x, y, ramp[Math.max(1, ramp.indexOf(q.get(x, y)) - 2)] ?? ramp[1]);
      else if (rings(x - 1)) q.set(x, y, ramp[Math.min(ramp.length - 2, Math.max(2, ramp.indexOf(q.get(x, y)) + 1))]);
    }
  }
}

/** A shaded ball of flesh with muscle rings across it, for the body. */
export function wormSegment(band = false) {
  const ramp = band ? BAND : WORM;
  const p = new Pix();
  groundShadow(p, 16, 27.5, 11.5, 2.6);
  layer(p, (q) => {
    flesh(q, sdCircle(16, 16, 11.5), ramp, band ? (x) => x === 11 || x === 20 : (x) => x === 15 || x === 9 || x === 22);
    // A slick of moisture.
    fill(q, sdEllipse(10.5, 10, 2.2, 1.3), ramp[ramp.length - 1]);
  }, 0.68, 0.45);
  return p;
}

/** The tail tip, pointing right: a tapering cone of rings. */
export function wormTail() {
  const p = new Pix();
  groundShadow(p, 13, 26.5, 12, 2.4);
  layer(p, (q) => {
    flesh(q, sdTaper(4, 16, 27, 16.5, 10, 1.2), WORM, (x) => x % 6 === 5 && x < 24);
    fill(q, sdEllipse(6, 10, 2, 1.1), WORM[6]);
  }, 0.68, 0.45);
  return p;
}

/**
 * The head, facing right: a bigger ball with a ringed maw full of teeth and
 * two eyes, yellow while it roams and red while it hunts; lunging, the jaws
 * gape.
 */
export function wormHead(angry: boolean, lunge = false): Pix {
  const p = new Pix();
  groundShadow(p, 15, 28, 13, 2.6);
  const head = sdCircle(14, 16, 13);
  layer(p, (q) => {
    flesh(q, head, WORM, (x) => x === 7 || x === 12);
    // The maw on the right: a dark hole ringed by teeth.
    const [mx, my, rx, ry] = lunge ? [24.5, 17, 5.5, 8] : [25, 17, 3.6, 5];
    fill(q, sdEllipse(mx, my, rx + 1.4, ry + 1.4), WORM[1]);
    fill(q, sdEllipse(mx, my, rx, ry), (x, y) => (x + y < mx + my - 2 ? '#2a0410' : '#14020a'));
    const teeth = lunge ? 9 : 6;
    for (let k = 0; k < teeth; k++) {
      const a = (k / teeth) * Math.PI * 2 + 0.3;
      const bx = mx + Math.cos(a) * rx, by = my + Math.sin(a) * ry;
      const tx = mx + Math.cos(a) * (rx - (lunge ? 3 : 2)), ty = my + Math.sin(a) * (ry - (lunge ? 3 : 2));
      line(Math.round(bx), Math.round(by), Math.round(tx), Math.round(ty), (x, y) => q.set(x, y, '#f4ead2'));
      q.set(Math.round(bx), Math.round(by), '#c8bca0');
    }
    if (lunge) for (let y = 13; y <= 21; y += 2) q.set(Math.round(mx + 2), y, '#ff4a5a');
    // Eyes up top, over the mouth, with brows when angry.
    const eye = angry ? ['#ff3a2a', '#ffd0a0', '#7a0a06'] : ['#ffd34a', '#fff6c8', '#8a5a00'];
    for (const [ex, ey] of [[16.5, 6.5], [22, 8.5]] as const) {
      fill(q, sdCircle(ex, ey, 2.3), WORM[0]);
      fill(q, sdCircle(ex, ey, 1.6), eye[0]);
      q.set(Math.floor(ex - 0.5), Math.floor(ey - 0.5), eye[1]);
      q.set(Math.floor(ex + 0.5), Math.floor(ey + 0.5), eye[2]);
      if (angry) line(Math.round(ex - 2.5), Math.round(ey - 3.5), Math.round(ex + 1.5), Math.round(ey - 2), (x, y) => q.set(x, y, WORM[0]));
    }
    fill(q, sdEllipse(7, 8, 2.4, 1.4), WORM[6]);
  }, 0.68, 0.45);
  return p;
}

/** A heap of fresh dirt where a worm is burrowing out, clods tumbling off it. */
export function wormMound() {
  const p = new Pix();
  const rand = rng(77), f = field(rand);
  groundShadow(p, 16, 26, 15, 3);
  const heap: Sdf = (x, y) => sdEllipse(16, 21, 14.5, 9.5)(x, y) + (at(f, Math.floor(x), Math.floor(y)) - 0.5) * 3;
  layer(p, (q) => {
    shape(q, heap, DIRT, { lo: 1, hi: 5, depth: 6, dither: 0.6 });
    // Clods and pebbles.
    for (let i = 0; i < 7; i++) {
      const a = rand() * Math.PI * 2, r = 5 + rand() * 7;
      const cx = 16 + Math.cos(a) * r * 1.3, cy = 20 + Math.sin(a) * r * 0.6;
      shape(q, sdCircle(cx, cy, 1.2 + rand() * 0.8), DIRT, { lo: 2, hi: 6, depth: 1 });
    }
    // The hole in the middle, its far lip lit.
    fill(q, sdEllipse(16, 18.5, 5.5, 2.6), DIRT[0]);
    fill(q, sdEllipse(16, 19.2, 4, 1.6), '#0a0604');
    for (let x = 12; x <= 19; x++) q.set(x, 21, DIRT[5]);
  }, 0.6, 0.45);
  return p;
}
