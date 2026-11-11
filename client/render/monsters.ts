// The monsters of the Dungeon arena: slimes, skeletons and bats sliding
// cell to cell, rising out of the ground, flashing when hit, with their
// health over the sturdy ones.

import { P_DEBRIS } from '../particles.js';
import { MONSTER_FLAG, MONSTER_KIND } from '../protocol.js';
import { C_DUST } from './constants.js';
import type { Stage } from './stage.js';

export class MonsterLayer {
  constructor(private readonly s: Stage) {}

  drawMonsters(camX: number, camY: number, T: number, sec: number, W: number, H: number) {
    const snap = this.s.wormSnap;
    const list = snap?.x.monsters;
    if (!snap || !list?.length) return;
    const { ctx } = this.s;
    const elapsed = this.s.wormTime - snap.k;
    const pix = this.s.pixelArt();
    ctx.imageSmoothingEnabled = !pix;
    for (const [id, kind, flags, cx, cy, fx, fy, step, since, hp, maxHp] of list) {
      if (kind < 1 || kind > 3) continue; // a kind this client doesn't know
      const prog = Math.min(1, Math.max(0, (since + elapsed) / Math.max(1, step)));
      const rising = (flags & MONSTER_FLAG.RISING) !== 0;
      const ease = rising ? 1 : prog * prog * (3 - 2 * prog);
      const x = fx + (cx - fx) * ease + 0.5, y = fy + (cy - fy) * ease + 0.5;
      const px = x * T - camX, py = y * T - camY;
      if (px < -T * 2 || py < -T * 2 || px > W + T * 2 || py > H + T * 2) continue;
      const bat = kind === MONSTER_KIND.BAT;
      const moving = !rising && prog < 1 && (cx !== fx || cy !== fy);
      // Animation: slimes squash as they hop, skeletons stride, bats flap.
      const frame = bat ? Math.floor(sec * 9 + id) % 2 : moving ? (prog < 0.5 ? 1 : 0) : Math.floor(sec * 1.5 + id * 0.37) % 2 === 0 && kind === MONSTER_KIND.SLIME ? 1 : 0;
      const hop = kind === MONSTER_KIND.SLIME && moving ? Math.sin(prog * Math.PI) * T * 0.22 : 0;
      const hover = bat ? T * (0.28 + 0.06 * Math.sin(sec * 5 + id)) : 0;
      const size = T * (kind === MONSTER_KIND.SKELETON ? 1.12 : 1.0);
      const flip = fx > cx ? -1 : 1;

      if (flags & MONSTER_FLAG.CHASING) {
        // A faint red glow under a hunting monster.
        ctx.fillStyle = `rgba(255,40,40,${0.12 + 0.06 * Math.sin(sec * 8 + id)})`;
        ctx.beginPath();
        ctx.ellipse(px, py + T * 0.32, T * 0.48, T * 0.17, 0, 0, 6.2832);
        ctx.fill();
      }

      ctx.save();
      if (rising) {
        // Climbing out of the ground: a dirt mound, the monster pushing up
        // through it (cut off at the floor), and a ring that closes as it gets ready.
        const k = prog;
        ctx.fillStyle = 'rgba(40,26,18,0.85)';
        ctx.beginPath();
        ctx.ellipse(px, py + T * 0.3, T * 0.42, T * 0.16, 0, 0, 6.2832);
        ctx.fill();
        ctx.strokeStyle = `rgba(255,90,70,${0.35 + 0.4 * k})`;
        ctx.lineWidth = Math.max(1.5, T * 0.05);
        ctx.beginPath();
        ctx.arc(px, py, T * (0.8 - 0.3 * k), 0, 6.2832);
        ctx.stroke();
        if (Math.random() < 0.15) this.s.particles.burst(P_DEBRIS, x, y + 0.3, 2, 1.2, 0.5, 0.1, C_DUST, 1);
        ctx.beginPath();
        ctx.rect(px - T, py - T * 2, T * 2, T * 2.32);
        ctx.clip();
        ctx.translate(px, py + T * 0.5 + (1 - k) * size * 0.85);
      } else {
        ctx.translate(px, py + T * 0.5 - hop - hover);
      }
      ctx.scale(flip, 1);
      const img = pix ? pix.monsters[kind - 1][frame] : null;
      if (img) ctx.drawImage(img, -size / 2, -size, size, size);
      else this.drawClassic(kind, frame, size, sec);
      if (flags & MONSTER_FLAG.HURT && Math.floor(sec * 20) % 2 === 0) {
        // A white flash when hit.
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.6;
        if (img) ctx.drawImage(img, -size / 2, -size, size, size);
        else this.drawClassic(kind, frame, size, sec);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      }
      ctx.restore();
      if (bat && !rising) {
        // A hovering bat's shadow stays on the floor.
        ctx.fillStyle = 'rgba(10,6,20,0.3)';
        ctx.beginPath();
        ctx.ellipse(px, py + T * 0.38, T * 0.22, T * 0.08, 0, 0, 6.2832);
        ctx.fill();
      }
      if (maxHp > 1 && !rising) {
        // A pip per hit point over the sturdy ones.
        const pw = T * 0.16, gap = T * 0.06, total = maxHp * pw + (maxHp - 1) * gap;
        const bx = px - total / 2, by = py - size + T * 0.35 - hover;
        for (let i = 0; i < maxHp; i++) {
          ctx.fillStyle = 'rgba(0,0,0,0.6)';
          ctx.fillRect(bx + i * (pw + gap) - 1, by - 1, pw + 2, pw * 0.6 + 2);
          ctx.fillStyle = i < hp ? '#ff5a4a' : 'rgba(255,255,255,0.15)';
          ctx.fillRect(bx + i * (pw + gap), by, pw, pw * 0.6);
        }
      }
    }
    ctx.imageSmoothingEnabled = true;
  }

