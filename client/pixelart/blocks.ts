// Blocks in 3/4 view at 32x32: biome pillars and the two kinds of crate.

import { at, clamp, crack, field, fill, int, LAVA, line, N, pick, Pix, relief, rng, sdCircle, sdEllipse, STEEL } from '../pixelkit.js';
import { CRYPT, HAZARD, HULL, ICE, LIMESTONE, MOSS, NEON, OBSIDIAN, SNOW, STONE, TOP, WOOD } from './palette.js';
import type { Shade } from './palette.js';

// ------------------------------------------------------------------- blocks

/**
 * A solid block in 3/4 view with an outline, a two-pixel bevel lit on its
 * top-left rim, a bright lip where the top face meets the front, a darker
 * front face and a contact shadow at its foot. `top(x, y)` and
 * `front(x, y)` colour the interiors.
 */
function block(ramp: readonly string[], top: Shade, front: Shade) {
  const p = new Pix(), last = ramp.length - 1;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let c;
      const corner = (x <= 1 || x >= N - 2) && (y <= 1 || y === N - 1);
      if (x === 0 || y === 0 || x === N - 1 || y === N - 1 || corner) c = ramp[0];
      else if (y < TOP) {
        if (y === 1 || x === 1) c = ramp[last];
        else if (y === 2 || x === 2) c = ramp[last - 1];
        else if (x === N - 2) c = ramp[last - 4];
        else if (x === N - 3) c = ramp[last - 3];
        else if (y === TOP - 1) c = ramp[last - 1];
        else if (y === TOP - 2) c = ramp[last - 2];
        else c = top(x, y);
      } else if (y === N - 2) c = ramp[1]; // contact shadow at the base
      else if (y === N - 3) c = ramp[2];
      else if (x === 1) c = ramp[last - 2]; // the front's lit left edge
      else if (x === N - 2) c = ramp[1];
      else c = front(x, y);
      p.set(x, y, c);
    }
  }
  return p;
}

/**
 * Masonry: courses of `h` rows separated by mortar, each brick lit along
 * its top edge and shaded along its right, with joints staggered per
 * course. `f` adds a little tone variation per brick.
 */
const masonry = (ramp: readonly string[], f: ArrayLike<number>, y0: number, h: number, w: number, lit = 4, body = 3): Shade => (x: number, y: number) => {
  const row = Math.floor((y - y0) / (h + 1)), ry = (y - y0) % (h + 1);
  const bx = (x + (row % 2) * Math.floor(w / 2)) % w;
  if (ry === h || bx === 0) return ramp[1];
  if (ry === 0) return ramp[lit];
  if (bx === w - 1) return ramp[body - 1];
  return pick(ramp, (at(f, x, y) - 0.5) * 0.25 + 0.5, x, y, body - 1, body, 0.4);
};

/** Is (x, y) inside a block's top face, excluding its bevel? */
const onTop = (x: number, y: number) => x > 2 && x < N - 3 && y > 2 && y < TOP - 2;

/** Meadow stone. Kind 0: plain; 1: an engraved panel; 2: cracked and mossy. */
export function stonePillar(seed: number, kind: number) {
  const rand = rng(seed), f = field(rand), moss = field(rand);
  const top = (x: number, y: number) => pick(STONE, 0.55 + relief(f, x, y) * 2.2 + (at(f, x, y) - 0.5) * 0.4, x, y, 3, 6, 0.5);
  const p = block(STONE, top, masonry(STONE, f, TOP, 3, 11));
  if (kind === 1) {
    // Engraved panel: grooves are dark on the top-left edge and lit on the bottom-right.
    for (let x = 8; x <= 23; x++) { p.set(x, 6, STONE[2]); p.set(x, 7, STONE[3]); p.set(x, 17, STONE[7]); }
    for (let y = 6; y <= 17; y++) { p.set(8, y, STONE[2]); p.set(9, y, y > 6 ? STONE[3] : STONE[2]); p.set(23, y, STONE[7]); }
    // A carved sun in the middle.
    fill(p, sdCircle(16, 12, 3), (x, y) => (x + y < 27 ? STONE[2] : STONE[6]));
    fill(p, sdCircle(16, 12, 1.8), STONE[4]);
    for (const [x, y] of [[16, 7], [16, 16], [11, 12], [21, 12]]) p.set(x, y, STONE[2]);
  }
  if (kind === 2) {
    crack(rand, 6 + int(rand, 8), 3, 14, (x: number, y: number) => {
      if (!onTop(x, y)) return;
      p.set(x, y, STONE[1]);
      if (onTop(x + 1, y + 1)) p.set(x + 1, y + 1, STONE[6]);
    });
  }
  if (kind !== 1) {
    // Moss gathers on the top face and drips over the lip.
    const amount = kind === 2 ? 0.6 : 0.76;
    for (let y = 1; y < TOP; y++) {
      for (let x = 1; x < N - 1; x++) {
        if (at(moss, x, y) > amount) p.set(x, y, pick(MOSS, 0.5 + relief(moss, x, y) * 3, x, y, 1, 4, 0.6));
      }
    }
    for (let x = 2; x < N - 2; x++) {
      if (at(moss, x, TOP - 1) > amount) {
        const len = 1 + int(rand, 3);
        for (let k = 0; k < len; k++) p.set(x, TOP + k, MOSS[Math.max(0, 2 - k)]);
      }
    }
  }
  return p;
}

