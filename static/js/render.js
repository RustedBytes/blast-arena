// Canvas renderer: tiles, entities, flames, labels, effects and minimap.

import { playerHue } from './assets.js';

const TILE_FLOOR = 0, TILE_WALL = 1, TILE_CRATE = 2;
const ITEM_SPRITES = [null, 'pu_bomb', 'pu_range', 'pu_speed', 'pu_kick'];
// Rotation for flame arms, indexed like the server: up, right, down, left.
const ARM_ANGLES = [-Math.PI / 2, 0, Math.PI / 2, Math.PI];
const ARM_DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];
/** Render this many ticks behind the server to interpolate smoothly. */
export const INTERP_TICKS = 2;

export class Renderer {
  constructor(canvas, minimap, assets) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.minimap = minimap;
    this.mctx = minimap.getContext('2d');
    this.assets = assets;
    this.T = 48;
    this.camX = 0;
    this.camY = 0;
    this.lastMinimap = 0;
    this.mapImage = null;
  }

  resize(aoi) {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(innerWidth * dpr);
    const h = Math.round(innerHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    // Tiles are sized so the viewport never exceeds the server's area of
    // interest; otherwise players at the screen edge would pop in and out.
    const [hw, hh] = aoi;
    this.T = Math.ceil(Math.max(w / (2 * hw - 1), h / (2 * hh - 1)));
    this.assets.setTileSize(this.T);
    this.dpr = dpr;
  }

  draw(state, now) {
    const { ctx, T } = this;
    const W = this.canvas.width, H = this.canvas.height;
    const { map } = state;
    const frame = interpolate(state, now);

    // Camera follows the (smoothed) local player.
    const focus = state.self;
    this.camX = clampCam(focus.x * T - W / 2, map.w * T, W);
    this.camY = clampCam(focus.y * T - H / 2, map.h * T, H);
    const camX = Math.round(this.camX), camY = Math.round(this.camY);

    ctx.fillStyle = '#1b2a17';
    ctx.fillRect(0, 0, W, H);

    const x0 = Math.max(0, Math.floor(camX / T)), y0 = Math.max(0, Math.floor(camY / T));
    const x1 = Math.min(map.w - 1, Math.floor((camX + W) / T)), y1 = Math.min(map.h - 1, Math.floor((camY + H) / T));
    const floor = this.assets.sprite('floor'), pillar = this.assets.sprite('pillar'), crate = this.assets.sprite('crate');
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const t = map.tiles[y * map.w + x];
        const sprite = t === TILE_WALL ? pillar : t === TILE_CRATE ? crate : floor;
        ctx.drawImage(sprite, x * T - camX, y * T - camY);
      }
    }

    const sec = now / 1000;

    // Items gently bob so they read as collectible.
    for (const [x, y, kind] of frame.items) {
      const s = this.assets.sprite(ITEM_SPRITES[kind]);
      if (!s) continue;
      const bob = Math.sin(sec * 4 + x + y) * T * 0.04;
      const k = 0.82;
      ctx.drawImage(s, x * T - camX + T * (1 - k) / 2, y * T - camY + T * (1 - k) / 2 + bob, T * k, T * k);
    }

    // Bombs pulse faster as the fuse burns down and flush red at the end.
    const bombSprite = this.assets.sprite('bomb');
    for (const b of frame.bombs) {
      const urgency = 1 - Math.min(1, b.fuse / 50);
      const pulse = 1 + Math.sin(sec * (6 + urgency * 18)) * (0.05 + urgency * 0.06);
      const size = T * 0.95 * pulse;
      const px = (b.x + 0.5) * T - camX, py = (b.y + 0.5) * T - camY;
      ctx.drawImage(bombSprite, px - size / 2, py - size / 2, size, size);
      if (b.fuse < 15 && Math.floor(sec * 10) % 2 === 0) {
        ctx.fillStyle = 'rgba(255,60,30,0.35)';
        ctx.beginPath();
        ctx.arc(px, py + T * 0.08, size * 0.32, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    this.drawExplosions(frame.explosions, camX, camY);

    // Players, back to front.
    frame.players.sort((a, b) => a.y - b.y);
    for (const p of frame.players) this.drawPlayer(p, camX, camY, sec, state);
    for (const p of frame.players) this.drawName(p, camX, camY, state);

    this.drawEffects(state, now, camX, camY);

    if (now - this.lastMinimap > 400) {
      this.lastMinimap = now;
      this.drawMinimap(state, frame);
    }
  }

  drawExplosions(explosions, camX, camY) {
    const { ctx, T } = this;
    const center = this.assets.sprite('flame_center');
    const arm = this.assets.sprite('flame_arm');
    const end = this.assets.sprite('flame_end');
    for (const [ex, ey, arms, left] of explosions) {
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
    ctx.globalAlpha = 1;
  }

  drawPlayer(p, camX, camY, sec, state) {
    const { ctx, T } = this;
    const hue = playerHue(p.id);
    const view = p.facing === 1 ? 'player_up' : p.facing === 3 ? 'player_down' : 'player_side';
    const sprite = this.assets.player(hue, view);
    const bob = p.moving ? -Math.abs(Math.sin(sec * 14 + p.id)) * T * 0.07 : 0;
    const px = p.x * T - camX, py = p.y * T - camY + bob;
    if (p.shield) ctx.globalAlpha = 0.45 + 0.35 * Math.sin(sec * 20);
    if (p.id === state.myId) {
      ctx.fillStyle = 'rgba(255,211,74,0.28)';
      ctx.beginPath();
      ctx.ellipse(px, p.y * T - camY + T * 0.42, T * 0.42, T * 0.13, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    if (sprite) {
      ctx.save();
      ctx.translate(px, py);
      if (p.facing === 4) ctx.scale(-1, 1);
      ctx.drawImage(sprite, -T / 2, -T / 2 - T * 0.08, T, T);
      ctx.restore();
    } else {
      ctx.fillStyle = `hsl(${hue},78%,54%)`;
      ctx.beginPath();
      ctx.arc(px, py, T * 0.35, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  drawName(p, camX, camY, state) {
    const { ctx, T } = this;
    const name = state.roster.get(p.id) ?? '?';
    const fs = Math.max(11, Math.round(T * 0.24));
    ctx.font = `700 ${fs}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    const x = p.x * T - camX, y = (p.y - 0.5) * T - camY - T * 0.06;
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

  drawEffects(state, now, camX, camY) {
    const { ctx, T } = this;
    state.effects = state.effects.filter((e) => now - e.start < e.duration);
    for (const e of state.effects) {
      const t = (now - e.start) / e.duration;
      const cx = e.x * T - camX, cy = e.y * T - camY;
      if (e.kind === 'debris') {
        ctx.fillStyle = '#a46a33';
        ctx.globalAlpha = 1 - t;
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2 + e.seed;
          const d = t * T * 0.7;
          const s = T * 0.16 * (1 - t * 0.5);
          ctx.fillRect(cx + Math.cos(a) * d - s / 2, cy + Math.sin(a) * d - s / 2 + t * t * T * 0.4, s, s);
        }
      } else if (e.kind === 'death') {
        ctx.globalAlpha = 1 - t;
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = T * 0.08 * (1 - t);
        ctx.beginPath();
        ctx.arc(cx, cy, T * (0.3 + t * 0.9), 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = 'rgba(70,70,80,0.8)';
        for (let i = 0; i < 5; i++) {
          const a = (i / 5) * Math.PI * 2 + e.seed;
          ctx.beginPath();
          ctx.arc(cx + Math.cos(a) * t * T * 0.5, cy + Math.sin(a) * t * T * 0.5 - t * T * 0.5, T * 0.22 * (1 - t * 0.6), 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    ctx.globalAlpha = 1;
  }

  drawMinimap(state, frame) {
    const { map } = state;
    const m = this.minimap, c = this.mctx;
    const scale = 2;
    if (m.width !== map.w * scale) {
      m.width = map.w * scale;
      m.height = map.h * scale;
    }
    const img = c.createImageData(map.w, map.h);
    for (let i = 0; i < map.tiles.length; i++) {
      const t = map.tiles[i];
      const [r, g, b] = t === TILE_WALL ? [120, 128, 138] : t === TILE_CRATE ? [150, 100, 52] : [70, 135, 50];
      img.data.set([r, g, b, 255], i * 4);
    }
    // Draw at 1px per tile, then scale up for crisp pixels.
    const tmp = this.mapImage ??= document.createElement('canvas');
    tmp.width = map.w;
    tmp.height = map.h;
    tmp.getContext('2d').putImageData(img, 0, 0);
    c.imageSmoothingEnabled = false;
    c.drawImage(tmp, 0, 0, m.width, m.height);

    const T = this.T;
    c.strokeStyle = 'rgba(255,255,255,0.7)';
    c.lineWidth = 1;
    c.strokeRect(this.camX / T * scale, this.camY / T * scale, this.canvas.width / T * scale, this.canvas.height / T * scale);
    for (const p of frame.players) {
      c.fillStyle = p.id === state.myId ? '#ffd34a' : '#ff4a4a';
      const s = p.id === state.myId ? 5 : 3;
      c.fillRect(p.x * scale - s / 2, p.y * scale - s / 2, s, s);
    }
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

/**
 * Builds the frame to draw: other players and bombs interpolated between the
 * two snapshots around the render time; the local player uses its smoothed
 * latest position so controls feel immediate.
 */
function interpolate(state, now) {
  const snaps = state.snaps;
  const latest = snaps[snaps.length - 1];
  const rt = now / state.tickMs - state.offset - INTERP_TICKS;
  let a = snaps[0], b = snaps[0];
  for (let i = snaps.length - 1; i >= 0; i--) {
    if (snaps[i].k <= rt) {
      a = snaps[i];
      b = snaps[i + 1] ?? snaps[i];
      break;
    }
  }
  const alpha = b.k > a.k ? Math.min(1, Math.max(0, (rt - a.k) / (b.k - a.k))) : 0;

  const prev = new Map(a.p.map((p) => [p[0], p]));
  const players = [];
  for (const q of b.p) {
    if (q[0] === state.myId) continue;
    const p = prev.get(q[0]) ?? q;
    const jump = Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]) > 200; // respawn teleport
    const f = jump ? 1 : alpha;
    players.push({
      id: q[0],
      x: (p[1] + (q[1] - p[1]) * f) / 100,
      y: (p[2] + (q[2] - p[2]) * f) / 100,
      facing: q[3],
      moving: (q[4] & 1) !== 0,
      shield: (q[4] & 2) !== 0,
    });
  }
  const mine = latest.p.find((p) => p[0] === state.myId);
  if (mine && state.me?.alive) {
    players.push({ id: mine[0], x: state.self.x, y: state.self.y, facing: mine[3], moving: (mine[4] & 1) !== 0, shield: (mine[4] & 2) !== 0 });
  }

  const prevBombs = new Map(a.b.map((x) => [x[0], x]));
  const bombs = b.b.map((q) => {
    const p = prevBombs.get(q[0]) ?? q;
    return { x: p[1] + (q[1] - p[1]) * alpha, y: p[2] + (q[2] - p[2]) * alpha, fuse: q[3] };
  });

  return { players, bombs, items: latest.i, explosions: latest.e };
}
