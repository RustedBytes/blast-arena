// Pixel-art tile generator. Every tile is painted pixel by pixel onto a
// 16x16 canvas and scaled up with smoothing off, so the pixels stay crisp.
//
// The design rules every tile follows:
// - One light source, from the top left. Bumps are lit on their top-left
//   side and shaded on the bottom right, and blocks cast shadows down-right.
// - Hue-shifted ramps: shadows lean cool (blue/purple), highlights warm
//   (yellow), so shading looks painted rather than just darker or lighter.
// - Floors are quiet (low contrast, mid value) and seamless, so players,
//   bombs and items always read first. Blocks are loud and outlined.
// - Blocks are in 3/4 view: a lit top face over a darker front face, so the
//   maze reads as raised walls instead of a flat grid.
// - Each biome has its own look: mossy stone in the meadow, snow-capped
//   blocks with icicles, carved sandstone, obsidian with lava veins.
//
// Everything comes from a seeded generator, so a seed always gives the same
// tile set. `buildPixelTiles(seed)` returns every tile plus the overlays the
// renderer composes per cell: block shadows and soft biome borders.

import {
  LAVA, N, Pix, SHADOW, STEEL, at, clamp, crack, field, int, line, pick, relief, rng, wrap,
} from './pixelkit.js';

/** Rows 0..TOP-1 are a block's top face; rows TOP..N-2 its front face. */
const TOP = 11;

// ------------------------------------------------------------------ palette
// Each ramp runs dark to light, shifting hue along the way.

const GRASS = ['#1b3a30', '#24523a', '#2e6a3c', '#3c8240', '#539b45', '#78b74e', '#a9d468'];
const SNOW = ['#56688f', '#7489b2', '#9db1d3', '#c3d3e8', '#e3ecf6', '#ffffff'];
const SAND = ['#6e4128', '#93603a', '#b7824c', '#d2a160', '#e6bf7c', '#f5dca2'];
const ASH = ['#120e17', '#1d1621', '#2a1f2b', '#382934', '#4a3842', '#5e4a50'];
const STONE = ['#191a28', '#272b3e', '#383f58', '#4d5772', '#67748f', '#8796ae', '#aebbcd', '#d8e0ea'];
const MOSS = ['#203a26', '#2f5530', '#46753a', '#679a45', '#8fbd57'];
const SANDSTONE = ['#3d2220', '#5e3428', '#844c33', '#a86843', '#c78a57', '#e0ac70', '#f2cf94'];
// Desert walls are pale limestone (cool shadows, cream tops), so they never
// read as the warm wooden crates around them.
const LIMESTONE = ['#2a2433', '#4a4257', '#6e6577', '#968b94', '#bdb0a8', '#dccfbf', '#f3ead8'];
const OBSIDIAN = ['#08060c', '#130e1b', '#1f1729', '#2e2240', '#45345e', '#5d4b7d', '#7a68a3'];
const WOOD = ['#2e1712', '#4f2a1b', '#743f23', '#98582c', '#b8733a', '#d4974f', '#ecbd72', '#f8dea0'];
const ICE = ['#1f4c82', '#2f6fae', '#4f98d4', '#7fc0ea', '#b2e2f8', '#e2f7ff', '#ffffff'];
const RUBBER = ['#0e0f14', '#17191f', '#22252d', '#2e323c', '#3d4250'];
const PORTAL = ['#1a0d33', '#2f1763', '#4c2a99', '#7448d6', '#a07cff', '#cdb8ff', '#f2ecff'];
const FLOWERS = [['#fff7e8', '#ffd75e'], ['#ff9ec4', '#fff1a8'], ['#9fd2ff', '#ffffff']];
const HAZARD = ['#f2c230', '#a8861f', '#26262e', '#15151b'];
const RUNE = '#7ff6ff';

// ------------------------------------------------------------------- floors

