// Map events and match overlays: meteors, lava, blizzards, capture-the-flag
// bases, the battle royale zone, king-of-the-hill zones and the replay frame.

import { t } from '../i18n.js';
import { P_DEBRIS } from '../particles.js';
import type { Circle, GameMap, GameState, Vec, Zone } from '../state.js';
import { biome, BIOME_VOLCANO, EVENT_BLIZZARD, EVENT_EARTHQUAKE, METEOR_WARN_MS, TEAM_COLORS } from './constants.js';
import { drawFlag } from './shapes.js';
import type { Stage } from './stage.js';
import type { LavaSurge, Meteor, Weather } from './types.js';

export class EventLayer {
  /** The current map event (read by the minimap, for the blizzard). */
  weather: Weather | null = null;
  /** Blizzard flakes (x, y in 0..1, speed). */
  private snow: Float32Array | null = null;
  private readonly meteors: Meteor[] = [];
  private readonly lava: LavaSurge[] = [];

  constructor(private readonly s: Stage) {}

  /** Screen shake from an earthquake around `focus`: hardest in the volcano, 0 without one. */
  quake(map: GameMap, focus: Vec, now: number): number {
    const w = this.weather;
    if (w?.kind !== EVENT_EARTHQUAKE || now >= w.end) return 0;
    const inVolcano = biome(map, Math.floor(focus.x), Math.floor(focus.y)) === BIOME_VOLCANO;
    const fade = Math.min(1, (w.end - now) / 800);
    return (inVolcano ? 0.32 : 0.12) * fade * (0.7 + 0.3 * Math.sin(now / 90));
  }

  /** A map event started (1 meteors, 2 blizzard, 3 lava, 4 conveyors). */
  mapEvent(kind: number, now: number, durationMs: number) {
    this.weather = { kind, start: now, end: now + durationMs };
  }

  addMeteor(x: number, y: number, at: number) {
    this.meteors.push({ x, y, at, hit: false });
  }

  /** Lava surge: flat [x0, y0, x1, y1, ...] cells, erupting at `start` for `burnMs`. */
  addLava(flat: number[], start: number, burnMs: number) {
    this.lava.push({ cells: flat, warn: performance.now(), start, end: start + burnMs });
  }

  /**
   * Things on the ground under everything else: the sudden-death ring
   * about to close, lava surges, meteor targets, and capture-the-flag
   * bases and flags lying around.
   */
  drawGroundEvents(state: GameState, now: number, camX: number, camY: number, T: number, sec: number, W: number, H: number) {
    const { ctx } = this.s;
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
      const pix = this.s.pixelArt();
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
          const sprite = pix ? pix.flames.center[(tick + x * 7 + y * 3) % 3] : this.s.assets.sprite('flame_center');
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
          this.s.particles.burst(P_DEBRIS, m.x + 0.5, m.y + 0.5, 14, 5, 0.9, 0.14, 4, 3);
          this.s.shake = Math.max(this.s.shake, 0.25);
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
          drawFlag(ctx, fx - T * 0.1, fy + T * 0.35, T * 0.95, color, sec);
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
  zoneNow(z: Zone, now: number): Circle {
    if (z.state !== 1) return z.from;
    const k = Math.min(1, Math.max(0, (now - z.start) / Math.max(1, z.end - z.start)));
    return { x: z.from.x + (z.to.x - z.from.x) * k, y: z.from.y + (z.to.y - z.from.y) * k, r: z.from.r + (z.to.r - z.from.r) * k };
  }

  /** The storm outside the zone (blue fog), its edge, and the next circle. */
  drawZone(state: GameState, now: number, camX: number, camY: number, T: number, sec: number, W: number, H: number) {
    const z = state.zone;
    if (!z || state.royale?.on === false) return;
    const cur = this.zoneNow(z, now);
    const { ctx } = this.s;
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
  drawSky(now: number, camX: number, camY: number, T: number, sec: number) {
    const { ctx } = this.s;
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
    const f = this.s.frame;
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
  drawWeather(now: number, dt: number, W: number, H: number) {
    const w = this.weather;
    if (w?.kind !== EVENT_BLIZZARD || now > w.end) return;
    const { ctx } = this.s;
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
    const s = this.snow, r = Math.max(1.5, 2 * this.s.dpr);
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
  drawReplayFrame(sec: number, W: number, H: number) {
    const { ctx } = this.s;
    const bar = Math.round(H * 0.07);
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.fillRect(0, 0, W, bar);
    ctx.fillRect(0, H - bar, W, bar);
    const fs = Math.round(16 * this.s.dpr);
    ctx.font = this.s.font(fs, 800);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = Math.floor(sec * 2) % 2 ? '#ff5a4a' : '#ffffff';
    ctx.fillText(`● ${t('replay')}`, W / 2, H - bar / 2);
  }

  /** King-of-the-hill zones: pulsing golden 3x3 squares. */
  drawHills(hills: readonly (readonly [number, number])[] | null, camX: number, camY: number, T: number, sec: number) {
    if (!hills) return;
    const { ctx } = this.s;
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
      ctx.font = this.s.font(Math.round(T * 0.5), '');
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.globalAlpha = 0.55;
      ctx.fillText('👑', px + T * 1.5, py + T * 1.5);
      ctx.globalAlpha = 1;
    }
  }
}
