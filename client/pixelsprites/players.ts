// Players (three views, three walk frames) and the cosmetic hats, drawn at
// 32x32 from lit shapes. Each body part is its own outlined layer, so a
// darker contour separates the head from the body and the arms from the
// torso, the way a pixel artist would draw it by hand.

import {
  fill, groundShadow, layer, lightOf, mix, N, Pix, sdBox, sdCapsule, sdCircle, sdEllipse, sdPoly, sdRing, sdTaper, sdUnion,
  shadeOf, shape, STEEL, UP, cssColor,
} from '../pixelkit.js';

/** Which way a player sprite faces. */
export type PlayerView = 'down' | 'up' | 'side';

// ------------------------------------------------------------------ players

const GLASS = ['#070a18', '#0d1430', '#152048', '#1f3266', '#2f4c8c'];
const GLOVE = ['#6d6a80', '#a9a6b8', '#d9d6df', '#f4f1e8', '#ffffff'];
const BOOT = ['#100c18', '#1c1726', '#2a2433', '#3c3448', '#56495e'];
const GOLD = ['#5a3200', '#9a6008', '#d69a1a', '#ffd34a', '#fff1a8'];

/** The player's colours as a six-step ramp, dark to light, hue-shifted. */
function suitRamp([body, shade]: readonly [string, string]): string[] {
  const mid = cssColor(body), dark = cssColor(shade);
  return [shadeOf(dark, 0.45), dark, mix(dark, mid, 0.55), mid, lightOf(mid, 0.38), lightOf(mid, 0.72)];
}

/** One leg and boot. `lift` raises the foot (a step), `dx` moves it sideways. */
function leg(q: Pix, suit: readonly string[], x: number, lift: number, dx = 0) {
  const foot = 29.5 - lift;
  shape(q, sdCapsule(x, 25, x + dx * 0.5, foot - 2, 2.1), suit, { lo: 1, hi: 3, depth: 2 });
  shape(q, sdBox(x + dx + 0.6, foot, 3, 1.8, 1.4), BOOT, { depth: 2, spec: BOOT[4] });
}

/**
 * One player frame: `view` is down, up or side; `frame` 0 stands, 1 and 2
 * step with one foot or the other. Side views face right.
 */
