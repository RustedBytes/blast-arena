// Canvas renderer. Static tiles are pre-rendered into chunk canvases that
// are redrawn only when a tile in them changes; entities are drawn from a
// pooled, interpolated frame; effects come from a fixed particle pool. The
// per-frame path allocates almost nothing.

import { ITEM_SPRITES, playerColors } from './assets.js';
import { P_CURSE, P_DEBRIS, P_SMOKE, P_SPARK, P_STAR } from './particles.js';
import { t } from './i18n.js';
import { FRINGE_RANK } from './pixelart.js';
import { hopHeight } from './prediction.js';

export const T_FLOOR = 0, T_WALL = 1, T_CRATE = 2, T_ICE = 3, T_TELEPORT = 8, T_ARMORED = 9, T_BUILT = 10;
// Ability objects (src/game/abilities.rs): portal pair colours by owner,
// particle colours for gas and dashes.
const PORTAL_COLORS = ['#4ad0ff', '#ff9a3a', '#b07aff', '#4affc8', '#ff5ad0', '#ffe14a'];
const C_GAS = 14, C_GAS_DARK = 15, C_DASH = 16;
const CONVEYOR_DIR = [0, 0, 0, 0, 1, 2, 3, 4];
// Rotation for flame arms / conveyors, indexed by direction code - 1.
const ARM_ANGLES = [-Math.PI / 2, 0, Math.PI / 2, Math.PI];
const ARM_DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];
/** Render this many ticks behind the server to interpolate smoothly. */
export const INTERP_TICKS = 2;
const CHUNK = 8;            // tiles per chunk side
const CHUNK_PX = 64;        // pixels per tile inside a chunk canvas
const MAX_CHUNKS = 48;      // chunk canvases kept (LRU)
const REPAINTS_PER_FRAME = 2; // changed chunks repainted per frame
const DECALS = 512;         // scorch marks ring buffer
const DECAL_LIFE = 4000;    // ms
const POOL = 512;           // pooled entities per frame
const MINIMAP_MS = 250;     // minimap overlay refresh period
// Item halo colour by rarity.
const HALO = [null, '#ffffff', '#ffffff', '#7fd0ff', '#7fd0ff', '#c08bff', '#c08bff', '#ffd34a', '#ff7af0',
  '#7fd0ff', '#ffb02e', '#ff7a7a', '#d6c8ff', '#9dff5a', '#bff4ff', '#ff9a6a', '#ffb02e', '#e08bff', '#ffd34a',
  '#7fd0ff', '#ff7af0', '#ffb347', '#9be04a', '#7fd0ff', '#ff7ad9', '#b07aff', '#4affc8'];
const TEAM_COLORS = ['#ffd34a', '#ff5a4a', '#5aa0ff'];
// Map events (src/game/events.rs): meteor warning, and kinds as announced.
const METEOR_WARN_MS = 1500;
const EVENT_BLIZZARD = 2;
const EVENT_EARTHQUAKE = 5;
const BIOME_VOLCANO = 3;
// Atomic bomb, mirroring the server (src/game/bomb.rs): fuse, how long each
// cell burns after the shockwave reaches it, how long the blast is shown,
// and shockwave speed in cells per second.
const NUKE_FUSE_TICKS = 70;
const NUKE_FLAME_S = 0.8;
export const NUKE_SHOW_TICKS = 60;
const NUKE_WAVE_CPS = 20;
const NUKE_LIFE_S = 3.2;
/** Death replay speed (game time per real time). */
export const REPLAY_RATE = 0.6;
const NUKE_RADIUS = 6;
/** Whether offset (dx, dy) from ground zero is inside the atomic disc (as on the server). */
const inNukeDisc = (dx, dy) => dx * dx + dy * dy <= NUKE_RADIUS * NUKE_RADIUS + NUKE_RADIUS;
// The disc's cells and the outline around them (cell edges between inside
// and outside), as offsets from ground zero.
const NUKE_DISC = [];
const NUKE_OUTLINE = []; // x0, y0, x1, y1 per edge, in cell units from the cell corner
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
const TRAIL_COLORS = [0, 10, 8, 9];
const PLAYER_VIEWS = ['player_up', 'player_down', 'player_side'];
const PIXEL_VIEWS = ['up', 'down', 'side'];
// Where the fuse ends on each bomb sprite, in tiles from the cell centre.
const FUSE_TIP = [0.34, -0.36];
const FUSE_TIP_PIXEL = [0.28, -0.47];

/** Picks one of `n` tile variants from a coordinate hash; the first is the most common. */
function variant(h, n) {
  if (n >= 3 && h % 7 === 0) return 2;
  if (n >= 2 && h % 3 === 0) return 1;
  return 0;
}

// Biome regions: [x, y, biome] centres as fractions of the map size, sent
// by the server in the welcome message (`map.biomes`); a cell takes the
// biome of the nearest centre. Maps without them use the classic layout.
const DEFAULT_BIOMES = [[0.5, 0.5, 0], [0.2, 0.2, 1], [0.8, 0.2, 2], [0.2, 0.8, 3], [0.8, 0.8, 0]];
export function biome(map, x, y) {
  const seeds = map.biomes ?? (map.w < 41 || map.h < 41 ? [] : DEFAULT_BIOMES);
  const fx = x / map.w, fy = y / map.h;
  let best = 0, bd = Infinity;
  for (const [sx, sy, b] of seeds) {
    const d = (fx - sx) ** 2 + (fy - sy) ** 2;
    if (d < bd) { bd = d; best = b; }
  }
  return best;
}

