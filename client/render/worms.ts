// The worms of the Worms arena: bodies sliding cell to cell, heads with
// jaws, and mounds while one burrows out.

import type { PixelSet } from '../assets.js';
import { P_DEBRIS, P_SMOKE } from '../particles.js';
import { WORM_FLAG } from '../protocol.js';
import { C_DUST } from './constants.js';
import type { Stage } from './stage.js';

export class WormLayer {
  /** Scratch points of a worm's body (reused every frame). */
  private readonly wormPts: number[] = [];

  constructor(private readonly s: Stage) {}

  /**
   * Worms: each segment slides from the cell behind it to its own over a
   * step (cells come head first, then the cell the tail left), tail to head
   * so the head is on top. Segments taper to a pointed tail, with an extra
   * smaller ball between neighbours so the body reads as one, a paler
   * saddle band a third of the way down, and a shadow underneath. The head
   * opens its jaws as it hunts and gapes when it lunges; a hunting worm
   * kicks up dirt. A worm still burrowing out is a dirt mound with the head
   * peeking out inside a warning ring that closes as it gets ready.
   */
  drawWorms(camX: number, camY: number, T: number, sec: number, W: number, H: number) {
    const s = this.s.wormSnap;
    const worms = s?.x.worms;
    if (!s || !worms?.length) return;
    const { ctx } = this.s;
    const pix = this.s.pixelArt();
    const pts = this.wormPts;
    for (const [id, flags, step, since, cells] of worms) {
      if (flags & WORM_FLAG.FAR) continue;
      const n = cells.length / 2 - 1; // segments; the last cell is the trail
      if (n < 1) continue;
      const hx = cells[0], hy = cells[1];
      if ((hx + 0.5) * T - camX < -T * 12 || (hy + 0.5) * T - camY < -T * 12 || hx * T - camX > W + T * 12 || hy * T - camY > H + T * 12) continue;
      const chasing = (flags & WORM_FLAG.CHASING) !== 0;
      const lunging = (flags & WORM_FLAG.LUNGE) !== 0;
      const lurking = (flags & WORM_FLAG.LURK) !== 0;
      // How far through its current step (or its emergence) the worm is.
      const prog = Math.min(1, Math.max(0, (since + this.s.wormTime - s.k) / Math.max(1, step)));
      if (flags & WORM_FLAG.EMERGING) {
        this.drawWormMound(hx, hy, camX, camY, T, sec, id, pix, prog);
        continue;
      }
      const ease = prog * prog * (3 - 2 * prog);
      pts.length = 0;
      for (let i = 0; i < n; i++) {
        const x0 = cells[2 * i + 2], y0 = cells[2 * i + 3], x1 = cells[2 * i], y1 = cells[2 * i + 1];
        let x = x0 + (x1 - x0) * ease + 0.5, y = y0 + (y1 - y0) * ease + 0.5;
        // A slither across the direction of travel; a lurking worm only breathes.
        const amp = lurking ? 0.02 : lunging ? 0.04 : 0.07;
        const wig = Math.sin(sec * (lunging ? 16 : chasing ? 11 : 7) - i * 1.2 + id) * amp;
        if (x1 !== x0) y += wig; else if (y1 !== y0) x += wig;
        pts.push(x, y);
      }
      // Facing: from the second cell to the head (or the last step's way).
      let dx = hx - cells[2], dy = hy - cells[3];
      if (dx === 0 && dy === 0 && n > 1) { dx = hx - cells[4]; dy = hy - cells[5]; }
      if (dx === 0 && dy === 0) dx = 1;
      const size = (i: number): number => T * (0.92 - 0.3 * (n > 1 ? i / (n - 1) : 0));
      const band = n >= 4 ? Math.round((n - 1) * 0.3) : -1;
      if (!pix) {
        // Shadows under the whole body first, then a red glow under a hunter's head.
        ctx.fillStyle = 'rgba(10,4,20,0.22)';
        for (let i = 0; i < n; i++) {
          const r = size(i) * 0.46;
          ctx.beginPath();
          ctx.ellipse(pts[2 * i] * T - camX, pts[2 * i + 1] * T - camY + r * 0.62, r, r * 0.38, 0, 0, 6.2832);
          ctx.fill();
        }
        if (chasing) {
          ctx.fillStyle = `rgba(255,60,60,${(lunging ? 0.3 : 0.16) + 0.1 * Math.sin(sec * 10)})`;
          ctx.beginPath();
          ctx.arc(pts[0] * T - camX, pts[1] * T - camY, T * (lunging ? 0.9 : 0.75), 0, 6.2832);
          ctx.fill();
        }
      }
      // A hunter churns up dirt behind its head.
      if (chasing && Math.random() < (lunging ? 0.5 : 0.18)) {
        this.s.particles.emit(P_SMOKE, pts[0] - dx * 0.35 + (Math.random() - 0.5) * 0.3, pts[1] - dy * 0.35 + 0.25,
          -dx * 0.4 + (Math.random() - 0.5) * 0.3, -0.3, 0.5, 0.09, C_DUST);
      }
      for (let i = n - 1; i >= 0; i--) {
        const px = pts[2 * i] * T - camX, py = pts[2 * i + 1] * T - camY;
        if (i < n - 1) {
          // A smaller ball halfway to the segment behind.
          const mx = (pts[2 * i] + pts[2 * i + 2]) / 2 * T - camX, my = (pts[2 * i + 1] + pts[2 * i + 3]) / 2 * T - camY;
          this.drawWormBall(mx, my, (size(i) + size(i + 1)) * 0.42, pix, i + 0.5, false);
        }
        if (i === 0) {
          const mode = lunging ? 2 : chasing ? 1 : 0;
          this.drawWormHead(px, py, size(0) * (lunging ? 1.2 : 1.12), dx, dy, mode, pix, sec);
        } else if (i === n - 1 && n > 2) {
          // The tail tip points away from the segment in front.
          this.drawWormTail(px, py, size(i) * 1.05, pts[2 * i] - pts[2 * i - 2], pts[2 * i + 1] - pts[2 * i - 1], pix);
        } else {
          this.drawWormBall(px, py, size(i) * (i === band ? 1.12 : 1), pix, i, i === band);
        }
      }
    }
  }