/** Meadow grass. Kind 0: tufts; 1: pebbles and clover; 2: wildflowers. */
function grass(seed, kind) {
  const rand = rng(seed), f = field(rand), p = new Pix();
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      p.set(x, y, pick(GRASS, at(f, x, y) * 0.8 + relief(f, x, y) * 0.9 + 0.1, x, y, 2, 4, 0.8));
    }
  }
  if (kind === 1) {
    // A darker clover patch and a couple of pebbles.
    const cx = int(rand, N), cy = int(rand, N);
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [-1, 0], [0, -1], [2, 1], [1, 2]]) p.wset(cx + dx, cy + dy, GRASS[2]);
    p.wset(cx, cy - 1, GRASS[4]);
    for (let i = 0; i < 2; i++) pebble(p, int(rand, N), int(rand, N), STONE, GRASS[1]);
  }
  for (let i = 0, n = kind === 0 ? 7 : 4; i < n; i++) tuft(p, int(rand, N), int(rand, N));
  if (kind === 2) {
    for (let i = 0; i < 3; i++) {
      const [petal, heart] = FLOWERS[int(rand, FLOWERS.length)];
      const x = int(rand, N), y = int(rand, N);
      p.wset(x + 1, y + 1, GRASS[1]);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) p.wset(x + dx, y + dy, petal);
      p.wset(x, y, heart);
    }
  }
  return p;
}

/** A little three-blade tuft, lit on its tips. */
function tuft(p, x, y) {
  p.wset(x, y + 1, GRASS[1]);
  p.wset(x + 1, y + 1, GRASS[1]);
  p.wset(x - 1, y, GRASS[4]);
  p.wset(x, y, GRASS[3]);
  p.wset(x + 1, y, GRASS[4]);
  p.wset(x - 1, y - 1, GRASS[5]);
  p.wset(x + 1, y - 1, GRASS[6]);
  p.wset(x, y - 2, GRASS[6]);
}

/** A 2x2 pebble with a highlight and a cast shadow. */
function pebble(p, x, y, ramp, shadow) {
  p.wset(x + 2, y + 1, shadow);
  p.wset(x + 1, y + 2, shadow);
  p.wset(x + 2, y + 2, shadow);
  p.wset(x, y, ramp[ramp.length - 2]);
  p.wset(x + 1, y, ramp[ramp.length - 3]);
  p.wset(x, y + 1, ramp[ramp.length - 3]);
  p.wset(x + 1, y + 1, ramp[ramp.length - 4]);
}

/** Wind-sculpted snow. Kind 1 adds a trail of little footprints. */
function snow(seed, kind) {
  const rand = rng(seed), f = field(rand, [[2, 0.6], [4, 0.3], [8, 0.1]]), p = new Pix();
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      p.set(x, y, pick(SNOW, 0.55 + relief(f, x, y) * 2.2 + (at(f, x, y) - 0.5) * 0.3, x, y, 2, 5, 0.9));
    }
  }
  if (kind === 1) {
    const x = int(rand, N), y = int(rand, N);
    for (let k = 0; k < 5; k++) p.wset(x + k * 3, y + (k % 2) * 2, SNOW[2]);
  }
  // Glints catch the light.
  for (let i = 0; i < 3; i++) {
    const x = int(rand, N), y = int(rand, N);
    p.wset(x, y, '#ffffff');
    p.wset(x + 1, y + 1, '#b8ecff');
  }
  return p;
}

