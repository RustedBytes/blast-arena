// Canvas renderer. Static tiles are pre-rendered into chunk canvases that
// are redrawn only when a tile in them changes; entities are drawn from a
// pooled, interpolated frame; effects come from a fixed particle pool. The
// per-frame path allocates almost nothing.

import { ITEM_SPRITES, playerColors } from './assets.js';
import { P_CURSE, P_DEBRIS, P_SMOKE, P_SPARK, P_STAR } from './particles.js';
import { FRINGE_RANK } from './pixelart.js';

export const T_FLOOR = 0, T_WALL = 1, T_CRATE = 2, T_ICE = 3, T_TELEPORT = 8, T_ARMORED = 9;
const CONVEYOR_DIR = [0, 0, 0, 0, 1, 2, 3, 4];
// Rotation for flame arms / conveyors, indexed by direction code - 1.
const ARM_ANGLES = [-Math.PI / 2, 0, Math.PI / 2, Math.PI];
const ARM_DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];
/** Render this many ticks behind the server to interpolate smoothly. */
export const INTERP_TICKS = 2;
const CHUNK = 8;            // tiles per chunk side
const CHUNK_PX = 64;        // pixels per tile inside a chunk canvas
const MAX_CHUNKS = 48;      // chunk canvases kept (LRU)
const DECALS = 512;         // scorch marks ring buffer
const DECAL_LIFE = 4000;    // ms
const POOL = 512;           // pooled entities per frame
// Item halo colour by rarity.
const HALO = [null, '#ffffff', '#ffffff', '#7fd0ff', '#7fd0ff', '#c08bff', '#c08bff', '#ffd34a', '#ff7af0',
  '#7fd0ff', '#ffb02e', '#ff7a7a', '#d6c8ff'];
export const EMOTES = ['👋', '😂', '😡', '👍', '💣', '😱', 'GG', '😎'];
const TRAIL_COLORS = [0, 10, 8, 9];

/** Picks one of `n` tile variants from a coordinate hash; the first is the most common. */
function variant(h, n) {
  if (n >= 3 && h % 7 === 0) return 2;
  if (n >= 2 && h % 3 === 0) return 1;
  return 0;
}