  private drawWormBall(px: number, py: number, size: number, pix: PixelSet | null, i: number, band: boolean) {
    const { ctx } = this.s;
    if (pix) {
      const img = band ? pix.worm_band : pix.worm_segment;
      ctx.drawImage(img, px - size / 2, py - size / 2, size, size);
      return;
    }
    const r = size / 2;
    const g = ctx.createRadialGradient(px - r * 0.35, py - r * 0.4, r * 0.1, px, py, r);
    if (band) {
      g.addColorStop(0, '#ffd8bf');
      g.addColorStop(0.55, '#e57c6c');
      g.addColorStop(1, '#6b2236');
    } else {
      g.addColorStop(0, '#ffb3a0');
      g.addColorStop(0.55, Math.floor(i) % 2 ? '#c94a66' : '#d9586f');
      g.addColorStop(1, '#5e1838');
    }
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(px, py, r, 0, 6.2832);
    ctx.fill();
    if (Number.isInteger(i)) {
      // A crisp rim and a ring of muscle across the segment.
      ctx.strokeStyle = 'rgba(46,8,28,0.55)';
      ctx.lineWidth = Math.max(1, r * 0.1);
      ctx.stroke();
      ctx.strokeStyle = band ? 'rgba(120,30,50,0.45)' : 'rgba(80,14,40,0.35)';
      ctx.beginPath();
      ctx.arc(px, py, r * 0.62, -2.4, -0.7);
      ctx.stroke();
    }
  }