  /** A classic-style (vector) monster, feet at the origin, facing right. */
  private drawClassic(kind: number, frame: number, size: number, sec: number) {
    const { ctx } = this.s;
    const u = size / 16;
    ctx.lineWidth = Math.max(1.5, u * 0.8);
    if (kind === MONSTER_KIND.SLIME) {
      const [rx, ry] = frame ? [7.2 * u, 4.6 * u] : [6.2 * u, 5.8 * u];
      const g = ctx.createRadialGradient(-2 * u, -ry * 1.1, u, 0, -ry * 0.5, rx * 1.3);
      g.addColorStop(0, '#c8ff8a');
      g.addColorStop(0.5, '#58bd44');
      g.addColorStop(1, '#1f6e35');
      ctx.fillStyle = g;
      ctx.strokeStyle = '#0d2a1c';
      ctx.beginPath();
      ctx.ellipse(0, -2 * u, rx, ry, 0, Math.PI, 0);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#0a140e';
      for (const ex of [-1.5, 1.5]) ctx.fillRect(ex * u - u * 0.6, -2 * u - ry * 0.55, u * 1.2, u * 2);
    } else if (kind === MONSTER_KIND.SKELETON) {
      ctx.strokeStyle = '#1a1820';
      ctx.fillStyle = '#ece6d2';
      // Legs and arms.
      ctx.beginPath();
      const stride = frame ? 2.4 : 1.2;
      ctx.moveTo(-stride * u, 0); ctx.lineTo(0, -4 * u); ctx.lineTo(stride * u, 0);
      ctx.moveTo(-4 * u, -4.5 * u); ctx.lineTo(-3 * u, -8 * u); ctx.lineTo(3 * u, -8 * u); ctx.lineTo(4 * u, -4.5 * u);
      ctx.strokeStyle = '#ece6d2';
      ctx.lineWidth = Math.max(2, u * 1.4);
      ctx.stroke();
      // Ribcage.
      ctx.lineWidth = Math.max(1.5, u * 0.8);
      ctx.strokeStyle = '#1a1820';
      ctx.beginPath();
      ctx.roundRect(-2.5 * u, -9 * u, 5 * u, 5 * u, u);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      for (const ry of [-7.5, -6]) { ctx.moveTo(-2.5 * u, ry * u); ctx.lineTo(2.5 * u, ry * u); }
      ctx.stroke();
      // Skull and burning eyes.
      ctx.beginPath();
      ctx.arc(0, -12 * u, 3.6 * u, 0, 6.2832);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#141218';
      ctx.fillRect(-2.4 * u, -13 * u, 1.8 * u, 1.8 * u);
      ctx.fillRect(0.6 * u, -13 * u, 1.8 * u, 1.8 * u);
      ctx.fillStyle = `rgba(255,74,58,${0.7 + 0.3 * Math.sin(sec * 6)})`;
      ctx.fillRect(-1.9 * u, -12.5 * u, 0.8 * u, 0.8 * u);
      ctx.fillRect(1.1 * u, -12.5 * u, 0.8 * u, 0.8 * u);
    } else {
      const lift = frame ? 3 : -3;
      ctx.fillStyle = '#3a2a55';
      ctx.strokeStyle = '#120c1c';
      for (const side of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(side * 1.5 * u, -8 * u);
        ctx.lineTo(side * 7.8 * u, (-8 + lift - 4) * u);
        ctx.lineTo(side * 6 * u, (-8 + lift) * u);
        ctx.lineTo(side * 4 * u, (-7 + lift * 0.6) * u);
        ctx.lineTo(side * 1.5 * u, -5 * u);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
      ctx.fillStyle = '#56407a';
      ctx.beginPath();
      ctx.ellipse(0, -7 * u, 2.4 * u, 3 * u, 0, 0, 6.2832);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#ff5a4a';
      ctx.fillRect(-1.3 * u, -8 * u, u, u);
      ctx.fillRect(0.3 * u, -8 * u, u, u);
    }
  }
}