// Biome regions, mirroring the server's map generator.
const BIOME_SEEDS = [[0.5, 0.5, 0], [0.2, 0.2, 1], [0.8, 0.2, 2], [0.2, 0.8, 3], [0.8, 0.8, 0]];
export function biome(map, x, y) {
  if (map.w < 41 || map.h < 41) return 0;
  const fx = x / map.w, fy = y / map.h;
  let best = 0, bd = Infinity;
  for (const [sx, sy, b] of BIOME_SEEDS) {
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
    this.specials = []; // [x, y, tile] of animated tiles (conveyors, pads)
    this.highContrast = false;
    this.colorblind = false;
    /** 'pixel' (default) or 'classic' map tiles. */
    this.tileStyle = 'pixel';
    // Pooled frame data, reused every frame.
    this.frame = {
      players: Array.from({ length: POOL }, () => ({ id: 0, x: 0, y: 0, facing: 3, moving: false, shield: false, cursed: false, ghost: false, bounty: false })),
      nPlayers: 0,
      bombs: Array.from({ length: POOL }, () => ({ x: 0, y: 0, fuse: 0, pierce: false, remote: false })),
      nBombs: 0,
    };
    this.prev = new Map();
    this.mapImage = document.createElement('canvas');
    this.mapPixels = null;
    this.vignette = document.createElement('canvas');
  }

  /** Recomputes the base tile size so the default view matches the server's default area. */
  resize(aoi, aoiMax) {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(innerWidth * dpr), h = Math.round(innerHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.buildVignette(w, h);
    }
    this.dpr = dpr;
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

  buildVignette(w, h) {
    const v = this.vignette;
    v.width = w; v.height = h;
    const g = v.getContext('2d');
    const grad = g.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.75);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(0,0,0,0.45)');
    g.fillStyle = grad;
    g.fillRect(0, 0, w, h);
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

  invalidateTile(map, x, y) {
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
  }

  /** Called on welcome: forget cached chunks and index animated tiles. */
  resetMap(map) {
    this.chunks.clear();
    this.dirty.clear();
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
    if (stale || c.key !== key) {
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
      return t === T_WALL || t === T_CRATE || t === T_ARMORED;
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
        if (this.highContrast && (t === T_CRATE || t === T_ARMORED || t === T_WALL)) {
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
    this.shake = Math.min(0.35, this.shake + 0.3 / (1 + distance * distance * 0.05));
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
    const sx = (Math.random() - 0.5) * this.shake * T, sy = (Math.random() - 0.5) * this.shake * T;
    this.camX = clampCam(state.focus.x * T - W / 2, map.w * T, W);
    this.camY = clampCam(state.focus.y * T - H / 2, map.h * T, H);
    const camX = Math.round(this.camX + sx), camY = Math.round(this.camY + sy);

    ctx.fillStyle = '#1b2a17';
    ctx.fillRect(0, 0, W, H);

    // Tile chunks.
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
    const scorch = this.assets.sprite('scorch');
    for (let i = 0; i < DECALS; i++) {
      const age = now - this.decalT[i];
      if (age >= DECAL_LIFE) continue;
      const x = this.decalX[i], y = this.decalY[i];
      const t = map.tiles[y * map.w + x];
      if (t === T_WALL || t === T_CRATE || t === T_ARMORED) continue;
      ctx.globalAlpha = 0.7 * (1 - age / DECAL_LIFE);
      ctx.drawImage(scorch, x * T - camX, y * T - camY, T, T);
    }
    ctx.globalAlpha = 1;

    this.drawItems(state.items, camX, camY, T, sec, W, H);
    this.drawBombs(f, camX, camY, T, sec, dt);
    this.drawExplosions(state.explosions, camX, camY, T);

    // Players back to front (insertion sort on the pooled slice: no garbage).
    const ps = f.players;
    for (let i = 1; i < f.nPlayers; i++) {
      const p = ps[i];
      let j = i - 1;
      while (j >= 0 && ps[j].y > p.y) { ps[j + 1] = ps[j]; j--; }
      ps[j + 1] = p;
    }
    for (let i = 0; i < f.nPlayers; i++) this.drawPlayer(ps[i], camX, camY, T, sec, dt, state);

    this.particles.draw(ctx, camX, camY, T);
    this.drawEffects(now, camX, camY, T);
    for (let i = 0; i < f.nPlayers; i++) this.drawName(ps[i], camX, camY, T, state, now);

    // The page may have loaded hidden (0x0); keep the vignette in step.
    if (W > 0 && H > 0) {
      if (this.vignette.width !== W || this.vignette.height !== H) this.buildVignette(W, H);
      ctx.drawImage(this.vignette, 0, 0);
    }

    if (now - this.lastMinimap > 400) {
      this.lastMinimap = now;
      this.drawMinimap(state);
    }
  }

  /** Moving chevrons on conveyors and spinning teleporter pads. */
  drawSpecials(map, camX, camY, T, sec, W, H) {
    const { ctx } = this;
    for (let i = 0; i < this.specials.length; i++) {
      const [x, y, t] = this.specials[i];
      const px = x * T - camX, py = y * T - camY;
      if (px < -T || py < -T || px > W || py > H) continue;
      ctx.save();
      ctx.translate(px + T / 2, py + T / 2);
      if (t === T_TELEPORT) {
        ctx.rotate(sec * 2.5);
        ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = 'rgba(200,160,255,0.75)';
        ctx.lineWidth = T * 0.06;
        for (let k = 0; k < 3; k++) {
          ctx.beginPath();
          ctx.arc(0, 0, T * (0.12 + k * 0.1), k * 2, k * 2 + 2.2);
          ctx.stroke();
        }
        ctx.globalCompositeOperation = 'source-over';
      } else {
        ctx.rotate(ARM_ANGLES[CONVEYOR_DIR[t] - 1]);
        ctx.strokeStyle = 'rgba(255,211,74,0.85)';
        ctx.lineWidth = T * 0.07;
        const phase = (sec * 1.6) % 1;
        for (let k = 0; k < 2; k++) {
          const ox = ((phase + k * 0.5) % 1 - 0.5) * T * 0.8;
          ctx.beginPath();
          ctx.moveTo(ox - T * 0.1, -T * 0.16);
          ctx.lineTo(ox + T * 0.06, 0);
          ctx.lineTo(ox - T * 0.1, T * 0.16);
          ctx.stroke();
        }
      }
      ctx.restore();
    }
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
      ctx.font = `${Math.round(T * 0.5)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.globalAlpha = 0.55;
      ctx.fillText('👑', px + T * 1.5, py + T * 1.5);
      ctx.globalAlpha = 1;
    }
  }

  drawItems(items, camX, camY, T, sec, W, H) {
    const { ctx } = this;
    for (const [x, y, kind] of items) {
      const cx = (x + 0.5) * T - camX, cy = (y + 0.5) * T - camY;
      if (cx < -T || cy < -T || cx > W + T || cy > H + T) continue;
      const s = this.assets.sprite(ITEM_SPRITES[kind]);
      if (!s) continue;
      const bob = Math.sin(sec * 4 + x + y) * T * 0.04;
      const pulse = 1 + 0.08 * Math.sin(sec * 3 + x * 2);
      ctx.globalCompositeOperation = 'lighter';
      const hs = T * 1.25 * pulse;
      ctx.drawImage(this.halo(HALO[kind]), cx - hs / 2, cy - hs / 2 + bob, hs, hs);
      ctx.globalCompositeOperation = 'source-over';
      const size = T * 0.82;
      if (kind === 8) {
        // Secret box: wobbles, and colour sparks orbit it.
        ctx.save();
        ctx.translate(cx, cy + bob);
        ctx.rotate(Math.sin(sec * 5 + x) * 0.14);
        ctx.drawImage(s, -size / 2, -size / 2, size, size);
        ctx.restore();
        for (let i = 0; i < 3; i++) {
          const a = sec * 2.5 + i * 2.094;
          ctx.fillStyle = i === 0 ? '#ff7af0' : i === 1 ? '#7ff6ff' : '#ffd34a';
          ctx.beginPath();
          ctx.arc(cx + Math.cos(a) * T * 0.45, cy + bob + Math.sin(a) * T * 0.45, T * 0.05, 0, 6.2832);
          ctx.fill();
        }
      } else {
        ctx.drawImage(s, cx - size / 2, cy - size / 2 + bob, size, size);
      }
    }
  }

  drawBombs(f, camX, camY, T, sec, dt) {
    const { ctx } = this;
    for (let i = 0; i < f.nBombs; i++) {
      const b = f.bombs[i];
      const urgency = b.remote ? 0 : 1 - Math.min(1, b.fuse / 50);
      const pulse = 1 + Math.sin(sec * (6 + urgency * 18)) * (0.05 + urgency * 0.06);
      const size = T * 0.95 * pulse;
      let px = (b.x + 0.5) * T - camX, py = (b.y + 0.5) * T - camY;
      const late = !b.remote && b.fuse < 15;
      if (late) {
        px += (Math.random() - 0.5) * T * 0.06;
        py += (Math.random() - 0.5) * T * 0.06;
      }
      ctx.drawImage(this.assets.sprite(b.pierce ? 'bomb_pierce' : 'bomb'), px - size / 2, py - size / 2, size, size);
      if (b.remote) {
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
      if (late || this.highContrast) {
        ctx.strokeStyle = late ? `rgba(255,60,30,${0.5 + 0.5 * Math.sin(sec * 30)})` : '#fff';
        ctx.lineWidth = T * 0.05;
        ctx.beginPath();
        ctx.arc(px - size * 0.03, py + size * 0.09, size * 0.33, 0, 6.2832);
        ctx.stroke();
      }
      // Fuse sparks fly off the tip.
      if (!b.remote && Math.random() < dt * 30) {
        this.particles.emit(P_SPARK, b.x + 0.5 + 0.34 * pulse, b.y + 0.5 - 0.36 * pulse,
          (Math.random() - 0.5) * 2, -Math.random() * 2, 0.25, 0.04, 1);
      }
    }
  }

  drawExplosions(explosions, camX, camY, T) {
    const { ctx } = this;
    const center = this.assets.sprite('flame_center');
    const arm = this.assets.sprite('flame_arm');
    const end = this.assets.sprite('flame_end');
    for (let k = 0; k < explosions.length; k++) {
      const [ex, ey, arms, left] = explosions[k];
      const life = left / 10; // 1 when fresh, 0 when gone
      ctx.globalAlpha = Math.min(1, life * 2.2);
      const thick = 0.75 + 0.25 * Math.sin(Math.min(1, (1 - life) * 3) * Math.PI / 2);
      for (let d = 0; d < 4; d++) {
        for (let r = 1; r <= arms[d]; r++) {
          const cx = (ex + ARM_DIRS[d][0] * r + 0.5) * T - camX;
          const cy = (ey + ARM_DIRS[d][1] * r + 0.5) * T - camY;
          ctx.save();
          ctx.translate(cx, cy);
          ctx.rotate(ARM_ANGLES[d]);
          ctx.scale(1, thick);
          ctx.drawImage(r === arms[d] ? end : arm, -T / 2, -T / 2, T + 1, T);
          ctx.restore();
        }
      }
      const s = T * (0.9 + 0.2 * thick);
      ctx.drawImage(center, (ex + 0.5) * T - camX - s / 2, (ey + 0.5) * T - camY - s / 2, s, s);
    }
    // Additive glow over all flames.
    ctx.globalCompositeOperation = 'lighter';
    const glow = this.assets.glow;
    for (let k = 0; k < explosions.length; k++) {
      const [ex, ey, arms, left] = explosions[k];
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
    const r = state.rosterInfo.get(id);
    return playerColors(id, r?.team ?? 0, this.colorblind);
  }

  drawSprite(colors, facing, px, py, T, sxs, sys) {
    const view = facing === 1 ? 'player_up' : facing === 3 ? 'player_down' : 'player_side';
    const sprite = this.assets.player(colors, view);
    const { ctx } = this;
    ctx.save();
    ctx.translate(px, py);
    ctx.scale(facing === 4 ? -sxs : sxs, sys);
    if (sprite) ctx.drawImage(sprite, -T / 2, -T * 0.92, T, T);
    else {
      ctx.fillStyle = colors[0];
      ctx.beginPath();
      ctx.arc(0, -T * 0.4, T * 0.35, 0, 6.2832);
      ctx.fill();
    }
    ctx.restore();
  }

  drawPlayer(p, camX, camY, T, sec, dt, state) {
    const { ctx } = this;
    const info = state.rosterInfo.get(p.id);
    const colors = this.colorsFor(p.id, state);
    // Two-step walk cycle: a hop with squash and stretch.
    const phase = p.moving ? Math.abs(Math.sin(sec * 12 + p.id)) : 0;
    const bob = -phase * T * 0.07;
    const sxs = 1 + phase * 0.05, sys = 1 - phase * 0.06;
    const px = p.x * T - camX, py = p.y * T - camY;
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
    if (p.ghost) ctx.globalAlpha = 0.45 + 0.15 * Math.sin(sec * 6);
    this.drawSprite(colors, p.facing, px, py + T * 0.42 + bob, T, sxs, sys);
    ctx.globalAlpha = 1;
    this.drawHat(info?.hat ?? 0, px, py - T * 0.16 + bob, T, p.facing);
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

  drawName(p, camX, camY, T, state, now) {
    const { ctx } = this;
    const info = state.rosterInfo.get(p.id);
    const name = info?.name ?? '?';
    const fs = Math.max(this.highContrast ? 13 : 11, Math.round(T * (this.highContrast ? 0.28 : 0.24)));
    ctx.font = `700 ${fs}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    const x = p.x * T - camX, y = (p.y - 0.5) * T - camY - T * 0.08;
    if (p.id === state.myId) {
      const w = ctx.measureText(name).width + fs * 0.8;
      ctx.fillStyle = 'rgba(255,211,74,0.95)';
      roundRect(ctx, x - w / 2, y - fs * 1.25, w, fs * 1.3, fs * 0.3);
      ctx.fill();
      ctx.fillStyle = '#2a1a00';
      ctx.fillText(name, x, y);
    } else {
      ctx.lineWidth = Math.max(2, fs * 0.22);
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.strokeText(name, x, y);
      const team = info?.team ?? 0;
      ctx.fillStyle = team === 1 ? (this.colorblind ? '#ffc04d' : '#ff8a80') : team === 2 ? (this.colorblind ? '#66c2ff' : '#8ab8ff') : '#fff';
      ctx.fillText(name, x, y);
    }
    // Emote bubble above the name.
    const em = state.emotes.get(p.id);
    if (em && em.until > now) {
      const by = y - fs * 1.6;
      const text = EMOTES[em.e] ?? '?';
      const efs = Math.round(fs * 1.5);
      ctx.font = `700 ${efs}px system-ui, sans-serif`;
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

  drawMinimap(state) {
    const { map } = state;
    const m = this.minimap, c = this.mctx;
    const scale = 2;
    if (m.width !== map.w * scale) {
      m.width = map.w * scale;
      m.height = map.h * scale;
      this.mapImage.width = map.w;
      this.mapImage.height = map.h;
      this.mapPixels = this.mapImage.getContext('2d').createImageData(map.w, map.h);
    }
    const data = this.mapPixels.data;
    for (let i = 0; i < map.tiles.length; i++) {
      const t = map.tiles[i], o = i * 4;
      let r = 70, g = 135, b = 50;
      if (t === T_WALL) { r = 120; g = 128; b = 138; }
      else if (t === T_CRATE) { r = 150; g = 100; b = 52; }
      else if (t === T_ARMORED) { r = 95; g = 80; b = 70; }
      else if (t === T_ICE) { r = 170; g = 225; b = 245; }
      else if (t === T_TELEPORT) { r = 185; g = 140; b = 255; }
      else if (CONVEYOR_DIR[t]) { r = 70; g = 74; b = 84; }
      data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255;
    }
    this.mapImage.getContext('2d').putImageData(this.mapPixels, 0, 0);
    c.imageSmoothingEnabled = false;
    c.drawImage(this.mapImage, 0, 0, m.width, m.height);
    if (state.hills) {
      c.fillStyle = 'rgba(255,211,74,0.8)';
      for (const [hx, hy] of state.hills) c.fillRect((hx - 1) * scale, (hy - 1) * scale, 3 * scale, 3 * scale);
    }
    const T = this.T;
    c.strokeStyle = 'rgba(255,255,255,0.7)';
    c.lineWidth = 1;
    c.strokeRect(this.camX / T * scale, this.camY / T * scale, this.canvas.width / T * scale, this.canvas.height / T * scale);
    const f = this.frame;
    for (let i = 0; i < f.nPlayers; i++) {
      const p = f.players[i];
      const me = p.id === state.myId;
      const team = state.rosterInfo.get(p.id)?.team ?? 0;
      c.fillStyle = me ? '#ffd34a' : team === 1 ? '#ff5a4a' : team === 2 ? '#5aa0ff' : '#ff4a4a';
      const s = me ? 5 : 3;
      c.fillRect(p.x * scale - s / 2, p.y * scale - s / 2, s, s);
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
    const rt = now / state.tickMs - state.offset - INTERP_TICKS;
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
      if (q[0] === state.myId) continue;
      const p = prev.get(q[0]) ?? q;
      const jump = Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]) > 200; // teleport or respawn
      const t = jump ? 1 : alpha;
      const o = f.players[n++];
      setPlayer(o, q, (p[1] + (q[1] - p[1]) * t) / 100, (p[2] + (q[2] - p[2]) * t) / 100);
    }
    if (state.me?.alive && state.mine) {
      setPlayer(f.players[n++], state.mine, state.self.x, state.self.y);
    }
    f.nPlayers = n;

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
    }
    f.nBombs = m;
    state.explosions = latest.e;
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