export class Renderer {
  constructor(canvas, minimap, assets, particles) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.minimap = minimap;
    this.mctx = minimap.getContext('2d');
    this.assets = assets;
    this.particles = particles;
    this.baseT = 48;
    this.T = 48;
    this.camX = 0;
    this.camY = 0;
    this.shake = 0;
    this.lastMinimap = 0;
    this.chunks = new Map(); // chunk index -> canvas (insertion order = LRU)
    this.dirty = new Set();
    this.decalX = new Float32Array(DECALS);
    this.decalY = new Float32Array(DECALS);
    this.decalT = new Float64Array(DECALS).fill(-1e9);
    this.decalHead = 0;
    this.halos = {};
    this.effects = []; // death animations and spawn beams (event-driven, short-lived)
    this.nukes = []; // atomic blasts being shown: { x, y, r, start, cells }
    this.flash = 0; // strength of the current atomic flash (0..1)
    this.flashAt = -1e9;
    this.puffs = null; // soft cloud sprites, built on first use
    this.meteors = []; // { x, y, at } incoming meteor strikes
    this.lava = []; // { cells, start, end } lava surges
    this.weather = null; // { kind, start, end } current map event
    this.snow = null; // blizzard flakes (x, y in 0..1, speed)
    this.dronePrev = new Map();
    this.clonePrev = new Map();
    this.stuckBy = new Map(); // bomb id -> carrier id (this frame)
    this.replaying = false;
    this.specials = []; // [x, y, tile] of animated tiles (conveyors, pads)
    this.highContrast = false;
    this.colorblind = false;
    /** 'pixel' (default) or 'classic' map tiles. */
    this.tileStyle = 'pixel';
    // Pooled frame data, reused every frame.
    this.frame = {
      players: Array.from({ length: POOL }, () => ({ id: 0, x: 0, y: 0, facing: 3, moving: false, shield: false, cursed: false, ghost: false, bounty: false, jumpDir: 0, lift: 0, stunned: false, carrying: false, dashing: false, gassed: false, clone: 0 })),
      nPlayers: 0,
      bombs: Array.from({ length: POOL }, () => ({ x: 0, y: 0, fuse: 0, pierce: false, remote: false, nuke: false, freeze: false, rocket: false, mine: false, sticky: false, gas: false, carrier: 0, dx: 0, dy: 0 })),
      nBombs: 0,
      drones: Array.from({ length: 64 }, () => ({ id: 0, x: 0, y: 0, team: 0 })),
      nDrones: 0,
    };
    this.prev = new Map();
    this.mapImage = document.createElement('canvas');
    this.mapPixels = null;
    this.mapDirty = true;   // minimap tile layer needs rebuilding
    this.dpr = window.devicePixelRatio || 1;
    // Per-player caches, so drawing a player allocates nothing.
    this.looks = new Map();  // id -> { team, cb, colors, sprites[] }
    this.labels = new Map(); // id -> { canvas, name, fs, me, team, hc, cb }
  }

  /** Recomputes the base tile size so the default view matches the server's default area. */
  resize(aoi, aoiMax) {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(innerWidth * dpr), h = Math.round(innerHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    if (this.dpr !== dpr) {
      this.dpr = dpr;
      this.labels.clear();
      this.mapDirty = true;
    }
    // A hidden page can report 0x0; keep the last good sizes until it's shown.
    if (w === 0 || h === 0) return;
    this.baseT = Math.max(w / (2 * aoi[0] - 1), h / (2 * aoi[1] - 1));
    // Zooming out may show at most the largest area the server will send.
    const minT = Math.max(w / (2 * aoiMax[0] - 1), h / (2 * aoiMax[1] - 1));
    this.minZoom = Math.max(0.4, minT / this.baseT);
    this.maxZoom = 2.2;
  }

  /** Half extents in tiles the current zoom needs from the server. */
  viewHalfExtents(zoom) {
    const T = this.baseT * zoom;
    return [Math.ceil(this.canvas.width / T / 2) + 1, Math.ceil(this.canvas.height / T / 2) + 1];
  }

  halo(color) {
    let c = this.halos[color];
    if (!c) {
      c = this.halos[color] = document.createElement('canvas');
      c.width = c.height = 64;
      const g = c.getContext('2d');
      const grad = g.createRadialGradient(32, 32, 4, 32, 32, 32);
      grad.addColorStop(0, color);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      g.globalAlpha = 0.55;
      g.fillStyle = grad;
      g.fillRect(0, 0, 64, 64);
    }
    return c;
  }

  // ------------------------------------------------------------- tiles

  /** The pixel-art set when that style is on, otherwise null. */
  pixelArt() {
    return this.tileStyle === 'pixel' ? this.assets.pixel : null;
  }

  /** A sprite in the current art style (pixel art falls back to the classic one). */
  art(name) {
    return this.pixelArt()?.[name] ?? this.assets.sprite(name);
  }

  invalidateTile(map, x, y) {
    this.mapDirty = true;
    // A tile's shadow falls on its east and south neighbours, which may be
    // in another chunk.
    const cols = Math.ceil(map.w / CHUNK);
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      const nx = Math.min(x + dx, map.w - 1), ny = Math.min(y + dy, map.h - 1);
      this.dirty.add(Math.floor(ny / CHUNK) * cols + Math.floor(nx / CHUNK));
    }
  }

  invalidateAll() {
    for (const c of this.chunks.values()) c.key = -1;
    this.looks.clear();
    this.labels.clear();
  }

  /** Called on welcome: forget cached chunks and index animated tiles. */
  resetMap(map) {
    this.chunks.clear();
    this.dirty.clear();
    this.mapDirty = true;
    this.looks.clear();
    this.labels.clear();
    this.decalT.fill(-1e9);
    this.specials = [];
    for (let y = 0; y < map.h; y++) {
      for (let x = 0; x < map.w; x++) {
        const t = map.tiles[y * map.w + x];
        if (CONVEYOR_DIR[t] || t === T_TELEPORT) this.specials.push([x, y, t]);
      }
    }
  }

  chunk(map, cx, cy) {
    const key = cy * Math.ceil(map.w / CHUNK) + cx;
    let c = this.chunks.get(key);
    const stale = this.dirty.has(key);
    if (c) {
      this.chunks.delete(key); // refresh LRU position
    } else {
      if (this.chunks.size >= MAX_CHUNKS) {
        const oldest = this.chunks.keys().next().value;
        c = this.chunks.get(oldest);
        this.chunks.delete(oldest);
      } else {
        c = document.createElement('canvas');
        c.width = c.height = CHUNK * CHUNK_PX;
      }
      c.key = -1;
    }
    // A cached chunk whose tiles changed is repainted within a per-frame
    // budget (an atomic blast can change dozens of chunks at once); the
    // rest keep showing their old picture for a frame or two.
    const mustPaint = c.key !== key;
    if (mustPaint || (stale && this.repaintBudget-- > 0)) {
      this.paintChunk(c, map, cx, cy);
      c.key = key;
      this.dirty.delete(key);
    }
    this.chunks.set(key, c);
    return c;
  }

  paintChunk(c, map, cx, cy) {
    const g = c.getContext('2d');
    const a = this.assets;
    const style = this.tileStyle;
    const sprite = (name) => a.tile(name, style);
    // Pixel art is scaled up with hard edges; vector art smoothly.
    g.imageSmoothingEnabled = style !== 'pixel';
    // Pixel art has variants per biome, block shadows and blended borders.
    const pix = style === 'pixel' ? a.pixel : null;
    const grass = [sprite('floor'), sprite('floor_b'), sprite('floor_c')];
    const biomeFloor = [grass, [sprite('floor_snow')], [sprite('floor_sand')], [sprite('floor_ash')]];
    const floors = pix ? pix.floors : biomeFloor;
    const tileAt = (x, y) => (x < 0 || y < 0 || x >= map.w || y >= map.h ? T_WALL : map.tiles[y * map.w + x]);
    const raised = (x, y) => {
      const t = tileAt(x, y);
      return t === T_WALL || t === T_CRATE || t === T_ARMORED || t === T_BUILT;
    };
    const P = CHUNK_PX;
    g.fillStyle = '#1b2a17';
    g.fillRect(0, 0, c.width, c.height);
    for (let ty = 0; ty < CHUNK; ty++) {
      const y = cy * CHUNK + ty;
      if (y >= map.h) break;
      for (let tx = 0; tx < CHUNK; tx++) {
        const x = cx * CHUNK + tx;
        if (x >= map.w) break;
        const t = map.tiles[y * map.w + x];
        const px = tx * P, py = ty * P;
        const b = biome(map, x, y);
        // Variants come from a coordinate hash, so they stay stable.
        const h = ((x * 73856093) ^ (y * 19349663)) >>> 0;
        if (t !== T_WALL) {
          g.drawImage(floors[b][variant(h, floors[b].length)], px, py, P, P);
          // A higher-ranked neighbouring biome spills over the border.
          if (pix) {
            for (let d = 0; d < 4; d++) {
              const nx = x + ARM_DIRS[d][0], ny = y + ARM_DIRS[d][1];
              if (nx < 0 || ny < 0 || nx >= map.w || ny >= map.h) continue;
              const nb = biome(map, nx, ny);
              if (FRINGE_RANK[nb] > FRINGE_RANK[b]) g.drawImage(pix.edges[nb][d], px, py, P, P);
            }
          }
        }
        let s = null;
        if (t === T_WALL) s = pix ? pix.pillars[b][variant(h, pix.pillars[b].length)] : sprite('pillar');
        else if (t === T_CRATE) s = sprite('crate');
        else if (t === T_ARMORED) s = sprite('crate_armored');
        else if (t === T_ICE) s = sprite('ice');
        else if (t === T_TELEPORT) s = sprite('teleport');
        if (s) g.drawImage(s, px, py, P, P);
        if (t === T_BUILT) paintBuiltWall(g, px, py, P, pix !== null);
        const belt = CONVEYOR_DIR[t];
        if (belt) {
          g.save();
          g.translate(px + P / 2, py + P / 2);
          g.rotate(ARM_ANGLES[belt - 1]);
          g.drawImage(sprite('conveyor'), -P / 2, -P / 2, P, P);
          g.restore();
        }
        if (pix && !raised(x, y)) {
          // Ice gets a soft shoreline of the surrounding ground.
          if (t === T_ICE) {
            for (let d = 0; d < 4; d++) {
              const nt = tileAt(x + ARM_DIRS[d][0], y + ARM_DIRS[d][1]);
              if (nt !== T_ICE && nt !== T_WALL) g.drawImage(pix.edges[b][d], px, py, P, P);
            }
          }
          // Raised neighbours cast shadows down and to the right.
          const mask = (raised(x, y - 1) ? 1 : 0) | (raised(x - 1, y) ? 2 : 0) | (raised(x - 1, y - 1) ? 4 : 0);
          if (mask) g.drawImage(pix.shadows[mask], px, py, P, P);
        }
        if (this.highContrast && (t === T_CRATE || t === T_ARMORED || t === T_WALL || t === T_BUILT)) {
          g.strokeStyle = t === T_WALL ? '#000' : '#fff';
          g.lineWidth = 4;
          g.strokeRect(px + 2, py + 2, P - 4, P - 4);
        }
      }
    }
  }

  // ----------------------------------------------------------- effects

  /** A new explosion appeared in a snapshot. */
  explosion(x, y, arms, now, distance) {
    const p = this.particles;
    p.burst(P_SPARK, x + 0.5, y + 0.5, 26, 7, 0.5, 0.09, 0, 3);
    p.burst(P_SMOKE, x + 0.5, y + 0.5, 6, 1.2, 1.1, 0.35, 4, 2);
    this.decal(x, y, now);
    for (let d = 0; d < 4; d++) {
      for (let r = 1; r <= arms[d]; r++) {
        const cx = x + ARM_DIRS[d][0] * r, cy = y + ARM_DIRS[d][1] * r;
        this.decal(cx, cy, now);
        if (r === arms[d]) p.burst(P_SPARK, cx + 0.5, cy + 0.5, 6, 4, 0.35, 0.07, 0, 3);
      }
    }
    // Screen shake falls off with distance from the camera focus.
    this.shake = Math.max(this.shake, Math.min(0.35, this.shake + 0.3 / (1 + distance * distance * 0.05)));
  }

  /**
   * An atomic blast at cell (x, y) of `radius`, detonated `age` seconds ago
   * (non-zero when we only learn of it late). Sets up the flash, shockwave,
   * fire, mushroom cloud, fallout and a heavy screen shake.
   */
  nuke(x, y, radius, now, distance, map, age = 0) {
    const start = now - age * 1000;
    // The disc of cells the fire covers (same shape as the server's), with
    // the time the shockwave reaches each.
    const cells = [];
    const r = radius;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const d2 = dx * dx + dy * dy;
        if (d2 > r * r + r) continue;
        const cx = x + dx, cy = y + dy;
        if (cx < 0 || cy < 0 || cx >= map.w || cy >= map.h || map.tiles[cy * map.w + cx] === T_WALL) continue;
        cells.push(cx, cy, Math.floor(Math.sqrt(d2)) / NUKE_WAVE_CPS);
      }
    }
    this.nukes.push({ x: x + 0.5, y: y + 0.5, r, start, cells });
    if (age > 0.5) return; // joined late: just show what's left of it
    for (let i = 0; i < cells.length; i += 3) this.decal(cells[i], cells[i + 1], now + cells[i + 2] * 1000);
    const p = this.particles, cx = x + 0.5, cy = y + 0.5;
    p.burst(P_SPARK, cx, cy, 70, 14, 0.7, 0.1, 0, 3);
    p.burst(P_DEBRIS, cx, cy, 50, 9, 1.4, 0.12, 6, 2);
    p.burst(P_STAR, cx, cy, 20, 6, 0.9, 0.2, 9, 2);
    // A ground-hugging dust surge racing outward.
    for (let k = 0; k < 64; k++) {
      const a = (k / 64) * Math.PI * 2 + Math.random() * 0.1;
      const s = NUKE_WAVE_CPS * (0.25 + Math.random() * 0.1);
      p.emit(P_SMOKE, cx + Math.cos(a) * 0.6, cy + Math.sin(a) * 0.6, Math.cos(a) * s, Math.sin(a) * s,
        1.2 + Math.random() * 0.8, 0.45, 4 + (k % 2));
    }
    const near = 1 / (1 + distance * distance * 0.004);
    this.shake = Math.max(this.shake, 1.1 * near);
    this.flash = Math.max(near, 0.35);
    this.flashAt = now;
  }

  /** Soft round sprites the mushroom cloud is built from. */
  buildPuffs() {
    const make = (stops) => {
      const c = document.createElement('canvas');
      c.width = c.height = 128;
      const g = c.getContext('2d');
      const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
      for (const [o, col] of stops) grad.addColorStop(o, col);
      g.fillStyle = grad;
      g.fillRect(0, 0, 128, 128);
      return c;
    };
    this.puffs = {
      fire: make([[0, '#fffbe6'], [0.25, '#fff08a'], [0.5, 'rgba(255,170,40,0.95)'], [0.78, 'rgba(230,70,10,0.55)'], [1, 'rgba(160,30,0,0)']]),
      smoke: make([[0, 'rgba(150,128,112,0.95)'], [0.55, 'rgba(104,88,80,0.85)'], [0.85, 'rgba(70,60,58,0.35)'], [1, 'rgba(50,44,44,0)']]),
      dark: make([[0, 'rgba(70,58,54,0.9)'], [0.6, 'rgba(48,40,40,0.6)'], [1, 'rgba(30,26,26,0)']]),
      dust: make([[0, 'rgba(176,150,120,0.75)'], [0.6, 'rgba(140,118,96,0.45)'], [1, 'rgba(120,100,80,0)']]),
    };
  }

  /** Ground layer of atomic blasts (under players): burning disc, shockwave, embers. */
  drawNukeGround(now, camX, camY, T) {
    if (this.nukes.length === 0) return;
    const { ctx } = this;
    const pix = this.pixelArt();
    const glow = this.assets.glow;
    const tick = Math.floor(now / 70);
    let keep = 0;
    for (let n = 0; n < this.nukes.length; n++) {
      const nk = this.nukes[n];
      const t = (now - nk.start) / 1000;
      if (t >= NUKE_LIFE_S) continue;
      this.nukes[keep++] = nk;
      const px = nk.x * T - camX, py = nk.y * T - camY;
      // Embers: the whole disc glows red and cools down.
      const ember = Math.max(0, Math.min(1, t * 4) * (1 - t / NUKE_LIFE_S));
      if (ember > 0) {
        const R = (nk.r + 0.5) * T;
        const g = ctx.createRadialGradient(px, py, 0, px, py, R);
        g.addColorStop(0, `rgba(255,120,30,${0.55 * ember})`);
        g.addColorStop(0.6, `rgba(200,40,10,${0.35 * ember})`);
        g.addColorStop(1, 'rgba(120,10,0,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(px, py, R, 0, 6.2832);
        ctx.fill();
      }
      // Each cell burns once the shockwave gets there.
      const cells = nk.cells;
      for (let i = 0; i < cells.length; i += 3) {
        const age = t - cells[i + 2];
        if (age < 0 || age > NUKE_FLAME_S) continue;
        const life = 1 - age / NUKE_FLAME_S;
        const cx = (cells[i] + 0.5) * T - camX, cy = (cells[i + 1] + 0.5) * T - camY;
        ctx.globalAlpha = Math.min(1, life * 2);
        const s = T * (0.85 + 0.3 * life);
        const sprite = pix ? pix.flames.center[(tick + cells[i] * 7 + cells[i + 1] * 3) % 3] : this.assets.sprite('flame_center');
        ctx.drawImage(sprite, cx - s / 2, cy - s / 2, s, s);
      }
      ctx.globalCompositeOperation = 'lighter';
      for (let i = 0; i < cells.length; i += 3) {
        const age = t - cells[i + 2];
        if (age < 0 || age > NUKE_FLAME_S) continue;
        ctx.globalAlpha = 0.6 * (1 - age / NUKE_FLAME_S);
        const cx = (cells[i] + 0.5) * T - camX, cy = (cells[i + 1] + 0.5) * T - camY, g = T * 1.6;
        ctx.drawImage(glow, cx - g / 2, cy - g / 2, g, g);
      }
      // The shockwave: a bright ring racing out to the edge of the blast,
      // then a fading pressure ring beyond it.
      const rr = t * NUKE_WAVE_CPS;
      const edge = nk.r + 3;
      if (rr < edge) {
        const fade = 1 - rr / edge;
        ctx.globalAlpha = fade;
        ctx.strokeStyle = '#ff9a2e';
        ctx.lineWidth = T * (0.55 * fade + 0.1);
        ctx.beginPath();
        ctx.arc(px, py, Math.max(1, rr * T), 0, 6.2832);
        ctx.stroke();
        ctx.strokeStyle = '#fffbe6';
        ctx.lineWidth = T * 0.12 * fade + 1;
        ctx.stroke();
      }
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
    }
    this.nukes.length = keep;
  }

  /** Sky layer of atomic blasts (over players): fireball and mushroom cloud. */
  drawNukeCloud(now, camX, camY, T) {
    if (this.nukes.length === 0) return;
    if (!this.puffs) this.buildPuffs();
    const { ctx } = this;
    const P = this.puffs;
    const puff = (img, x, y, size, alpha) => {
      if (alpha <= 0.01) return;
      ctx.globalAlpha = Math.min(1, alpha);
      ctx.drawImage(img, x - size / 2, y - size / 2, size, size);
    };
    for (let n = 0; n < this.nukes.length; n++) {
      const nk = this.nukes[n];
      const t = (now - nk.start) / 1000;
      if (t >= NUKE_LIFE_S) continue;
      const gx = nk.x * T - camX, gy = nk.y * T - camY;
      const p = Math.max(0, (t - 0.12) / (NUKE_LIFE_S - 0.12)); // cloud progress 0..1
      const rise = 1 - (1 - p) ** 3; // fast up, then hanging
      const fadeOut = p < 0.7 ? 1 : (1 - p) / 0.3;
      const heat = Math.max(0, 1 - p * 1.4); // fire shows through early on
      const scale = nk.r / 6;

      // Base surge: a flat ring of dust rolling outward along the ground.
      const baseR = T * (1 + nk.r * 0.75 * rise);
      for (let k = 0; k < 14; k++) {
        const a = (k / 14) * Math.PI * 2 + t * 0.4;
        puff(P.dust, gx + Math.cos(a) * baseR, gy + Math.sin(a) * baseR * 0.45, T * (1.6 + rise) * scale, 0.55 * fadeOut);
      }

      // The fireball, swelling in the first moments, then lifting into the cap.
      const fb = Math.min(1, t / 0.3);
      const capY = gy - T * (0.8 + 5.6 * rise) * scale;
      if (t < 1.2) {
        const fy = gy + (capY - gy) * Math.min(1, t / 1.2);
        ctx.globalCompositeOperation = 'lighter';
        puff(P.fire, gx, fy, T * (1.2 + 3.4 * fb) * scale, 1.2 - t);
        ctx.globalCompositeOperation = 'source-over';
      }
      if (p <= 0) continue;

      // The stem: a column of smoke from the ground up to the cap, glowing at the root.
      const stemTop = capY + T * 0.8 * scale;
      for (let k = 0; k < 8; k++) {
        const f = k / 7;
        const sy = gy + (stemTop - gy) * f;
        const w = T * (1.5 - 0.6 * Math.sin(f * Math.PI * 0.9)) * scale * (0.6 + 0.4 * rise);
        const wob = Math.sin(t * 3 + k) * T * 0.08;
        puff(P.smoke, gx + wob, sy, w * 1.5, fadeOut * Math.min(1, p * 6));
      }
      if (heat > 0) {
        // The stem's glowing core.
        ctx.globalCompositeOperation = 'lighter';
        for (let k = 0; k < 5; k++) {
          const sy = gy + (stemTop - gy) * (k / 4);
          puff(P.fire, gx, sy, T * 1.1 * scale, heat * 0.55);
        }
        ctx.globalCompositeOperation = 'source-over';
      }
      // The cap: a rolling ring of puffs (the torus), dark on top, fire underneath.
      const capW = T * (1.6 + 3.4 * rise) * scale, capH = capW * 0.45;
      const size = T * (1.8 + 2.4 * rise) * scale;
      // Back half of the rolling ring first, then the dome, then the front half.
      for (let pass = 0; pass < 2; pass++) {
        for (let k = 0; k < 14; k++) {
          const a = (k / 14) * Math.PI * 2 + t * 1.3;
          const oy = Math.sin(a);
          if ((oy < 0) !== (pass === 0)) continue;
          puff(pass === 0 ? P.dark : P.smoke, gx + Math.cos(a) * capW * 0.55, capY + oy * capH * 0.5, size, fadeOut);
        }
        if (pass === 0) {
          puff(P.smoke, gx, capY - capH * 0.45, size * 1.6, fadeOut);
          puff(P.dark, gx - capW * 0.15, capY - capH * 0.75, size * 1.1, 0.8 * fadeOut);
          puff(P.smoke, gx + capW * 0.2, capY - capH * 0.7, size * 1.0, 0.8 * fadeOut);
        }
      }
      if (heat > 0) {
        ctx.globalCompositeOperation = 'lighter';
        puff(P.fire, gx, capY + capH * 0.25, size * 1.6, heat);
        puff(P.fire, gx, gy - T * 0.2, T * 2.2 * scale, heat * 0.8);
        for (let k = 0; k < 6; k++) {
          const a = (k / 6) * Math.PI * 2 + t * 1.3;
          puff(P.fire, gx + Math.cos(a) * capW * 0.5, capY + Math.abs(Math.sin(a)) * capH * 0.4, size * 0.7, heat * 0.8);
        }
        ctx.globalCompositeOperation = 'source-over';
      }
    }
    ctx.globalAlpha = 1;
  }

  /** The blinding flash of a nearby atomic blast, over everything. */
  drawFlash(now, W, H) {
    const t = (now - this.flashAt) / 1000;
    if (t > 0.6 || this.flash <= 0) return;
    const { ctx } = this;
    const k = this.flash * (1 - t / 0.6) ** 2;
    ctx.globalAlpha = Math.min(1, k);
    ctx.fillStyle = t < 0.08 ? '#ffffff' : '#fff6d8';
    ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = 1;
  }

  decal(x, y, now) {
    const i = this.decalHead;
    this.decalX[i] = x; this.decalY[i] = y; this.decalT[i] = now;
    this.decalHead = (i + 1) % DECALS;
  }

  crateBroken(x, y) {
    this.particles.burst(P_DEBRIS, x + 0.5, y + 0.5, 10, 3.5, 0.8, 0.14, 6, 2);
    this.particles.burst(P_SMOKE, x + 0.5, y + 0.5, 3, 0.8, 0.8, 0.3, 5, 1);
  }

  /** Death animation: the victim's sprite spins, shrinks and floats away. */
  death(x, y, now, colors, facing) {
    this.effects.push({ kind: 'die', x, y, start: now, duration: 900, colors, facing });
    this.particles.burst(P_SMOKE, x, y, 10, 1.6, 1.2, 0.3, 4, 2);
    this.particles.burst(P_STAR, x, y, 8, 3, 0.6, 0.25, 9, 1);
  }

  spawnBeam(x, y, now) {
    this.effects.push({ kind: 'beam', x, y, start: now, duration: 700 });
    this.particles.burst(P_STAR, x, y, 12, 2.5, 0.7, 0.2, 8, 2);
  }

  sparkle(x, y, mystery) {
    this.particles.burst(P_STAR, x, y, mystery ? 24 : 10, mystery ? 4 : 2.5, 0.8, 0.25, mystery ? 9 : 10, mystery ? 3 : 1);
  }

  /** Round-end celebration around the camera. */
  confetti(state) {
    const vw = this.canvas.width / this.T, vh = this.canvas.height / this.T;
    for (let i = 0; i < 160; i++) {
      const x = this.camX / this.T + Math.random() * vw;
      const y = this.camY / this.T + Math.random() * vh * 0.3;
      this.particles.emit(P_DEBRIS, x, y, (Math.random() - 0.5) * 3, -Math.random() * 4, 2.2, 0.12, 7 + Math.floor(Math.random() * 7));
    }
  }

  // ------------------------------------------------------------- frame

  draw(state, now, dt) {
    const { ctx } = this;
    const W = this.canvas.width, H = this.canvas.height;
    const { map } = state;
    const T = this.T = this.baseT * state.zoom;
    this.interpolate(state, now);
    const f = this.frame;
    const sec = now / 1000;

    // Camera follows the focus (yourself, or whoever you're watching).
    this.shake *= Math.exp(-dt * 7);
    // An earthquake keeps the ground rumbling, hardest in the volcano.
    const w = this.weather;
    if (w && w.kind === EVENT_EARTHQUAKE && now < w.end) {
      const inVolcano = biome(map, Math.floor(state.focus.x), Math.floor(state.focus.y)) === BIOME_VOLCANO;
      const fade = Math.min(1, (w.end - now) / 800);
      this.shake = Math.max(this.shake, (inVolcano ? 0.32 : 0.12) * fade * (0.7 + 0.3 * Math.sin(now / 90)));
    }
    const sx = (Math.random() - 0.5) * this.shake * T, sy = (Math.random() - 0.5) * this.shake * T;
    this.camX = clampCam(state.focus.x * T - W / 2, map.w * T, W);
    this.camY = clampCam(state.focus.y * T - H / 2, map.h * T, H);
    const camX = Math.round(this.camX + sx), camY = Math.round(this.camY + sy);

    // The chunks cover the whole view unless the map is smaller than it.
    if (camX < 0 || camY < 0 || camX + W > map.w * T || camY + H > map.h * T) {
      ctx.fillStyle = '#1b2a17';
      ctx.fillRect(0, 0, W, H);
    }

    // Tile chunks.
    this.repaintBudget = REPAINTS_PER_FRAME;
    const cpx = CHUNK * T;
    const cx0 = Math.max(0, Math.floor(camX / cpx)), cy0 = Math.max(0, Math.floor(camY / cpx));
    const cx1 = Math.min(Math.ceil(map.w / CHUNK) - 1, Math.floor((camX + W) / cpx));
    const cy1 = Math.min(Math.ceil(map.h / CHUNK) - 1, Math.floor((camY + H) / cpx));
    ctx.imageSmoothingEnabled = true;
    for (let cy = cy0; cy <= cy1; cy++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const c = this.chunk(map, cx, cy);
        ctx.drawImage(c, Math.floor(cx * cpx - camX), Math.floor(cy * cpx - camY), Math.ceil(cpx) + 1, Math.ceil(cpx) + 1);
      }
    }

    this.drawSpecials(map, camX, camY, T, sec, W, H);
    this.drawHills(state.hills, camX, camY, T, sec);

    // Scorch marks fade out over a few seconds.
    const scorch = this.art('scorch');
    for (let i = 0; i < DECALS; i++) {
      const age = now - this.decalT[i];
      if (age >= DECAL_LIFE || age < 0) continue; // (an atomic blast schedules marks ahead)
      const x = this.decalX[i], y = this.decalY[i];
      const t = map.tiles[y * map.w + x];
      if (t === T_WALL || t === T_CRATE || t === T_ARMORED || t === T_BUILT) continue;
      ctx.globalAlpha = 0.7 * (1 - age / DECAL_LIFE);
      ctx.drawImage(scorch, x * T - camX, y * T - camY, T, T);
    }
    ctx.globalAlpha = 1;

    this.drawGroundEvents(state, now, camX, camY, T, sec, W, H);
    this.drawPortals(state, camX, camY, T, sec);
    const inZone = this.drawNukeZones(state, f, camX, camY, T, sec);
    /** The atomic bomb whose zone the local player is in (for the alerts), or null. */
    this.inNukeZone = inZone;
    this.drawItems(state.items, camX, camY, T, sec, W, H);
    this.drawBombs(f, camX, camY, T, sec, dt);
    this.drawExplosions(state.explosions, camX, camY, T);
    this.drawNukeGround(now, camX, camY, T);
    this.drawGas(state, camX, camY, T, sec, dt);

    // Players back to front (insertion sort on the pooled slice: no garbage).
    const ps = f.players;
    for (let i = 1; i < f.nPlayers; i++) {
      const p = ps[i];
      let j = i - 1;
      while (j >= 0 && ps[j].y > p.y) { ps[j + 1] = ps[j]; j--; }
      ps[j + 1] = p;
    }
    for (let i = 0; i < f.nPlayers; i++) this.drawPlayer(ps[i], camX, camY, T, sec, dt, state);
    this.drawStuckBombs(f, camX, camY, T, sec);

    this.particles.pixel = this.tileStyle === 'pixel';
    this.particles.draw(ctx, camX, camY, T);
    this.drawEffects(now, camX, camY, T);
    this.drawNukeCloud(now, camX, camY, T);
    this.drawSky(state, now, camX, camY, T, sec);
    this.drawZone(state, now, camX, camY, T, sec, W, H);
    for (let i = 0; i < f.nPlayers; i++) this.drawName(ps[i], camX, camY, T, state, now);
    this.drawNukeCountdowns(f, camX, camY, T);
    if (inZone) this.drawRunWarning(state, inZone, camX, camY, T, sec, W);
    this.drawWeather(now, dt, W, H);
    if (this.replaying) this.drawReplayFrame(sec, W, H);
    this.drawFlash(now, W, H);

    // (The vignette is a CSS overlay: the compositor blends it for free.)

    if (now - this.lastMinimap > MINIMAP_MS) {
      this.lastMinimap = now;
      this.drawMinimap(state);
    }
  }

  /** Moving chevrons on conveyors and spinning teleporter pads. */
  drawSpecials(map, camX, camY, T, sec, W, H) {
    const { ctx } = this;
    const spin = sec * 2.5, sc = Math.cos(spin), ss = Math.sin(spin);
    const phase = (sec * 1.6) % 1;
    let style = -1; // which stroke style is set: 0 teleporter, 1 conveyor
    for (let i = 0; i < this.specials.length; i++) {
      const sp = this.specials[i];
      const x = sp[0], y = sp[1], t = sp[2];
      const px = x * T - camX, py = y * T - camY;
      if (px < -T || py < -T || px > W || py > H) continue;
      const cx = px + T / 2, cy = py + T / 2;
      if (t === T_TELEPORT) {
        if (style !== 0) {
          style = 0;
          ctx.strokeStyle = 'rgba(200,160,255,0.75)';
          ctx.lineWidth = T * 0.06;
        }
        ctx.setTransform(sc, ss, -ss, sc, cx, cy);
        ctx.globalCompositeOperation = 'lighter';
        for (let k = 0; k < 3; k++) {
          ctx.beginPath();
          ctx.arc(0, 0, T * (0.12 + k * 0.1), k * 2, k * 2 + 2.2);
          ctx.stroke();
        }
        ctx.globalCompositeOperation = 'source-over';
      } else {
        if (style !== 1) {
          style = 1;
          ctx.strokeStyle = 'rgba(255,211,74,0.85)';
          ctx.lineWidth = T * 0.07;
        }
        const d = CONVEYOR_DIR[t] - 1;
        const c = ARM_DIRS[d][0], s = ARM_DIRS[d][1]; // cos/sin of ARM_ANGLES[d]
        ctx.setTransform(c, s, -s, c, cx, cy);
        ctx.beginPath();
        for (let k = 0; k < 2; k++) {
          const ox = ((phase + k * 0.5) % 1 - 0.5) * T * 0.8;
          ctx.moveTo(ox - T * 0.1, -T * 0.16);
          ctx.lineTo(ox + T * 0.06, 0);
          ctx.lineTo(ox - T * 0.1, T * 0.16);
        }
        ctx.stroke();
      }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /** King-of-the-hill zones: pulsing golden 3x3 squares. */
  drawHills(hills, camX, camY, T, sec) {
    if (!hills) return;
    const { ctx } = this;
    const pulse = 0.5 + 0.5 * Math.sin(sec * 3);
    for (const [hx, hy] of hills) {
      const px = (hx - 1) * T - camX, py = (hy - 1) * T - camY;
      ctx.fillStyle = `rgba(255,211,74,${0.12 + 0.1 * pulse})`;
      ctx.fillRect(px, py, T * 3, T * 3);
      ctx.strokeStyle = `rgba(255,211,74,${0.6 + 0.4 * pulse})`;
      ctx.lineWidth = Math.max(2, T * 0.06);
      ctx.setLineDash([T * 0.3, T * 0.2]);
      ctx.lineDashOffset = -sec * T;
      ctx.strokeRect(px + 2, py + 2, T * 3 - 4, T * 3 - 4);
      ctx.setLineDash([]);
      ctx.font = this.font(Math.round(T * 0.5), '');
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.globalAlpha = 0.55;
      ctx.fillText('👑', px + T * 1.5, py + T * 1.5);
      ctx.globalAlpha = 1;
    }
  }

  drawItems(items, camX, camY, T, sec, W, H) {
    const { ctx } = this;
    // Halos first, all in one additive pass (one composite switch per frame).
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const x = it[0], y = it[1], kind = it[2];
      const cx = (x + 0.5) * T - camX, cy = (y + 0.5) * T - camY;
      if (cx < -T || cy < -T || cx > W + T || cy > H + T) continue;
      const bob = Math.sin(sec * 4 + x + y) * T * 0.04;
      const hs = T * 1.25 * (1 + 0.08 * Math.sin(sec * 3 + x * 2));
      ctx.drawImage(this.halo(HALO[kind]), cx - hs / 2, cy - hs / 2 + bob, hs, hs);
    }
    ctx.globalCompositeOperation = 'source-over';
    const size = T * 0.82;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const x = it[0], y = it[1], kind = it[2];
      const cx = (x + 0.5) * T - camX, cy = (y + 0.5) * T - camY;
      if (cx < -T || cy < -T || cx > W + T || cy > H + T) continue;
      const s = this.art(ITEM_SPRITES[kind]);
      if (!s) continue;
      const bob = Math.sin(sec * 4 + x + y) * T * 0.04;
      if (kind === 8) {
        // Secret box: wobbles, and colour sparks orbit it.
        const r = Math.sin(sec * 5 + x) * 0.14, rc = Math.cos(r), rs = Math.sin(r);
        ctx.setTransform(rc, rs, -rs, rc, cx, cy + bob);
        ctx.drawImage(s, -size / 2, -size / 2, size, size);
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        for (let k = 0; k < 3; k++) {
          const a = sec * 2.5 + k * 2.094;
          ctx.fillStyle = k === 0 ? '#ff7af0' : k === 1 ? '#7ff6ff' : '#ffd34a';
          ctx.beginPath();
          ctx.arc(cx + Math.cos(a) * T * 0.45, cy + bob + Math.sin(a) * T * 0.45, T * 0.05, 0, 6.2832);
          ctx.fill();
        }
      } else {
        ctx.drawImage(s, cx - size / 2, cy - size / 2 + bob, size, size);
      }
    }
  }

  /**
   * Portal pairs: a swirling ring in the pair's colour (by owner), dashed
   * and dim while the first one waits for its partner, flickering as the
   * pair runs out. Shape and motion, not just colour, tell them apart.
   */
  drawPortals(state, camX, camY, T, sec) {
    const portals = state.snaps.latest()?.x?.portals;
    if (!portals?.length) return;
    const { ctx } = this;
    for (const [, x, y, owner, partner, left] of portals) {
      const cx = (x + 0.5) * T - camX, cy = (y + 0.5) * T - camY;
      const color = PORTAL_COLORS[owner % PORTAL_COLORS.length];
      const active = partner !== 0;
      const fading = left < 60 && Math.floor(sec * 8) % 2 === 0;
      ctx.save();
      ctx.translate(cx, cy);
      ctx.globalAlpha = active ? (fading ? 0.55 : 1) : 0.55;
      ctx.fillStyle = 'rgba(8,10,30,0.75)';
      ctx.beginPath();
      ctx.ellipse(0, 0, T * 0.38, T * 0.44, 0, 0, 6.2832);
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = T * 0.08;
      if (!active) ctx.setLineDash([T * 0.1, T * 0.08]);
      ctx.beginPath();
      ctx.ellipse(0, 0, T * 0.38, T * 0.44, 0, 0, 6.2832);
      ctx.stroke();
      if (active) {
        // A spiral turning inwards.
        ctx.rotate(sec * 3);
        ctx.lineWidth = T * 0.04;
        ctx.beginPath();
        for (let k = 0; k < 24; k++) {
          const a = k * 0.5, r = T * 0.32 * (1 - k / 26);
          if (k === 0) ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r); else ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
        }
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  /** Gas clouds: drifting green puffs over every cell, thinning as they fade. */
  drawGas(state, camX, camY, T, sec, dt) {
    const clouds = state.snaps.latest()?.x?.gas;
    if (!clouds?.length) return;
    const { ctx } = this;
    for (const [id, x, y, arms, left] of clouds) {
      const fade = Math.min(1, left / 15);
      const cell = (cx, cy, k) => {
        const px = (cx + 0.5) * T - camX, py = (cy + 0.5) * T - camY;
        const wob = Math.sin(sec * 1.7 + k * 1.3 + id) * T * 0.06;
        ctx.globalAlpha = 0.5 * fade;
        ctx.fillStyle = '#6fb02f';
        ctx.beginPath();
        ctx.arc(px + wob, py - wob, T * 0.62, 0, 6.2832);
        ctx.fill();
        ctx.globalAlpha = 0.35 * fade;
        ctx.fillStyle = '#c8ff8a';
        ctx.beginPath();
        ctx.arc(px - wob * 1.5, py + wob, T * 0.32, 0, 6.2832);
        ctx.fill();
        if (Math.random() < dt * 1.5) this.particles.emit(P_SMOKE, cx + Math.random(), cy + Math.random(), 0, -0.2, 1.2, 0.18, C_GAS);
      };
      cell(x, y, 0);
      for (let d = 0; d < 4; d++) {
        for (let r = 1; r <= arms[d]; r++) cell(x + ARM_DIRS[d][0] * r, y + ARM_DIRS[d][1] * r, d * 8 + r);
      }
    }
    ctx.globalAlpha = 1;
  }

  /** Sticky bombs ride on their carrier's back, fuse ring and all. */
  drawStuckBombs(f, camX, camY, T, sec) {
    const { ctx } = this;
    for (let i = 0; i < f.nBombs; i++) {
      const b = f.bombs[i];
      if (!b.carrier) continue;
      let who = null;
      for (let k = 0; k < f.nPlayers; k++) if (f.players[k].id === b.carrier && !f.players[k].clone) { who = f.players[k]; break; }
      if (!who) continue;
      const size = T * 0.6;
      const px = (who.x + 0.28) * T - camX, py = (who.y - 0.2) * T - camY - who.lift;
      ctx.drawImage(this.art('bomb'), px - size / 2, py - size / 2, size, size);
      drawGoo(ctx, px, py, size, sec);
      // How much fuse is left, as a shrinking ring.
      const left = Math.min(1, b.fuse / 60);
      ctx.strokeStyle = left < 0.3 ? `rgba(255,60,30,${0.6 + 0.4 * Math.sin(sec * 30)})` : '#ff7ad9';
      ctx.lineWidth = T * 0.06;
      ctx.beginPath();
      ctx.arc(px, py, size * 0.62, -Math.PI / 2, -Math.PI / 2 + left * 6.2832);
      ctx.stroke();
    }
  }

  drawBombs(f, camX, camY, T, sec, dt) {
    const { ctx } = this;
    const pix = this.pixelArt();
    for (let i = 0; i < f.nBombs; i++) {
      const b = f.bombs[i];
      if (b.carrier) continue; // drawn on whoever carries it (drawStuckBombs)
      const urgency = b.remote ? 0 : 1 - Math.min(1, b.fuse / (b.nuke ? NUKE_FUSE_TICKS : 50));
      const pulse = 1 + Math.sin(sec * (6 + urgency * 18)) * (0.05 + urgency * 0.06);
      const size = T * (b.nuke ? 1.15 : 0.95) * pulse;
      let px = (b.x + 0.5) * T - camX, py = (b.y + 0.5) * T - camY;
      const late = !b.remote && b.fuse < 15;
      if (late) {
        px += (Math.random() - 0.5) * T * 0.06;
        py += (Math.random() - 0.5) * T * 0.06;
      }
      if (b.mine) {
        this.drawMine(px, py, T, sec);
        continue;
      }
      if (b.rocket) {
        this.drawRocket(b, px, py, T, sec);
        continue;
      }
      if (b.gas) {
        // Gas bombs leak green wisps.
        ctx.fillStyle = 'rgba(140,210,80,0.35)';
        ctx.beginPath();
        ctx.arc(px, py + size * 0.08, size * 0.55, 0, 6.2832);
        ctx.fill();
        if (Math.random() < dt * 8) this.particles.emit(P_SMOKE, b.x + 0.5, b.y + 0.4, (Math.random() - 0.5) * 0.4, -0.5, 0.9, 0.12, C_GAS);
      }
      if (b.freeze) {
        // Frosty halo around freeze bombs.
        ctx.fillStyle = 'rgba(160,230,255,0.35)';
        ctx.beginPath();
        ctx.arc(px, py + size * 0.08, size * 0.55, 0, 6.2832);
        ctx.fill();
      }
      ctx.drawImage(this.art(b.nuke ? 'bomb_nuke' : b.pierce ? 'bomb_pierce' : 'bomb'), px - size / 2, py - size / 2, size, size);
      if (b.remote && pix) {
        ctx.drawImage(pix.antenna[Math.floor(sec * 4) % 2], px - size / 2, py - size / 2, size, size);
      } else if (b.remote) {
        // Remote bombs: antenna with a blinking LED.
        ctx.strokeStyle = '#9fb0c8';
        ctx.lineWidth = T * 0.03;
        ctx.beginPath();
        ctx.moveTo(px - size * 0.1, py - size * 0.25);
        ctx.lineTo(px - size * 0.22, py - size * 0.5);
        ctx.stroke();
        ctx.fillStyle = Math.floor(sec * 4) % 2 ? '#4af' : '#bdf';
        ctx.beginPath();
        ctx.arc(px - size * 0.22, py - size * 0.52, T * 0.05, 0, 6.2832);
        ctx.fill();
      }
      if (b.sticky) drawGoo(ctx, px, py, size, sec);
      if (late || this.highContrast) {
        ctx.strokeStyle = late ? `rgba(255,60,30,${0.5 + 0.5 * Math.sin(sec * 30)})` : '#fff';
        ctx.lineWidth = T * 0.05;
        ctx.beginPath();
        ctx.arc(px - size * 0.03, py + size * 0.09, size * 0.33, 0, 6.2832);
        ctx.stroke();
      }
      // Fuse sparks fly off the tip.
      if (!b.remote && Math.random() < dt * 30) {
        const [tx, ty] = pix ? FUSE_TIP_PIXEL : FUSE_TIP;
        this.particles.emit(P_SPARK, b.x + 0.5 + tx * pulse, b.y + 0.5 + ty * pulse,
          (Math.random() - 0.5) * 2, -Math.random() * 2, 0.25, 0.04, 1);
      }
    }
  }

  /**
   * Danger zones of ticking atomic bombs, under everything else: every cell
   * the blast will burn is tinted red (pulsing faster as the fuse runs
   * out), with a bold line where safety starts. Returns the zone the local
   * player stands in (the bomb), or null.
   */
  drawNukeZones(state, f, camX, camY, T, sec) {
    let mine = null;
    const { ctx } = this;
    const { map } = state;
    const me = state.me?.alive ? state.self : null;
    for (let i = 0; i < f.nBombs; i++) {
      const b = f.bombs[i];
      if (!b.nuke) continue;
      const bx = Math.round(b.x), by = Math.round(b.y);
      const urgency = 1 - Math.min(1, b.fuse / NUKE_FUSE_TICKS);
      const beat = 0.5 + 0.5 * Math.sin(sec * (4 + urgency * 20));
      // Cells that will burn (walls don't).
      ctx.fillStyle = `rgba(255,40,20,${0.14 + 0.08 * beat + 0.12 * urgency})`;
      ctx.beginPath();
      for (let k = 0; k < NUKE_DISC.length; k += 2) {
        const x = bx + NUKE_DISC[k], y = by + NUKE_DISC[k + 1];
        if (x < 0 || y < 0 || x >= map.w || y >= map.h || map.tiles[y * map.w + x] === T_WALL) continue;
        ctx.rect(x * T - camX, y * T - camY, T, T);
      }
      ctx.fill();
      // The border of the zone: dark underlay for contrast, then bright.
      ctx.beginPath();
      for (let k = 0; k < NUKE_OUTLINE.length; k += 4) {
        ctx.moveTo((bx + NUKE_OUTLINE[k]) * T - camX, (by + NUKE_OUTLINE[k + 1]) * T - camY);
        ctx.lineTo((bx + NUKE_OUTLINE[k + 2]) * T - camX, (by + NUKE_OUTLINE[k + 3]) * T - camY);
      }
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(0,0,0,0.55)';
      ctx.lineWidth = Math.max(4, T * 0.16);
      ctx.stroke();
      ctx.strokeStyle = `rgb(255,${Math.round(220 - 170 * urgency)},40)`;
      ctx.lineWidth = Math.max(2, T * 0.08);
      ctx.globalAlpha = 0.65 + 0.35 * beat;
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.lineCap = 'butt';
      if (me && inNukeDisc(Math.floor(me.x) - bx, Math.floor(me.y) - by)) {
        if (!mine || b.fuse < mine.fuse) mine = b;
      }
    }
    return mine;
  }

  /** Seconds left over each atomic bomb, above players and names. */
  drawNukeCountdowns(f, camX, camY, T) {
    const { ctx } = this;
    for (let i = 0; i < f.nBombs; i++) {
      const b = f.bombs[i];
      if (!b.nuke) continue;
      const px = (b.x + 0.5) * T - camX, py = (b.y + 0.5) * T - camY - T * 0.75;
      const fs = Math.max(Math.round(14 * this.dpr), Math.round(T * 0.45));
      ctx.font = this.font(fs, 800);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      const label = `☢ ${Math.ceil(b.fuse * 0.05)}`;
      ctx.lineWidth = Math.max(3, fs * 0.22);
      ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.strokeText(label, px, py);
      ctx.fillStyle = b.fuse < 20 ? '#ff5a3a' : '#ffd23f';
      ctx.fillText(label, px, py);
    }
  }

  /**
   * The local player is inside an atomic bomb's zone: an arrow points the
   * way out (straight away from ground zero).
   */
  drawRunWarning(state, b, camX, camY, T, sec, W) {
    const { ctx } = this;
    const sx = state.self.x, sy = state.self.y;
    let dx = sx - (b.x + 0.5), dy = sy - (b.y + 0.5);
    const len = Math.hypot(dx, dy);
    if (len < 0.05) { dx = 0; dy = -1; } else { dx /= len; dy /= len; }
    const px = sx * T - camX, py = sy * T - camY;
    const bob = (0.5 + 0.5 * Math.sin(sec * 10)) * T * 0.15;
    const ax = px + dx * (T * 0.9 + bob), ay = py + dy * (T * 0.9 + bob);
    const s = T * 0.45;
    // Arrowhead pointing away from the bomb.
    ctx.beginPath();
    ctx.moveTo(ax + dx * s, ay + dy * s);
    ctx.lineTo(ax - dy * s * 0.6, ay + dx * s * 0.6);
    ctx.lineTo(ax + dy * s * 0.6, ay - dx * s * 0.6);
    ctx.closePath();
    ctx.fillStyle = '#ffd23f';
    ctx.strokeStyle = 'rgba(0,0,0,0.8)';
    ctx.lineWidth = Math.max(2, T * 0.05);
    ctx.fill();
    ctx.stroke();
    // (The "get out" message is a status alert: see main.js.)
  }

  // ------------------------------------------------- events and gadgets

  /** A conveyor or teleporter changed (map events): keep the animated list in step. */
  updateSpecial(x, y, tile) {
    const i = this.specials.findIndex((s) => s[0] === x && s[1] === y);
    const special = CONVEYOR_DIR[tile] || tile === T_TELEPORT;
    if (i >= 0 && special) this.specials[i][2] = tile;
    else if (i >= 0) this.specials.splice(i, 1);
    else if (special) this.specials.push([x, y, tile]);
  }

  /** A map event started (1 meteors, 2 blizzard, 3 lava, 4 conveyors). */
  mapEvent(kind, now, durationMs) {
    this.weather = { kind, start: now, end: now + durationMs };
  }

  addMeteor(x, y, at) {
    this.meteors.push({ x, y, at, hit: false });
  }

  /** Lava surge: flat [x0, y0, x1, y1, ...] cells, erupting at `start` for `burnMs`. */
  addLava(flat, start, burnMs) {
    this.lava.push({ cells: flat, warn: performance.now(), start, end: start + burnMs });
  }

  /** A small five-pointed star. */
  star(ctx, x, y, r) {
    ctx.beginPath();
    for (let k = 0; k < 10; k++) {
      const a = -Math.PI / 2 + k * Math.PI / 5, rr = k % 2 ? r * 0.45 : r;
      if (k === 0) ctx.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); else ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
    }
    ctx.closePath();
    ctx.fill();
  }

  /** A waving flag on a pole whose foot is at (x, y), `h` tall. */
  drawFlag(x, y, h, color, sec) {
    const { ctx } = this;
    ctx.strokeStyle = '#d8d8d8';
    ctx.lineWidth = Math.max(2, h * 0.06);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x, y - h);
    ctx.stroke();
    const w = h * 0.55, fh = h * 0.36, top = y - h;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x, top);
    for (let k = 0; k <= 6; k++) {
      const fx = x + (w * k) / 6;
      ctx.lineTo(fx, top + Math.sin(sec * 8 + k) * h * 0.04 * (k / 6));
    }
    for (let k = 6; k >= 0; k--) {
      const fx = x + (w * k) / 6;
      ctx.lineTo(fx, top + fh + Math.sin(sec * 8 + k) * h * 0.04 * (k / 6));
    }
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  /** Your own hidden land mine: a dim disc with a blinking light. */
  drawMine(px, py, T, sec) {
    const { ctx } = this;
    ctx.globalAlpha = 0.55;
    ctx.fillStyle = '#3a3f4f';
    ctx.beginPath();
    ctx.ellipse(px, py + T * 0.1, T * 0.3, T * 0.18, 0, 0, 6.2832);
    ctx.fill();
    ctx.fillStyle = '#6a7394';
    ctx.beginPath();
    ctx.ellipse(px, py + T * 0.04, T * 0.2, T * 0.11, 0, 0, 6.2832);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillStyle = Math.floor(sec * 2) % 2 ? '#ff4a3a' : '#5a1a14';
    ctx.beginPath();
    ctx.arc(px, py + T * 0.02, T * 0.05, 0, 6.2832);
    ctx.fill();
  }

  /** A rocket pointing the way it flies, with an exhaust flame. */
  drawRocket(b, px, py, T, sec) {
    const { ctx } = this;
    let a = Math.atan2(b.dy, b.dx);
    if (b.dx === 0 && b.dy === 0) a = (b.rocketA ?? 0);
    b.rocketA = a;
    const c = Math.cos(a), s = Math.sin(a);
    ctx.setTransform(c, s, -s, c, px, py);
    const L = T * 0.8, R = T * 0.17;
    // Exhaust.
    ctx.globalCompositeOperation = 'lighter';
    const flick = 0.8 + 0.4 * Math.sin(sec * 40);
    ctx.fillStyle = 'rgba(255,170,40,0.9)';
    ctx.beginPath();
    ctx.moveTo(-L * 0.45, -R * 0.7);
    ctx.lineTo(-L * (0.45 + 0.5 * flick), 0);
    ctx.lineTo(-L * 0.45, R * 0.7);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
    // Body, fins and nose.
    ctx.fillStyle = '#d9dde8';
    ctx.fillRect(-L * 0.45, -R, L * 0.7, R * 2);
    ctx.fillStyle = '#d23a2f';
    ctx.beginPath();
    ctx.moveTo(L * 0.25, -R);
    ctx.lineTo(L * 0.55, 0);
    ctx.lineTo(L * 0.25, R);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-L * 0.45, -R);
    ctx.lineTo(-L * 0.55, -R * 1.9);
    ctx.lineTo(-L * 0.2, -R);
    ctx.moveTo(-L * 0.45, R);
    ctx.lineTo(-L * 0.55, R * 1.9);
    ctx.lineTo(-L * 0.2, R);
    ctx.fill();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (Math.random() < 0.6) this.particles.emit(P_SMOKE, b.x + 0.5 - c * 0.45, b.y + 0.5 - s * 0.45, -c * 0.5, -s * 0.5, 0.5, 0.12, 4);
  }

  /**
   * Things on the ground under everything else: the sudden-death ring
   * about to close, lava surges, meteor targets, and capture-the-flag
   * bases and flags lying around.
   */
  drawGroundEvents(state, now, camX, camY, T, sec, W, H) {
    const { ctx } = this;
    const sd = state.sd;
    if (sd) {
      // The next ring to turn to stone, pulsing faster as it nears.
      const left = Math.max(0, sd.nextAt - now);
      const urgency = 1 - Math.min(1, left / 2500);
      const beat = 0.5 + 0.5 * Math.sin(sec * (4 + 16 * urgency));
      ctx.fillStyle = `rgba(255,40,20,${0.18 + 0.3 * urgency * beat})`;
      const r = sd.r;
      const x0 = (sd.cx - r) * T - camX, y0 = (sd.cy - r) * T - camY, size = (2 * r + 1) * T;
      ctx.beginPath();
      ctx.rect(x0, y0, size, size);
      ctx.rect(x0 + T, y0 + T, size - 2 * T, size - 2 * T);
      ctx.fill('evenodd');
      ctx.strokeStyle = `rgba(255,${Math.round(220 - 160 * urgency)},40,0.9)`;
      ctx.lineWidth = Math.max(2, T * 0.08);
      ctx.strokeRect(x0 + T, y0 + T, size - 2 * T, size - 2 * T);
    }
    // Lava: glowing cracks while it warns, then fire.
    let keep = 0;
    for (const lv of this.lava) {
      if (now > lv.end) continue;
      this.lava[keep++] = lv;
      const burning = now >= lv.start;
      const pix = this.pixelArt();
      const tick = Math.floor(now / 70);
      for (let i = 0; i < lv.cells.length; i += 2) {
        const x = lv.cells[i], y = lv.cells[i + 1];
        const px = x * T - camX, py = y * T - camY;
        if (px < -T || py < -T || px > W || py > H) continue;
        if (!burning) {
          const k = (now - lv.warn) / Math.max(1, lv.start - lv.warn);
          ctx.fillStyle = `rgba(255,${Math.round(120 - 60 * k)},20,${0.15 + 0.4 * k * (0.6 + 0.4 * Math.sin(sec * 12 + x + y))})`;
          ctx.fillRect(px + T * 0.1, py + T * 0.1, T * 0.8, T * 0.8);
        } else {
          const sprite = pix ? pix.flames.center[(tick + x * 7 + y * 3) % 3] : this.assets.sprite('flame_center');
          ctx.globalAlpha = Math.min(1, (lv.end - now) / 300);
          ctx.drawImage(sprite, px, py, T, T);
          ctx.globalAlpha = 1;
        }
      }
    }
    this.lava.length = keep;
    // Meteor targets: a shrinking ring and cross-hair where it will land.
    keep = 0;
    for (const m of this.meteors) {
      if (now > m.at + 300) continue;
      this.meteors[keep++] = m;
      if (now >= m.at) {
        if (!m.hit) {
          m.hit = true;
          this.particles.burst(P_DEBRIS, m.x + 0.5, m.y + 0.5, 14, 5, 0.9, 0.14, 4, 3);
          this.shake = Math.max(this.shake, 0.25);
        }
        continue;
      }
      const k = Math.max(0, Math.min(1, 1 - (m.at - now) / METEOR_WARN_MS));
      const cx = (m.x + 0.5) * T - camX, cy = (m.y + 0.5) * T - camY;
      ctx.strokeStyle = `rgba(255,90,40,${0.4 + 0.5 * k})`;
      ctx.lineWidth = Math.max(2, T * 0.06);
      ctx.beginPath();
      ctx.arc(cx, cy, T * (1.6 - 1.1 * k), 0, 6.2832);
      ctx.stroke();
      ctx.fillStyle = `rgba(255,60,20,${0.15 + 0.3 * k})`;
      ctx.fillRect(cx - T * 1.5, cy - T * 0.5, T * 3, T);
      ctx.fillRect(cx - T * 0.5, cy - T * 1.5, T, T * 3);
    }
    this.meteors.length = keep;
    // Capture the flag: bases, and flags at home or dropped.
    if (state.flags) {
      for (let k = 0; k < 2; k++) {
        const f = state.flags[k];
        const color = TEAM_COLORS[k + 1];
        const bx = (f.base[0] + 0.5) * T - camX, by = (f.base[1] + 0.5) * T - camY;
        ctx.fillStyle = k === 0 ? 'rgba(255,90,74,0.25)' : 'rgba(90,160,255,0.25)';
        ctx.fillRect(bx - T * 1.5, by - T * 1.5, T * 3, T * 3);
        ctx.strokeStyle = color;
        ctx.lineWidth = Math.max(2, T * 0.06);
        ctx.setLineDash([T * 0.25, T * 0.15]);
        ctx.strokeRect(bx - T * 1.5 + 2, by - T * 1.5 + 2, T * 3 - 4, T * 3 - 4);
        ctx.setLineDash([]);
        if (f.state !== 1) {
          const fx = (f.pos[0] + 0.5) * T - camX, fy = (f.pos[1] + 0.5) * T - camY;
          this.drawFlag(fx - T * 0.1, fy + T * 0.35, T * 0.95, color, sec);
          if (f.state === 2) {
            // Dropped: blinking so both teams notice it.
            ctx.strokeStyle = `rgba(255,255,255,${0.4 + 0.4 * Math.sin(sec * 8)})`;
            ctx.beginPath();
            ctx.arc(fx, fy, T * 0.55, 0, 6.2832);
            ctx.stroke();
          }
        }
      }
    }
  }

  /** The battle royale safe zone right now (moving while it closes in). */
  zoneNow(state, now) {
    const z = state.zone;
    if (!z) return null;
    if (z.state !== 1) return z.from;
    const k = Math.min(1, Math.max(0, (now - z.start) / Math.max(1, z.end - z.start)));
    return { x: z.from.x + (z.to.x - z.from.x) * k, y: z.from.y + (z.to.y - z.from.y) * k, r: z.from.r + (z.to.r - z.from.r) * k };
  }

  /** The storm outside the zone (blue fog), its edge, and the next circle. */
  drawZone(state, now, camX, camY, T, sec, W, H) {
    const cur = this.zoneNow(state, now);
    if (!cur || state.royale?.on === false) return;
    const { ctx } = this;
    const z = state.zone;
    const cx = cur.x * T - camX, cy = cur.y * T - camY, r = Math.max(0, cur.r * T);
    ctx.fillStyle = 'rgba(40,80,220,0.32)';
    ctx.beginPath();
    ctx.rect(0, 0, W, H);
    ctx.moveTo(cx + r, cy);
    ctx.arc(cx, cy, r, 0, 6.2832, true);
    ctx.fill('evenodd');
    ctx.strokeStyle = `rgba(120,170,255,${0.75 + 0.25 * Math.sin(sec * 4)})`;
    ctx.lineWidth = Math.max(3, T * 0.12);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, 6.2832);
    ctx.stroke();
    if (z.state === 0 || z.state === 1) {
      // Where the zone is heading.
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = Math.max(2, T * 0.06);
      ctx.setLineDash([T * 0.4, T * 0.25]);
      ctx.beginPath();
      ctx.arc(z.to.x * T - camX, z.to.y * T - camY, Math.max(1, z.to.r * T), 0, 6.2832);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  /** In the sky: falling meteors and bomber drones. */
  drawSky(state, now, camX, camY, T, sec) {
    const { ctx } = this;
    for (const m of this.meteors) {
      const left = m.at - now;
      if (left < 0 || left > 600) continue;
      const k = left / 600; // 1 high up, 0 at impact
      const cx = (m.x + 0.5 + k * 3) * T - camX, cy = (m.y + 0.5 - k * 7) * T - camY;
      ctx.globalCompositeOperation = 'lighter';
      const g = ctx.createLinearGradient(cx, cy, cx + T * 1.5, cy - T * 3.5);
      g.addColorStop(0, 'rgba(255,200,80,0.9)');
      g.addColorStop(1, 'rgba(255,80,0,0)');
      ctx.strokeStyle = g;
      ctx.lineWidth = T * 0.35;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + T * 1.5, cy - T * 3.5);
      ctx.stroke();
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = '#5a3a2a';
      ctx.beginPath();
      ctx.arc(cx, cy, T * 0.3, 0, 6.2832);
      ctx.fill();
      ctx.fillStyle = '#ffb02e';
      ctx.beginPath();
      ctx.arc(cx - T * 0.08, cy + T * 0.06, T * 0.16, 0, 6.2832);
      ctx.fill();
    }
    const f = this.frame;
    for (let i = 0; i < f.nDrones; i++) {
      const d = f.drones[i];
      const px = d.x * T - camX, py = d.y * T - camY;
      const hover = Math.sin(sec * 5 + d.id) * T * 0.05;
      // Shadow on the ground.
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.beginPath();
      ctx.ellipse(px, py + T * 0.3, T * 0.32, T * 0.1, 0, 0, 6.2832);
      ctx.fill();
      const y = py - T * 0.55 + hover;
      // Arms, rotors and body.
      ctx.strokeStyle = '#2a2f3d';
      ctx.lineWidth = Math.max(2, T * 0.06);
      ctx.beginPath();
      ctx.moveTo(px - T * 0.3, y - T * 0.18); ctx.lineTo(px + T * 0.3, y + T * 0.18);
      ctx.moveTo(px + T * 0.3, y - T * 0.18); ctx.lineTo(px - T * 0.3, y + T * 0.18);
      ctx.stroke();
      ctx.fillStyle = 'rgba(220,230,255,0.45)';
      for (const [rx, ry] of [[-0.3, -0.18], [0.3, -0.18], [-0.3, 0.18], [0.3, 0.18]]) {
        ctx.beginPath();
        ctx.ellipse(px + rx * T, y + ry * T, T * 0.16, T * 0.05 * (1 + Math.abs(Math.sin(sec * 40 + rx))), 0, 0, 6.2832);
        ctx.fill();
      }
      ctx.fillStyle = TEAM_COLORS[d.team] ?? TEAM_COLORS[0];
      ctx.fillRect(px - T * 0.14, y - T * 0.1, T * 0.28, T * 0.2);
      ctx.fillStyle = Math.floor(sec * 4 + d.id) % 2 ? '#ff4a3a' : '#7fff6a';
      ctx.beginPath();
      ctx.arc(px, y, T * 0.04, 0, 6.2832);
      ctx.fill();
    }
  }

  /** Blizzard: driving snow over the whole view. */
  drawWeather(now, dt, W, H) {
    const w = this.weather;
    if (!w || w.kind !== EVENT_BLIZZARD || now > w.end) return;
    const { ctx } = this;
    if (!this.snow) {
      this.snow = new Float32Array(240 * 3);
      for (let i = 0; i < this.snow.length; i += 3) {
        this.snow[i] = Math.random(); this.snow[i + 1] = Math.random(); this.snow[i + 2] = 0.3 + Math.random() * 0.7;
      }
    }
    const fade = Math.min(1, (now - w.start) / 1000, (w.end - now) / 1000);
    ctx.fillStyle = `rgba(230,240,255,${0.18 * fade})`;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = `rgba(255,255,255,${0.85 * fade})`;
    const s = this.snow, r = Math.max(1.5, 2 * this.dpr);
    ctx.beginPath();
    for (let i = 0; i < s.length; i += 3) {
      s[i] = (s[i] + dt * 0.25 * s[i + 2] + 1) % 1;
      s[i + 1] = (s[i + 1] + dt * 0.35 * s[i + 2]) % 1;
      const x = s[i] * W, y = s[i + 1] * H, rr = r * (0.6 + s[i + 2]);
      ctx.moveTo(x + rr, y);
      ctx.arc(x, y, rr, 0, 6.2832);
    }
    ctx.fill();
  }

  /** Letterbox and label while a death replay plays. */
  drawReplayFrame(sec, W, H) {
    const { ctx } = this;
    const bar = Math.round(H * 0.07);
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.fillRect(0, 0, W, bar);
    ctx.fillRect(0, H - bar, W, bar);
    const fs = Math.round(16 * this.dpr);
    ctx.font = this.font(fs, 800);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = Math.floor(sec * 2) % 2 ? '#ff5a4a' : '#ffffff';
    ctx.fillText(`● ${t('replay')}`, W / 2, H - bar / 2);
  }

  drawExplosions(explosions, camX, camY, T) {
    const { ctx } = this;
    const pix = this.pixelArt();
    // Pixel flames flicker through three frames; each explosion starts on its own.
    const tick = Math.floor(performance.now() / 70);
    let center = this.assets.sprite('flame_center');
    let arm = this.assets.sprite('flame_arm');
    let end = this.assets.sprite('flame_end');
    for (let k = 0; k < explosions.length; k++) {
      const [ex, ey, arms, left, nuke] = explosions[k];
      if (nuke) continue; // atomic blasts have their own effect (drawNuke*)
      if (pix) {
        const fr = (tick + ex * 7 + ey * 3) % 3;
        center = pix.flames.center[fr];
        arm = pix.flames.arm[fr];
        end = pix.flames.end[fr];
      }
      const life = left / 10; // 1 when fresh, 0 when gone
      ctx.globalAlpha = Math.min(1, life * 2.2);
      const thick = 0.75 + 0.25 * Math.sin(Math.min(1, (1 - life) * 3) * Math.PI / 2);
      for (let d = 0; d < 4; d++) {
        for (let r = 1; r <= arms[d]; r++) {
          const cx = (ex + ARM_DIRS[d][0] * r + 0.5) * T - camX;
          const cy = (ey + ARM_DIRS[d][1] * r + 0.5) * T - camY;
          // rotate(ARM_ANGLES[d]) then scale(1, thick), as one matrix
          const c = ARM_DIRS[d][0], sn = ARM_DIRS[d][1];
          ctx.setTransform(c, sn, -sn * thick, c * thick, cx, cy);
          ctx.drawImage(r === arms[d] ? end : arm, -T / 2, -T / 2, T + 1, T);
        }
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      const s = T * (0.9 + 0.2 * thick);
      ctx.drawImage(center, (ex + 0.5) * T - camX - s / 2, (ey + 0.5) * T - camY - s / 2, s, s);
    }
    // Additive glow over all flames.
    ctx.globalCompositeOperation = 'lighter';
    const glow = this.assets.glow;
    for (let k = 0; k < explosions.length; k++) {
      const [ex, ey, arms, left, nuke] = explosions[k];
      if (nuke) continue;
      ctx.globalAlpha = Math.min(1, left / 10) * 0.8;
      const g = T * 2.2;
      ctx.drawImage(glow, (ex + 0.5) * T - camX - g / 2, (ey + 0.5) * T - camY - g / 2, g, g);
      const ga = T * 1.4;
      for (let d = 0; d < 4; d++) {
        for (let r = 1; r <= arms[d]; r++) {
          const cx = (ex + ARM_DIRS[d][0] * r + 0.5) * T - camX, cy = (ey + ARM_DIRS[d][1] * r + 0.5) * T - camY;
          ctx.drawImage(glow, cx - ga / 2, cy - ga / 2, ga, ga);
        }
      }
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  colorsFor(id, state) {
    return this.look(id, state).colors;
  }

  /** Cached colours and sprites of a player (rebuilt when team or palette changes). */
  look(id, state) {
    const team = state.rosterInfo.get(id)?.team ?? 0;
    let l = this.looks.get(id);
    if (!l || l.team !== team || l.cb !== this.colorblind) {
      l = { team, cb: this.colorblind, colors: playerColors(id, team, this.colorblind), sprites: new Array(9).fill(null) };
      this.looks.set(id, l);
    }
    return l;
  }

  /**
   * `frame`: 0 standing, 1 and 2 the walk steps (pixel art only). `cache`
   * (a player's `look().sprites`) memoizes the sprite lookup.
   */
  drawSprite(colors, facing, px, py, T, sxs, sys, frame = 0, cache = null) {
    const vi = facing === 1 ? 0 : facing === 3 ? 1 : 2;
    let sprite = null;
    if (this.pixelArt()) {
      const slot = vi * 3 + frame;
      sprite = cache?.[slot];
      if (!sprite) {
        sprite = this.assets.pixelPlayer(colors, PIXEL_VIEWS[vi], frame);
        if (cache) cache[slot] = sprite;
      }
    } else {
      sprite = this.assets.player(colors, PLAYER_VIEWS[vi]);
    }
    const { ctx } = this;
    // Players draw in screen space (one setTransform); death effects call
    // this inside their own transform, so they nest with save/restore.
    const nested = cache === null;
    if (nested) {
      ctx.save();
      ctx.translate(px, py);
      ctx.scale(facing === 4 ? -sxs : sxs, sys);
    } else {
      ctx.setTransform(facing === 4 ? -sxs : sxs, 0, 0, sys, px, py);
    }
    if (sprite) ctx.drawImage(sprite, -T / 2, -T * 0.92, T, T);
    else {
      ctx.fillStyle = colors[0];
      ctx.beginPath();
      ctx.arc(0, -T * 0.4, T * 0.35, 0, 6.2832);
      ctx.fill();
    }
    if (nested) ctx.restore();
    else ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  drawPlayer(p, camX, camY, T, sec, dt, state) {
    const { ctx } = this;
    const info = state.rosterInfo.get(p.id);
    const look = this.look(p.id, state);
    const colors = look.colors;
    // Two-step walk cycle: a hop with squash and stretch. Pixel art steps
    // its legs instead and hops by whole art pixels, so the grid never warps.
    const pixel = this.pixelArt() !== null;
    const phase = p.moving ? Math.abs(Math.sin(sec * 12 + p.id)) : 0;
    const bob = pixel ? -Math.round(phase) * T / 16 : -phase * T * 0.07;
    const sxs = pixel ? 1 : 1 + phase * 0.05, sys = pixel ? 1 : 1 - phase * 0.06;
    const step = p.moving ? (Math.floor((sec * 12 + p.id) / Math.PI) % 2 ? 1 : 2) : 0;
    const px = p.x * T - camX;
    let py = p.y * T - camY;
    // A hop over a pillar: a shadow stays on the ground, the player arcs up.
    const hop = p.jumpDir ? hopHeight(state.map, p.x, p.y, p.jumpDir) : 0;
    p.lift = hop * T * 0.9;
    if (hop > 0) {
      ctx.fillStyle = `rgba(0,0,0,${0.35 - 0.15 * hop})`;
      ctx.beginPath();
      ctx.ellipse(px, py + T * 0.38, T * (0.36 - 0.12 * hop), T * (0.12 - 0.04 * hop), 0, 0, 6.2832);
      ctx.fill();
    }
    if (p.id === state.myId) {
      ctx.fillStyle = 'rgba(255,211,74,0.3)';
      ctx.beginPath();
      ctx.ellipse(px, py + T * 0.42, T * 0.42, T * 0.13, 0, 0, 6.2832);
      ctx.fill();
    }
    if (p.cursed) {
      ctx.fillStyle = 'rgba(176,107,255,0.28)';
      ctx.beginPath();
      ctx.ellipse(px, py + T * 0.4, T * 0.48, T * 0.16, 0, 0, 6.2832);
      ctx.fill();
      if (Math.random() < dt * 12) {
        this.particles.emit(P_CURSE, p.x + (Math.random() - 0.5) * 0.6, p.y + 0.2, 0, -0.8, 0.9, 0.06, 12 + (Math.random() < 0.5 ? 1 : 0));
      }
    }
    // Cosmetic trail.
    const trail = info?.trail ?? 0;
    if (trail && p.moving && Math.random() < dt * 25) {
      const color = trail === 3 ? 8 + Math.floor(Math.random() * 4) : TRAIL_COLORS[trail];
      this.particles.emit(P_STAR, p.x + (Math.random() - 0.5) * 0.3, p.y + 0.35, 0, -0.3, 0.6, 0.12, color);
    }
    if (this.highContrast) {
      ctx.strokeStyle = '#000';
      ctx.lineWidth = T * 0.08;
      ctx.beginPath();
      ctx.arc(px, py - T * 0.05, T * 0.47, 0, 6.2832);
      ctx.stroke();
    }
    if (p.dashing && Math.random() < dt * 60) {
      // A dash leaves a streak of light.
      this.particles.emit(P_SPARK, p.x + (Math.random() - 0.5) * 0.3, p.y + (Math.random() - 0.2) * 0.4, 0, 0, 0.3, 0.1, C_DASH);
    }
    if (p.gassed && Math.random() < dt * 6) {
      this.particles.emit(P_SMOKE, p.x + (Math.random() - 0.5) * 0.5, p.y - 0.1, 0, -0.4, 0.8, 0.1, C_GAS_DARK);
    }
    if (p.clone && p.clone === state.myId) {
      // Only the owner sees which one is the clone: a dashed ring.
      ctx.save();
      ctx.setLineDash([T * 0.08, T * 0.06]);
      ctx.strokeStyle = 'rgba(127,208,255,0.85)';
      ctx.lineWidth = Math.max(1.5, T * 0.035);
      ctx.beginPath();
      ctx.ellipse(px, py + T * 0.42, T * 0.44, T * 0.15, 0, 0, 6.2832);
      ctx.stroke();
      ctx.restore();
    }
    py -= p.lift;
    if (p.ghost) ctx.globalAlpha = 0.45 + 0.15 * Math.sin(sec * 6);
    this.drawSprite(colors, p.facing, px, py + T * 0.42 + bob, T, sxs, sys, step, look.sprites);
    ctx.globalAlpha = 1;
    if (pixel) this.drawPixelHat(info?.hat ?? 0, px, py - T * 0.5 + bob, T, p.facing);
    else this.drawHat(info?.hat ?? 0, px, py - T * 0.16 + bob, T, p.facing);
    if (p.shield) {
      // Rotating hexagonal shield bubble.
      const r = T * (0.56 + 0.03 * Math.sin(sec * 6));
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(sec * 0.8);
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = i * Math.PI / 3;
        if (i === 0) ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r); else ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      ctx.closePath();
      ctx.fillStyle = 'rgba(127,246,255,0.12)';
      ctx.fill();
      ctx.strokeStyle = `rgba(127,246,255,${0.55 + 0.3 * Math.sin(sec * 8)})`;
      ctx.lineWidth = Math.max(1.5, T * 0.04);
      ctx.stroke();
      ctx.restore();
    }
    if (p.stunned) {
      // Dizzy stars circling the head.
      ctx.fillStyle = '#ffe680';
      for (let k = 0; k < 3; k++) {
        const a = sec * 6 + k * 2.094;
        this.star(ctx, px + Math.cos(a) * T * 0.32, py - T * 0.78 + Math.sin(a) * T * 0.1, T * 0.09);
      }
    }
    if (p.carrying) {
      // The flag being carried: the other team's colour.
      const team = state.rosterInfo.get(p.id)?.team ?? 0;
      this.drawFlag(px + T * 0.18, py - T * 0.35, T * 0.8, TEAM_COLORS[team === 1 ? 2 : 1], sec);
    }
    if (p.bounty) {
      // Crosshair over the bounty holder.
      const r = T * 0.22, cy = py - T * 0.95;
      ctx.strokeStyle = '#ff4a4a';
      ctx.lineWidth = Math.max(2, T * 0.05);
      ctx.beginPath();
      ctx.arc(px, cy, r, 0, 6.2832);
      ctx.moveTo(px - r * 1.5, cy); ctx.lineTo(px + r * 1.5, cy);
      ctx.moveTo(px, cy - r * 1.5); ctx.lineTo(px, cy + r * 1.5);
      ctx.stroke();
    }
  }

  /**
   * Pixel-art hat sitting on the helmet. `top` is the sprite's top edge;
   * hats overlap the helmet by two art pixels, and the halo floats above.
   */
  drawPixelHat(hat, x, top, T, facing) {
    const h = hat && this.assets.pixel.hats[hat];
    if (!h) return;
    const u = T / 16;
    const y = hat === 4 ? top - (h.rows + 1) * u : top + (2 - h.rows) * u;
    const { ctx } = this;
    ctx.save();
    ctx.translate(x, y);
    if (facing === 4) ctx.scale(-1, 1);
    ctx.drawImage(h.canvas, -T / 2, 0, T, T);
    ctx.restore();
  }

  /** Hats are drawn in code on top of the helmet. `y` is the head centre. */
  drawHat(hat, x, y, T, facing) {
    if (!hat) return;
    const { ctx } = this;
    const top = y - T * 0.24;
    const flip = facing === 4 ? -1 : 1;
    ctx.save();
    ctx.lineJoin = 'round';
    switch (hat) {
      case 1: // cap
        ctx.fillStyle = '#d23a2f';
        ctx.beginPath();
        ctx.arc(x, top + T * 0.08, T * 0.17, Math.PI, 0);
        ctx.fill();
        ctx.fillRect(x - T * 0.02 * flip, top + T * 0.05, T * 0.26 * flip, T * 0.05);
        break;
      case 2: { // party hat
        ctx.fillStyle = '#ff7af0';
        ctx.beginPath();
        ctx.moveTo(x - T * 0.13, top + T * 0.07);
        ctx.lineTo(x + T * 0.13, top + T * 0.07);
        ctx.lineTo(x, top - T * 0.25);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = T * 0.03;
        ctx.beginPath();
        ctx.moveTo(x - T * 0.08, top - T * 0.02); ctx.lineTo(x + T * 0.05, top - T * 0.12);
        ctx.stroke();
        ctx.fillStyle = '#ffd34a';
        ctx.beginPath();
        ctx.arc(x, top - T * 0.26, T * 0.045, 0, 6.2832);
        ctx.fill();
        break;
      }
      case 3: // horns
        ctx.fillStyle = '#b8312f';
        for (const s of [-1, 1]) {
          ctx.beginPath();
          ctx.moveTo(x + s * T * 0.1, top + T * 0.08);
          ctx.quadraticCurveTo(x + s * T * 0.25, top, x + s * T * 0.22, top - T * 0.16);
          ctx.quadraticCurveTo(x + s * T * 0.16, top - T * 0.02, x + s * T * 0.02, top + T * 0.06);
          ctx.fill();
        }
        break;
      case 4: // halo
        ctx.strokeStyle = '#ffe680';
        ctx.lineWidth = T * 0.05;
        ctx.shadowColor = '#ffd34a';
        ctx.shadowBlur = T * 0.2;
        ctx.beginPath();
        ctx.ellipse(x, top - T * 0.1, T * 0.18, T * 0.06, 0, 0, 6.2832);
        ctx.stroke();
        break;
      case 5: // crown
        ctx.fillStyle = '#ffd34a';
        ctx.strokeStyle = '#a86b00';
        ctx.lineWidth = T * 0.02;
        ctx.beginPath();
        ctx.moveTo(x - T * 0.16, top + T * 0.06);
        ctx.lineTo(x - T * 0.16, top - T * 0.1);
        ctx.lineTo(x - T * 0.08, top - T * 0.02);
        ctx.lineTo(x, top - T * 0.14);
        ctx.lineTo(x + T * 0.08, top - T * 0.02);
        ctx.lineTo(x + T * 0.16, top - T * 0.1);
        ctx.lineTo(x + T * 0.16, top + T * 0.06);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        break;
      case 6: // top hat
        ctx.fillStyle = '#1a1c22';
        ctx.fillRect(x - T * 0.2, top + T * 0.03, T * 0.4, T * 0.05);
        ctx.fillRect(x - T * 0.12, top - T * 0.22, T * 0.24, T * 0.26);
        ctx.fillStyle = '#d23a2f';
        ctx.fillRect(x - T * 0.12, top - T * 0.03, T * 0.24, T * 0.05);
        break;
    }
    ctx.restore();
  }

  /** A cached CSS font string for a size and weight. */
  font(px, weight) {
    const key = weight ? -px : px;
    this.fonts ??= new Map();
    let f = this.fonts.get(key);
    if (!f) this.fonts.set(key, (f = `${weight ? `${weight} ` : ''}${px}px system-ui, sans-serif`));
    return f;
  }

  /** Name tag rendered once to its own canvas; redrawn only when it changes. */
  label(p, state, fs) {
    const info = state.rosterInfo.get(p.id);
    const name = info?.name ?? '?';
    const me = p.id === state.myId;
    const team = info?.team ?? 0;
    let l = this.labels.get(p.id);
    if (l && l.name === name && l.fs === fs && l.me === me && l.team === team && l.hc === this.highContrast && l.cb === this.colorblind) return l;
    if (!l) this.labels.set(p.id, (l = { canvas: document.createElement('canvas') }));
    Object.assign(l, { name, fs, me, team, hc: this.highContrast, cb: this.colorblind });
    const c = l.canvas, g = c.getContext('2d');
    const font = this.font(fs, 700);
    g.font = font;
    const tw = g.measureText(name).width;
    const pad = Math.ceil(fs * 0.5);
    c.width = Math.ceil(tw + fs * 0.8) + pad * 2;
    c.height = Math.ceil(fs * 1.3) + pad * 2;
    g.font = font; // resizing resets the context state
    g.textAlign = 'center';
    g.textBaseline = 'bottom';
    // The tag's anchor (text centre, baseline bottom) inside the canvas.
    l.ax = c.width / 2;
    l.ay = c.height - pad - fs * 0.05;
    if (me) {
      const w = tw + fs * 0.8;
      g.fillStyle = 'rgba(255,211,74,0.95)';
      roundRect(g, l.ax - w / 2, l.ay - fs * 1.25, w, fs * 1.3, fs * 0.3);
      g.fill();
      g.fillStyle = '#2a1a00';
      g.fillText(name, l.ax, l.ay);
    } else {
      g.lineWidth = Math.max(2, fs * 0.22);
      g.lineJoin = 'round';
      g.strokeStyle = 'rgba(0,0,0,0.8)';
      g.strokeText(name, l.ax, l.ay);
      g.fillStyle = team === 1 ? (this.colorblind ? '#ffc04d' : '#ff8a80') : team === 2 ? (this.colorblind ? '#66c2ff' : '#8ab8ff') : '#fff';
      g.fillText(name, l.ax, l.ay);
    }
    return l;
  }

  drawName(p, camX, camY, T, state, now) {
    const { ctx } = this;
    // Minimum sizes are CSS px, so they stay readable on high-DPI screens.
    const fs = Math.max(Math.round((this.highContrast ? 13 : 11) * this.dpr), Math.round(T * (this.highContrast ? 0.28 : 0.24)));
    const x = p.x * T - camX, y = (p.y - 0.5) * T - camY - T * 0.08 - p.lift;
    const l = this.label(p, state, fs);
    ctx.drawImage(l.canvas, Math.round(x - l.ax), Math.round(y - l.ay));
    // Emote bubble above the name.
    const em = state.emotes.get(p.id);
    if (em && em.until > now) {
      const by = y - fs * 1.6;
      const text = EMOTES[em.e] ?? '?';
      const efs = Math.round(fs * 1.5);
      ctx.font = this.font(efs, 700);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      const w = Math.max(efs * 1.6, ctx.measureText(text).width + efs * 0.6);
      ctx.fillStyle = 'rgba(255,255,255,0.95)';
      roundRect(ctx, x - w / 2, by - efs * 1.3, w, efs * 1.4, efs * 0.4);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(x - efs * 0.2, by + efs * 0.08); ctx.lineTo(x, by + efs * 0.4); ctx.lineTo(x + efs * 0.2, by + efs * 0.08);
      ctx.fill();
      ctx.fillStyle = '#1a1a1a';
      ctx.fillText(text, x, by);
    }
  }

  drawEffects(now, camX, camY, T) {
    const { ctx } = this;
    let keep = 0;
    for (let i = 0; i < this.effects.length; i++) {
      const e = this.effects[i];
      const t = (now - e.start) / e.duration;
      if (t >= 1) continue;
      this.effects[keep++] = e;
      const cx = e.x * T - camX, cy = e.y * T - camY;
      if (e.kind === 'die') {
        ctx.globalAlpha = 1 - t;
        ctx.save();
        ctx.translate(cx, cy - t * T * 0.8);
        ctx.rotate(t * Math.PI * 3);
        const s = 1 - t * 0.7;
        this.drawSprite(e.colors, e.facing, 0, T * 0.42 * s, T * s, 1, 1);
        ctx.restore();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = T * 0.08 * (1 - t);
        ctx.beginPath();
        ctx.arc(cx, cy, T * (0.3 + t * 0.9), 0, 6.2832);
        ctx.stroke();
      } else {
        // Spawn beam: a column of light that narrows.
        ctx.globalAlpha = 1 - t;
        const w = T * 0.7 * (1 - t);
        const grad = ctx.createLinearGradient(cx - w, 0, cx + w, 0);
        grad.addColorStop(0, 'rgba(127,246,255,0)');
        grad.addColorStop(0.5, 'rgba(220,255,255,0.9)');
        grad.addColorStop(1, 'rgba(127,246,255,0)');
        ctx.fillStyle = grad;
        ctx.fillRect(cx - w, cy - T * 3, w * 2, T * 3.4);
      }
    }
    this.effects.length = keep;
    ctx.globalAlpha = 1;
  }

  /**
   * Minimap: the tile layer is rebuilt only when tiles change; the overlay
   * (view box, hills, players) is redrawn every MINIMAP_MS. The canvas has
   * a device-pixel backing store, so it stays sharp on high-DPI screens.
   */
  drawMinimap(state) {
    const { map } = state;
    const m = this.minimap, c = this.mctx;
    // Hidden (the setting, touch layout, small screens): nothing to draw.
    if (!m.offsetWidth) return;
    // Its CSS size comes from the settings; the backing store follows it.
    const size = Math.round(m.offsetWidth * this.dpr);
    if (m.width !== size || m.height !== size) {
      m.width = m.height = size;
    }
    if (this.mapImage.width !== map.w || this.mapImage.height !== map.h || !this.mapPixels) {
      this.mapImage.width = map.w;
      this.mapImage.height = map.h;
      this.mapPixels = this.mapImage.getContext('2d').createImageData(map.w, map.h);
      this.mapDirty = true;
    }
    if (this.mapDirty) {
      this.mapDirty = false;
      const data = this.mapPixels.data;
      for (let i = 0; i < map.tiles.length; i++) {
        const t = map.tiles[i], o = i * 4;
        let r = 70, g = 135, b = 50;
        if (t === T_WALL) { r = 120; g = 128; b = 138; }
        else if (t === T_CRATE) { r = 150; g = 100; b = 52; }
        else if (t === T_ARMORED) { r = 95; g = 80; b = 70; }
        else if (t === T_BUILT) { r = 210; g = 120; b = 60; }
        else if (t === T_ICE) { r = 170; g = 225; b = 245; }
        else if (t === T_TELEPORT) { r = 185; g = 140; b = 255; }
        else if (CONVEYOR_DIR[t]) { r = 70; g = 74; b = 84; }
        data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255;
      }
      this.mapImage.getContext('2d').putImageData(this.mapPixels, 0, 0);
    }
    const scale = size / Math.max(map.w, map.h);
    c.imageSmoothingEnabled = false;
    c.clearRect(0, 0, size, size);
    c.drawImage(this.mapImage, 0, 0, map.w * scale, map.h * scale);
    if (state.hills) {
      c.fillStyle = 'rgba(255,211,74,0.8)';
      for (const [hx, hy] of state.hills) c.fillRect((hx - 1) * scale, (hy - 1) * scale, 3 * scale, 3 * scale);
    }
    // Battle royale: the zone and the next circle.
    const zone = this.zoneNow(state, performance.now());
    if (zone && state.royale?.on !== false) {
      c.save();
      c.fillStyle = 'rgba(40,80,220,0.45)';
      c.beginPath();
      c.rect(0, 0, size, size);
      c.moveTo((zone.x + zone.r) * scale, zone.y * scale);
      c.arc(zone.x * scale, zone.y * scale, Math.max(0, zone.r * scale), 0, 6.2832, true);
      c.fill('evenodd');
      c.strokeStyle = '#8ab8ff';
      c.lineWidth = this.dpr * 1.5;
      c.stroke();
      const nz = state.zone;
      if (nz.state === 0 || nz.state === 1) {
        c.strokeStyle = '#ffffff';
        c.beginPath();
        c.arc(nz.to.x * scale, nz.to.y * scale, Math.max(1, nz.to.r * scale), 0, 6.2832);
        c.stroke();
      }
      c.restore();
    }
    // Ticking atomic bombs: their danger zones.
    const fb = this.frame;
    for (let i = 0; i < fb.nBombs; i++) {
      const b = fb.bombs[i];
      if (!b.nuke) continue;
      c.beginPath();
      c.arc((Math.round(b.x) + 0.5) * scale, (Math.round(b.y) + 0.5) * scale, (NUKE_RADIUS + 0.5) * scale, 0, 6.2832);
      c.fillStyle = 'rgba(255,40,20,0.35)';
      c.fill();
      c.strokeStyle = '#ff5a3a';
      c.lineWidth = this.dpr * 1.5;
      c.stroke();
    }
    if (state.sd) {
      const r = state.sd.r;
      c.strokeStyle = '#ff5a3a';
      c.lineWidth = this.dpr * 1.5;
      c.strokeRect((state.sd.cx - r + 1) * scale, (state.sd.cy - r + 1) * scale, (2 * r - 1) * scale, (2 * r - 1) * scale);
    }
    if (state.flags) {
      for (let k = 0; k < 2; k++) {
        const f = state.flags[k];
        let fx = f.pos[0] + 0.5, fy = f.pos[1] + 0.5;
        if (f.state === 1) {
          // Carried: show it on the carrier, if in view.
          const fr = this.frame;
          let found = false;
          for (let i = 0; i < fr.nPlayers; i++) {
            if (fr.players[i].id === f.carrier) { fx = fr.players[i].x; fy = fr.players[i].y; found = true; }
          }
          if (!found) continue;
        }
        c.fillStyle = TEAM_COLORS[k + 1];
        c.fillRect(fx * scale - 3 * this.dpr, fy * scale - 3 * this.dpr, 6 * this.dpr, 6 * this.dpr);
      }
    }
    const T = this.T;
    c.strokeStyle = 'rgba(255,255,255,0.7)';
    c.lineWidth = this.dpr;
    c.strokeRect(this.camX / T * scale, this.camY / T * scale, this.canvas.width / T * scale, this.canvas.height / T * scale);
    const f = this.frame;
    const dot = this.dpr * 1.5;
    for (let i = 0; i < f.nPlayers; i++) {
      const p = f.players[i];
      const me = p.id === state.myId;
      const team = state.rosterInfo.get(p.id)?.team ?? 0;
      c.fillStyle = me ? '#ffd34a' : team === 1 ? '#ff5a4a' : team === 2 ? '#5aa0ff' : '#ff4a4a';
      const s = me ? dot * 2.5 : dot * 1.5;
      c.fillRect(p.x * scale - s / 2, p.y * scale - s / 2, s, s);
    }
    // A blizzard fogs the minimap.
    const w = this.weather;
    if (w && w.kind === EVENT_BLIZZARD && performance.now() < w.end) {
      c.fillStyle = 'rgba(235,242,255,0.82)';
      c.fillRect(0, 0, size, size);
    }
  }

  /**
   * Fills the pooled frame: other players and bombs interpolated between the
   * two snapshots around the render time; the local player uses its
   * predicted position so controls feel immediate.
   */
  interpolate(state, now) {
    const ring = state.snaps;
    const latest = ring.latest();
    // A death replay plays recent snapshots again, slowly.
    const rp = state.replay;
    this.replaying = !!rp;
    const rt = rp
      ? Math.min(latest.k, rp.from + ((now - rp.t0) / state.tickMs) * REPLAY_RATE)
      : now / state.tickMs - state.offset - (state.interpDelay ?? INTERP_TICKS);
    let a = ring.get(0), b = a;
    for (let i = ring.len - 1; i >= 0; i--) {
      const s = ring.get(i);
      if (s.k <= rt) {
        a = s;
        b = i + 1 < ring.len ? ring.get(i + 1) : s;
        break;
      }
    }
    const alpha = b.k > a.k ? Math.min(1, Math.max(0, (rt - a.k) / (b.k - a.k))) : 0;
    const f = this.frame;
    const prev = this.prev;

    prev.clear();
    for (let i = 0; i < a.p.length; i++) prev.set(a.p[i][0], a.p[i]);
    let n = 0;
    for (let i = 0; i < b.p.length && n < POOL - 1; i++) {
      const q = b.p[i];
      if (q[0] === state.myId && !rp) continue;
      const p = prev.get(q[0]) ?? q;
      const jump = Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]) > 200; // teleport or respawn
      const t = jump ? 1 : alpha;
      const o = f.players[n++];
      setPlayer(o, q, (p[1] + (q[1] - p[1]) * t) / 100, (p[2] + (q[2] - p[2]) * t) / 100);
    }
    // Clones look like their owners: they're drawn as players with the
    // owner's id (name, colours, hat), interpolated by the clone's own id.
    const cp = this.clonePrev;
    cp.clear();
    for (const c of a.x?.clones ?? []) cp.set(c[0], c);
    for (const c of b.x?.clones ?? []) {
      if (n >= POOL - 1) break;
      const p = cp.get(c[0]) ?? c;
      const o = f.players[n++];
      setPlayer(o, [c[1], 0, 0, c[4], c[5]], (p[2] + (c[2] - p[2]) * alpha) / 100, (p[3] + (c[3] - p[3]) * alpha) / 100);
      o.clone = c[1];
    }
    if (state.me?.alive && state.mine) {
      const o = f.players[n++];
      setPlayer(o, state.mine, state.self.x, state.self.y);
      // Our own hop comes from prediction, not the (older) snapshot.
      o.jumpDir = state.selfJump ?? 0;
      if (o.jumpDir) o.facing = o.jumpDir;
    }
    f.nPlayers = n;

    this.stuckBy.clear();
    for (const [bid, carrier] of b.x?.stuck ?? []) this.stuckBy.set(bid, carrier);
    prev.clear();
    for (let i = 0; i < a.b.length; i++) prev.set(a.b[i][0], a.b[i]);
    let m = 0;
    for (let i = 0; i < b.b.length && m < POOL; i++) {
      const q = b.b[i];
      const p = prev.get(q[0]) ?? q;
      const jump = Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]) > 2; // punched
      const t = jump ? 1 : alpha;
      const o = f.bombs[m++];
      o.x = p[1] + (q[1] - p[1]) * t;
      o.y = p[2] + (q[2] - p[2]) * t;
      o.fuse = q[3];
      o.pierce = (q[4] & 1) !== 0;
      o.remote = (q[4] & 2) !== 0;
      o.nuke = (q[4] & 4) !== 0;
      o.freeze = (q[4] & 8) !== 0;
      o.rocket = (q[4] & 16) !== 0;
      o.mine = (q[4] & 32) !== 0;
      o.sticky = (q[4] & 64) !== 0;
      o.gas = (q[4] & 128) !== 0;
      o.carrier = this.stuckBy.get(q[0]) ?? 0;
      o.dx = q[1] - p[1];
      o.dy = q[2] - p[2];
    }
    // A clone's decoy bombs look like real ones.
    for (const d of b.x?.decoys ?? []) {
      if (m >= POOL) break;
      const o = f.bombs[m++];
      o.x = d[1];
      o.y = d[2];
      o.fuse = Math.max(0, d[3]);
      o.pierce = o.remote = o.nuke = o.freeze = o.rocket = o.mine = o.sticky = o.gas = false;
      o.carrier = 0;
      o.dx = o.dy = 0;
    }
    f.nBombs = m;

    // Drones, interpolated by id.
    const dp = this.dronePrev;
    dp.clear();
    for (const d of a.d ?? []) dp.set(d[0], d);
    let nd = 0;
    for (const d of b.d ?? []) {
      if (nd >= f.drones.length) break;
      const p = dp.get(d[0]) ?? d;
      const o = f.drones[nd++];
      o.id = d[0];
      o.x = p[1] + (d[1] - p[1]) * alpha;
      o.y = p[2] + (d[2] - p[2]) * alpha;
      o.team = d[3];
    }
    f.nDrones = nd;
    // Replaying a death shows the flames of that moment.
    state.explosions = this.replaying ? b.e : latest.e;
  }
}

