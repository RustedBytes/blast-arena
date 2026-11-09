// Canvas renderer. Static tiles are pre-rendered into chunk canvases that
// are redrawn only when a tile in them changes; entities are drawn from a
// pooled, interpolated frame; effects come from a fixed particle pool. The
// per-frame path allocates nothing.

import { ITEM_SPRITES, playerHue } from './assets.js';
import { P_CURSE, P_DEBRIS, P_SMOKE, P_SPARK, P_STAR } from './particles.js';

const TILE_WALL = 1, TILE_CRATE = 2;
// Rotation for flame arms, indexed like the server: up, right, down, left.
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
const HALO = [null, '#ffffff', '#ffffff', '#7fd0ff', '#7fd0ff', '#c08bff', '#c08bff', '#ffd34a', '#ff7af0'];

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
    this.effects = []; // death rings and spawn beams (event-driven, short-lived)
    // Pooled frame data, reused every frame.
    this.frame = {
      players: Array.from({ length: POOL }, () => ({ id: 0, x: 0, y: 0, facing: 3, moving: false, shield: false, cursed: false })),
      nPlayers: 0,
      bombs: Array.from({ length: POOL }, () => ({ x: 0, y: 0, fuse: 0, pierce: false })),
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
    this.dirty.add(Math.floor(y / CHUNK) * Math.ceil(map.w / CHUNK) + Math.floor(x / CHUNK));
  }

  resetMap() {
    this.chunks.clear();
    this.dirty.clear();
    this.decalT.fill(-1e9);
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
    const floors = [this.assets.sprite('floor'), this.assets.sprite('floor_b'), this.assets.sprite('floor_c')];
    const pillar = this.assets.sprite('pillar'), crate = this.assets.sprite('crate');
    g.fillStyle = '#1b2a17';
    g.fillRect(0, 0, c.width, c.height);
    for (let ty = 0; ty < CHUNK; ty++) {
      const y = cy * CHUNK + ty;
      if (y >= map.h) break;
      for (let tx = 0; tx < CHUNK; tx++) {
        const x = cx * CHUNK + tx;
        if (x >= map.w) break;
        const t = map.tiles[y * map.w + x];
        const px = tx * CHUNK_PX, py = ty * CHUNK_PX;
        if (t !== TILE_WALL) {
          // Floor variant from a coordinate hash, so it stays stable.
          const h = ((x * 73856093) ^ (y * 19349663)) >>> 0;
          g.drawImage(floors[h % 7 === 0 ? 2 : h % 3 === 0 ? 1 : 0], px, py, CHUNK_PX, CHUNK_PX);
        }
        if (t === TILE_WALL) g.drawImage(pillar, px, py, CHUNK_PX, CHUNK_PX);
        else if (t === TILE_CRATE) g.drawImage(crate, px, py, CHUNK_PX, CHUNK_PX);
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

  death(x, y, now) {
    this.effects.push({ kind: 'death', x, y, start: now, duration: 800 });
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

  // ------------------------------------------------------------- frame

  draw(state, now, dt) {
    const { ctx } = this;
    const W = this.canvas.width, H = this.canvas.height;
    const { map } = state;
    const T = this.T = this.baseT * state.zoom;
    this.interpolate(state, now);
    const f = this.frame;
    const sec = now / 1000;

    // Camera follows the smoothed local player, plus screen shake.
    this.shake *= Math.exp(-dt * 7);
    const sx = (Math.random() - 0.5) * this.shake * T, sy = (Math.random() - 0.5) * this.shake * T;
    this.camX = clampCam(state.self.x * T - W / 2, map.w * T, W);
    this.camY = clampCam(state.self.y * T - H / 2, map.h * T, H);
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

    // Scorch marks fade out over a few seconds.
    const scorch = this.assets.sprite('scorch');
    for (let i = 0; i < DECALS; i++) {
      const age = now - this.decalT[i];
      if (age >= DECAL_LIFE) continue;
      const x = this.decalX[i], y = this.decalY[i];
      if (map.tiles[y * map.w + x] !== 0) continue;
      ctx.globalAlpha = 0.7 * (1 - age / DECAL_LIFE);
      ctx.drawImage(scorch, x * T - camX, y * T - camY, T, T);
    }
    ctx.globalAlpha = 1;

    this.drawItems(state.items, camX, camY, T, sec);
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
    for (let i = 0; i < f.nPlayers; i++) this.drawName(ps[i], camX, camY, T, state);

    ctx.drawImage(this.vignette, 0, 0);

    if (now - this.lastMinimap > 400) {
      this.lastMinimap = now;
      this.drawMinimap(state);
    }
  }

  drawItems(items, camX, camY, T, sec) {
    const { ctx } = this;
    for (let k = 0; k < items.length; k++) {
      const [x, y, kind] = items[k];
      const s = this.assets.sprite(ITEM_SPRITES[kind]);
      if (!s) continue;
      const cx = (x + 0.5) * T - camX, cy = (y + 0.5) * T - camY;
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
      const urgency = 1 - Math.min(1, b.fuse / 50);
      const pulse = 1 + Math.sin(sec * (6 + urgency * 18)) * (0.05 + urgency * 0.06);
      const size = T * 0.95 * pulse;
      let px = (b.x + 0.5) * T - camX, py = (b.y + 0.5) * T - camY;
      if (b.fuse < 15) {
        px += (Math.random() - 0.5) * T * 0.06;
        py += (Math.random() - 0.5) * T * 0.06;
      }
      ctx.drawImage(this.assets.sprite(b.pierce ? 'bomb_pierce' : 'bomb'), px - size / 2, py - size / 2, size, size);
      if (b.fuse < 15) {
        ctx.strokeStyle = `rgba(255,60,30,${0.5 + 0.5 * Math.sin(sec * 30)})`;
        ctx.lineWidth = T * 0.05;
        ctx.beginPath();
        ctx.arc(px - size * 0.03, py + size * 0.09, size * 0.33, 0, 6.2832);
        ctx.stroke();
      }
      // Fuse sparks fly off the tip.
      if (Math.random() < dt * 30) {
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

  drawPlayer(p, camX, camY, T, sec, dt, state) {
    const { ctx } = this;
    const hue = playerHue(p.id);
    const view = p.facing === 1 ? 'player_up' : p.facing === 3 ? 'player_down' : 'player_side';
    const sprite = this.assets.player(hue, view);
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
    if (sprite) {
      ctx.save();
      ctx.translate(px, py + T * 0.42 + bob);
      ctx.scale(p.facing === 4 ? -sxs : sxs, sys);
      ctx.drawImage(sprite, -T / 2, -T * 0.92, T, T);
      ctx.restore();
    } else {
      ctx.fillStyle = `hsl(${hue},78%,54%)`;
      ctx.beginPath();
      ctx.arc(px, py + bob, T * 0.35, 0, 6.2832);
      ctx.fill();
    }
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
  }

  drawName(p, camX, camY, T, state) {
    const { ctx } = this;
    const name = state.roster.get(p.id) ?? '?';
    const fs = Math.max(11, Math.round(T * 0.24));
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
      ctx.strokeStyle = 'rgba(0,0,0,0.75)';
      ctx.strokeText(name, x, y);
      ctx.fillStyle = '#fff';
      ctx.fillText(name, x, y);
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
      ctx.globalAlpha = 1 - t;
      if (e.kind === 'death') {
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = T * 0.08 * (1 - t);
        ctx.beginPath();
        ctx.arc(cx, cy, T * (0.3 + t * 0.9), 0, 6.2832);
        ctx.stroke();
      } else {
        // Spawn beam: a column of light that narrows.
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
      if (t === TILE_WALL) { data[o] = 120; data[o + 1] = 128; data[o + 2] = 138; }
      else if (t === TILE_CRATE) { data[o] = 150; data[o + 1] = 100; data[o + 2] = 52; }
      else { data[o] = 70; data[o + 1] = 135; data[o + 2] = 50; }
      data[o + 3] = 255;
    }
    this.mapImage.getContext('2d').putImageData(this.mapPixels, 0, 0);
    c.imageSmoothingEnabled = false;
    c.drawImage(this.mapImage, 0, 0, m.width, m.height);
    const T = this.T;
    c.strokeStyle = 'rgba(255,255,255,0.7)';
    c.lineWidth = 1;
    c.strokeRect(this.camX / T * scale, this.camY / T * scale, this.canvas.width / T * scale, this.canvas.height / T * scale);
    const f = this.frame;
    for (let i = 0; i < f.nPlayers; i++) {
      const p = f.players[i];
      const me = p.id === state.myId;
      c.fillStyle = me ? '#ffd34a' : '#ff4a4a';
      const s = me ? 5 : 3;
      c.fillRect(p.x * scale - s / 2, p.y * scale - s / 2, s, s);
    }
  }

  /**
   * Fills the pooled frame: other players and bombs interpolated between the
   * two snapshots around the render time; the local player uses its smoothed
   * latest position so controls feel immediate.
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
      const jump = Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]) > 200; // respawn teleport
      const t = jump ? 1 : alpha;
      const o = f.players[n++];
      o.id = q[0];
      o.x = (p[1] + (q[1] - p[1]) * t) / 100;
      o.y = (p[2] + (q[2] - p[2]) * t) / 100;
      o.facing = q[3];
      o.moving = (q[4] & 1) !== 0;
      o.shield = (q[4] & 2) !== 0;
      o.cursed = (q[4] & 4) !== 0;
    }
    if (state.me?.alive) {
      const mine = state.mine;
      if (mine) {
        const o = f.players[n++];
        o.id = state.myId;
        o.x = state.self.x;
        o.y = state.self.y;
        o.facing = mine[3];
        o.moving = (mine[4] & 1) !== 0;
        o.shield = (mine[4] & 2) !== 0;
        o.cursed = (mine[4] & 4) !== 0;
      }
    }
    f.nPlayers = n;

    prev.clear();
    for (let i = 0; i < a.b.length; i++) prev.set(a.b[i][0], a.b[i]);
    let m = 0;
    for (let i = 0; i < b.b.length && m < POOL; i++) {
      const q = b.b[i];
      const p = prev.get(q[0]) ?? q;
      const o = f.bombs[m++];
      o.x = p[1] + (q[1] - p[1]) * alpha;
      o.y = p[2] + (q[2] - p[2]) * alpha;
      o.fuse = q[3];
      o.pierce = q[4] === 1;
    }
    f.nBombs = m;
    state.items = latest.i;
    state.explosions = latest.e;
  }
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
