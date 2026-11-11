// The vault's Warden: a stone golem, calm or enraged.

import { bitmap, clamp, N, Pix, SHADOW } from '../pixelkit.js';

// ------------------------------------------------------------------ warden

const STONE = ['#16171d', '#2c2f38', '#454955', '#626774', '#838a97', '#aab1bc', '#d3d8de'];
const GOLD = ['#4a2e06', '#94600e', '#d69a26', '#ffd25a', '#fff1b0'];

/**
 * The vault's Warden, facing the viewer: a hulking stone golem with a gold
 * crown, a glowing rune on its chest and huge fists. Enraged, the rune and
 * eyes burn red and cracks glow through the stone.
 */
export function warden(rage: boolean): Pix {
  const p = new Pix();
  for (let y = 13; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (((x - 7.5) / 7.5) ** 2 + ((y - 14.5) / 1.5) ** 2 <= 1) p.set(x, y, SHADOW);
    }
  }
  const glow = rage ? ['#7a1206', '#ff3a1a', '#ffb08a'] : ['#6a4a06', '#ffd25a', '#fff6c8'];
  // Stone with light from the top left: k from the distance to the light.
  const stone = (x: number, y: number, cx: number, cy: number, r: number): string => {
    const lit = -((x - cx) * 0.6 + (y - cy) * 0.8) / r;
    return STONE[clamp(Math.round(3 + lit * 2.2), 1, 5)];
  };
  // Legs.
  for (let y = 12; y <= 14; y++) {
    for (const x0 of [4, 9]) {
      for (let x = x0; x < x0 + 3; x++) p.set(x, y, y === 14 ? STONE[0] : stone(x, y, 7.5, 9, 6));
    }
  }
  // Body: a rounded block.
  for (let y = 3; y <= 12; y++) {
    for (let x = 2; x <= 13; x++) {
      const corner = (x === 2 || x === 13) && (y === 3 || y === 12);
      if (corner) continue;
      const edge = x === 2 || x === 13 || y === 3 || y === 12;
      p.set(x, y, edge ? STONE[0] : stone(x, y, 7.5, 7.5, 6));
    }
  }
  // Fists.
  for (const [x0, side] of [[0, -1], [13, 1]]) {
    for (let y = 7; y <= 11; y++) {
      for (let x = x0; x < x0 + 3; x++) {
        const edge = x === x0 + (side < 0 ? 0 : 2) || y === 7 || y === 11;
        p.set(x, y, edge ? STONE[0] : stone(x, y, x0 + 1, 8, 3));
      }
    }
  }
  // Crown and brow band.
  for (let x = 3; x <= 12; x++) p.set(x, 3, GOLD[x < 7 ? 3 : 2]);
  for (const x of [3, 6, 9, 12]) {
    p.set(x, 2, GOLD[3]);
    p.set(x, 1, GOLD[x < 7 ? 4 : 3]);
  }
  p.set(7, 2, GOLD[2]);
  p.set(8, 2, GOLD[2]);
  // Eyes in a dark visor slit.
  for (let x = 4; x <= 11; x++) p.set(x, 5, STONE[0]);
  for (const x of [5, 6, 9, 10]) p.set(x, 5, glow[x === 5 || x === 9 ? 2 : 1]);
  // The chest rune.
  bitmap(p, [' a ', 'aba', ' a '], { a: glow[1], b: glow[2] }, 6, 8);
  p.set(7, 7, glow[0]);
  p.set(7, 11, glow[0]);
  // Cracks, glowing when enraged.
  const crack = rage ? glow[1] : STONE[1];
  for (const [x, y] of [[3, 6], [4, 7], [4, 8], [12, 9], [11, 10], [10, 11], [5, 11]]) p.set(x, y, crack);
  // Highlights on the shoulders.
  p.set(3, 4, STONE[6]);
  p.set(4, 4, STONE[5]);
  p.set(1, 8, STONE[5]);
  return p;
}
