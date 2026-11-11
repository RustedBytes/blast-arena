// The vault and its Warden: the stone golem, its telegraphed skills and
// health bar.

import { t } from '../i18n.js';
import { P_SMOKE } from '../particles.js';
import { GUARD_FLAG } from '../protocol.js';
import type { GuardInfo } from '../protocol.js';
import type { GameState } from '../state.js';
import { T_ARMORED, T_BUILT, T_CRATE, T_WALL, WARDEN_CHARGE_CELLS, WARDEN_CHARGE_WINDUP, WARDEN_SLAM_RADIUS, WARDEN_SLAM_WINDUP } from './constants.js';
import type { Stage } from './stage.js';

export class WardenLayer {
  /** The vault as last seen. */
  private lastGuard: GuardInfo | null = null;

  constructor(private readonly s: Stage) {}

  /** The vault and Warden as of the newest snapshot that has them. */
  guardInfo(state: GameState) {
    const g = this.s.wormSnap?.x.guard ?? state.snaps.latest().x.guard;
    if (g) this.lastGuard = g;
    return this.lastGuard ?? null;
  }

  /**
   * The vault: a gilded floor with a soft glow, gold trim along the walls
   * and glowing thresholds in the gates; while the Warden is away, how
   * long until it's back.
   */
  drawVault(state: GameState, camX: number, camY: number, T: number, sec: number) {
    const g = this.guardInfo(state);
    if (!g) return;
    const [x0, y0, x1, y1] = g.vault;
    const { ctx } = this.s;
    const left = (x0 + 1) * T - camX, top = (y0 + 1) * T - camY;
    const w = (x1 - x0 - 1) * T, h = (y1 - y0 - 1) * T;
    if (left > this.s.canvas.width || top > this.s.canvas.height || left + w < 0 || top + h < 0) return;
    // Gilded flagstones.
    for (let y = y0 + 1; y < y1; y++) {
      for (let x = x0 + 1; x < x1; x++) {
        ctx.fillStyle = (x + y) % 2 ? 'rgba(255,205,80,0.13)' : 'rgba(255,225,130,0.22)';
        ctx.fillRect(x * T - camX, y * T - camY, T, T);
      }
    }
    const pulse = 0.5 + 0.5 * Math.sin(sec * 2.2);
    ctx.strokeStyle = `rgba(255,214,90,${0.5 + 0.3 * pulse})`;
    ctx.lineWidth = Math.max(2, T * 0.06);
    ctx.strokeRect(left + T * 0.08, top + T * 0.08, w - T * 0.16, h - T * 0.16);
    // Gold trim round the outside of the walls.
    ctx.strokeStyle = 'rgba(214,154,38,0.9)';
    ctx.lineWidth = Math.max(2, T * 0.08);
    ctx.strokeRect(x0 * T - camX + T * 0.04, y0 * T - camY + T * 0.04, (x1 - x0 + 1) * T - T * 0.08, (y1 - y0 + 1) * T - T * 0.08);
    // The gates.
    const mx = Math.floor((x0 + x1) / 2), my = Math.floor((y0 + y1) / 2);
    ctx.fillStyle = `rgba(255,236,160,${0.35 + 0.25 * pulse})`;
    for (const [gx, gy] of [[mx, y0], [mx, y1], [x0, my], [x1, my]]) {
      ctx.fillRect(gx * T - camX + T * 0.1, gy * T - camY + T * 0.1, T * 0.8, T * 0.8);
    }
    if (!g.warden && g.back > 0) {
      const secs = Math.ceil(g.back / 20);
      ctx.font = `800 ${Math.round(T * 0.3)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      const label = t('wardenReturns', { n: secs });
      const cx = (mx + 0.5) * T - camX, cy = (my + 0.5) * T - camY;
      const tw = ctx.measureText(label).width + T * 0.3;
      ctx.fillRect(cx - tw / 2, cy - T * 0.25, tw, T * 0.45);
      ctx.fillStyle = '#ffd25a';
      ctx.fillText(label, cx, cy + T * 0.08);
      ctx.textAlign = 'left';
    }
  }

  /**
   * The Warden: a stone golem a cell and a half tall sliding between
   * cells, with its telegraphs on the ground first (a slam's square
   * filling up, a charge's lane), an aura when enraged, a stone shell for
   * its stone skin, a flash when hit, and its health above it.
   */
  drawWarden(state: GameState, camX: number, camY: number, T: number, sec: number) {
    const g = this.guardInfo(state);
    const d = g?.warden;
    if (!d) return;
    const [, cx, cy, fx, fy, flags, step, since, hp, max, skillLeft, dir] = d;
    const s = this.s.wormSnap;
    const elapsed = s ? this.s.wormTime - s.k : 0;
    const prog = Math.min(1, Math.max(0, (since + elapsed) / Math.max(1, step)));
    const ease = prog * prog * (3 - 2 * prog);
    const x = fx + (cx - fx) * ease + 0.5, y = fy + (cy - fy) * ease + 0.5;
    const px = x * T - camX, py = y * T - camY;
    if (px < -T * 10 || py < -T * 10 || px > this.s.canvas.width + T * 10 || py > this.s.canvas.height + T * 10) return;
    const { ctx } = this.s;
    const left = Math.max(0, skillLeft - elapsed);
    // Telegraphs on the ground.
    if (flags & GUARD_FLAG.SLAM) {
      const k = 1 - Math.min(1, left / WARDEN_SLAM_WINDUP);
      const r = WARDEN_SLAM_RADIUS;
      ctx.fillStyle = `rgba(255,50,30,${0.12 + 0.3 * k})`;
      ctx.fillRect((cx - r) * T - camX, (cy - r) * T - camY, (2 * r + 1) * T, (2 * r + 1) * T);
      ctx.strokeStyle = `rgba(255,80,50,${0.6 + 0.4 * k})`;
      ctx.lineWidth = Math.max(2, T * 0.06);
      ctx.strokeRect((cx - r) * T - camX, (cy - r) * T - camY, (2 * r + 1) * T, (2 * r + 1) * T);
      // The square fills in from the edges as the slam comes.
      ctx.fillStyle = `rgba(255,40,20,${0.25 * k})`;
      const inset = (1 - k) * (r + 0.5) * T;
      ctx.fillRect((cx - r) * T - camX + inset, (cy - r) * T - camY + inset, (2 * r + 1) * T - 2 * inset, (2 * r + 1) * T - 2 * inset);
    }
    if (flags & (GUARD_FLAG.CHARGE_WINDUP | GUARD_FLAG.CHARGING) && dir >= 1 && dir <= 4) {
      const [dx, dy] = [[0, 0], [0, -1], [1, 0], [0, 1], [-1, 0]][dir];
      const map = state.map;
      const k = flags & GUARD_FLAG.CHARGING ? 1 : 1 - Math.min(1, left / WARDEN_CHARGE_WINDUP);
      for (let i = 1; i <= WARDEN_CHARGE_CELLS; i++) {
        const lx = cx + dx * i, ly = cy + dy * i;
        if (lx < 0 || ly < 0 || lx >= map.w || ly >= map.h) break;
        const tt = map.tiles[ly * map.w + lx];
        if (tt === T_WALL || tt === T_CRATE || tt === T_ARMORED || tt === T_BUILT) break;
        ctx.fillStyle = `rgba(255,60,30,${(0.15 + 0.3 * k) * (1 - i / (WARDEN_CHARGE_CELLS + 2))})`;
        ctx.fillRect(lx * T - camX + T * 0.08, ly * T - camY + T * 0.08, T * 0.84, T * 0.84);
        // A chevron pointing the way it will come.
        ctx.strokeStyle = `rgba(255,120,80,${0.5 + 0.4 * k})`;
        ctx.lineWidth = Math.max(2, T * 0.07);
        const mx = (lx + 0.5) * T - camX, my = (ly + 0.5) * T - camY;
        ctx.beginPath();
        ctx.moveTo(mx - dx * T * 0.15 - dy * T * 0.22, my - dy * T * 0.15 - dx * T * 0.22);
        ctx.lineTo(mx + dx * T * 0.15, my + dy * T * 0.15);
        ctx.lineTo(mx - dx * T * 0.15 + dy * T * 0.22, my - dy * T * 0.15 + dx * T * 0.22);
        ctx.stroke();
      }
    }
    const enraged = (flags & GUARD_FLAG.ENRAGED) !== 0;
    if (enraged || flags & GUARD_FLAG.HUNTING) {
      ctx.fillStyle = enraged ? `rgba(255,50,20,${0.25 + 0.12 * Math.sin(sec * 12)})` : 'rgba(255,200,80,0.14)';
      ctx.beginPath();
      ctx.arc(px, py, T * (enraged ? 1.05 : 0.9), 0, 6.2832);
      ctx.fill();
      if (enraged && Math.random() < 0.3) {
        this.s.particles.emit(P_SMOKE, x + (Math.random() - 0.5) * 0.8, y - 0.4, 0, -0.8, 0.7, 0.12, 3);
      }
    }
    // Shadow, then the body; a slam wind-up rears up, a charge leans in.
    ctx.fillStyle = 'rgba(10,6,20,0.35)';
    ctx.beginPath();
    ctx.ellipse(px, py + T * 0.38, T * 0.62, T * 0.2, 0, 0, 6.2832);
    ctx.fill();
    const rear = flags & GUARD_FLAG.SLAM ? (1 - Math.min(1, left / WARDEN_SLAM_WINDUP)) * T * 0.3 : 0;
    const walking = prog < 1 && (cx !== fx || cy !== fy);
    const bob = walking ? Math.abs(Math.sin(prog * Math.PI)) * T * 0.06 : 0;
    const size = T * 1.55;
    const flip = dir === 4 ? -1 : 1;
    const lean = flags & GUARD_FLAG.CHARGING ? (dir === 2 ? 0.18 : dir === 4 ? -0.18 : 0) : 0;
    ctx.save();
    ctx.translate(px, py + T * 0.45 - rear - bob);
    ctx.rotate(lean);
    ctx.scale(flip, 1);
    const pix = this.s.pixelArt();
    if (pix) {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(enraged ? pix.warden_rage : pix.warden, -size / 2, -size, size, size);
    } else {
      this.drawWardenBody(size, enraged, sec);
    }
    if (flags & GUARD_FLAG.HURT && Math.floor(sec * 20) % 2 === 0) {
      // A white flash when hit.
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.55;
      if (pix) ctx.drawImage(enraged ? pix.warden_rage : pix.warden, -size / 2, -size, size, size);
      else this.drawWardenBody(size, enraged, sec);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.restore();
    if (flags & GUARD_FLAG.SKIN) {
      // Stone skin: a grey shell with runes turning round it.
      ctx.strokeStyle = `rgba(200,206,220,${0.7 + 0.2 * Math.sin(sec * 8)})`;
      ctx.lineWidth = Math.max(2, T * 0.08);
      ctx.setLineDash([T * 0.18, T * 0.1]);
      ctx.lineDashOffset = sec * T;
      ctx.beginPath();
      ctx.arc(px, py - T * 0.25, T * 0.95, 0, 6.2832);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(170,178,195,0.18)';
      ctx.fill();
    }
    // Health: a segment per hit point, with its name over it.
    const bw = T * 1.5, bh = Math.max(4, T * 0.12), bx = px - bw / 2, by = py - T * 1.35 - rear;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(bx - 2, by - 2, bw + 4, bh + 4);
    const seg = bw / max;
    for (let i = 0; i < max; i++) {
      ctx.fillStyle = i < hp ? (enraged ? '#ff4a2a' : '#ffcf4a') : 'rgba(255,255,255,0.12)';
      ctx.fillRect(bx + i * seg + 1, by, seg - 2, bh);
    }
    ctx.font = `800 ${Math.max(10, Math.round(T * 0.24))}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.fillStyle = '#000';
    ctx.fillText(t('wardenName'), px + 1, by - T * 0.08 + 1);
    ctx.fillStyle = enraged ? '#ff8a6a' : '#ffd25a';
    ctx.fillText(t('wardenName'), px, by - T * 0.08);
    ctx.textAlign = 'left';
  }

  /** The classic-style Warden, feet at the origin, facing the viewer. */
  private drawWardenBody(size: number, enraged: boolean, sec: number) {
    const { ctx } = this.s;
    const u = size / 16;
    const glow = enraged ? '#ff3a1a' : '#ffd25a';
    const stone = ctx.createLinearGradient(-8 * u, -15 * u, 6 * u, 0);
    stone.addColorStop(0, '#b4bac4');
    stone.addColorStop(0.5, '#6b717d');
    stone.addColorStop(1, '#353842');
    ctx.strokeStyle = '#16171d';
    ctx.lineWidth = Math.max(1.5, u * 0.7);
    // Legs.
    ctx.fillStyle = '#4d515c';
    for (const lx of [-4.5, 1.5]) {
      ctx.fillRect(lx * u, -4 * u, 3 * u, 4 * u);
      ctx.strokeRect(lx * u, -4 * u, 3 * u, 4 * u);
    }
    // Body.
    ctx.fillStyle = stone;
    ctx.beginPath();
    ctx.roundRect(-6 * u, -13 * u, 12 * u, 10 * u, 2.2 * u);
    ctx.fill();
    ctx.stroke();
    // Fists.
    for (const fx of [-8.5, 5.5]) {
      ctx.beginPath();
      ctx.roundRect(fx * u, -9 * u, 3 * u, 5 * u, 1.2 * u);
      ctx.fill();
      ctx.stroke();
    }
    // Crown.
    ctx.fillStyle = '#e8a62c';
    ctx.beginPath();
    ctx.moveTo(-5 * u, -12.5 * u);
    for (let k = 0; k <= 4; k++) {
      const x = -5 * u + k * 2.5 * u;
      ctx.lineTo(x, -15.5 * u);
      ctx.lineTo(x + 1.25 * u, -13.5 * u);
    }
    ctx.lineTo(5 * u, -12.5 * u);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#6a4206';
    ctx.stroke();
    // Visor and eyes.
    ctx.fillStyle = '#16171d';
    ctx.fillRect(-4 * u, -11 * u, 8 * u, 1.6 * u);
    ctx.fillStyle = glow;
    ctx.shadowColor = glow;
    ctx.shadowBlur = u * 3;
    ctx.fillRect(-3 * u, -10.8 * u, 2 * u, 1.2 * u);
    ctx.fillRect(1 * u, -10.8 * u, 2 * u, 1.2 * u);
    // The chest rune.
    const r = 1.6 * u * (1 + 0.1 * Math.sin(sec * 6));
    ctx.beginPath();
    ctx.moveTo(0, -8 * u - r);
    ctx.lineTo(r, -8 * u);
    ctx.lineTo(0, -8 * u + r);
    ctx.lineTo(-r, -8 * u);
    ctx.closePath();
    ctx.fill();
    ctx.shadowBlur = 0;
    if (enraged) {
      ctx.strokeStyle = glow;
      ctx.lineWidth = Math.max(1, u * 0.5);
      ctx.beginPath();
      ctx.moveTo(-5 * u, -10 * u);
      ctx.lineTo(-3.5 * u, -7 * u);
      ctx.lineTo(-4.5 * u, -5 * u);
      ctx.moveTo(4.5 * u, -6 * u);
      ctx.lineTo(3 * u, -4.5 * u);
      ctx.stroke();
    }
  }
}
