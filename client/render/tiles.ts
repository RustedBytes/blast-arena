// Map tiles: pre-rendered chunk canvases, repainted only when a tile in them
// changes, plus the animated conveyors and teleport pads on top.

import type { SpriteName } from '../assets.js';
import { context2d, makeCanvas } from '../dom.js';
import { FRINGE_RANK } from '../pixelart.js';
import type { GameMap } from '../state.js';
import { ARM_ANGLES, ARM_DIRS, biome, CHUNK, CHUNK_PX, CONVEYOR_DIR, MAX_CHUNKS, REPAINTS_PER_FRAME, T_ARMORED, T_BUILT, T_CRATE, T_ICE, T_TELEPORT, T_WALL, variant } from './constants.js';
import { paintBuiltWall } from './shapes.js';
import type { Stage } from './stage.js';
import type { Chunk } from './types.js';

export class TileLayer {
  /** Chunk index -> cached chunk (insertion order = LRU). */
  private readonly chunks = new Map<number, Chunk>();
  private readonly dirty = new Set<number>();
  /** Changed chunks that may still be repainted this frame. */
  private repaintBudget = 0;
  /** [x, y, tile] of animated tiles (conveyors, pads). */
  private specials: [number, number, number][] = [];

  constructor(private readonly s: Stage) {}

  /** Draws the cached tile chunks under the view. */
  drawChunks(map: GameMap, camX: number, camY: number, T: number, W: number, H: number): void {
    const { ctx } = this.s;
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
  }

  /** A tile changed: its chunk (and the neighbours its shadow falls on) need repainting. */
  invalidate(map: GameMap, x: number, y: number): void {
    const cols = Math.ceil(map.w / CHUNK);
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
      const nx = Math.min(x + dx, map.w - 1), ny = Math.min(y + dy, map.h - 1);
      this.dirty.add(Math.floor(ny / CHUNK) * cols + Math.floor(nx / CHUNK));
    }
  }

  /** The art style changed: repaint every chunk. */
  invalidateAll(): void {
    for (const c of this.chunks.values()) c.key = -1;
  }

  /** A new map: forget cached chunks and index animated tiles. */
  reset(map: GameMap): void {
    this.chunks.clear();
    this.dirty.clear();
    this.specials = [];
    for (let y = 0; y < map.h; y++) {
      for (let x = 0; x < map.w; x++) {
        const t = map.tiles[y * map.w + x];
        if (CONVEYOR_DIR[t] || t === T_TELEPORT) this.specials.push([x, y, t]);
      }
    }
  }

  private chunk(map: GameMap, cx: number, cy: number): HTMLCanvasElement {
    const key = cy * Math.ceil(map.w / CHUNK) + cx;
    const stale = this.dirty.has(key);
    let c = this.chunks.get(key);
    if (c) {
      this.chunks.delete(key); // refresh LRU position
    } else {
      c = this.chunks.size >= MAX_CHUNKS ? this.evictOldestChunk() : undefined;
      c ??= { canvas: makeCanvas(CHUNK * CHUNK_PX), key: -1 };
      c.key = -1;
    }
    // A cached chunk whose tiles changed is repainted within a per-frame
    // budget (an atomic blast can change dozens of chunks at once); the
    // rest keep showing their old picture for a frame or two.
    const mustPaint = c.key !== key;
    if (mustPaint || (stale && this.repaintBudget-- > 0)) {
      this.paintChunk(c.canvas, map, cx, cy);
      c.key = key;
      this.dirty.delete(key);
    }
    this.chunks.set(key, c);
    return c.canvas;
  }

  /** Takes the least recently used chunk out of the cache, to reuse its canvas. */
  private evictOldestChunk(): Chunk | undefined {
    for (const [key, chunk] of this.chunks) {
      this.chunks.delete(key);
      return chunk;
    }
    return undefined;
  }

  paintChunk(c: HTMLCanvasElement, map: GameMap, cx: number, cy: number): void {
    const g = context2d(c);
    const a = this.s.assets;
    const style = this.s.tileStyle;
    const sprite = (name: SpriteName): HTMLCanvasElement => a.tile(name, style);
    // Pixel art is scaled up with hard edges; vector art smoothly.
    g.imageSmoothingEnabled = style !== 'pixel';
    // Pixel art has variants per biome, block shadows and blended borders.
    const pix = style === 'pixel' ? a.pixel : null;
    const grass = [sprite('floor'), sprite('floor_b'), sprite('floor_c')];
    // The crypt has no classic art of its own: volcanic ash is the closest.
    const biomeFloor = [grass, [sprite('floor_snow')], [sprite('floor_sand')], [sprite('floor_ash')], [sprite('floor_ash')]];
    const floors = pix ? pix.floors : biomeFloor;
    const tileAt = (x: number, y: number): number => (x < 0 || y < 0 || x >= map.w || y >= map.h ? T_WALL : map.tiles[y * map.w + x]);
    const raised = (x: number, y: number): boolean => {
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
        let s: HTMLCanvasElement | null = null;
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
          const shade = pix.shadows[mask];
          if (shade) g.drawImage(shade, px, py, P, P);
        }
        if (this.s.highContrast && (t === T_CRATE || t === T_ARMORED || t === T_WALL || t === T_BUILT)) {
          g.strokeStyle = t === T_WALL ? '#000' : '#fff';
          g.lineWidth = 4;
          g.strokeRect(px + 2, py + 2, P - 4, P - 4);
        }
      }
    }
  }

  /** Moving chevrons on conveyors and spinning teleporter pads. */
  drawSpecials(camX: number, camY: number, T: number, sec: number, W: number, H: number) {
    const { ctx } = this.s;
    const spin = sec * 2.5, sc = Math.cos(spin), ss = Math.sin(spin);
    const phase = (sec * 1.6) % 1;
    let style = -1; // which stroke style is set: 0 teleporter, 1 conveyor
    for (const sp of this.specials) {
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

  /** A conveyor or teleporter changed (map events): keep the animated list in step. */
  updateSpecial(x: number, y: number, tile: number) {
    const i = this.specials.findIndex((s) => s[0] === x && s[1] === y);
    const special = CONVEYOR_DIR[tile] || tile === T_TELEPORT;
    if (i >= 0 && special) this.specials[i][2] = tile;
    else if (i >= 0) this.specials.splice(i, 1);
    else if (special) this.specials.push([x, y, tile]);
  }
}