function setPlayer(o, q, x, y) {
  o.id = q[0];
  o.x = x;
  o.y = y;
  o.facing = q[3];
  o.moving = (q[4] & 1) !== 0;
  o.shield = (q[4] & 2) !== 0;
  o.cursed = (q[4] & 4) !== 0;
  o.ghost = (q[4] & 8) !== 0;
  o.bounty = (q[4] & 16) !== 0;
  o.jumpDir = (q[4] & 32) !== 0 ? q[3] : 0;
  o.stunned = (q[4] & 64) !== 0;
  o.carrying = (q[4] & 128) !== 0;
  o.dashing = (q[4] & 256) !== 0;
  o.gassed = (q[4] & 512) !== 0;
  o.clone = 0;
}

/** A builder's wall: a stack of orange bricks with mortar lines. */
function paintBuiltWall(g, px, py, P, pixel) {
  g.fillStyle = '#7a3a18';
  g.fillRect(px, py, P, P);
  const rows = 4, h = P / rows;
  for (let r = 0; r < rows; r++) {
    const off = r % 2 ? P / 4 : 0;
    for (let k = -1; k < 2; k++) {
      const x0 = px + off + k * (P / 2), y0 = py + r * h;
      const x1 = Math.max(px, x0 + 2), x2 = Math.min(px + P, x0 + P / 2 - 2);
      if (x2 <= x1) continue;
      g.fillStyle = (r + k) % 2 ? '#d9824a' : '#c46d36';
      g.fillRect(x1, y0 + 2, x2 - x1, h - 4);
      if (!pixel) {
        g.fillStyle = 'rgba(255,255,255,0.18)';
        g.fillRect(x1, y0 + 2, x2 - x1, 3);
      }
    }
  }
  g.strokeStyle = '#4a2008';
  g.lineWidth = 3;
  g.strokeRect(px + 1.5, py + 1.5, P - 3, P - 3);
}

/** Pink goo dripping off a sticky bomb. */
function drawGoo(ctx, px, py, size, sec) {
  ctx.strokeStyle = '#ff7ad9';
  ctx.lineWidth = size * 0.07;
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (let k = 0; k < 3; k++) {
    const x = px + (k - 1) * size * 0.22;
    const len = size * (0.14 + 0.06 * Math.sin(sec * 3 + k * 2));
    ctx.moveTo(x, py + size * 0.32);
    ctx.lineTo(x, py + size * 0.32 + len);
  }
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(px - size * 0.03, py + size * 0.09, size * 0.34, Math.PI * 1.1, Math.PI * 1.9);
  ctx.stroke();
  ctx.lineCap = 'butt';
}

function clampCam(cam, worldPx, viewPx) {
  if (worldPx <= viewPx) return (worldPx - viewPx) / 2;
  return Math.max(0, Math.min(worldPx - viewPx, cam));
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