/** Stone under a snow cap, with icicles hanging off the lip. */
export function snowPillar(seed: number) {
  const rand = rng(seed), f = field(rand);
  const top = (x: number, y: number) => pick(SNOW, 0.62 + relief(f, x, y) * 2.6, x, y, 2, 5, 0.6);
  const p = block(STONE, top, masonry(STONE, f, TOP, 3, 10));
  // The cap is snow too, with a bulging edge over the lip and a blue shadow under it.
  for (let x = 1; x < N - 1; x++) {
    p.set(x, 1, x < 5 ? '#ffffff' : SNOW[5]);
    p.set(x, 2, SNOW[4]);
    p.set(x, TOP - 2, SNOW[4]);
    p.set(x, TOP - 1, SNOW[3]);
    const bulge = Math.sin(x * 0.7 + rand()) > 0.1;
    p.set(x, TOP, bulge ? SNOW[3] : SNOW[1]);
    if (bulge && x > 1 && x < N - 2) { p.set(x, TOP + 1, SNOW[2]); p.set(x, TOP + 2, SNOW[0]); } else p.set(x, TOP + 1, SNOW[0]);
  }
  for (let y = 1; y < TOP; y++) { p.set(1, y, SNOW[5]); p.set(2, y, SNOW[4]); }
  for (let y = 3; y < TOP; y++) { p.set(N - 2, y, SNOW[1]); p.set(N - 3, y, SNOW[2]); }
  // Icicles: bright and two pixels wide at the root, tapering to a dark tip.
  for (const x of [5, 11 + int(rand, 3), 19, 25 + int(rand, 2)]) {
    const len = 3 + int(rand, 5);
    for (let k = 0; k < len; k++) {
      p.set(x, TOP + 1 + k, ICE[clamp(6 - Math.floor((k * 5) / len), 2, 6)]);
      if (k < len / 2) p.set(x + 1, TOP + 1 + k, ICE[clamp(4 - Math.floor((k * 4) / len), 1, 4)]);
    }
  }
  // Sparkles on the cap.
  for (let i = 0; i < 4; i++) p.set(4 + int(rand, 24), 4 + int(rand, 14), '#ffffff');
  return p;
}

