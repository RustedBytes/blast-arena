// Small pixel sprites that used to be smooth strokes: goo, gas, portals,
// halos, drones, flags, dizzy stars, a hill crown and chunky nuke puffs.

import { fill, groundShadow, layer, N, Pix, sdBox, sdCircle, sdEllipse, shape, STEEL, UP } from '../pixelkit.js';

const PINK = ['#6a1848', '#c43a8a', '#ff7ad9', '#ffc0ee'];
const GAS = ['#1a3a08cc', '#3a7a18cc', '#6fb02fe0', '#c8ff8acc'];
const FROST = ['#0a3048aa', '#3a90b8cc', '#b8f0ffee'];

/** Drips under a sticky bomb. `frame` 0 is short, 1 hangs longer. */
export function goo(frame: number): Pix {
  const p = new Pix();
  const len = 5 + frame * 3;
  for (const x of [10, 16, 22]) {
    for (let k = 0; k < len; k++) p.set(x, 20 + k, k === len - 1 ? PINK[3] : k < 2 ? PINK[1] : PINK[2]);
    p.set(x, 20 + len, PINK[3] + 'aa');
  }
  for (let x = 8; x <= 24; x++) {
    const sag = x > 12 && x < 20 ? 1 : 0;
    p.set(x, 18 + sag, PINK[1]);
    p.set(x, 19 + sag, PINK[2]);
  }
  return p;
}

/** One cell of a gas cloud. `frame` shifts the puff. */
export function gasPuff(frame: number): Pix {
  const p = new Pix();
  const ox = frame ? 2 : -1, oy = frame ? -1 : 2;
  fill(p, sdCircle(16 + ox, 16 + oy, 11), (x, y) => {
    const d = Math.hypot(x - 16 - ox, y - 16 - oy);
    return d < 5 ? GAS[3] : d < 8 ? GAS[2] : GAS[1];
  });
  fill(p, sdCircle(12, 13, 3), GAS[3]);
  return p;
}

/** A pale frost disc behind a freeze bomb. */
export function frostPuff(): Pix {
  const p = new Pix();
  fill(p, sdCircle(16, 16, 11), (x, y) => (Math.hypot(x - 16, y - 16) < 6 ? FROST[2] : FROST[1]));
  return p;
}

/** Portal colours, matching `PORTAL_COLORS` in the renderer. */
export const PORTAL_ART = ['#4ad0ff', '#ff9a3a', '#b07aff', '#4affc8', '#ff5ad0', '#ffe14a'];

/** A portal mouth in `color`, and a separate spiral that the renderer spins. */
export function portal(color: string): { ring: Pix; spiral: Pix } {
  const ring = new Pix();
  fill(ring, sdEllipse(16, 17, 10, 12), '#080a1ecc');
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const d = Math.hypot((x - 16) / 10, (y - 17) / 12);
      if (d > 0.82 && d < 1.05) ring.set(x, y, color);
      else if (d >= 1.05 && d < 1.18) ring.set(x, y, color + '88');
    }
  }
  const spiral = new Pix();
  for (let k = 0; k < 18; k++) {
    const a = k * 0.55, r = 11 * (1 - k / 20);
    spiral.set(Math.round(16 + Math.cos(a) * r), Math.round(17 + Math.sin(a) * r), color);
    spiral.set(Math.round(16 + Math.cos(a) * r) + 1, Math.round(17 + Math.sin(a) * r), color);
  }
  return { ring, spiral };
}

/** A white additive halo. Tinted to the item's rarity at draw time. */
export function halo(): Pix {
  const p = new Pix();
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const d = Math.hypot(x - 15.5, y - 15.5);
      if (d > 15) continue;
      const a = d < 3 ? 'ee' : d < 7 ? 'aa' : d < 11 ? '66' : '33';
      const cross = Math.abs(x - 16) <= 1 || Math.abs(y - 16) <= 1;
      if (cross || (Math.abs(x - 16) + Math.abs(y - 16)) % 3 === 0) p.set(x, y, '#ffffff' + a);
    }
  }
  return p;
}