export function player(colors: readonly [string, string], view: PlayerView, frame: number): Pix {
  const p = new Pix(), suit = suitRamp(colors);
  const side = view === 'side';
  groundShadow(p, 16, 30.2, side ? 7.5 : 9.5, 2);
  // Legs: standing, or one foot lifted mid-step.
  layer(p, (q) => {
    if (side) {
      const swing = frame === 0 ? 0 : frame === 1 ? 3 : -3;
      leg(q, suit, 15 - swing * 0.6, frame === 1 ? 0 : frame ? 1.5 : 0, -swing);
      leg(q, suit, 16 + swing * 0.6, frame === 2 ? 0 : frame ? 1.5 : 0, swing);
    } else {
      leg(q, suit, 12.5, frame === 1 ? 2 : 0);
      leg(q, suit, 19.5, frame === 2 ? 2 : 0);
    }
  });
  // Body, belt and backpack.
  layer(p, (q) => {
    const torso = side ? sdBox(15.5, 21.5, 5.2, 4.6, 3) : sdBox(16, 21.5, 6.6, 4.6, 3.2);
    shape(q, torso, suit, { depth: 4 });
    if (view === 'up') {
      // A steel backpack with a red status light and a coiled fuse.
      shape(q, sdBox(16, 20.5, 4.6, 3.6, 1.6), STEEL, { lo: 2, hi: 6, depth: 2.5 });
      for (let x = 13; x <= 18; x++) q.set(x, 19, STEEL[1]);
      q.set(14, 21, '#ff4a3a'); q.set(15, 21, '#ffb0a0'); q.set(14, 22, '#a81e1a');
      q.set(18, 21, STEEL[6]); q.set(18, 22, STEEL[5]);
    } else {
      // A gold belt with a buckle, lit along its top.
      const b0 = side ? 10.5 : 9.5, b1 = side ? 20.5 : 22.5;
      fill(q, sdBox((b0 + b1) / 2, 23.5, (b1 - b0) / 2, 1, 0), (x, y) => (y === 23 ? GOLD[3] : x < 16 ? GOLD[2] : GOLD[1]));
      const bx = side ? 17 : 14.5;
      fill(q, sdBox(bx + 1.5, 23.5, 1.6, 1.6, 0.5), (x, y) => (x === Math.floor(bx) + 1 && y === 22 ? GOLD[4] : GOLD[3]));
      q.set(Math.floor(bx) + 1, 23, GOLD[0]); q.set(Math.floor(bx) + 2, 23, GOLD[1]);
      if (side) shape(q, sdBox(10, 21, 2.2, 3.4, 1.2), STEEL, { lo: 2, hi: 5, depth: 2 }); // backpack edge
    }
  });
  // Arms and gloves.
  layer(p, (q) => {
    if (side) {
      const swing = frame === 0 ? 0 : frame === 1 ? -1.5 : 1.5;
      shape(q, sdCapsule(15.5, 19.5, 17.5 + swing, 22.5, 1.8), suit, { lo: 2, hi: 5, depth: 2 });
      shape(q, sdCircle(18.5 + swing, 23, 2.5), GLOVE, { depth: 2.2, spec: GLOVE[4] });
    } else {
      for (const s of [-1, 1]) {
        const sw = frame === 0 ? 0 : (frame === 1 ? 1 : -1) * s * 0.8;
        shape(q, sdCapsule(16 + s * 5.5, 19.5, 16 + s * 7.6, 22 + sw, 1.8), suit, { lo: 2, hi: 5, depth: 2 });
        shape(q, sdCircle(16 + s * 8, 22.6 + sw, 2.6), GLOVE, { depth: 2.2, spec: GLOVE[4] });
      }
    }
  });
  // The helmet, with radio pods over the ears and the visor.
  layer(p, (q) => {
    const cx = side ? 15 : 16, helmet = sdCircle(cx, 10, 8.8);
    shape(q, helmet, suit, { depth: 5, spec: suit[5], shine: 0.985 });
    if (view === 'up') {
      // A lighter stripe over the crown of the helmet.
      shape(q, sdBox(16, 8, 1.6, 7.5, 1.4), suit, { lo: 3, hi: 5, depth: 2, bias: 0.15, clip: (x, y) => helmet(x + 0.5, y + 0.5) < -1 });
    }
    // Radio pods: steel discs with a light.
    const pods = side ? [cx - 6.8] : [cx - 8.4, cx + 8.4];
    for (const px of pods) {
      shape(q, sdCircle(px, 12, 2.4), STEEL, { lo: 2, hi: 6, depth: 1.8 });
      q.set(Math.floor(px), 11, view === 'up' ? '#ff6a5a' : '#7ff6ff');
    }
    if (view !== 'up') {
      const visor = side ? sdBox(cx + 5.2, 12, 4.4, 3.6, 2.6) : sdBox(cx, 12.2, 6.4, 3.8, 3);
      const inner = (x: number, y: number) => visor(x + 0.5, y + 0.5) < -0.9;
      // A dark rubber gasket round the glass.
      fill(q, visor, () => shadeOf(suit[1], 0.5));
      shape(q, sdBox(side ? cx + 5.4 : cx, 12.3, side ? 3.6 : 5.6, 3, 2.2), GLASS, { depth: 3, bias: -0.08, clip: inner });
      // Eyes glowing behind the glass.
      const eyes = side ? [cx + 6.5] : [cx - 2.8, cx + 2.8];
      for (const ex of eyes) {
        const x = Math.floor(ex);
        for (let y = 11; y <= 13; y++) q.set(x, y, y === 11 ? '#ffffff' : '#bdf6ff');
        q.set(x + 1, 12, '#4ad8ff');
        q.set(x + 1, 13, '#2aa6d6');
      }
      // A reflection streak across the glass, top left.
      const gx = side ? cx + 2.5 : cx - 4.5;
      q.set(Math.floor(gx), 10, '#9ff4ff');
      q.set(Math.floor(gx) + 1, 10, '#e8fbff');
      q.set(Math.floor(gx), 11, '#5fb8e0');
      q.set(Math.floor(gx) + 3, 10, '#5fb8e0');
    }
  });
  return p;
}

// --------------------------------------------------------------------- hats

/** A hat sprite and its height in art pixels. */
export interface PixelHat { canvas: HTMLCanvasElement; rows: number }
/** A hat drawn into the top `rows` of a sprite, centred on x = 16. */
type HatArt = readonly [paint: (q: Pix) => void, rows: number];

