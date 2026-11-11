// Players: sprites with walk cycles, hats, trails, status effects and name
// tags, all cached per player so drawing one allocates nothing.

import { playerColors } from '../assets.js';
import type { PlayerColors } from '../assets.js';
import { context2d } from '../dom.js';
import { N as ART_PX } from '../pixelkit.js';
import { P_CURSE, P_SMOKE, P_SPARK, P_STAR } from '../particles.js';
import { hopHeight } from '../prediction.js';
import { C_DASH, C_DUST, C_GAS_DARK, EMOTES, PIXEL_VIEWS, PLAYER_VIEWS, STRIDE, TEAM_COLORS, TRAIL_COLORS } from './constants.js';
import { drawFlag, roundRect, star } from './shapes.js';
import type { Stage } from './stage.js';
import type { Frame, FramePlayer, Gait, Label, Look, PlayerScene } from './types.js';

export class PlayerLayer {
  /** Animation key -> walk state (see gait()). */
  private readonly gaits = new Map<number, Gait>();
  private gaitFrame = 0;
  /** Per-player caches, so drawing a player allocates nothing. */
  private readonly looks = new Map<number, Look>();
  private readonly labels = new Map<number, Label>();

  constructor(private readonly s: Stage) {}

  /** Players back to front (insertion sort on the pooled slice: no garbage). */
  sortByDepth(f: Frame): void {
    const ps = f.players;
    for (let i = 1; i < f.nPlayers; i++) {
      const p = ps[i];
      let j = i - 1;
      while (j >= 0 && ps[j].y > p.y) { ps[j + 1] = ps[j]; j--; }
      ps[j + 1] = p;
    }
  }

  /** Forgets the walk state of players not drawn for a while. */
  endFrame(): void {
    if (++this.gaitFrame % 600 !== 0) return;
    for (const [key, g] of this.gaits) if (this.gaitFrame - g.seen > 120) this.gaits.delete(key);
  }

  /** Drops cached colours and name tags (palette, art style or screen density changed). */
  forgetLooks(): void {
    this.looks.clear();
    this.labels.clear();
  }

  /** Cached colours and sprites of a player (rebuilt when team or palette changes). */
  private look(id: number, state: PlayerScene) {
    const team = state.rosterInfo.get(id)?.team ?? 0;
    let l = this.looks.get(id);
    if (l?.team !== team || l.cb !== this.s.colorblind) {
      l = { team, cb: this.s.colorblind, colors: playerColors(id, team, this.s.colorblind), sprites: new Array<HTMLCanvasElement | null>(9).fill(null) };
      this.looks.set(id, l);
    }
    return l;
  }

