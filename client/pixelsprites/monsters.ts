// The monsters of the Dungeon arena: slimes, skeletons and bats, two
// animation frames each.

import { bitmap, clamp, N, Pix, SHADOW } from '../pixelkit.js';

// ----------------------------------------------------------------- monsters

/** Slime goo: deep teal shadows up to an acid-green highlight. */
const SLIME = ['#0d2a1c', '#14492a', '#1f6e35', '#33963c', '#58bd44', '#8fde5a', '#d4ff9a'];
const BONE = { o: '#1a1820', w: '#ece6d2', s: '#aaa18a', k: '#141218', r: '#ff4a3a', d: '#6e6656' };
/** Bat fur and wing membrane: inky purples, lit towards lavender. */
const BAT = ['#120c1c', '#241a36', '#3a2a55', '#56407a', '#7a5ea3', '#a68bd0'];

/** A shadow on the ground under a sprite, `rx` pixels wide. */
function groundShadow(p: Pix, rx: number, cy = 14.2) {
  for (let y = 12; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (((x - 7.5) / rx) ** 2 + ((y - cy) / 1.4) ** 2 <= 1) p.set(x, y, SHADOW);
    }
  }
}

/**
 * A slime: a glossy dome of goo with two beady eyes. Frame 1 is squashed
 * flat and wide, mid-hop.
 */
export function slime(frame: number): Pix {
  const p = new Pix();
  const [rx, ry] = frame ? [7.2, 4.6] : [6.2, 5.8];
  groundShadow(p, rx);
  const cx = 7.5, base = 14;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const dx = (x - cx) / rx, dy = (y - base) / ry;
      // A dome: the top half of an ellipse sitting on the floor.
      if (y > base || dx * dx + dy * dy > 1) continue;
      const edge = (x - cx) ** 2 / (rx - 1) ** 2 + (y - base) ** 2 / (ry - 1) ** 2 > 1 || y === base;
      if (edge) { p.set(x, y, SLIME[0]); continue; }
      const lit = -(0.6 * dx + 0.9 * dy) - 0.2;
      p.set(x, y, SLIME[clamp(Math.round(2 + lit * 2.6), 1, 5)]);
    }
  }
  const top = Math.round(base - ry);
  // A wet highlight on the top left.
  p.set(5, top + 2, SLIME[6]);
  p.set(4, top + 3, SLIME[6]);
  p.set(5, top + 3, SLIME[5]);
  // Eyes.
  const ey = top + Math.round(ry * 0.55);
  for (const ex of [6, 9]) {
    p.set(ex, ey, '#0a140e');
    p.set(ex, ey + 1, '#0a140e');
    p.set(ex, ey, '#f4fff0');
  }
  p.set(6, ey + 1, '#0a140e');
  p.set(9, ey + 1, '#0a140e');
  // Bubbles inside.
  p.set(10, base - 2, SLIME[5]);
  p.set(7, base - 1, SLIME[4]);
  return p;
}

const SKULL = [
  '     oooooo     ',
  '    owwwwwwo    ',
  '   owwwwwwwso   ',
  '   owkkwwkkso   ',
  '   owkrwwkrso   ',
  '   owwwkkwwso   ',
  '    owwwwwso    ',
  '     owkwko     ',
];
const SKELETON_BODY = [
  '    oooooooo    ',
  '   owwswwswso   ',
  '  owokswwskowo  ',
  '  ow owswso wo  ',
  '  oo owwwwo oo  ',
  '     owssso     ',
];
const SKELETON_LEGS = [
  ['     ow  wo     ', '     oo  oo     '],
  ['    ow    wo    ', '    oo    oo    '],
];

/**
 * A skeleton facing the viewer, red sparks in its eye sockets. The frames
 * are its two strides.
 */
export function skeleton(frame: number): Pix {
  const p = new Pix();
  groundShadow(p, 4.5);
  bitmap(p, [...SKULL, ...SKELETON_BODY, ...SKELETON_LEGS[frame & 1]], BONE);
  return p;
}

/** Whether (x, y) is inside the triangle a, b, c. */
function inTriangle(x: number, y: number, a: readonly number[], b: readonly number[], c: readonly number[]): boolean {
  const s = (p: readonly number[], q: readonly number[]) => (x - q[0]) * (p[1] - q[1]) - (p[0] - q[0]) * (y - q[1]);
  const d1 = s(a, b), d2 = s(b, c), d3 = s(c, a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

/**
 * A bat, wings spread: frame 0 with the wings raised, frame 1 with them
 * swept down. It hovers, so its shadow is small and far below.
 */
export function bat(frame: number): Pix {
  const p = new Pix();
  for (let y = 13; y < N; y++) {
    for (let x = 4; x < 12; x++) {
      if (((x - 7.5) / 3) ** 2 + ((y - 14.5) / 1) ** 2 <= 1) p.set(x, y, SHADOW);
    }
  }
  // The left wing; the right one is its mirror image.
  const shoulder = [6, 6.5], tip = frame ? [0.2, 10.5] : [0.2, 1.2], low = frame ? [3.5, 12.5] : [1.5, 9.5];
  const wing = (x: number, y: number) => {
    if (!inTriangle(x + 0.5, y + 0.5, shoulder, tip, low)) return false;
    // Scalloped trailing edge.
    const along = (x + 0.5 - low[0]) / (tip[0] - low[0]);
    const scallop = Math.abs(Math.sin(along * Math.PI * 2.5));
    const ex = low[0] + (tip[0] - low[0]) * along, ey = low[1] + (tip[1] - low[1]) * along;
    return Math.hypot(x + 0.5 - ex, y + 0.5 - ey) > scallop * 1.4 || along < 0.05;
  };
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < 8; x++) {
      if (!wing(x, y)) continue;
      const edge = !wing(x - 1, y) || !wing(x, y - 1) || !wing(x, y + 1);
      const k = edge ? 0 : clamp(Math.round(2 + (x / 8) * 1.5 - (y - 6) / 8), 1, 4);
      p.set(x, y, BAT[k]);
      p.set(15 - x, y, BAT[edge ? 0 : Math.max(1, k - 1)]);
    }
  }
  // Wing bones from the shoulder to the tip.
  for (let i = 1; i < 6; i++) {
    const x = Math.round(shoulder[0] + (tip[0] - shoulder[0]) * (i / 6));
    const y = Math.round(shoulder[1] + (tip[1] - shoulder[1]) * (i / 6));
    p.set(x, y, BAT[5]);
    p.set(15 - x, y, BAT[4]);
  }
  // The furry body, ears and red eyes.
  bitmap(p, [
    ' o  o ',
    ' fo of',
    'offffo',
    'ofrfro',
    'offffo',
    'offffo',
    ' offo ',
    '  oo  ',
  ], { o: BAT[0], f: BAT[2], r: '#ff5a4a' }, 5, 3);
  p.set(6, 6, BAT[4]);
  p.set(7, 8, '#f4f0ff');
  p.set(8, 8, '#f4f0ff');
  return p;
}

/** Every monster sprite as [kind - 1][frame]. */
export function monsterSprites(): Pix[][] {
  return [[slime(0), slime(1)], [skeleton(0), skeleton(1)], [bat(0), bat(1)]];
}