const RED = ['#2a0606', '#5c100c', '#8c1f1a', '#c22e26', '#e8473a', '#ff8a7a', '#ffd0c4'];
const PINK = ['#3a0a34', '#6a1a5e', '#a83292', '#de56c8', '#ff7af0', '#ffc0f8', '#ffffff'];
const CROWN = ['#4a2a00', '#7a4a00', '#b57a0a', '#e8ad1c', '#ffd34a', '#fff1a8', '#ffffff'];
const SILK = ['#06070a', '#0f1016', '#1a1c24', '#262a36', '#3a3f50', '#565d74'];
const HALO = ['#c99a1a', '#ffd34a', '#ffe680', '#fff4c0', '#ffffff'];

export const HATS: readonly (HatArt | null)[] = [
  null,
  // A red cap with its brim to the side and a button on top.
  [(q) => {
    shape(q, sdBox(22, 9.2, 7, 1.4, 1.2), RED, { lo: 1, hi: 4, depth: 1.5 });
    shape(q, sdEllipse(16, 9.5, 8, 8), RED, { depth: 4, spec: RED[6], clip: (_x, y) => y <= 9 });
    for (let y = 3; y <= 9; y++) q.set(16, y, RED[2]);
    shape(q, sdCircle(16, 2.2, 1.6), RED, { lo: 3, hi: 6, depth: 1.5 });
  }, 11],
  // A party cone with stripes and a pompom.
  [(q) => {
    const cone = sdPoly([[16, 1.5], [23.5, 16], [8.5, 16]]);
    shape(q, cone, PINK, { lo: 1, hi: 5, depth: 3 });
    fill(q, cone, (x, y) => ((x + y * 0.6) % 6 < 1.6 && y > 4 ? (x < 16 ? '#ffffff' : '#ffe0fa') : null));
    shape(q, sdBox(16, 15.5, 8, 1, 0.8), PINK, { lo: 4, hi: 6, depth: 1 });
    shape(q, sdCircle(16, 2, 2.4), CROWN, { lo: 3, hi: 6, depth: 2 });
  }, 17],
  // Devil horns, curling up and out.
  [(q) => {
    for (const s of [-1, 1]) {
      shape(q, sdUnion(0.6, sdTaper(16 + s * 5, 11, 16 + s * 8.5, 5, 2.6, 1.6), sdTaper(16 + s * 8.5, 5, 16 + s * 7.5, 0.5, 1.6, 0.4)), RED, { depth: 2, spec: RED[6] });
    }
  }, 12],
  // A floating halo.
  [(q) => {
    const ring = sdRing(16, 3.5, 7.5, 1.1, 0.34);
    fill(q, ring, (x, y) => HALO[Math.max(0, Math.min(4, Math.round(2 + (y < 4 ? 1.2 : -0.8) + (x < 14 ? 0.8 : 0))))]);
  }, 7],
  // A jewelled crown.
  [(q) => {
    const crown = sdUnion(0, sdBox(16, 10, 8.5, 3, 0.8), sdPoly([[7.5, 8], [9, 1.5], [12.5, 8]]), sdPoly([[12, 8], [16, 0.5], [20, 8]]), sdPoly([[19.5, 8], [23, 1.5], [24.5, 8]]));
    shape(q, crown, CROWN, { depth: 2.5, spec: CROWN[6] });
    for (let x = 8; x <= 24; x++) q.set(x, 10, x % 2 ? CROWN[2] : CROWN[1]);
    for (const [x, c] of [[11, '#ff3a4a'], [16, '#3a9aff'], [21, '#ff3a4a']] as const) {
      q.set(x, 9, c); q.set(x + 1, 9, c); q.set(x, 8, '#ffffff'); q.set(x + 1, 10, shadeOf(c, 0.4));
    }
    for (const x of [9, 16, 23]) q.set(x, 1, '#ffffff');
  }, 14],
  // A tall top hat with a red band.
  [(q) => {
    shape(q, sdBox(16, 7.5, 6, 7, 1), SILK, { depth: 3, bias: 0.05 });
    for (let x = 10; x <= 21; x++) for (const y of [11, 12]) q.set(x, y, y === 11 ? RED[4] : RED[2]);
    shape(q, sdEllipse(16, 15, 10.5, 2), SILK, { depth: 1.5, bias: 0.1 });
    for (let y = 2; y <= 9; y++) q.set(11, y, SILK[5]);
  }, 17],
];

/** A hat as a 2x canvas (32 wide, art at the top, centred), plus its art-pixel height. */
export function hat(art: HatArt): PixelHat {
  return { canvas: hatPix(art).canvas(UP), rows: Math.min(N, art[1] + 1) };
}

/** A hat's pixels, outlined. */
export function hatPix([paint]: HatArt): Pix {
  const p = new Pix();
  layer(p, paint);
  return p;
}
