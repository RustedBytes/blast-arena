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
//
// The parts live in client/pixelart/.

import { armoredCrate, crate, cryptPillar, hullPillar, obsidianPillar, sandPillar, snowPillar, stonePillar } from './pixelart/blocks.js';
import { ash, crypt, grass, sand, snow, space } from './pixelart/floors.js';
import { fringe, shadow } from './pixelart/overlays.js';
import { ASH, CRYPT, DECK, GRASS, SAND, SNOW } from './pixelart/palette.js';
import { conveyor, ice, teleport } from './pixelart/specials.js';
import { Pix } from './pixelkit.js';

// ------------------------------------------------------------------- export

/**
 * Which biome's floor spills over a border, by biome index (0 meadow,
 * 1 snow, 2 desert, 3 volcano, 4 crypt, 5 space): the higher rank covers
 * the lower.
 */
export const FRINGE_RANK = [2, 3, 1, 0, 4, 5];

/**
 * Builds the pixel-art tile set from a seed. Returns canvases keyed like
 * the classic sprites (so either style can be swapped in), plus:
 * - `floors[biome]` and `pillars[biome]`: variants per biome
 * - `shadows[mask]`: shadow overlays, see `shadow()`
 * - `edges[biome][dir]`: border fringes, see `fringe()`
 */
export function buildPixelTiles(seed = 1) {
  const s = (k: number): number => (Math.imul(seed, 0x9e3779b1) ^ Math.imul(k, 0x85ebca6b)) >>> 0;
  const floors = [
    [grass(s(1), 0), grass(s(2), 1), grass(s(3), 2)],
    [snow(s(4), 0), snow(s(5), 1)],
    [sand(s(6), 0), sand(s(7), 1)],
    [ash(s(8), 0), ash(s(9), 1)],
    [crypt(s(40), 0), crypt(s(41), 0), crypt(s(42), 1), crypt(s(43), 2)],
    [space(s(50), 0), space(s(51), 0), space(s(52), 0), space(s(53), 1), space(s(54), 2)],
  ];
  const pillars = [
    [stonePillar(s(10), 0), stonePillar(s(11), 1), stonePillar(s(12), 2)],
    [snowPillar(s(13)), snowPillar(s(14))],
    [sandPillar(s(15), 0), sandPillar(s(16), 1)],
    [obsidianPillar(s(17), 0), obsidianPillar(s(18), 1)],
    [cryptPillar(s(44), 0), cryptPillar(s(45), 0), cryptPillar(s(46), 1), cryptPillar(s(47), 2)],
    [hullPillar(s(55), 0), hullPillar(s(56), 0), hullPillar(s(57), 1), hullPillar(s(58), 2)],
  ];
  const borders = [GRASS[1], SNOW[2], SAND[2], ASH[1], CRYPT[1], DECK[1]];
  const cv = (p: Pix): HTMLCanvasElement => p.canvas();
  return {
    floor: cv(floors[0][0]),
    floor_b: cv(floors[0][1]),
    floor_c: cv(floors[0][2]),
    floor_snow: cv(floors[1][0]),
    floor_sand: cv(floors[2][0]),
    floor_ash: cv(floors[3][0]),
    floor_space: cv(floors[5][0]),
    pillar: cv(pillars[0][0]),
    crate: cv(crate(s(19))),
    crate_armored: cv(armoredCrate(s(20))),
    ice: cv(ice(s(21))),
    conveyor: cv(conveyor()),
    teleport: cv(teleport(s(22))),
    floors: floors.map((vs) => vs.map(cv)),
    pillars: pillars.map((vs) => vs.map(cv)),
    shadows: Array.from({ length: 8 }, (_, mask) => (mask ? cv(shadow(mask)) : null)),
    edges: floors.map((vs, b) => [0, 1, 2, 3].map((d) => cv(fringe(vs[0], borders[b], d, s(30 + b * 4 + d))))),
  };
}
export type PixelTiles = ReturnType<typeof buildPixelTiles>;