  /** The pointed tail tip at (px, py), pointing along (dx, dy). */
  private drawWormTail(px: number, py: number, size: number, dx: number, dy: number, pix: PixelSet | null) {
    const { ctx } = this.s;
    const a = Math.atan2(dy, dx);
    if (pix) {
      // Pixel art turns in quarter turns only, so the grid stays square.
      const q = Math.round(a / (Math.PI / 2)) * (Math.PI / 2);
      ctx.setTransform(Math.cos(q), Math.sin(q), -Math.sin(q), Math.cos(q), px, py);
      ctx.drawImage(pix.worm_tail, -size * 0.35, -size / 2, size, size);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      return;
    }
    const r = size / 2;
    ctx.setTransform(Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), px, py);
    const g = ctx.createLinearGradient(0, -r, 0, r);
    g.addColorStop(0, '#f08a86');
    g.addColorStop(0.5, '#c94a66');
    g.addColorStop(1, '#5e1838');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(-r * 0.2, -r * 0.82);
    ctx.quadraticCurveTo(r * 0.9, -r * 0.45, r * 1.25, 0);
    ctx.quadraticCurveTo(r * 0.9, r * 0.45, -r * 0.2, r * 0.82);
    ctx.arc(-r * 0.2, 0, r * 0.82, Math.PI / 2, -Math.PI / 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(46,8,28,0.55)';
    ctx.lineWidth = Math.max(1, r * 0.1);
    ctx.stroke();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /** `mode`: 0 roaming, 1 hunting (red-eyed, jaws working), 2 lunging (jaws wide). */
  private drawWormHead(px: number, py: number, size: number, dx: number, dy: number, mode: number, pix: PixelSet | null, sec: number) {
    const { ctx } = this.s;
    const angry = mode > 0;
    // Turned to face the way it crawls; a left-facing head is mirrored, so
    // it never crawls upside down.
    const a = dx < 0 ? 0 : Math.atan2(dy, dx);
    const c = Math.cos(a), s = Math.sin(a), flip = dx < 0 ? -1 : 1;
    ctx.setTransform(c * flip, s * flip, -s, c, px, py);
    if (pix) {
      const img = mode === 2 ? pix.worm_head_lunge : angry ? pix.worm_head_angry : pix.worm_head;
      ctx.drawImage(img, -size / 2, -size / 2, size, size);
    } else {
      const r = size / 2;
      // Jaws: two pincers at the front, wider the hungrier it is.
      const open = mode === 2 ? 0.75 + 0.1 * Math.sin(sec * 30) : mode === 1 ? 0.35 + 0.2 * Math.abs(Math.sin(sec * 12)) : 0.18 + 0.1 * Math.abs(Math.sin(sec * 4));
      ctx.fillStyle = '#4a1024';
      ctx.strokeStyle = 'rgba(30,4,16,0.8)';
      ctx.lineWidth = Math.max(1, r * 0.08);
      for (const k of [-1, 1]) {
        const ang = k * open;
        ctx.save();
        ctx.rotate(ang);
        ctx.beginPath();
        ctx.moveTo(r * 0.45, -k * r * 0.18);
        ctx.quadraticCurveTo(r * 1.25, -k * r * 0.2, r * 1.2, k * r * 0.12);
        ctx.quadraticCurveTo(r * 0.95, 0, r * 0.45, k * r * 0.18);
        ctx.fill();
        ctx.stroke();
        ctx.restore();
      }
      const g = ctx.createRadialGradient(-r * 0.3, -r * 0.4, r * 0.1, 0, 0, r);
      g.addColorStop(0, '#ffc2ab');
      g.addColorStop(0.6, '#d0506a');
      g.addColorStop(1, '#5a1434');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, 6.2832);
      ctx.fill();
      ctx.stroke();
      // The mouth between the jaws, ringed with teeth.
      ctx.fillStyle = '#2a0410';
      ctx.beginPath();
      ctx.moveTo(r * 0.15, 0);
      ctx.arc(0, 0, r * 0.97, -open * 0.9, open * 0.9);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = '#f4ead2';
      const teeth = mode === 2 ? 5 : 3;
      for (let t = 0; t < teeth; t++) {
        const ta = -open * 0.8 + (t + 0.5) * (open * 1.6 / teeth);
        const tx = Math.cos(ta) * r * 0.95, ty = Math.sin(ta) * r * 0.95;
        ctx.beginPath();
        ctx.moveTo(tx, ty);
        ctx.lineTo(tx - Math.cos(ta) * r * 0.3 + Math.sin(ta) * r * 0.08, ty - Math.sin(ta) * r * 0.3 - Math.cos(ta) * r * 0.08);
        ctx.lineTo(tx - Math.cos(ta) * r * 0.3 - Math.sin(ta) * r * 0.08, ty - Math.sin(ta) * r * 0.3 + Math.cos(ta) * r * 0.08);
        ctx.fill();
      }
      // Eyes on top; hunting, they glow red under a frown.
      for (const [ex, ey] of [[0.12, -0.56], [0.48, -0.42]]) {
        if (angry) {
          ctx.fillStyle = `rgba(255,60,40,${0.35 + 0.2 * Math.sin(sec * 12)})`;
          ctx.beginPath();
          ctx.arc(ex * r, ey * r, r * 0.28, 0, 6.2832);
          ctx.fill();
        }
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(ex * r, ey * r, r * 0.17, 0, 6.2832);
        ctx.fill();
        ctx.fillStyle = angry ? '#ff2a1a' : '#1a0a14';
        ctx.beginPath();
        ctx.arc(ex * r + r * 0.06, ey * r + r * 0.02, r * 0.09, 0, 6.2832);
        ctx.fill();
        if (angry) {
          ctx.strokeStyle = '#2a0410';
          ctx.lineWidth = Math.max(1, r * 0.09);
          ctx.beginPath();
          ctx.moveTo(ex * r - r * 0.18, ey * r - r * 0.26);
          ctx.lineTo(ex * r + r * 0.2, ey * r - r * 0.12);
          ctx.stroke();
        }
      }
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  /**
   * A worm burrowing out: a trembling heap of dirt that grows and shakes
   * harder as it gets ready (`prog` 0..1), the head peeking up, inside a
   * red warning ring that closes in until it comes out.
   */
  private drawWormMound(x: number, y: number, camX: number, camY: number, T: number, sec: number, id: number, pix: PixelSet | null, prog = 0.5) {
    const { ctx } = this.s;
    const px = (x + 0.5) * T - camX, py = (y + 0.5) * T - camY;
    const shake = Math.sin(sec * 40 + id) * T * (0.015 + 0.035 * prog);
    // The warning ring: a cell and a half out, closing to the mound.
    const rr = T * (1.5 - 0.7 * prog);
    ctx.save();
    ctx.setLineDash([T * 0.16, T * 0.1]);
    ctx.lineDashOffset = -sec * T * 0.6;
    ctx.strokeStyle = `rgba(255,70,50,${0.6 + 0.3 * prog + 0.1 * Math.sin(sec * 14)})`;
    ctx.lineWidth = Math.max(2, T * 0.065);
    ctx.beginPath();
    ctx.arc(px, py, rr, 0, 6.2832);
    ctx.stroke();
    ctx.restore();
    // Cracks spreading out of the ground.
    ctx.strokeStyle = 'rgba(30,16,8,0.7)';
    ctx.lineWidth = Math.max(1, T * 0.035);
    ctx.beginPath();
    for (let k = 0; k < 5; k++) {
      const a = id * 1.7 + k * 1.2566;
      const len = T * (0.35 + 0.35 * prog);
      ctx.moveTo(px + Math.cos(a) * T * 0.3, py + Math.sin(a) * T * 0.2);
      ctx.lineTo(px + Math.cos(a + 0.2) * len, py + Math.sin(a + 0.2) * len * 0.7);
    }
    ctx.stroke();
    const grow = 0.8 + 0.3 * prog;
    if (pix) {
      ctx.drawImage(pix.worm_mound, px - T * 0.55 * grow + shake, py - T * 0.5 * grow, T * 1.1 * grow, T * 1.1 * grow);
    } else {
      ctx.fillStyle = '#6e4826';
      ctx.beginPath();
      ctx.ellipse(px + shake, py + T * 0.12, T * 0.48 * grow, T * 0.3 * grow, 0, 0, 6.2832);
      ctx.fill();
      ctx.fillStyle = '#94673a';
      ctx.beginPath();
      ctx.ellipse(px + shake - T * 0.1, py + T * 0.04, T * 0.26 * grow, T * 0.12 * grow, 0, 0, 6.2832);
      ctx.fill();
      ctx.fillStyle = '#1a0e08';
      ctx.beginPath();
      ctx.ellipse(px + shake, py + T * 0.08, T * 0.22, T * 0.1, 0, 0, 6.2832);
      ctx.fill();
    }
    // Clods of dirt thrown up, more as it gets ready.
    if (Math.random() < 0.08 + 0.3 * prog) {
      this.s.particles.emit(P_DEBRIS, x + 0.5 + (Math.random() - 0.5) * 0.5, y + 0.55, (Math.random() - 0.5) * 1.5, -1.5 - Math.random(), 0.5, 0.06, 6);
    }
    const peek = (0.3 + 0.7 * prog) * (0.6 + 0.4 * Math.sin(sec * 6 + id));
    ctx.globalAlpha = 0.85;
    this.drawWormHead(px + shake, py - T * 0.16 * peek, T * (0.45 + 0.15 * prog), 0, -1, prog > 0.7 ? 1 : 0, pix, sec);
    ctx.globalAlpha = 1;
  }
}