/** Carved limestone with strata. Kind 0 has a carved diamond glyph. */
export function sandPillar(seed: number, kind: number) {
  const rand = rng(seed), f = field(rand);
  const top = (x: number, y: number) => {
    const band = (y + Math.round(at(f, x, y) * 4)) % 7 === 0;
    return pick(LIMESTONE, (band ? 0.25 : 0.62) + relief(f, x, y) * 1.4, x, y, 3, 5, 0.5);
  };
  const front = (x: number, y: number) => {
    if (x === 15) return LIMESTONE[1];
    if (x === 16) return LIMESTONE[4];
    const strata = (y - TOP + Math.round(at(f, x, 0) * 1.5)) % 3;
    return strata === 0 ? LIMESTONE[4] : strata === 1 ? LIMESTONE[3] : LIMESTONE[2];
  };
  const p = block(LIMESTONE, top, front);
  if (kind === 0) {
    for (let y = 3; y < TOP - 2; y++) {
      for (let x = 3; x < N - 3; x++) {
        const d = Math.abs(x - 15.5) + Math.abs(y - 11);
        if (d > 6 && d <= 7) p.set(x, y, x + y < 27 ? LIMESTONE[2] : LIMESTONE[6]);
        else if (d > 7 && d <= 8) p.set(x, y, x + y < 27 ? LIMESTONE[6] : LIMESTONE[2]);
        else if (d <= 2.5) p.set(x, y, d <= 1 ? '#ffe89a' : x + y < 27 ? '#f2c45a' : '#b8822a'); // a gold inlay
      }
    }
  } else {
    // Wind has worn the far corner.
    for (let y = 2; y < 8; y++) for (let x = N - 3 - (7 - y); x < N - 1; x++) if (x > N - 8) p.set(x, y, y < 4 ? LIMESTONE[3] : LIMESTONE[2]);
    crack(rand, 8, 6, 10, (x: number, y: number) => { if (onTop(x, y)) { p.set(x, y, LIMESTONE[2]); p.set(x + 1, y, LIMESTONE[6]); } });
  }
  return p;
}

/** Faceted obsidian split by a glowing lava vein. */
export function obsidianPillar(seed: number, kind: number) {
  const rand = rng(seed), smooth = field(rand, [[2, 0.6], [4, 0.4]]);
  const facet = (x: number, y: number) => Math.floor(x * 0.22 + y * 0.42 + at(smooth, x, y) * 3) % 3;
  const top = (x: number, y: number) => {
    if (facet(x, y) !== facet(x - 1, y - 1)) return OBSIDIAN[5]; // glint along facet edges
    if (facet(x, y) !== facet(x - 2, y - 2)) return OBSIDIAN[4];
    return OBSIDIAN[1 + facet(x, y)];
  };
  const front = (x: number, y: number) => (y === TOP ? OBSIDIAN[3] : y === TOP + 1 ? OBSIDIAN[2] : (x + y) % 9 === 0 ? OBSIDIAN[3] : OBSIDIAN[1]);
  const p = block(OBSIDIAN, top, front);
  // The vein runs across the top, spills over the lip and down the front.
  const vein: [number, number][] = [];
  crack(rand, 8 + int(rand, 8), 4, kind === 0 ? 20 : 10, (x: number, y: number) => { if (onTop(x, y) || (y >= TOP - 3 && y < TOP && x > 2 && x < N - 3)) vein.push([x, y]); });
  const glow = (x: number, y: number) => { if (p.get(x, y) !== LAVA[3] && p.get(x, y) !== LAVA[4] && y < N - 2) p.set(x, y, '#5a1a14'); };
  for (const [x, y] of vein) for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) glow(x + dx, y + dy);
  for (const [x, y] of vein) { p.set(x, y, LAVA[3]); if (rand() < 0.3) p.set(x, y, LAVA[4]); }
  if (kind === 0 && vein.length) {
    const vx = vein[vein.length - 1][0];
    for (let y = TOP - 1; y < N - 1; y++) {
      p.set(vx, y, y >= N - 3 ? LAVA[1] : LAVA[3]);
      p.set(vx + 1, y, y >= N - 3 ? LAVA[0] : LAVA[2]);
    }
    p.set(vx - 1, N - 2, LAVA[1]); p.set(vx + 2, N - 2, LAVA[1]);
  }
  return p;
}

/**
 * Dungeon brick: a dark block of mortared bricks. Kind 1 holds a wall
 * sconce with a flickering flame on its front; kind 2 is cracked.
 */
