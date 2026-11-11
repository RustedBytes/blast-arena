// Constants and small helpers shared by the render layers.

import type { GameMap } from '../state.js';

export const T_FLOOR = 0, T_WALL = 1, T_CRATE = 2, T_ICE = 3, T_TELEPORT = 8, T_ARMORED = 9, T_BUILT = 10;
// Ability objects (src/game/abilities.rs): portal pair colours by owner,
// particle colours for gas and dashes.
export const PORTAL_COLORS = ['#4ad0ff', '#ff9a3a', '#b07aff', '#4affc8', '#ff5ad0', '#ffe14a'];
// The Warden's tuning the client needs to draw its telegraphs (mirrors
// `game::guard::GuardTuning`).
export const WARDEN_SLAM_WINDUP = 14, WARDEN_SLAM_RADIUS = 2, WARDEN_CHARGE_WINDUP = 12, WARDEN_CHARGE_CELLS = 7;

/** Tiles walked per step of the walk cycle. */
export const STRIDE = 0.55;
/** Particle colour of a blaster bolt: `C_BOLT + colour code` (1..5). */
export const C_BOLT = 25;
export const C_GAS = 14, C_GAS_DARK = 15, C_DASH = 16, C_WORM = 17, C_DUST = 19, C_SLIME = 20, C_BONE = 22, C_BAT = 24;
export const CONVEYOR_DIR = [0, 0, 0, 0, 1, 2, 3, 4];
// Rotation for flame arms / conveyors, indexed by direction code - 1.
export const ARM_ANGLES = [-Math.PI / 2, 0, Math.PI / 2, Math.PI];
export const ARM_DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];
export const CHUNK = 8;            // tiles per chunk side
export const CHUNK_PX = 64;        // pixels per tile inside a chunk canvas
export const MAX_CHUNKS = 48;      // chunk canvases kept (LRU)
export const REPAINTS_PER_FRAME = 2; // changed chunks repainted per frame
export const DECALS = 512;         // scorch marks ring buffer
export const DECAL_LIFE = 4000;    // ms
export const POOL = 512;           // pooled entities per frame
export const MINIMAP_MS = 250;     // minimap overlay refresh period
// Item halo colour by rarity.
export const HALO = [null, '#ffffff', '#ffffff', '#7fd0ff', '#7fd0ff', '#c08bff', '#c08bff', '#ffd34a', '#ff7af0',
  '#7fd0ff', '#ffb02e', '#ff7a7a', '#d6c8ff', '#9dff5a', '#bff4ff', '#ff9a6a', '#ffb02e', '#e08bff', '#ffd34a',
  '#7fd0ff', '#ff7af0', '#ffb347', '#9be04a', '#7fd0ff', '#ff7ad9', '#b07aff', '#4affc8'];
export const TEAM_COLORS = ['#ffd34a', '#ff5a4a', '#5aa0ff'];
// Map events (src/game/events.rs): meteor warning, and kinds as announced.
export const METEOR_WARN_MS = 1500;
export const EVENT_BLIZZARD = 2;
export const EVENT_EARTHQUAKE = 5;
export const BIOME_VOLCANO = 3;
export const BIOME_CRYPT = 4;
export const BIOME_SPACE = 5;
// Atomic bomb, mirroring the server (src/game/bomb.rs): fuse, how long each
// cell burns after the shockwave reaches it, how long the blast is shown,
// and shockwave speed in cells per second.
export const NUKE_FUSE_TICKS = 70;
export const NUKE_FLAME_S = 0.8;
export const NUKE_SHOW_TICKS = 60;
export const NUKE_WAVE_CPS = 20;
export const NUKE_LIFE_S = 3.2;
/** Death replay speed (game time per real time). */
export const REPLAY_RATE = 0.6;
export const NUKE_RADIUS = 6;
/** Whether offset (dx, dy) from ground zero is inside the atomic disc (as on the server). */
export const inNukeDisc = (dx: number, dy: number): boolean => dx * dx + dy * dy <= NUKE_RADIUS * NUKE_RADIUS + NUKE_RADIUS;
// The disc's cells and the outline around them (cell edges between inside
// and outside), as offsets from ground zero.
export const NUKE_DISC: number[] = [];
export const NUKE_OUTLINE: number[] = []; // x0, y0, x1, y1 per edge, in cell units from the cell corner
for (let dy = -NUKE_RADIUS; dy <= NUKE_RADIUS; dy++) {
  for (let dx = -NUKE_RADIUS; dx <= NUKE_RADIUS; dx++) {
    if (!inNukeDisc(dx, dy)) continue;
    NUKE_DISC.push(dx, dy);
    if (!inNukeDisc(dx, dy - 1)) NUKE_OUTLINE.push(dx, dy, dx + 1, dy);
    if (!inNukeDisc(dx, dy + 1)) NUKE_OUTLINE.push(dx, dy + 1, dx + 1, dy + 1);
    if (!inNukeDisc(dx - 1, dy)) NUKE_OUTLINE.push(dx, dy, dx, dy + 1);
    if (!inNukeDisc(dx + 1, dy)) NUKE_OUTLINE.push(dx + 1, dy, dx + 1, dy + 1);
  }
}
export const EMOTES = ['👋', '😂', '😡', '👍', '💣', '😱', 'GG', '😎'];
export const TRAIL_COLORS = [0, 10, 8, 9];
export const PLAYER_VIEWS = ['player_up', 'player_down', 'player_side'] as const;
export const PIXEL_VIEWS = ['up', 'down', 'side'] as const;
// Where the fuse ends on each bomb sprite, in tiles from the cell centre.
export const FUSE_TIP = [0.34, -0.36];
export const FUSE_TIP_PIXEL = [0.28, -0.47];

/** Picks one of `n` tile variants from a coordinate hash; the first is the most common. */
export function variant(h: number, n: number) {
  if (n >= 3 && h % 7 === 0) return 2;
  if (n >= 2 && h % 3 === 0) return 1;
  return 0;
}

// Biome regions: [x, y, biome] centres as fractions of the map size, sent
// by the server in the welcome message (`map.biomes`); a cell takes the
// biome of the nearest centre. Maps without them use the classic layout.
export const DEFAULT_BIOMES = [[0.5, 0.5, 0], [0.2, 0.2, 1], [0.8, 0.2, 2], [0.2, 0.8, 3], [0.8, 0.8, 0]];
export function biome(map: GameMap, x: number, y: number) {
  const seeds = map.biomes ?? (map.w < 41 || map.h < 41 ? [] : DEFAULT_BIOMES);
  const fx = x / map.w, fy = y / map.h;
  let best = 0, bd = Infinity;
  for (const [sx, sy, b] of seeds) {
    const d = (fx - sx) ** 2 + (fy - sy) ** 2;
    if (d < bd) { bd = d; best = b; }
  }
  return best;
}
