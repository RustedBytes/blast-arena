// Event-driven effects: explosions and atomic blasts, scorch marks, deaths,
// spawn beams, sparkles and confetti.

import type { PlayerColors } from '../assets.js';
import { context2d, makeCanvas } from '../dom.js';
import { P_DEBRIS, P_SMOKE, P_SPARK, P_STAR } from '../particles.js';
import type { Arms, FlameEntry } from '../protocol.js';
import type { GameMap } from '../state.js';
import { ARM_DIRS, C_WORM, DECAL_LIFE, DECALS, NUKE_FLAME_S, NUKE_LIFE_S, NUKE_WAVE_CPS, T_ARMORED, T_BUILT, T_CRATE, T_WALL, WARDEN_SLAM_RADIUS } from './constants.js';
import type { PlayerLayer } from './players.js';
import type { Stage } from './stage.js';
import type { Effect, NukeShow, Puffs } from './types.js';

export class EffectsLayer {
  private readonly decalX = new Float32Array(DECALS);
  private readonly decalY = new Float32Array(DECALS);
  private readonly decalT = new Float64Array(DECALS).fill(-1e9);
  private decalHead = 0;
  /** Death animations and spawn beams (event-driven, short-lived). */
  private readonly effects: Effect[] = [];
  /** Atomic blasts being shown. */
  private readonly nukes: NukeShow[] = [];
  /** Strength of the current atomic flash (0..1). */
  private flash = 0;
  private flashAt = -1e9;
  /** Soft cloud sprites, built on first use. */
  private puffs: Puffs | null = null;

  constructor(private readonly s: Stage, private readonly players: PlayerLayer) {}

  /** Forgets scorch marks (a new map). */
  reset(): void {
    this.decalT.fill(-1e9);
  }

  /** Scorch marks, fading out over a few seconds. */
  drawDecals(map: GameMap, now: number, camX: number, camY: number, T: number): void {
    const { ctx } = this.s;
    const scorch = this.s.art('scorch');
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
  }

  /** A new explosion appeared in a snapshot. */
  explosion(x: number, y: number, arms: Arms, now: number, distance: number) {
    const p = this.s.particles;
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
    this.s.shake = Math.max(this.s.shake, Math.min(0.35, this.s.shake + 0.3 / (1 + distance * distance * 0.05)));
  }

  /**
   * An atomic blast at cell (x, y) of `radius`, detonated `age` seconds ago
   * (non-zero when we only learn of it late). Sets up the flash, shockwave,
   * fire, mushroom cloud, fallout and a heavy screen shake.
   */
  nuke(x: number, y: number, radius: number, now: number, distance: number, map: GameMap, age = 0) {
    const start = now - age * 1000;
    // The disc of cells the fire covers (same shape as the server's), with
    // the time the shockwave reaches each.
    const cells: number[] = [];
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
    const p = this.s.particles, cx = x + 0.5, cy = y + 0.5;
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
    this.s.shake = Math.max(this.s.shake, 1.1 * near);
    this.flash = Math.max(near, 0.35);
    this.flashAt = now;
  }

  /** Soft round sprites the mushroom cloud is built from. */
  private buildPuffs(): Puffs {
    const make = (stops: [number, string][]): HTMLCanvasElement => {
      const c = makeCanvas(128);
      const g = context2d(c);
      const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
      for (const [o, col] of stops) grad.addColorStop(o, col);
      g.fillStyle = grad;
      g.fillRect(0, 0, 128, 128);
      return c;
    };
    return {
      fire: make([[0, '#fffbe6'], [0.25, '#fff08a'], [0.5, 'rgba(255,170,40,0.95)'], [0.78, 'rgba(230,70,10,0.55)'], [1, 'rgba(160,30,0,0)']]),
      smoke: make([[0, 'rgba(150,128,112,0.95)'], [0.55, 'rgba(104,88,80,0.85)'], [0.85, 'rgba(70,60,58,0.35)'], [1, 'rgba(50,44,44,0)']]),
      dark: make([[0, 'rgba(70,58,54,0.9)'], [0.6, 'rgba(48,40,40,0.6)'], [1, 'rgba(30,26,26,0)']]),
      dust: make([[0, 'rgba(176,150,120,0.75)'], [0.6, 'rgba(140,118,96,0.45)'], [1, 'rgba(120,100,80,0)']]),
    };
  }

