// Blocks in 3/4 view: biome pillars and the two kinds of crate.

import { at, clamp, crack, field, int, LAVA, line, N, pick, Pix, relief, rng, STEEL } from '../pixelkit.js';
import { HAZARD, ICE, LIMESTONE, MOSS, OBSIDIAN, SNOW, STONE, TOP, WOOD } from './palette.js';
import type { Shade } from './palette.js';

// ------------------------------------------------------------------- blocks

/**
 * A solid block in 3/4 view with an outline, a lit top-left rim, a bright
 * lip where the top face meets the front, and a darker front face.
 * `top(x, y)` and `front(x, y)` colour the interiors.
 */
function block(ramp: readonly string[], top: Shade, front: Shade) {
  const p = new Pix(), last = ramp.length - 1;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let c;
      if (x === 0 || y === 0 || x === N - 1 || y === N - 1) c = ramp[0];
      else if (y < TOP) {
        if (y === 1 || x === 1) c = ramp[last];
        else if (x === N - 2) c = ramp[last - 3];
        else if (y === TOP - 1) c = ramp[last - 1];
        else c = top(x, y);
      } else if (y === N - 2) c = ramp[1]; // contact shadow at the base
      else c = front(x, y);
      p.set(x, y, c);
    }
  }
  return p;
}

/** Plain front face: a single course of blocks split by mortar seams. */
const masonry = (ramp: readonly string[], seams: readonly number[]): Shade => (x: number, y: number) => {
  if (seams.includes(x)) return ramp[1];
  return y === TOP ? ramp[4] : ramp[3];
};

/** Is (x, y) inside a block's top face, excluding its rim? */
const onTop = (x: number, y: number) => x > 1 && x < N - 2 && y > 1 && y < TOP - 1;

/** Meadow stone. Kind 0: plain; 1: an engraved panel; 2: cracked and mossy. */
export function stonePillar(seed: number, kind: number) {
  const rand = rng(seed), f = field(rand), moss = field(rand);
  const top = (x: number, y: number) => pick(STONE, 0.55 + relief(f, x, y) * 1.5 + (at(f, x, y) - 0.5) * 0.35, x, y, 3, 6, 0.6);
  const p = block(STONE, top, masonry(STONE, [5, 11]));
  if (kind === 1) {
    // Engraved panel: grooves are dark on the top-left edge and lit on the bottom-right.
    for (let x = 4; x <= 11; x++) { p.set(x, 3, STONE[2]); p.set(x, 8, STONE[6]); }
    for (let y = 3; y <= 8; y++) { p.set(4, y, STONE[2]); p.set(11, y, STONE[6]); }
    p.set(11, 3, STONE[4]);
    p.set(4, 8, STONE[4]);
    for (const [x, y] of [[7, 5], [8, 5], [7, 6], [8, 6]]) p.set(x, y, STONE[3]);
    p.set(7, 5, STONE[5]);
  }
  if (kind === 2) {
    crack(rand, 3 + int(rand, 4), 2, 7, (x: number, y: number) => {
      if (!onTop(x, y)) return;
      p.set(x, y, STONE[1]);
      if (onTop(x + 1, y + 1)) p.set(x + 1, y + 1, STONE[5]);
    });
  }
  if (kind !== 1) {
    // Moss gathers on the top face and drips over the lip.
    const amount = kind === 2 ? 0.55 : 0.75;
    for (let y = 1; y < TOP; y++) {
      for (let x = 1; x < N - 1; x++) {
        if (at(moss, x, y) > amount) p.set(x, y, pick(MOSS, 0.5 + relief(moss, x, y) * 2, x, y, 1, 4, 0.7));
      }
    }
    for (let x = 2; x < N - 2; x++) {
      if (at(moss, x, TOP - 1) > amount) {
        p.set(x, TOP, MOSS[2]);
        if (rand() < 0.5) p.set(x, TOP + 1, MOSS[1]);
      }
    }
  }
  return p;
}

/** Stone under a snow cap, with icicles hanging off the lip. */
export function snowPillar(seed: number) {
  const rand = rng(seed), f = field(rand);
  const top = (x: number, y: number) => pick(SNOW, 0.6 + relief(f, x, y) * 2, x, y, 2, 5, 0.8);
  const p = block(STONE, top, masonry(STONE, [4, 10]));
  // The cap is snow too, with a bulging edge over the lip and a blue shadow under it.
  for (let x = 1; x < N - 1; x++) {
    p.set(x, 1, x < 3 ? '#ffffff' : SNOW[5]);
    p.set(x, TOP - 1, SNOW[4]);
    if (x > 1 && x < N - 2 && rand() < 0.4) {
      p.set(x, TOP, SNOW[3]);
      p.set(x, TOP + 1, SNOW[1]);
    } else {
      p.set(x, TOP, SNOW[1]);
    }
  }
  for (let y = 1; y < TOP; y++) p.set(1, y, SNOW[5]);
  for (let y = 2; y < TOP; y++) p.set(N - 2, y, SNOW[2]);
  // Icicles: bright at the root, tapering to a dark tip.
  for (const x of [3, 6 + int(rand, 2), 11, 13]) {
    const len = 1 + int(rand, 3);
    for (let k = 0; k < len; k++) p.set(x, TOP + 1 + k, ICE[clamp(5 - k * 2, 2, 5)]);
  }
  return p;
}

