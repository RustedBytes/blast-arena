// Small drawing helpers shared by the render layers.

/** A small five-pointed star. */
export function star(ctx: CanvasRenderingContext2D, x: number, y: number, r: number) {
  ctx.beginPath();
  for (let k = 0; k < 10; k++) {
    const a = -Math.PI / 2 + k * Math.PI / 5, rr = k % 2 ? r * 0.45 : r;
    if (k === 0) ctx.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr); else ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.closePath();
  ctx.fill();
}

/** A waving flag on a pole whose foot is at (x, y), `h` tall. */
export function drawFlag(ctx: CanvasRenderingContext2D, x: number, y: number, h: number, color: string, sec: number) {
  ctx.strokeStyle = '#d8d8d8';
  ctx.lineWidth = Math.max(2, h * 0.06);
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x, y - h);
  ctx.stroke();
  const w = h * 0.55, fh = h * 0.36, top = y - h;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, top);
  for (let k = 0; k <= 6; k++) {
    const fx = x + (w * k) / 6;
    ctx.lineTo(fx, top + Math.sin(sec * 8 + k) * h * 0.04 * (k / 6));
  }
  for (let k = 6; k >= 0; k--) {
    const fx = x + (w * k) / 6;
    ctx.lineTo(fx, top + fh + Math.sin(sec * 8 + k) * h * 0.04 * (k / 6));
  }
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.lineWidth = 1;
  ctx.stroke();
}

/** A builder's wall: a stack of orange bricks with mortar lines. */
export function paintBuiltWall(g: CanvasRenderingContext2D, px: number, py: number, P: number, pixel: boolean) {
  g.fillStyle = '#7a3a18';
  g.fillRect(px, py, P, P);
  const rows = 4, h = P / rows;
  for (let r = 0; r < rows; r++) {
    const off = r % 2 ? P / 4 : 0;
    for (let k = -1; k < 2; k++) {
      const x0 = px + off + k * (P / 2), y0 = py + r * h;
      const x1 = Math.max(px, x0 + 2), x2 = Math.min(px + P, x0 + P / 2 - 2);
      if (x2 <= x1) continue;
      g.fillStyle = (r + k) % 2 ? '#d9824a' : '#c46d36';
      g.fillRect(x1, y0 + 2, x2 - x1, h - 4);
      if (!pixel) {
        g.fillStyle = 'rgba(255,255,255,0.18)';
        g.fillRect(x1, y0 + 2, x2 - x1, 3);
      }
    }
  }
  g.strokeStyle = '#4a2008';
  g.lineWidth = 3;
  g.strokeRect(px + 1.5, py + 1.5, P - 3, P - 3);
}

/** Pink goo dripping off a sticky bomb. */
export function drawGoo(ctx: CanvasRenderingContext2D, px: number, py: number, size: number, sec: number) {
  ctx.strokeStyle = '#ff7ad9';
  ctx.lineWidth = size * 0.07;
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (let k = 0; k < 3; k++) {
    const x = px + (k - 1) * size * 0.22;
    const len = size * (0.14 + 0.06 * Math.sin(sec * 3 + k * 2));
    ctx.moveTo(x, py + size * 0.32);
    ctx.lineTo(x, py + size * 0.32 + len);
  }
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(px - size * 0.03, py + size * 0.09, size * 0.34, Math.PI * 1.1, Math.PI * 1.9);
  ctx.stroke();
  ctx.lineCap = 'butt';
}

export function clampCam(cam: number, worldPx: number, viewPx: number) {
  if (worldPx <= viewPx) return (worldPx - viewPx) / 2;
  return Math.max(0, Math.min(worldPx - viewPx, cam));
}

export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