export function cryptPillar(seed: number, kind: number) {
  const rand = rng(seed), f = field(rand);
  const p = block(CRYPT, masonry(CRYPT, f, 3, 4, 9, 5, 4), masonry(CRYPT, f, TOP, 3, 8, 4, 3));
  if (kind === 1) {
    // A torch in an iron bracket on the front face, its flame licking up over the lip.
    for (const [x, y] of [[14, TOP + 5], [15, TOP + 5], [16, TOP + 5], [17, TOP + 5], [15, TOP + 4], [16, TOP + 4], [15, TOP + 6]]) p.set(x, y, '#3c3640');
    p.set(14, TOP + 4, '#5a5260');
    for (const [x, y, k] of [[15, TOP + 3, 3], [16, TOP + 3, 4], [15, TOP + 2, 4], [16, TOP + 2, 5], [16, TOP + 1, 4], [15, TOP + 1, 3], [16, TOP, 3], [15, TOP - 1, 2], [16, TOP - 2, 4]] as const) p.set(x, y, LAVA[k]);
    // Warm light on the bricks around it.
    for (const [x, y] of [[13, TOP + 2], [18, TOP + 2], [13, TOP + 3], [18, TOP + 3]]) p.set(x, y, '#4a3436');
  }
  if (kind === 2) {
    crack(rand, 6 + int(rand, 12), 4, 12, (x: number, y: number) => {
      if (!onTop(x, y)) return;
      p.set(x, y, CRYPT[0]);
      if (onTop(x + 1, y + 1)) p.set(x + 1, y + 1, CRYPT[6]);
    });
  }
  return p;
}

/**
 * Station hull: a riveted gunmetal block with a panel seam across its
 * top and a cyan running light on its front. Kind 1 has a porthole full of
 * stars; kind 2 a hazard-lit antenna stub.
 */
export function hullPillar(seed: number, kind: number) {
  const rand = rng(seed), f = field(rand, [[2, 0.5], [8, 0.3], [16, 0.2]]);
  const top = (x: number, y: number) => {
    if (y === 11) return HULL[2]; // panel seam
    if (y === 12) return HULL[6];
    if (x === 16 && y < 11) return HULL[2];
    if (x === 17 && y < 11) return HULL[6];
    if ((x === 6 || x === N - 7) && (y === 6 || y === 16)) return HULL[7]; // rivets
    if ((x === 7 || x === N - 6) && (y === 7 || y === 17)) return HULL[2];
    return pick(HULL, at(f, x * 2, y) * 0.4 + 0.4, x, y, 3, 5, 0.4);
  };
  const front = (x: number, y: number) => {
    if (y === TOP + 3 && x > 4 && x < N - 5) return x % 5 === 0 ? NEON[2] : NEON[1]; // running light
    if ((y === TOP + 2 || y === TOP + 4) && x > 4 && x < N - 5) return NEON[0];
    if (y === TOP + 6 && x % 4 !== 0 && x > 2 && x < N - 3) return HULL[1]; // vent slits
    return y === TOP ? HULL[5] : HULL[3];
  };
  const p = block(HULL, top, front);
  if (kind === 1) {
    // A round porthole on the top face with stars inside.
    fill(p, sdEllipse(16, 9, 8, 6), HULL[1]);
    fill(p, sdEllipse(16, 9, 7, 5), (x, y) => (x + y < 23 ? HULL[7] : HULL[5]));
    fill(p, sdEllipse(16, 9, 5.8, 4), '#070a1a');
    fill(p, sdEllipse(15, 9.5, 3, 1.6), '#120c2e');
    for (let i = 0; i < 4; i++) p.set(12 + int(rand, 9), 7 + int(rand, 5), i ? '#8a96c8' : '#e8f0ff');
    p.set(12, 7, '#b8d0ff80');
  }
  if (kind === 2) {
    // An antenna stub with a blinking red light.
    for (let y = 3; y <= 16; y++) { p.set(23, y, HULL[6]); p.set(24, y, HULL[3]); }
    fill(p, sdEllipse(24, 17, 3, 1.5), HULL[1]);
    for (const [x, y, c] of [[23, 1, '#ff4a3a'], [24, 1, '#ff9a8a'], [23, 2, '#a81e1a'], [24, 2, '#ff4a3a']] as const) p.set(x, y, c);
  }
  return p;
}

