// Little maps for the tutorial slides, drawn with the game's pixel art.

import { playerColors } from '../assets.js';
import type { Assets, SpriteName } from '../assets.js';
import { context2d } from '../dom.js';

/**
 * A scene: one string per row, one character per cell.
 * `.` floor, `#` pillar, `c` crate, `a` armored crate, `i` ice, `k` conveyor,
 * `t` teleporter, `b` bomb, `P` the player, `1`–`9` items (see `items`), and
 * fire: `x` centre, `h` / `v` horizontal / vertical arm, `L` `R` `U` `D` arm ends.
 */
export interface Scene {
  rows: readonly string[];
  items?: Readonly<Record<number, SpriteName>>;
  /** Arrows between cell centres: [x0, y0, x1, y1] in cells, 'arc' for a hop. */
  arrows?: readonly (readonly [number, number, number, number, 'arc'?])[];
}

/** CSS pixels per cell. */
const CELL = 40;
const BLOCKS: Readonly<Partial<Record<string, SpriteName>>> = {
  '#': 'pillar', c: 'crate', a: 'crate_armored', i: 'ice', k: 'conveyor', t: 'teleport', b: 'bomb',
};
/** Fire pieces: the sprite and its rotation (the art points right). */
const FIRE: Readonly<Partial<Record<string, readonly ['center' | 'arm' | 'end', number]>>> = {
  x: ['center', 0], h: ['arm', 0], v: ['arm', Math.PI / 2],
  R: ['end', 0], D: ['end', Math.PI / 2], L: ['end', Math.PI], U: ['end', -Math.PI / 2],
};

export const hasFire = (scene: Scene): boolean => scene.rows.some((r) => /[xhvLRUD]/.test(r));

/** A canvas showing the scene; `frame` picks the flicker frame of the fire. */
export function drawScene(canvas: HTMLCanvasElement, scene: Scene, assets: Assets, frame: number): void {
  const cols = Math.max(...scene.rows.map((r) => r.length)), rows = scene.rows.length;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = cols * CELL * dpr;
  canvas.height = rows * CELL * dpr;
  const g = context2d(canvas);
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.imageSmoothingEnabled = false;
  const sprite = (name: SpriteName): HTMLCanvasElement | null => {
    try {
      return assets.tile(name, 'pixel');
    } catch {
      return null; // classic art still loading: skip it this time
    }
  };
  const put = (img: CanvasImageSource | null, x: number, y: number, scale = 1): void => {
    if (!img) return;
    const s = CELL * scale, o = (CELL - s) / 2;
    g.drawImage(img, x * CELL + o, y * CELL + o, s, s);
  };
  const flames = assets.pixel.flames;

  scene.rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row.charAt(x);
      put(sprite(ch === 'i' ? 'floor_snow' : 'floor'), x, y);
      const block = BLOCKS[ch];
      if (block) put(sprite(block), x, y);
      const fire = FIRE[ch];
      if (fire) {
        const [part, angle] = fire;
        const img = flames[part][frame % flames[part].length];
        g.save();
        g.translate((x + 0.5) * CELL, (y + 0.5) * CELL);
        g.rotate(angle);
        g.drawImage(img, -CELL / 2, -CELL / 2, CELL, CELL);
        g.restore();
      }
      const kind = Number(ch);
      const itemSprite = kind ? scene.items?.[kind] : undefined;
      if (itemSprite) put(sprite(itemSprite), x, y, 0.8);
    }
  });

  // The player last, standing a little above the cell like in the game.
  scene.rows.forEach((row, y) => {
    const x = row.indexOf('P');
    if (x < 0) return;
    const img = assets.pixelPlayer(playerColors(1, 0, false), 'down', 0);
    g.drawImage(img, x * CELL, (y - 0.2) * CELL, CELL, CELL);
  });

  for (const [x0, y0, x1, y1, arc] of scene.arrows ?? []) drawArrow(g, x0, y0, x1, y1, arc === 'arc');
}

function drawArrow(g: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, arc: boolean): void {
  const ax = (x0 + 0.5) * CELL, ay = (y0 + 0.5) * CELL, bx = (x1 + 0.5) * CELL, by = (y1 + 0.5) * CELL;
  // Control point of a hop: above the middle.
  const cx = (ax + bx) / 2, cy = arc ? Math.min(ay, by) - CELL * 1.1 : (ay + by) / 2;
  g.save();
  g.lineCap = 'round';
  g.lineJoin = 'round';
  for (const [color, width] of [['rgba(0,0,0,0.6)', 7], ['#ffd34a', 3.5]] as const) {
    g.strokeStyle = color;
    g.lineWidth = width;
    g.beginPath();
    g.moveTo(ax, ay);
    g.quadraticCurveTo(cx, cy, bx, by);
    // The head points along the last stretch of the curve.
    const angle = Math.atan2(by - cy, bx - cx);
    const head = 9;
    g.moveTo(bx - head * Math.cos(angle - 0.5), by - head * Math.sin(angle - 0.5));
    g.lineTo(bx, by);
    g.lineTo(bx - head * Math.cos(angle + 0.5), by - head * Math.sin(angle + 0.5));
    g.stroke();
  }
  g.restore();
}

/** A single sprite as a square canvas (for icon grids). */
export function drawIcon(canvas: HTMLCanvasElement, name: SpriteName, assets: Assets): void {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = canvas.height = CELL * 1.2 * dpr;
  const g = context2d(canvas);
  g.imageSmoothingEnabled = false;
  try {
    g.drawImage(assets.tile(name, 'pixel'), 0, 0, canvas.width, canvas.height);
  } catch { /* classic art still loading */ }
}