/** A bomber drone. `team` colours the body; `frame` flips the rotors. */
export function drone(frame: number, team: string): Pix {
  const p = new Pix();
  groundShadow(p, 16, 26, 8, 2);
  const thin = frame ? 0.7 : 1.6;
  layer(p, (q) => {
    shape(q, sdBox(16, 14, 12, 0.7, 0), STEEL, { lo: 2, hi: 5, depth: 0.6 });
    for (const [cx, cy] of [[6, 8], [26, 8], [6, 20], [26, 20]] as const) {
      fill(q, sdEllipse(cx, cy, 3.2, thin), frame ? '#dce6ffaa' : '#dce6ff66');
    }
    shape(q, sdBox(16, 14, 3.2, 2.4, 1), [team, team, '#ffffff'], { lo: 0, hi: 2, depth: 1.5 });
    q.set(16, 13, frame ? '#ff4a3a' : '#7fff6a');
  });
  return p;
}

/** Flag pole, drawn under the cloth. */
export function flagPole(): Pix {
  const p = new Pix();
  for (let y = 4; y <= 28; y++) { p.set(8, y, '#a8a8a8'); p.set(9, y, '#f0f0f0'); }
  p.set(8, 28, '#606060');
  return p;
}

/** White flag cloth. `frame` is the wave. Tinted to the team colour. */
export function flagCloth(frame: number): Pix {
  const p = new Pix();
  for (let x = 0; x < 14; x++) {
    const wave = Math.round(Math.sin(x * 0.7 + frame * 1.4) * (x / 14) * 2);
    for (let y = 0; y < 8; y++) p.set(10 + x, 4 + y + wave, y === 0 || y === 7 ? '#ffffffcc' : '#ffffff');
  }
  return p;
}

/** A five-pixel dizzy star. */
export function dizzyStar(): Pix {
  const p = new Pix();
  const c = '#ffe680';
  for (const [x, y] of [[16, 12], [16, 13], [16, 14], [16, 15], [16, 16], [16, 17], [16, 18], [16, 19], [16, 20], [12, 16], [13, 16], [14, 16], [15, 16], [17, 16], [18, 16], [19, 16], [20, 16], [14, 14], [18, 14], [14, 18], [18, 18]] as const) p.set(x, y, c);
  p.set(16, 16, '#ffffff');
  return p;
}

/** A tiny crown for a king-of-the-hill square. */
export function crownMark(): Pix {
  const p = new Pix();
  const g = '#ffd34a', d = '#a86b00';
  for (let x = 10; x <= 22; x++) { p.set(x, 18, d); p.set(x, 17, g); }
  for (const x of [10, 16, 22]) for (let y = 10; y <= 17; y++) p.set(x, y, y < 13 ? '#fff1a8' : g);
  for (const x of [13, 19]) for (let y = 14; y <= 17; y++) p.set(x, y, g);
  p.set(16, 9, '#ffffff');
  return p;
}

/** A dried blood splat. */
export function bloodSplat(): Pix {
  const p = new Pix();
  for (const [x, y, c] of [[15, 16, '#b3121e'], [16, 16, '#b3121e'], [17, 16, '#6e0b12'], [16, 15, '#b3121e'], [14, 17, '#6e0b12'], [18, 15, '#b3121eaa'], [15, 18, '#6e0b12aa']] as const) p.set(x, y, c);
  return p;
}

const puff = (stops: readonly string[]): HTMLCanvasElement => {
  const p = new Pix();
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const d = Math.hypot(x - 15.5, y - 15.5) / 16;
      const i = Math.min(stops.length - 1, Math.floor(d * stops.length));
      if (d < 1) p.set(x, y, stops[i]);
    }
  }
  return p.canvas(UP);
};

/** Chunky stand-ins for the soft nuke cloud sprites. */
export function nukePuffs(): { fire: HTMLCanvasElement; smoke: HTMLCanvasElement; dark: HTMLCanvasElement; dust: HTMLCanvasElement } {
  return {
    fire: puff(['#fffbe6', '#fff08a', '#ffaa28', '#e6460a', '#a01e0088']),
    smoke: puff(['#968070', '#685850ee', '#463c3aaa', '#322c2c66']),
    dark: puff(['#463a36', '#302828cc', '#1e1a1a88']),
    dust: puff(['#b09678cc', '#8c7660aa', '#78645066']),
  };
}
