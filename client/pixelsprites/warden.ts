// The vault's Warden at 32x32: a stone golem, calm or enraged.

import { crack, fill, groundShadow, layer, line, Pix, rng, sdBox, sdCircle, sdPoly, sdUnion, shape } from '../pixelkit.js';

// ------------------------------------------------------------------ warden

const STONE = ['#16171d', '#2c2f38', '#454955', '#626774', '#838a97', '#aab1bc', '#d3d8de'];
const GOLD = ['#4a2e06', '#94600e', '#d69a26', '#ffd25a', '#fff1b0', '#ffffff'];
const MOSS = ['#203a26', '#2f5530', '#46753a', '#679a45'];

/**
 * The vault's Warden, facing the viewer: a hulking stone golem with a gold
 * crown, a glowing rune on its chest and huge fists. Enraged, the rune and
 * eyes burn red and cracks glow through the stone.
 */
export function warden(rage: boolean): Pix {
  const p = new Pix();
  groundShadow(p, 16, 29.5, 15, 2.4);
  const glow = rage ? ['#7a1206', '#ff3a1a', '#ffb08a', '#fff0e0'] : ['#6a4a06', '#ffd25a', '#fff6c8', '#ffffff'];
  // Legs.
  layer(p, (q) => {
    for (const x of [10.5, 21.5]) shape(q, sdBox(x, 26, 3.6, 3.4, 1.4), darker(STONE), { depth: 2 });
  });
  // The body: a great rounded block of stone with moss on its shoulders.
  const body = sdBox(16, 16, 10.5, 9.5, 4);
  layer(p, (q) => {
    shape(q, body, STONE, { lo: 1, hi: 5, depth: 6, bounce: 0.3 });
    // Masonry seams.
    for (const [x0, y0, x1, y1] of [[7, 13, 12, 13], [20, 13, 25, 13], [9, 19, 13, 19], [19, 20, 24, 20], [16, 21, 16, 24]]) {
      line(x0, y0, x1, y1, (x, y) => { if (body(x + 0.5, y + 0.5) < -1) { q.set(x, y, STONE[1]); q.set(x, y + 1, STONE[4]); } });
    }
    // Cracks, glowing when enraged.
    const rand = rng(9);
    for (const [sx, sy] of [[8, 16], [22, 22], [11, 23]]) {
      crack(rand, sx, sy, 5, (x, y) => { if (body(x + 0.5, y + 0.5) < -1) q.set(x, y, rage ? glow[1] : STONE[1]); });
    }
    // The chest rune: a diamond in a ring.
    fill(q, sdCircle(16, 17, 4.2), STONE[1]);
    fill(q, sdPoly([[16, 13.5], [19, 17], [16, 20.5], [13, 17]]), glow[1]);
    fill(q, sdPoly([[16, 15], [17.6, 17], [16, 19], [14.4, 17]]), glow[2]);
    q.set(15, 16, glow[3]);
    for (let x = 9; x <= 13; x++) if (x % 2) q.set(x, 8, MOSS[2]);
    q.set(10, 9, MOSS[1]); q.set(22, 8, MOSS[3]); q.set(23, 8, MOSS[2]); q.set(22, 9, MOSS[1]);
  });
  // The head: a heavy brow with eyes burning in a dark slit, under a crown.
  layer(p, (q) => {
    shape(q, sdBox(16, 7.5, 6, 4.5, 2), STONE, { lo: 1, hi: 6, depth: 3 });
    for (let x = 11; x <= 20; x++) q.set(x, 8, STONE[0]);
    for (const x of [12, 13, 18, 19]) q.set(x, 8, glow[x === 12 || x === 18 ? 2 : 1]);
    for (const x of [12, 19]) q.set(x, 9, glow[0]);
    const crown = sdUnion(0, sdBox(16, 3.4, 6.4, 1.3, 0.4), sdPoly([[9.6, 3], [10.5, -0.5], [12.5, 3]]), sdPoly([[14, 3], [16, -1], [18, 3]]), sdPoly([[19.5, 3], [21.5, -0.5], [22.4, 3]]));
    shape(q, crown, GOLD, { lo: 1, hi: 4, depth: 1.5, spec: GOLD[5] });
    q.set(15, 3, '#ff3a4a'); q.set(16, 3, '#ff8a8a');
  });
  // Huge fists hanging at its sides.
  layer(p, (q) => {
    for (const s of [-1, 1]) {
      const cx = 16 + s * 12;
      shape(q, sdUnion(1.5, sdCircle(cx, 19.5, 4.4), sdCircle(cx - s * 1.5, 12, 3.6)), STONE, { lo: 1, hi: 6, depth: 3.5 });
      for (const ky of [18, 20]) line(cx - 2, ky, cx + 1, ky, (x, y) => q.set(x, y, STONE[2]));
    }
  });
  return p;
}

/** A ramp a step darker (for the legs, in the body's shadow). */
function darker(ramp: readonly string[]): string[] {
  return [ramp[0], ...ramp.slice(0, -1)];
}