/** Desert sand with wind ripples. Kind 1 has a dry sprig instead of pebbles. */
function sand(seed, kind) {
  const rand = rng(seed), f = field(rand), p = new Pix();
  const phase = rand() * Math.PI * 2;
  // Integer frequencies along x and y keep the ripples seamless.
  const h = (x, y) => Math.sin((2 * Math.PI * (x + 3 * y)) / N + phase + at(f, x, y) * 3);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const lit = h(x + 1, y + 1) - h(x - 1, y - 1);
      p.set(x, y, pick(SAND, 0.5 + lit * 0.3 + (at(f, x, y) - 0.5) * 0.3, x, y, 1, 5, 0.7));
    }
  }
  if (kind === 1) {
    const x = int(rand, N), y = int(rand, N);
    p.wset(x + 1, y + 1, SAND[1]);
    p.wset(x, y, '#7d6a2c');
    p.wset(x - 1, y - 1, '#a8963f');
    p.wset(x + 1, y - 1, '#a8963f');
    p.wset(x, y - 2, '#c9b45a');
  } else {
    for (let i = 0; i < 2; i++) pebble(p, int(rand, N), int(rand, N), SANDSTONE, SAND[1]);
  }
  return p;
}

/**
 * Volcanic basalt: cooled columns (a seamless Voronoi pattern on the
 * torus). Kind 0, the common one, is calm with a few loose embers; kind 1
 * has lava glowing in one crack.
 */
function ash(seed, kind) {
  const rand = rng(seed), lavaF = field(rand), p = new Pix();
  const pts = Array.from({ length: 6 }, () => [rand() * N, rand() * N, rand()]);
  const edge = new Uint8Array(N * N), cell = new Float32Array(N * N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let d1 = Infinity, d2 = Infinity, tone = 0;
      for (const [px, py, t] of pts) {
        const dx = Math.min(Math.abs(x - px), N - Math.abs(x - px));
        const dy = Math.min(Math.abs(y - py), N - Math.abs(y - py));
        const d = Math.hypot(dx, dy);
        if (d < d1) { d2 = d1; d1 = d; tone = t; } else if (d < d2) d2 = d;
      }
      edge[y * N + x] = d2 - d1 < 1.1 ? 1 : 0;
      cell[y * N + x] = tone;
    }
  }
  const isEdge = (x, y) => edge[wrap(y) * N + wrap(x)] === 1;
  const lavaAt = kind === 0 ? 2 : 0.84;
  const isLava = (x, y) => isEdge(x, y) && at(lavaF, x, y) > lavaAt;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (isLava(x, y)) {
        p.set(x, y, at(lavaF, x, y) > lavaAt + 0.08 ? LAVA[3] : LAVA[2]);
      } else if (isEdge(x, y)) {
        p.set(x, y, ASH[0]);
      } else if (isLava(x - 1, y) || isLava(x + 1, y) || isLava(x, y - 1) || isLava(x, y + 1)) {
        p.set(x, y, '#6b2a22'); // lava light on the rock
      } else if (isEdge(x - 1, y) || isEdge(x, y - 1)) {
        p.set(x, y, ASH[4]); // top-left rim of a column catches the light
      } else if (isEdge(x + 1, y) || isEdge(x, y + 1)) {
        p.set(x, y, ASH[1]);
      } else {
        p.set(x, y, pick(ASH, cell[y * N + x] * 0.6 + (at(lavaF, x, y) - 0.5) * 0.3 + 0.2, x, y, 2, 4, 0.6));
      }
    }
  }
  if (kind === 0) {
    for (let i = 0; i < 2; i++) p.wset(int(rand, N), int(rand, N), LAVA[2]);
  }
  return p;
}

// ------------------------------------------------------------------- blocks

/**
 * A solid block in 3/4 view with an outline, a lit top-left rim, a bright
 * lip where the top face meets the front, and a darker front face.
 * `top(x, y)` and `front(x, y)` colour the interiors.
 */
