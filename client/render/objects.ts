// Things on the ground: items, bombs (with mines, rockets and sticky bombs),
// gas clouds, portals and atomic bomb danger zones.

import { ITEM_SPRITES } from '../assets.js';
import { context2d, makeCanvas } from '../dom.js';
import { P_SMOKE, P_SPARK } from '../particles.js';
import type { GameState } from '../state.js';
import { BOLT_COLORS } from '../protocol.js';
import { ARM_DIRS, C_BOLT, C_GAS, FUSE_TIP, FUSE_TIP_PIXEL, HALO, inNukeDisc, NUKE_DISC, NUKE_FUSE_TICKS, NUKE_OUTLINE, PORTAL_COLORS, T_WALL } from './constants.js';
import { drawGoo } from './shapes.js';
import type { Stage } from './stage.js';
import type { Frame, FrameBomb } from './types.js';

export class ObjectLayer {
  /** Item halo sprites by colour. */
  private readonly halos = new Map<string, HTMLCanvasElement>();

  constructor(private readonly s: Stage) {}

  private halo(color: string): HTMLCanvasElement {
    let c = this.halos.get(color);
    if (!c) {
      c = makeCanvas(64);
      this.halos.set(color, c);
      const g = context2d(c);
      const grad = g.createRadialGradient(32, 32, 4, 32, 32, 32);
      grad.addColorStop(0, color);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      g.globalAlpha = 0.55;
      g.fillStyle = grad;
      g.fillRect(0, 0, 64, 64);
    }
    return c;
  }