/** Carved limestone with strata. Kind 0 has a carved diamond glyph. */
export function sandPillar(seed: number, kind: number) {
  const rand = rng(seed), f = field(rand);
  const top = (x: number, y: number) => {
    const band = (y + Math.round(at(f, x, y) * 2)) % 4 === 0;
    return pick(LIMESTONE, (band ? 0.25 : 0.65) + relief(f, x, y), x, y, 3, 5, 0.6);
  };
  const front = (x: number, y: number) => (x === 7 ? LIMESTONE[1] : y % 2 ? LIMESTONE[2] : LIMESTONE[3]);
  const p = block(LIMESTONE, top, front);
  if (kind === 0) {
    for (let y = 2; y < TOP - 1; y++) {
      for (let x = 2; x < N - 2; x++) {
        const d = Math.abs(x - 7.5) + Math.abs(y - 5.5);
        if (d > 2.5 && d <= 3.5) p.set(x, y, x + y < 13 ? LIMESTONE[2] : LIMESTONE[6]);
        else if (d <= 1) p.set(x, y, '#d9a441'); // a gold inlay
      }
    }
  } else {
    // Wind has worn the far corner.
    for (const [x, y] of [[13, 2], [12, 2], [13, 3], [12, 9], [13, 8], [13, 9]]) p.set(x, y, LIMESTONE[2]);
    crack(rand, 4, 3, 5, (x: number, y: number) => { if (onTop(x, y)) p.set(x, y, LIMESTONE[2]); });
  }
  return p;
}

/** Faceted obsidian split by a glowing lava vein. */
export function obsidianPillar(seed: number, kind: number) {
  const rand = rng(seed), f = field(rand);
  const facet = (x: number, y: number) => Math.floor(x * 0.7 + y * 1.3 + at(f, x, y) * 3) % 3;
  const top = (x: number, y: number) => {
    if (facet(x, y) !== facet(x - 1, y - 1)) return OBSIDIAN[4]; // glint along facet edges
    return OBSIDIAN[1 + facet(x, y)];
  };
  const front = (_x: number, y: number) => (y === TOP ? OBSIDIAN[2] : OBSIDIAN[1]);
  const p = block(OBSIDIAN, top, front);
  // The vein runs across the top, spills over the lip and down the front.
  let vx = 4 + int(rand, 4);
  crack(rand, vx, 3, kind === 0 ? 7 : 4, (x: number, y: number) => {
    if (!onTop(x, y)) return;
    p.set(x, y, LAVA[3]);
    if (onTop(x - 1, y)) p.set(x - 1, y, LAVA[1]);
    vx = x;
  });
  if (kind === 0) {
    for (let y = TOP; y < N - 1; y++) p.set(vx, y, y === N - 2 ? LAVA[1] : LAVA[3]);
    p.set(vx + 1, N - 2, LAVA[2]);
  }
  return p;
}

/** The breakable wooden crate: a braced lid over a planked, iron-cornered front. */
export function crate(seed: number) {
  const rand = rng(seed), f = field(rand, [[2, 0.3], [8, 0.7]]);
  const top = (x: number, y: number) => {
    if (x === N - 3 || y === TOP - 2) return WOOD[4]; // inner frame, shaded side
    if (x === 2 || y === 2) return WOOD[6]; // inner frame, lit side
    if (y === 5 || y === 7) return WOOD[3]; // plank seams
    return pick(WOOD, at(f, x, y), x, y, 4, 5, 0.6); // grain
  };
  const front = (x: number, y: number) => {
    if (x === 5 || x === 10) return WOOD[2];
    return y === TOP ? WOOD[4] : WOOD[3];
  };
  const p = block(WOOD, top, front);
  // Diagonal brace across the lid, with its shadow.
  line(3, 3, 12, 8, (x: number, y: number) => {
    p.set(x, y, WOOD[6]);
    p.set(x, y + 1, WOOD[2]);
  });
  // Iron corner brackets and nails.
  for (let y = TOP; y < N - 1; y++) {
    p.set(1, y, STEEL[5]); p.set(2, y, STEEL[4]);
    p.set(N - 3, y, STEEL[3]); p.set(N - 2, y, STEEL[2]);
  }
  for (const [x, y] of [[2, TOP + 1], [N - 3, TOP + 1]]) p.set(x, y, STEEL[6]);
  for (const [x, y] of [[3, 3], [12, 8], [12, 3], [3, 8]]) p.set(x, y, WOOD[1]);
  // A knot or two.
  for (let i = 0; i < 2; i++) p.set(4 + int(rand, 8), 4 + int(rand, 2) * 2, WOOD[2]);
  return p;
}

/** The armored crate: riveted steel, a warning lamp, and hazard stripes. */
export function armoredCrate(seed: number) {
  const rand = rng(seed), f = field(rand, [[2, 0.4], [8, 0.6]]);
  const top = (x: number, y: number) => {
    if (y === 5 && x > 2 && x < N - 3) return STEEL[5]; // cross plate, lit edge
    if (y === 6 && x > 2 && x < N - 3) return STEEL[2];
    if ((x === 7 || x === 8) && y > 2 && y < TOP - 2) return x === 7 ? STEEL[5] : STEEL[3];
    // Brushed metal: horizontal streaks.
    return pick(STEEL, at(f, x * 3, y) * 0.7 + 0.15, x, y, 3, 4, 0.5);
  };
  const front = (x: number, y: number) => {
    const stripe = (x + y) % 4 < 2;
    if (y === N - 3) return stripe ? HAZARD[1] : HAZARD[3];
    return stripe ? HAZARD[0] : HAZARD[2];
  };
  const p = block(STEEL, top, front);
  for (const [x, y] of [[2, 2], [13, 2], [2, 9], [13, 9]]) {
    p.set(x, y, STEEL[6]);
    p.set(x + 1, y + 1, STEEL[1]);
  }
  // Warning lamp where the plates cross.
  p.set(7, 5, '#ffe9a8');
  p.set(8, 5, '#ffb02e');
  p.set(7, 6, '#ff7a1a');
  p.set(8, 6, '#c2410c');
  return p;
}