  /** Ground layer of atomic blasts (under players): burning disc, shockwave, embers. */
  drawNukeGround(now: number, camX: number, camY: number, T: number) {
    if (this.nukes.length === 0) return;
    const { ctx } = this.s;
    const pix = this.s.pixelArt();
    const glow = this.s.assets.glow;
    const tick = Math.floor(now / 70);
    let keep = 0;
    for (const nk of this.nukes) {
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
        const sprite = pix ? pix.flames.center[(tick + cells[i] * 7 + cells[i + 1] * 3) % 3] : this.s.assets.sprite('flame_center');
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
  drawNukeCloud(now: number, camX: number, camY: number, T: number) {
    if (this.nukes.length === 0) return;
    const { ctx } = this.s;
    const P = (this.puffs ??= this.buildPuffs());
    const puff = (img: HTMLCanvasElement, x: number, y: number, size: number, alpha: number): void => {
      if (alpha <= 0.01) return;
      ctx.globalAlpha = Math.min(1, alpha);
      ctx.drawImage(img, x - size / 2, y - size / 2, size, size);
    };
    for (const nk of this.nukes) {
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
  drawFlash(now: number, W: number, H: number) {
    const t = (now - this.flashAt) / 1000;
    if (t > 0.6 || this.flash <= 0) return;
    const { ctx } = this.s;
    const k = this.flash * (1 - t / 0.6) ** 2;
    ctx.globalAlpha = Math.min(1, k);
    ctx.fillStyle = t < 0.08 ? '#ffffff' : '#fff6d8';
    ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = 1;
  }

  private decal(x: number, y: number, now: number) {
    const i = this.decalHead;
    this.decalX[i] = x; this.decalY[i] = y; this.decalT[i] = now;
    this.decalHead = (i + 1) % DECALS;
  }

  crateBroken(x: number, y: number) {
    this.s.particles.burst(P_DEBRIS, x + 0.5, y + 0.5, 10, 3.5, 0.8, 0.14, 6, 2);
    this.s.particles.burst(P_SMOKE, x + 0.5, y + 0.5, 3, 0.8, 0.8, 0.3, 5, 1);
  }

  /** Death animation: the victim's sprite spins, shrinks and floats away. */
  death(x: number, y: number, now: number, colors: PlayerColors, facing: number) {
    this.effects.push({ kind: 'die', x, y, start: now, duration: 900, colors, facing });
    this.s.particles.burst(P_SMOKE, x, y, 10, 1.6, 1.2, 0.3, 4, 2);
    this.s.particles.burst(P_STAR, x, y, 8, 3, 0.6, 0.25, 9, 1);
  }

  /** A worm's segment bursting (blown up, or cut in two at a cell). */
  wormSplat(x: number, y: number, big: boolean) {
    this.s.particles.burst(P_DEBRIS, x + 0.5, y + 0.5, big ? 18 : 9, big ? 4 : 2.5, 0.8, 0.16, C_WORM, 2);
    this.s.particles.burst(P_SMOKE, x + 0.5, y + 0.5, 3, 0.8, 0.8, 0.3, 5, 1);
  }

  /** The Warden's slam landing at cell (x, y): a shockwave, dust and a shake. */
  wardenSlam(x: number, y: number, now: number, near: boolean) {
    this.effects.push({ kind: 'shock', x: x + 0.5, y: y + 0.5, start: now, duration: 450 });
    this.s.particles.burst(P_DEBRIS, x + 0.5, y + 0.5, 22, 4.5, 0.7, 0.14, 4, 2);
    this.s.particles.burst(P_SMOKE, x + 0.5, y + 0.6, 10, 2.2, 0.9, 0.35, 19, 1);
    if (near) this.s.shake = Math.max(this.s.shake, 0.45);
  }

  /** The Warden brought down: it bursts into rubble and gold. */
  wardenDown(x: number, y: number, now: number) {
    this.effects.push({ kind: 'shock', x: x + 0.5, y: y + 0.5, start: now, duration: 800 });
    this.s.particles.burst(P_DEBRIS, x + 0.5, y + 0.5, 40, 6, 1.2, 0.2, 4, 2);
    this.s.particles.burst(P_STAR, x + 0.5, y + 0.5, 30, 5, 1.2, 0.3, 10, 1);
    this.s.particles.burst(P_SMOKE, x + 0.5, y + 0.5, 14, 2.5, 1.4, 0.45, 4, 2);
    this.s.shake = Math.max(this.s.shake, 0.5);
  }

  /** A worm's gulp: a ring of dust where someone was eaten. */
  wormGulp(x: number, y: number) {
    this.s.particles.burst(P_DEBRIS, x + 0.5, y + 0.5, 10, 2, 0.6, 0.14, 6, 2);
  }

  spawnBeam(x: number, y: number, now: number) {
    this.effects.push({ kind: 'beam', x, y, start: now, duration: 700 });
    this.s.particles.burst(P_STAR, x, y, 12, 2.5, 0.7, 0.2, 8, 2);
  }

  sparkle(x: number, y: number, mystery: boolean) {
    this.s.particles.burst(P_STAR, x, y, mystery ? 24 : 10, mystery ? 4 : 2.5, 0.8, 0.25, mystery ? 9 : 10, mystery ? 3 : 1);
  }

  /** Round-end celebration around the camera. */
  confetti() {
    const vw = this.s.canvas.width / this.s.T, vh = this.s.canvas.height / this.s.T;
    for (let i = 0; i < 160; i++) {
      const x = this.s.camX / this.s.T + Math.random() * vw;
      const y = this.s.camY / this.s.T + Math.random() * vh * 0.3;
      this.s.particles.emit(P_DEBRIS, x, y, (Math.random() - 0.5) * 3, -Math.random() * 4, 2.2, 0.12, 7 + Math.floor(Math.random() * 7));
    }
  }

  drawEffects(now: number, camX: number, camY: number, T: number) {
    const { ctx } = this.s;
    let keep = 0;
    for (const e of this.effects) {
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
        this.players.drawSprite(e.colors, e.facing, 0, T * 0.42 * s, T * s, 1, 1);
        ctx.restore();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = T * 0.08 * (1 - t);
        ctx.beginPath();
        ctx.arc(cx, cy, T * (0.3 + t * 0.9), 0, 6.2832);
        ctx.stroke();
      } else if (e.kind === 'shock') {
        // The Warden's slam: a ring of force rolling out over its reach.
        ctx.globalAlpha = 1 - t;
        ctx.strokeStyle = '#ffcf6a';
        ctx.lineWidth = T * 0.22 * (1 - t);
        ctx.beginPath();
        ctx.arc(cx, cy, T * (0.6 + t * (WARDEN_SLAM_RADIUS + 0.2)), 0, 6.2832);
        ctx.stroke();
        ctx.globalAlpha = 1;
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

  drawExplosions(explosions: readonly FlameEntry[], camX: number, camY: number, T: number) {
    const { ctx } = this.s;
    const pix = this.s.pixelArt();
    // Pixel flames flicker through three frames; each explosion starts on its own.
    const tick = Math.floor(performance.now() / 70);
    let center = this.s.assets.sprite('flame_center');
    let arm = this.s.assets.sprite('flame_arm');
    let end = this.s.assets.sprite('flame_end');
    for (const [ex, ey, arms, left, nuke] of explosions) {
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
    const glow = this.s.assets.glow;
    for (const [ex, ey, arms, left, nuke] of explosions) {
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
}