  drawItems(items: readonly (readonly [number, number, number])[], camX: number, camY: number, T: number, sec: number, W: number, H: number) {
    const { ctx } = this.s;
    // Halos first, all in one additive pass (one composite switch per frame).
    ctx.globalCompositeOperation = 'lighter';
    for (const it of items) {
      const x = it[0], y = it[1], kind = it[2];
      const cx = (x + 0.5) * T - camX, cy = (y + 0.5) * T - camY;
      if (cx < -T || cy < -T || cx > W + T || cy > H + T) continue;
      const bob = Math.sin(sec * 4 + x + y) * T * 0.04;
      const hs = T * 1.25 * (1 + 0.08 * Math.sin(sec * 3 + x * 2));
      ctx.drawImage(this.halo(HALO[kind] ?? '#ffffff'), cx - hs / 2, cy - hs / 2 + bob, hs, hs);
    }
    ctx.globalCompositeOperation = 'source-over';
    const size = T * 0.82;
    for (const it of items) {
      const x = it[0], y = it[1], kind = it[2];
      const cx = (x + 0.5) * T - camX, cy = (y + 0.5) * T - camY;
      if (cx < -T || cy < -T || cx > W + T || cy > H + T) continue;
      const name = ITEM_SPRITES[kind];
      if (!name) continue;
      const s = this.s.art(name);
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
  drawPortals(state: GameState, camX: number, camY: number, T: number, sec: number) {
    const portals = state.snaps.latest().x.portals;
    if (portals.length === 0) return;
    const { ctx } = this.s;
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
  drawGas(state: GameState, camX: number, camY: number, T: number, sec: number, dt: number) {
    const clouds = state.snaps.latest().x.gas;
    if (clouds.length === 0) return;
    const { ctx } = this.s;
    for (const [id, x, y, arms, left] of clouds) {
      const fade = Math.min(1, left / 15);
      const cell = (cx: number, cy: number, k: number): void => {
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
        if (Math.random() < dt * 1.5) this.s.particles.emit(P_SMOKE, cx + Math.random(), cy + Math.random(), 0, -0.2, 1.2, 0.18, C_GAS);
      };
      cell(x, y, 0);
      for (let d = 0; d < 4; d++) {
        for (let r = 1; r <= arms[d]; r++) cell(x + ARM_DIRS[d][0] * r, y + ARM_DIRS[d][1] * r, d * 8 + r);
      }
    }
    ctx.globalAlpha = 1;
  }

  /** Sticky bombs ride on their carrier's back, fuse ring and all. */
  drawStuckBombs(f: Frame, camX: number, camY: number, T: number, sec: number) {
    const { ctx } = this.s;
    for (let i = 0; i < f.nBombs; i++) {
      const b = f.bombs[i];
      if (!b.carrier) continue;
      let who = null;
      for (let k = 0; k < f.nPlayers; k++) if (f.players[k].id === b.carrier && !f.players[k].clone) { who = f.players[k]; break; }
      if (!who) continue;
      const size = T * 0.6;
      const px = (who.x + 0.28) * T - camX, py = (who.y - 0.2) * T - camY - who.lift;
      ctx.drawImage(this.s.art('bomb'), px - size / 2, py - size / 2, size, size);
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

  drawBombs(f: Frame, camX: number, camY: number, T: number, sec: number, dt: number) {
    const { ctx } = this.s;
    const pix = this.s.pixelArt();
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
      if (b.bolt) {
        this.drawBolt(b, px, py, T, sec);
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
        if (Math.random() < dt * 8) this.s.particles.emit(P_SMOKE, b.x + 0.5, b.y + 0.4, (Math.random() - 0.5) * 0.4, -0.5, 0.9, 0.12, C_GAS);
      }
      if (b.freeze) {
        // Frosty halo around freeze bombs.
        ctx.fillStyle = 'rgba(160,230,255,0.35)';
        ctx.beginPath();
        ctx.arc(px, py + size * 0.08, size * 0.55, 0, 6.2832);
        ctx.fill();
      }
      ctx.drawImage(this.s.art(b.nuke ? 'bomb_nuke' : b.pierce ? 'bomb_pierce' : 'bomb'), px - size / 2, py - size / 2, size, size);
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
      if (late || this.s.highContrast) {
        ctx.strokeStyle = late ? `rgba(255,60,30,${0.5 + 0.5 * Math.sin(sec * 30)})` : '#fff';
        ctx.lineWidth = T * 0.05;
        ctx.beginPath();
        ctx.arc(px - size * 0.03, py + size * 0.09, size * 0.33, 0, 6.2832);
        ctx.stroke();
      }
      // Fuse sparks fly off the tip.
      if (!b.remote && Math.random() < dt * 30) {
        const [tx, ty] = pix ? FUSE_TIP_PIXEL : FUSE_TIP;
        this.s.particles.emit(P_SPARK, b.x + 0.5 + tx * pulse, b.y + 0.5 + ty * pulse,
          (Math.random() - 0.5) * 2, -Math.random() * 2, 0.25, 0.04, 1);
      }
    }
  }

  /** Your own hidden land mine: a dim disc with a blinking light. */
  private drawMine(px: number, py: number, T: number, sec: number) {
    const { ctx } = this.s;
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

  /**
   * A cosmos blaster bolt: a glowing streak of light in its blaster's
   * colour, a white-hot core and a trail of sparks. Phase bolts flicker,
   * plasma bolts are fat.
   */
  private drawBolt(b: FrameBomb, px: number, py: number, T: number, sec: number) {
    const { ctx } = this.s;
    let a = Math.atan2(b.dy, b.dx);
    if (b.dx === 0 && b.dy === 0) a = (b.rocketA ?? 0);
    b.rocketA = a;
    const [core, glow] = BOLT_COLORS[b.bolt] ?? BOLT_COLORS[1];
    const c = Math.cos(a), s = Math.sin(a);
    const fat = b.bolt === 2 ? 1.5 : 1;
    const flicker = b.bolt === 4 ? 0.55 + 0.45 * Math.abs(Math.sin(sec * 40)) : 1;
    const L = T * 0.95, R = T * 0.11 * fat;
    ctx.setTransform(c, s, -s, c, px, py);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.45 * flicker;
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.ellipse(-L * 0.15, 0, L * 0.65, R * 3, 0, 0, 6.2832);
    ctx.fill();
    ctx.globalAlpha = flicker;
    ctx.beginPath();
    ctx.ellipse(-L * 0.1, 0, L * 0.5, R * 1.4, 0, 0, 6.2832);
    ctx.fill();
    ctx.fillStyle = core;
    ctx.beginPath();
    ctx.ellipse(0, 0, L * 0.38, R * 0.7, 0, 0, 6.2832);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.ellipse(L * 0.12, 0, L * 0.16, R * 0.45, 0, 0, 6.2832);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (Math.random() < 0.7) {
      this.s.particles.emit(P_SPARK, b.x + 0.5 - c * 0.4, b.y + 0.5 - s * 0.4, -c * 0.8 + (Math.random() - 0.5) * 0.6,
        -s * 0.8 + (Math.random() - 0.5) * 0.6, 0.3, 0.05 * fat, C_BOLT + b.bolt);
    }
  }

  /** A rocket pointing the way it flies, with an exhaust flame. */
  private drawRocket(b: FrameBomb, px: number, py: number, T: number, sec: number) {
    const { ctx } = this.s;
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
    if (Math.random() < 0.6) this.s.particles.emit(P_SMOKE, b.x + 0.5 - c * 0.45, b.y + 0.5 - s * 0.45, -c * 0.5, -s * 0.5, 0.5, 0.12, 4);
  }

  /**
   * Danger zones of ticking atomic bombs, under everything else: every cell
   * the blast will burn is tinted red (pulsing faster as the fuse runs
   * out), with a bold line where safety starts. Returns the zone the local
   * player stands in (the bomb), or null.
   */
  drawNukeZones(state: GameState, f: Frame, camX: number, camY: number, T: number, sec: number) {
    let mine = null;
    const { ctx } = this.s;
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
  drawNukeCountdowns(f: Frame, camX: number, camY: number, T: number) {
    const { ctx } = this.s;
    for (let i = 0; i < f.nBombs; i++) {
      const b = f.bombs[i];
      if (!b.nuke) continue;
      const px = (b.x + 0.5) * T - camX, py = (b.y + 0.5) * T - camY - T * 0.75;
      const fs = Math.max(Math.round(14 * this.s.dpr), Math.round(T * 0.45));
      ctx.font = this.s.font(fs, 800);
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
  drawRunWarning(state: GameState, b: FrameBomb, camX: number, camY: number, T: number, sec: number) {
    const { ctx } = this.s;
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
    // (The "get out" message is a status alert: see main.ts.)
  }
}
