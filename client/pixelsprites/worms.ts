// The worms of the Worms arena: body segments, the saddle band, tail,
// head (calm, angry, lunging) and the burrowing mound.

import { bitmap, clamp, N, Pix, rng, SHADOW } from '../pixelkit.js';

// ------------------------------------------------------------------- worms

// Worm flesh: plum shadows up to a pale coral highlight.
const WORM = ['#1d0818', '#3d1030', '#651a45', '#922a55', '#c2465f', '#ea7476', '#ffbfa3'];
const DIRT = ['#2a1a10', '#4a2f1a', '#6e4826', '#94673a', '#b98b55'];
// The saddle band (clitellum): swollen, paler, warmer.
const BAND = ['#2a0c18', '#6b2236', '#a8434d', '#d86a62', '#f39a83', '#ffd2b4'];

/** A shaded ball of flesh with a darker ring across it, for the body. */
export function wormSegment(band = false) {
  const ramp = band ? BAND : WORM;
  const p = new Pix();
  for (let y = 11; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (((x - 7.5) / 5.5) ** 2 + ((y - 13.5) / 1.6) ** 2 <= 1) p.set(x, y, SHADOW);
    }
  }
  const cx = 7.5, cy = 8, r = 5.8;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy);
      if (d > r) continue;
      if (d > r - 1) { p.set(x, y, ramp[0]); continue; }
      const lit = -(0.6 * dx + 0.8 * dy) / r;
      let k = clamp(Math.round(3 + lit * 2.4), 1, ramp.length - 2);
      // A ring of muscle round the middle (two on the band).
      if (band ? Math.abs(Math.abs(dx) - 2) < 0.6 : Math.abs(dx) < 1) k = Math.max(1, k - 2);
      p.set(x, y, ramp[k]);
    }
  }
  p.set(5, 5, ramp[ramp.length - 1]);
  p.set(4, 6, ramp[ramp.length - 1]);
  return p;
}

/** The tail tip, pointing right: a tapering cone of rings. */
export function wormTail() {
  const p = new Pix();
  for (let y = 11; y < N; y++) {
    for (let x = 0; x < 13; x++) {
      if (((x - 6) / 6) ** 2 + ((y - 13) / 1.3) ** 2 <= 1) p.set(x, y, SHADOW);
    }
  }
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      // Radius shrinks from 5 at the left edge to a point at x = 14.
      const r = 5 * (1 - x / 14);
      const dy = y - 8;
      if (r <= 0 || Math.abs(dy) > r) continue;
      if (Math.abs(dy) > r - 1 || x >= 13) { p.set(x, y, WORM[0]); continue; }
      const lit = -dy / Math.max(1, r);
      let k = clamp(Math.round(3 + lit * 2), 1, 5);
      if (x % 4 === 3) k = Math.max(1, k - 1);
      p.set(x, y, WORM[k]);
    }
  }
  p.set(2, 5, WORM[6]);
  return p;
}

/**
 * The head, facing right: a bigger ball with a jaw of teeth and two eyes,
 * yellow while it roams and red while it hunts; lunging, the jaws gape.
 */
export function wormHead(angry: boolean, lunge = false): Pix {
  const p = new Pix();
  for (let y = 11; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (((x - 7.5) / 6.5) ** 2 + ((y - 14) / 1.7) ** 2 <= 1) p.set(x, y, SHADOW);
    }
  }
  const cx = 7, cy = 8, r = 6.6;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy);
      if (d > r) continue;
      if (d > r - 1) { p.set(x, y, WORM[0]); continue; }
      const lit = -(0.6 * dx + 0.8 * dy) / r;
      p.set(x, y, WORM[clamp(Math.round(3.2 + lit * 2.4), 1, 6)]);
    }
  }
  // An open mouth with a row of teeth at the front; a lunge gapes, all fangs.
  if (lunge) {
    bitmap(p, ['oot ', 'ommt', 'omm ', 'ommm', 'omm ', 'ommt', 'oot '], { o: WORM[0], m: '#2a0410', t: '#f4ead2' }, 10, 5);
  } else {
    bitmap(p, [' oo', 'omt', 'om ', 'omt', ' oo'], { o: WORM[0], m: '#2a0410', t: '#f4ead2' }, 11, 6);
  }
  // Eyes up top, over the mouth.
  const eye = angry ? ['#ff3a2a', '#ffd0a0'] : ['#ffd34a', '#fff6c8'];
  bitmap(p, ['oo', 'ab'], { o: WORM[0], a: eye[0], b: eye[1] }, 8, 3);
  bitmap(p, ['oo', 'ab'], { o: WORM[0], a: eye[0], b: eye[1] }, 11, 4);
  if (angry) {
    // Furrowed brows.
    p.set(8, 2, WORM[0]);
    p.set(12, 3, WORM[0]);
  }
  return p;
}

/** A heap of fresh dirt where a worm is burrowing out. */
export function wormMound() {
  const p = new Pix();
  const rand = rng(77);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const e = ((x - 7.5) / 7) ** 2 + ((y - 10) / 4.6) ** 2;
      if (e > 1) continue;
      const lit = -((x - 7.5) * 0.5 + (y - 8) * 0.9) / 6;
      const k = e > 0.8 ? 0 : clamp(Math.round(2 + lit * 1.6 + (rand() - 0.5)), 1, 4);
      p.set(x, y, DIRT[k]);
    }
  }
  // The hole in the middle.
  for (let x = 5; x <= 10; x++) p.set(x, 9, DIRT[0]);
  for (let x = 6; x <= 9; x++) p.set(x, 10, '#120a06');
  return p;
}