function block(ramp, top, front) {
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
const masonry = (ramp, seams) => (x, y) => {
  if (seams.includes(x)) return ramp[1];
  return y === TOP ? ramp[4] : ramp[3];
};

/** Is (x, y) inside a block's top face, excluding its rim? */
const onTop = (x, y) => x > 1 && x < N - 2 && y > 1 && y < TOP - 1;

/** Meadow stone. Kind 0: plain; 1: an engraved panel; 2: cracked and mossy. */
function stonePillar(seed, kind) {
  const rand = rng(seed), f = field(rand), moss = field(rand);
  const top = (x, y) => pick(STONE, 0.55 + relief(f, x, y) * 1.5 + (at(f, x, y) - 0.5) * 0.35, x, y, 3, 6, 0.6);
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
    crack(rand, 3 + int(rand, 4), 2, 7, (x, y) => {
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
function snowPillar(seed) {
  const rand = rng(seed), f = field(rand);
  const top = (x, y) => pick(SNOW, 0.6 + relief(f, x, y) * 2, x, y, 2, 5, 0.8);
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
function sandPillar(seed, kind) {
  const rand = rng(seed), f = field(rand);
  const top = (x, y) => {
    const band = (y + Math.round(at(f, x, y) * 2)) % 4 === 0;
    return pick(LIMESTONE, (band ? 0.25 : 0.65) + relief(f, x, y), x, y, 3, 5, 0.6);
  };
  const front = (x, y) => (x === 7 ? LIMESTONE[1] : y % 2 ? LIMESTONE[2] : LIMESTONE[3]);
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
    crack(rand, 4, 3, 5, (x, y) => { if (onTop(x, y)) p.set(x, y, LIMESTONE[2]); });
  }
  return p;
}

/** Faceted obsidian split by a glowing lava vein. */
function obsidianPillar(seed, kind) {
  const rand = rng(seed), f = field(rand);
  const facet = (x, y) => Math.floor(x * 0.7 + y * 1.3 + at(f, x, y) * 3) % 3;
  const top = (x, y) => {
    if (facet(x, y) !== facet(x - 1, y - 1)) return OBSIDIAN[4]; // glint along facet edges
    return OBSIDIAN[1 + facet(x, y)];
  };
  const front = (x, y) => (y === TOP ? OBSIDIAN[2] : OBSIDIAN[1]);
  const p = block(OBSIDIAN, top, front);
  // The vein runs across the top, spills over the lip and down the front.
  let vx = 4 + int(rand, 4);
  crack(rand, vx, 3, kind === 0 ? 7 : 4, (x, y) => {
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
function crate(seed) {
  const rand = rng(seed), f = field(rand, [[2, 0.3], [8, 0.7]]);
  const top = (x, y) => {
    if (x === N - 3 || y === TOP - 2) return WOOD[4]; // inner frame, shaded side
    if (x === 2 || y === 2) return WOOD[6]; // inner frame, lit side
    if (y === 5 || y === 7) return WOOD[3]; // plank seams
    return pick(WOOD, at(f, x, y), x, y, 4, 5, 0.6); // grain
  };
  const front = (x, y) => {
    if (x === 5 || x === 10) return WOOD[2];
    return y === TOP ? WOOD[4] : WOOD[3];
  };
  const p = block(WOOD, top, front);
  // Diagonal brace across the lid, with its shadow.
  line(3, 3, 12, 8, (x, y) => {
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
function armoredCrate(seed) {
  const rand = rng(seed), f = field(rand, [[2, 0.4], [8, 0.6]]);
  const top = (x, y) => {
    if (y === 5 && x > 2 && x < N - 3) return STEEL[5]; // cross plate, lit edge
    if (y === 6 && x > 2 && x < N - 3) return STEEL[2];
    if ((x === 7 || x === 8) && y > 2 && y < TOP - 2) return x === 7 ? STEEL[5] : STEEL[3];
    // Brushed metal: horizontal streaks.
    return pick(STEEL, at(f, x * 3, y) * 0.7 + 0.15, x, y, 3, 4, 0.5);
  };
  const front = (x, y) => {
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

// ---------------------------------------------------------------- specials

/** Seamless ice: diagonal shine bands, white fractures, trapped bubbles. */
function ice(seed) {
  const rand = rng(seed), f = field(rand, [[2, 0.7], [4, 0.3]]), streak = field(rand), p = new Pix();
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const d = (x + y) % N;
      let c;
      if ((d === 4 || d === 5) && at(streak, x, y) > 0.3) c = d === 4 ? ICE[5] : ICE[4];
      else if (d === 11 && at(streak, x, y) > 0.45) c = ICE[4];
      else c = pick(ICE, 0.35 + (at(f, x, y) - 0.5) * 0.6, x, y, 2, 3, 0.9);
      p.set(x, y, c);
    }
  }
  for (let i = 0; i < 2; i++) {
    crack(rand, int(rand, N), int(rand, N), 5 + int(rand, 3), (x, y) => {
      p.wset(x, y, ICE[6]);
      p.wset(x, y + 1, ICE[1]);
    });
  }
  for (let i = 0; i < 2; i++) p.wset(int(rand, N), int(rand, N), ICE[1]);
  return p;
}

/**
 * A belt running left to right between riveted rails. The renderer
 * rotates it and animates chevrons on top. Seamless along the belt.
 */
function conveyor() {
  const p = new Pix();
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let c;
      if (y === 0) c = STEEL[5];
      else if (y === 1) c = x % 8 === 3 ? STEEL[6] : STEEL[3];
      else if (y === N - 2) c = x % 8 === 3 ? STEEL[5] : STEEL[3];
      else if (y === N - 1) c = STEEL[1];
      else if (y === 2 || y === N - 3) c = RUBBER[0];
      else if (x % 4 === 0) c = RUBBER[0]; // gap between slats
      else if (x % 4 === 1) c = RUBBER[4]; // leading edge catches the light
      else c = y < N / 2 ? RUBBER[3] : RUBBER[2];
      p.set(x, y, c);
    }
  }
  return p;
}

/** A stone ring around a swirling portal, with glowing runes. Transparent outside. */
function teleport(seed) {
  const rand = rng(seed), p = new Pix(), c = 7.5;
  const twist = rand() * Math.PI;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const dx = x - c, dy = y - c, d = Math.hypot(dx, dy);
      if (d > 7.6) continue;
      if (d > 5.6) {
        const lit = -(dx + dy) / (d * Math.SQRT2); // 1 facing the top left
        p.set(x, y, d > 7 && lit < 0 ? STONE[1] : STONE[clamp(Math.round(4 + lit * 2), 2, 7)]);
      } else if (d > 4.8) {
        const lit = (dx + dy) / (d * Math.SQRT2); // the inner wall faces the other way
        p.set(x, y, STONE[clamp(Math.round(2 + lit), 1, 3)]);
      } else {
        const swirl = 0.5 + 0.5 * Math.sin(3 * Math.atan2(dy, dx) + d * 1.4 + twist);
        p.set(x, y, d < 1.1 ? PORTAL[6] : pick(PORTAL, swirl * 0.55 + (1 - d / 4.8) * 0.6, x, y, 1, 6, 0.8));
      }
    }
  }
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4;
    p.set(Math.round(c + Math.cos(a) * 6.6), Math.round(c + Math.sin(a) * 6.6), k % 2 ? RUNE : '#d8fdff');
  }
  // Drop shadow on the floor, down and to the right.
  for (let y = N - 1; y >= 0; y--) {
    for (let x = N - 1; x >= 0; x--) {
      if (!p.filled(x, y) && p.filled(x - 1, y - 1)) p.set(x, y, SHADOW);
    }
  }
  return p;
}

// ---------------------------------------------------------------- overlays

/**
 * Shadow a raised neighbour casts on a floor cell. Bits of `mask`: 1 = a
 * block to the north, 2 = to the west, 4 = to the north-west. Coverage is
 * combined before painting, so overlapping shadows never double up.
 */
function shadow(mask) {
  const p = new Pix();
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      let cov = 0; // 2 = solid, 1 = dithered fringe
      if (mask & 1) cov = Math.max(cov, y <= 2 ? (x === 0 ? 1 : 2) : y === 3 ? 1 : 0);
      if (mask & 2) cov = Math.max(cov, x <= 2 ? (y === 0 ? 1 : 2) : x === 3 ? 1 : 0);
      if (mask & 4) cov = Math.max(cov, x <= 2 && y <= 2 ? 2 : 0);
      if (cov === 2 || (cov === 1 && (x + y) % 2 === 0)) p.set(x, y, SHADOW);
    }
  }
  return p;
}

/**
 * A neighbouring biome's floor spilling over one edge of a cell, with a
 * wavy, seamless border line. `dir`: 0 north, 1 east, 2 south, 3 west.
 */
function fringe(source, border, dir, seed) {
  const rand = rng(seed), p = new Pix();
  const a = rand() * Math.PI * 2, b = rand() * Math.PI * 2;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const along = dir % 2 === 0 ? x : y;
      const dist = [y, N - 1 - x, N - 1 - y, x][dir];
      // Whole waves per tile, so neighbouring cells on the same border line up.
      const depth = 1.8 + 0.9 * Math.sin((2 * Math.PI * along) / N + a) + 0.6 * Math.sin((6 * Math.PI * along) / N + b);
      if (dist < depth - 1) {
        const i = (y * N + x) * 4, s = source.d;
        p.d[i] = s[i]; p.d[i + 1] = s[i + 1]; p.d[i + 2] = s[i + 2]; p.d[i + 3] = 255;
      } else if (dist < depth) {
        p.set(x, y, border);
      }
    }
  }
  return p;
}

/**
 * Which biome's floor spills over a border, by biome index (0 meadow,
 * 1 snow, 2 desert, 3 volcano): the higher rank covers the lower.
 */
export const FRINGE_RANK = [2, 3, 1, 0];

/**
 * Builds the pixel-art tile set from a seed. Returns canvases keyed like
 * the classic sprites (so either style can be swapped in), plus:
 * - `floors[biome]` and `pillars[biome]`: variants per biome
 * - `shadows[mask]`: shadow overlays, see `shadow()`
 * - `edges[biome][dir]`: border fringes, see `fringe()`
 */
export function buildPixelTiles(seed = 1) {
  const s = (k) => (Math.imul(seed, 0x9e3779b1) ^ Math.imul(k, 0x85ebca6b)) >>> 0;
  const floors = [
    [grass(s(1), 0), grass(s(2), 1), grass(s(3), 2)],
    [snow(s(4), 0), snow(s(5), 1)],
    [sand(s(6), 0), sand(s(7), 1)],
    [ash(s(8), 0), ash(s(9), 1)],
  ];
  const pillars = [
    [stonePillar(s(10), 0), stonePillar(s(11), 1), stonePillar(s(12), 2)],
    [snowPillar(s(13)), snowPillar(s(14))],
    [sandPillar(s(15), 0), sandPillar(s(16), 1)],
    [obsidianPillar(s(17), 0), obsidianPillar(s(18), 1)],
  ];
  const borders = [GRASS[1], SNOW[2], SAND[2], ASH[1]];
  const cv = (p) => p.canvas();
  return {
    floor: cv(floors[0][0]),
    floor_b: cv(floors[0][1]),
    floor_c: cv(floors[0][2]),
    floor_snow: cv(floors[1][0]),
    floor_sand: cv(floors[2][0]),
    floor_ash: cv(floors[3][0]),
    pillar: cv(pillars[0][0]),
    crate: cv(crate(s(19))),
    crate_armored: cv(armoredCrate(s(20))),
    ice: cv(ice(s(21))),
    conveyor: cv(conveyor()),
    teleport: cv(teleport(s(22))),
    floors: floors.map((vs) => vs.map(cv)),
    pillars: pillars.map((vs) => vs.map(cv)),
    shadows: [null, 1, 2, 3, 4, 5, 6, 7].map((m) => m && cv(shadow(m))),
    edges: floors.map((vs, b) => [0, 1, 2, 3].map((d) => cv(fringe(vs[0], borders[b], d, s(30 + b * 4 + d))))),
  };
}