/** The breakable wooden crate: a braced lid over a planked, iron-cornered front. */
export function crate(seed: number) {
  const rand = rng(seed), f = field(rand, [[2, 0.25], [8, 0.35], [16, 0.4]]);
  const grain = (x: number, y: number) => at(f, x, Math.floor(y / 2) * 2 + (x % 7 === 0 ? 1 : 0));
  const top = (x: number, y: number) => {
    if (x === N - 5 || y === TOP - 5) return WOOD[3]; // inner frame, shaded side
    if (x === N - 4 || y === TOP - 4) return WOOD[4];
    if (x === 4 || y === 4) return WOOD[6]; // inner frame, lit side
    if (x === 3 || y === 3) return WOOD[5];
    if (y === 9 || y === 14) return WOOD[2]; // plank seams
    if (y === 10 || y === 15) return WOOD[6];
    return pick(WOOD, grain(x, y) * 0.8 + 0.1, x, y, 4, 5, 0.5); // grain
  };
  const front = (x: number, y: number) => {
    if (x === 10 || x === 21) return WOOD[1];
    if (x === 11 || x === 22) return WOOD[4];
    if (y === TOP) return WOOD[5];
    return pick(WOOD, at(f, x * 3, y) * 0.8, x, y, 2, 3, 0.5);
  };
  const p = block(WOOD, top, front);
  // Diagonal brace across the lid, with its shadow.
  line(6, 6, 25, 16, (x: number, y: number) => {
    p.set(x, y - 1, WOOD[7]);
    p.set(x, y, WOOD[6]);
    p.set(x, y + 1, WOOD[5]);
    p.set(x, y + 2, WOOD[2]);
  });
  // Iron corner brackets with rivets.
  for (let y = TOP; y < N - 2; y++) {
    p.set(1, y, STEEL[5]); p.set(2, y, STEEL[5]); p.set(3, y, STEEL[4]); p.set(4, y, STEEL[2]);
    p.set(N - 5, y, STEEL[4]); p.set(N - 4, y, STEEL[3]); p.set(N - 3, y, STEEL[3]); p.set(N - 2, y, STEEL[2]);
  }
  for (const x of [2, N - 4]) for (const y of [TOP + 2, TOP + 6]) { p.set(x, y, STEEL[6]); p.set(x + 1, y + 1, STEEL[1]); }
  // Nails where the brace meets the frame.
  for (const [x, y] of [[6, 6], [25, 16], [25, 6], [6, 16]]) { p.set(x, y, STEEL[5]); p.set(x + 1, y + 1, WOOD[1]); }
  // A knot or two.
  for (let i = 0; i < 2; i++) {
    const x = 8 + int(rand, 16), y = 6 + int(rand, 2) * 6;
    p.set(x, y, WOOD[1]); p.set(x + 1, y, WOOD[2]); p.set(x, y - 1, WOOD[6]);
  }
  return p;
}

/** The armored crate: riveted steel, a warning lamp, and hazard stripes. */
export function armoredCrate(seed: number) {
  const rand = rng(seed), f = field(rand, [[2, 0.3], [8, 0.3], [16, 0.4]]);
  const top = (x: number, y: number) => {
    const inPlate = x > 4 && x < N - 5;
    if (y === 10 && inPlate) return STEEL[6]; // cross plate, lit edge
    if (y === 11 && inPlate) return STEEL[4];
    if (y === 12 && inPlate) return STEEL[1];
    if (x === 15 && y > 4 && y < TOP - 4) return STEEL[6];
    if (x === 16 && y > 4 && y < TOP - 4) return STEEL[4];
    if (x === 17 && y > 4 && y < TOP - 4) return STEEL[1];
    // Brushed metal: horizontal streaks.
    return pick(STEEL, at(f, x * 3, y) * 0.6 + 0.2, x, y, 3, 4, 0.3);
  };
  const front = (x: number, y: number) => {
    const stripe = (x + y) % 8 < 4;
    if (y === N - 4) return stripe ? HAZARD[1] : HAZARD[3];
    if (y === TOP) return stripe ? '#ffe680' : '#4a4a56';
    return stripe ? HAZARD[0] : HAZARD[2];
  };
  const p = block(STEEL, top, front);
  for (const [x, y] of [[4, 4], [N - 6, 4], [4, TOP - 5], [N - 6, TOP - 5]]) {
    p.set(x, y, STEEL[6]); p.set(x + 1, y, STEEL[5]); p.set(x, y + 1, STEEL[5]); p.set(x + 1, y + 1, STEEL[2]);
  }
  // Warning lamp where the plates cross, glowing.
  fill(p, sdCircle(16, 11.5, 3.6), (x, y) => (x + y < 27 ? '#7a3a10' : '#4a2008'));
  fill(p, sdCircle(16, 11.5, 2.6), (x, y) => (x + y < 26 ? '#ffb02e' : '#c2410c'));
  p.set(15, 10, '#fff4c2'); p.set(16, 10, '#ffe9a8'); p.set(15, 11, '#ffe9a8');
  return p;
}