  /**
   * `frame`: 0 standing, 1 and 2 the walk steps (pixel art only). `cache`
   * (a player's `look().sprites`) memoizes the sprite lookup.
   */
  drawSprite(colors: PlayerColors, facing: number, px: number, py: number, T: number, sxs: number, sys: number, frame = 0, cache: (HTMLCanvasElement | null)[] | null = null, rot = 0) {
    const vi = facing === 1 ? 0 : facing === 3 ? 1 : 2;
    let sprite: HTMLCanvasElement | null | undefined;
    if (this.s.pixelArt()) {
      const slot = vi * 3 + frame;
      sprite = cache?.[slot];
      if (!sprite) {
        sprite = this.s.assets.pixelPlayer(colors, PIXEL_VIEWS[vi], frame);
        if (cache) cache[slot] = sprite;
      }
    } else {
      sprite = this.s.assets.player(colors, PLAYER_VIEWS[vi]);
    }
    const { ctx } = this.s;
    // Players draw in screen space (one setTransform); death effects call
    // this inside their own transform, so they nest with save/restore.
    const nested = cache === null;
    if (nested) {
      ctx.save();
      ctx.translate(px, py);
      ctx.scale(facing === 4 ? -sxs : sxs, sys);
    } else {
      // Leaning (`rot`) pivots on the feet, where (px, py) is.
      const fx = facing === 4 ? -sxs : sxs, c = Math.cos(rot), s = Math.sin(rot);
      ctx.setTransform(c * fx, s * fx, -s * sys, c * sys, px, py);
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

  /**
   * Walk state of one drawn player, from how far they really moved since
   * the last frame: the stride follows the ground covered (no feet sliding
   * at high speed, no stepping on the spot), the gait eases in and out
   * instead of switching, the body leans into horizontal motion, and a
   * stop settles with a little squash. Kicks up dust on footfalls.
   */
  private gait(p: FramePlayer, dt: number, self: boolean) {
    let g = this.gaits.get(p.anim);
    if (!g) {
      g = { x: p.x, y: p.y, dist: 0, vx: 0, vy: 0, amp: 0, lean: 0, settle: 0, step: 0, walking: false, seen: 0 };
      this.gaits.set(p.anim, g);
    }
    g.seen = this.gaitFrame;
    let dx = p.x - g.x, dy = p.y - g.y;
    g.x = p.x;
    g.y = p.y;
    // A teleport, respawn or hop isn't walking.
    if (Math.abs(dx) + Math.abs(dy) > 1.2 || p.jumpDir || dt <= 0) dx = dy = 0;
    g.dist += Math.hypot(dx, dy);
    const dtc = Math.max(dt, 1e-3);
    const k = 1 - Math.exp(-dt * 16);
    g.vx += (dx / dtc - g.vx) * k;
    g.vy += (dy / dtc - g.vy) * k;
    // Our own `moving` flag comes from an older snapshot; the predicted
    // motion alone says it sooner. (Others' flag rules out conveyor rides.)
    const walking = (p.moving || self) && Math.hypot(g.vx, g.vy) > 0.8;
    if (g.walking && !walking) g.settle = 1;
    g.walking = walking;
    // Quick to get going, a touch slower to wind down.
    g.amp += ((walking ? 1 : 0) - g.amp) * (1 - Math.exp(-dt * (walking ? 18 : 10)));
    g.settle *= Math.exp(-dt * 7);
    const lean = p.jumpDir ? 0 : Math.max(-1, Math.min(1, g.vx / 7)) * 0.13 * g.amp;
    g.lean += (lean - g.lean) * (1 - Math.exp(-dt * 12));
    return g;
  }

  drawPlayer(p: FramePlayer, camX: number, camY: number, T: number, sec: number, dt: number, state: PlayerScene) {
    const { ctx } = this.s;
    const info = state.rosterInfo.get(p.id);
    const look = this.look(p.id, state);
    const colors = look.colors;
    const g = this.gait(p, dt, p.anim === state.myId && !this.s.replaying);
    // Two-step walk cycle driven by distance walked: a bounce that
    // squashes on each footfall and stretches between them. Pixel art
    // steps its legs instead, bobs by whole art pixels and doesn't lean,
    // so the grid never warps.
    const pixel = this.s.pixelArt() !== null;
    const phase = g.dist * Math.PI / STRIDE;
    const lift = Math.abs(Math.sin(phase)) * g.amp;
    const bob = pixel ? -Math.round(lift * 2) * T / ART_PX : -lift * T * 0.07;
    const stretch = pixel ? 0 : (lift - 0.5 * g.amp) * 0.09 - g.settle * 0.07;
    const sxs = 1 - stretch * 0.7, sys = 1 + stretch;
    const lean = pixel ? 0 : g.lean;
    const stepNo = Math.floor(phase / Math.PI);
    const step = g.amp > 0.35 ? (stepNo % 2 ? 1 : 2) : 0;
    if (stepNo !== g.step) {
      g.step = stepNo;
      // A puff of dust where the foot lands, kicked back a little.
      if (g.amp > 0.6 && !p.ghost && !p.jumpDir && Math.random() < 0.7) {
        const sp = Math.hypot(g.vx, g.vy) || 1;
        this.s.particles.emit(P_SMOKE, p.x - g.vx / sp * 0.15 + (Math.random() - 0.5) * 0.2, p.y + 0.38,
          -g.vx / sp * 0.3, -0.25, 0.45, 0.07, C_DUST);
      }
    }
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
        this.s.particles.emit(P_CURSE, p.x + (Math.random() - 0.5) * 0.6, p.y + 0.2, 0, -0.8, 0.9, 0.06, 12 + (Math.random() < 0.5 ? 1 : 0));
      }
    }
    // Wounded (dungeon): blood drips while walking, more so on the last heart's blink.
    if (p.wounded && p.moving && !p.jumpDir && Math.random() < dt * (p.hurt ? 14 : 7)) {
      this.s.blood.add(p.x, p.y + 0.3, performance.now());
    }
    // Cosmetic trail.
    const trail = info?.trail ?? 0;
    if (trail && p.moving && Math.random() < dt * 25) {
      const color = trail === 3 ? 8 + Math.floor(Math.random() * 4) : TRAIL_COLORS[trail];
      this.s.particles.emit(P_STAR, p.x + (Math.random() - 0.5) * 0.3, p.y + 0.35, 0, -0.3, 0.6, 0.12, color);
    }
    if (this.s.highContrast) {
      ctx.strokeStyle = '#000';
      ctx.lineWidth = T * 0.08;
      ctx.beginPath();
      ctx.arc(px, py - T * 0.05, T * 0.47, 0, 6.2832);
      ctx.stroke();
    }
    if (p.dashing && Math.random() < dt * 60) {
      // A dash leaves a streak of light.
      this.s.particles.emit(P_SPARK, p.x + (Math.random() - 0.5) * 0.3, p.y + (Math.random() - 0.2) * 0.4, 0, 0, 0.3, 0.1, C_DASH);
    }
    if (p.gassed && Math.random() < dt * 6) {
      this.s.particles.emit(P_SMOKE, p.x + (Math.random() - 0.5) * 0.5, p.y - 0.1, 0, -0.4, 0.8, 0.1, C_GAS_DARK);
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
    // Just bitten: blinks while the bite immunity lasts.
    else if (p.hurt) ctx.globalAlpha = Math.floor(sec * 12) % 2 ? 0.3 : 1;
    this.drawSprite(colors, p.facing, px, py + T * 0.42 + bob, T, sxs, sys, step, look.sprites, lean);
    ctx.globalAlpha = 1;
    if (pixel) this.drawPixelHat(info?.hat ?? 0, px, py - T * 0.5 + bob, T, p.facing);
    else this.drawHat(info?.hat ?? 0, px + Math.sin(lean) * T * 0.58, py + T * (0.42 - 0.58 * sys) + bob, T, p.facing);
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
        star(ctx, px + Math.cos(a) * T * 0.32, py - T * 0.78 + Math.sin(a) * T * 0.1, T * 0.09);
      }
    }
    if (p.carrying) {
      // The flag being carried: the other team's colour.
      const team = state.rosterInfo.get(p.id)?.team ?? 0;
      drawFlag(ctx, px + T * 0.18, py - T * 0.35, T * 0.8, TEAM_COLORS[team === 1 ? 2 : 1], sec);
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
   * hats overlap the helmet by four art pixels, and the halo floats above.
   */
  private drawPixelHat(hat: number, x: number, top: number, T: number, facing: number) {
    const h = hat && this.s.assets.pixel.hats[hat];
    if (!h) return;
    const u = T / ART_PX;
    const y = hat === 4 ? top - (h.rows + 1) * u : top + (4 - h.rows) * u;
    const { ctx } = this.s;
    ctx.save();
    ctx.translate(x, y);
    if (facing === 4) ctx.scale(-1, 1);
    ctx.drawImage(h.canvas, -T / 2, 0, T, T);
    ctx.restore();
  }

  /** Hats are drawn in code on top of the helmet. `y` is the head centre. */
  private drawHat(hat: number, x: number, y: number, T: number, facing: number) {
    if (!hat) return;
    const { ctx } = this.s;
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

  /** Name tag rendered once to its own canvas; redrawn only when it changes. */
  private label(p: FramePlayer, state: PlayerScene, fs: number) {
    const info = state.rosterInfo.get(p.id);
    const name = info?.name ?? '?';
    const me = p.id === state.myId;
    const team = info?.team ?? 0;
    let l = this.labels.get(p.id);
    if (l?.name === name && l.fs === fs && l.me === me && l.team === team && l.hc === this.s.highContrast && l.cb === this.s.colorblind) return l;
    if (!l) this.labels.set(p.id, (l = { canvas: document.createElement('canvas'), ax: 0, ay: 0 }));
    Object.assign(l, { name, fs, me, team, hc: this.s.highContrast, cb: this.s.colorblind });
    const c = l.canvas, g = context2d(c);
    const font = this.s.font(fs, 700);
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
      g.fillStyle = team === 1 ? (this.s.colorblind ? '#ffc04d' : '#ff8a80') : team === 2 ? (this.s.colorblind ? '#66c2ff' : '#8ab8ff') : '#fff';
      g.fillText(name, l.ax, l.ay);
    }
    return l;
  }

  drawName(p: FramePlayer, camX: number, camY: number, T: number, state: PlayerScene, now: number) {
    const { ctx } = this.s;
    // Minimum sizes are CSS px, so they stay readable on high-DPI screens.
    const fs = Math.max(Math.round((this.s.highContrast ? 13 : 11) * this.s.dpr), Math.round(T * (this.s.highContrast ? 0.28 : 0.24)));
    const x = p.x * T - camX, y = (p.y - 0.5) * T - camY - T * 0.08 - p.lift;
    const l = this.label(p, state, fs);
    ctx.drawImage(l.canvas, Math.round(x - l.ax), Math.round(y - l.ay));
    // Emote bubble above the name.
    const em = state.emotes.get(p.id);
    if (em && em.until > now) {
      const by = y - fs * 1.6;
      const text = EMOTES[em.e] ?? '?';
      const efs = Math.round(fs * 1.5);
      ctx.font = this.s.font(efs, 700);
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
}
