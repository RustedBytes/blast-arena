// Power-up tokens at 32x32: a bevelled, riveted token with a
// rarity-coloured frame and a lit glyph on an inset dark panel.

import {
  fill, layer, line, mix, N, Pix, sdBox, sdCapsule, sdCircle, sdCut, sdEllipse, sdPoly, sdRing, sdTaper, sdUnion, shadeOf, shape, STEEL,
} from '../pixelkit.js';
import type { Sdf } from '../pixelkit.js';
import { FUSE, IRON } from './bombs.js';

// ---------------------------------------------------------------- power-ups

// Token frame colours by rarity (dark, mid, light), matching the item halos.
type Rarity = 'common' | 'blue' | 'purple' | 'gold' | 'pink' | 'orange' | 'red' | 'lavender';
const FRAMES: Record<Rarity, readonly string[]> = {
  common: ['#5a6475', '#aeb9c9', '#f2f5fa'],
  blue: ['#1f5f9a', '#4aa3e0', '#a8dcff'],
  purple: ['#4b2a8c', '#8a5cf0', '#cdb8ff'],
  gold: ['#8a5a00', '#f2b11a', '#ffe58a'],
  pink: ['#8a2a78', '#ff7af0', '#ffc8f6'],
  orange: ['#8a3a00', '#ff9a2e', '#ffd09a'],
  red: ['#8c1f1a', '#ff5a4a', '#ffb0a0'],
  lavender: ['#4a3a8a', '#a898e8', '#e6deff'],
};
const PANEL = ['#0e1020', '#151a30', '#1c2240', '#252d52', '#303a66'];

// Glyph ramps, dark to light.
const FIRE = ['#5c140e', '#a8281a', '#e8541c', '#ff9a2e', '#ffd66b', '#fff4c2'];
const BLUE = ['#0f2a4a', '#1f5f9a', '#3a8fd6', '#7fd4ff', '#c8f0ff', '#ffffff'];
const RED = ['#3a0a0a', '#8c1f1a', '#c22e26', '#ff4a3a', '#ff8a7a', '#ffd0c4'];
const VIOLET = ['#1e0f40', '#3d2280', '#5b34b8', '#8a5cf0', '#cdb8ff', '#ffffff'];
const PINK = ['#3a0a34', '#8a2a78', '#c84ab0', '#ff7af0', '#ffc8f6', '#ffffff'];
const GOLD = ['#4a2a00', '#8a5a00', '#d69a1a', '#ffd34a', '#fff1a8', '#ffffff'];
const LILAC = ['#2a1f4a', '#5a4a90', '#a898d8', '#e8e0ff', '#ffffff'];
const CYAN = ['#0a3a4a', '#1a7a9a', '#3ad8ff', '#a8f4ff', '#ffffff'];
const GREEN = ['#0a3a14', '#147a2a', '#2bd94a', '#8af59a', '#e0ffe0'];
const LEATHER = ['#2a1408', '#5a3418', '#8a5428', '#b8783a', '#e0a860'];
const WOOD = ['#2e1712', '#5a321c', '#8a5428', '#b8783a'];

/**
 * Every power-up is the same family of object, a bevelled token with a
 * rarity-coloured frame and a bright glyph on a dark panel, so pickups are
 * recognisable at a glance and the glyph says which one.
 */
function token(frame: Rarity, glyph: (q: Pix) => void): Pix {
  const p = new Pix();
  const [dark, mid, light] = FRAMES[frame];
  const outer = sdBox(16, 16, 14, 14, 3.5), inner = sdBox(16, 16, 10.5, 10.5, 1.5);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const X = x + 0.5, Y = y + 0.5, o = outer(X, Y), i = inner(X, Y);
      if (o > 0) continue;
      let c: string;
      if (o > -1) c = '#0d0b18';
      else if (i > 0) {
        // The bevel: lit on the top and left, shaded bottom and right.
        const lit = x + y < N - 1 ? (x < y ? x : y) < 4 : false;
        const rim = o > -2;
        c = rim ? (lit ? light : shadeOf(dark, 0.3)) : i < 1 ? shadeOf(dark, 0.45) : lit ? mid : dark;
        if (x + y === N - 1 && i > 1 && !rim) c = mid;
      } else {
        // The panel, inset: shadowed under its top and left edges.
        const shadow = x < 7 || y < 7 ? (x === 6 || y === 6 ? 0 : 1) : 2;
        c = PANEL[Math.min(4, shadow + (y < 14 ? 2 : y < 21 ? 1 : 0))];
      }
      p.set(x, y, c);
    }
  }
  // Rivets in the frame corners, lit top left.
  for (const [x, y] of [[4, 4], [27, 4], [4, 27], [27, 27]]) {
    p.set(x, y, light); p.set(x + 1, y, mid); p.set(x, y + 1, mid); p.set(x + 1, y + 1, shadeOf(dark, 0.4));
  }
  p.set(3, 3, '#ffffff');
  // The glyph, outlined, over a faint glow of the rarity colour.
  const g = new Pix();
  glyph(g);
  for (let y = 7; y < 25; y++) {
    for (let x = 7; x < 25; x++) {
      if (!g.filled(x, y) && (g.filled(x - 2, y) || g.filled(x + 2, y) || g.filled(x, y - 2) || g.filled(x, y + 2))) p.set(x, y, mix(p.get(x, y), mid, 0.22));
    }
  }
  layer(p, glyph, 0.82, 0.78);
  return p;
}

const lit = (sdf: Sdf, ramp: readonly string[], depth = 2.5) => (q: Pix) => shape(q, sdf, ramp, { depth, spec: ramp[ramp.length - 1] });

function heartSdf(cx: number, cy: number, s: number): Sdf {
  return sdUnion(0.5, sdCircle(cx - 2.6 * s, cy - 1.5 * s, 3.4 * s), sdCircle(cx + 2.6 * s, cy - 1.5 * s, 3.4 * s),
    sdPoly([[cx - 5.9 * s, cy - 0.6 * s], [cx + 5.9 * s, cy - 0.6 * s], [cx, cy + 6.5 * s]]));
}

const BOLT: [number, number][] = [[18.5, 6.5], [10.5, 17], [15.5, 17], [12.5, 25.5], [21.5, 13.5], [16.5, 13.5], [19.5, 6.5]];

function snowflake(q: Pix, ramp: readonly string[], tip: string) {
  const c = 16;
  for (let k = 0; k < 6; k++) {
    const a = (k * Math.PI) / 3 - Math.PI / 2, ca = Math.cos(a), sa = Math.sin(a);
    shape(q, sdCapsule(c, c, c + ca * 8, c + sa * 8, 0.9), ramp, { depth: 1 });
    for (const s of [-1, 1]) {
      const bx = c + ca * 5, by = c + sa * 5, ba = a + s * 0.8;
      shape(q, sdCapsule(bx, by, bx + Math.cos(ba) * 3, by + Math.sin(ba) * 3, 0.7), ramp, { depth: 1 });
    }
    q.set(Math.round(c + ca * 8.5 - 0.5), Math.round(c + sa * 8.5 - 0.5), tip);
  }
  shape(q, sdCircle(c, c, 2.2), ramp, { depth: 2 });
}

function droneAt(q: Pix, cx: number, cy: number, s: number) {
  for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
    line(Math.round(cx), Math.round(cy), Math.round(cx + dx * 4 * s), Math.round(cy + dy * 4 * s), (x, y) => q.set(x, y, '#3a4050'));
    fill(q, sdEllipse(cx + dx * 4.5 * s, cy + dy * 4.5 * s, 2.6 * s, 0.9 * s), '#bfe6ffd0');
  }
  shape(q, sdBox(cx, cy, 2.4 * s, 2 * s, 1), GOLD, { depth: 1.5 });
  q.set(Math.round(cx - 0.5), Math.round(cy - 0.5), '#ff3a2a');
}

/** The power-up tokens, in the order of the protocol's item kinds (from 1). */
export function powerUps(): Pix[] {
  return [
    // Bomb: a little black bomb with a lit fuse.
    token('common', (q) => {
      shape(q, sdCircle(15, 18, 6.2), IRON, { lo: 2, hi: 6, depth: 4, spec: '#ffffff' });
      shape(q, sdBox(18.5, 11.5, 2.2, 1.5, 0.6), STEEL, { lo: 2, hi: 6, depth: 1 });
      line(19, 10, 21, 8, (x, y) => q.set(x, y, FUSE[1]));
      for (const [x, y, c] of [[22, 7, '#ffd34a'], [23, 6, '#fff9d6'], [22, 6, '#ff7a1a'], [23, 7, '#ff9a2e']] as const) q.set(x, y, c);
    }),
    // Range: a flame.
    token('common', (q) => {
      const outer = sdUnion(2.5, sdCircle(16, 19.5, 5.8), sdTaper(16, 18, 18, 6.5, 4.5, 0.4), sdTaper(12, 18, 10.5, 10, 2.6, 0.3));
      shape(q, outer, FIRE, { lo: 1, hi: 3, depth: 2 });
      shape(q, sdUnion(1.5, sdCircle(16, 20.5, 3.2), sdTaper(16, 19, 16.8, 12.5, 2.6, 0.3)), FIRE, { lo: 3, hi: 5, depth: 2 });
    }),
    // Speed: a lightning bolt.
    token('blue', lit(sdPoly(BOLT), BLUE, 2)),
    // Kick: a red boot with a white sole.
    token('blue', (q) => {
      shape(q, sdUnion(1.5, sdBox(13, 13, 3.2, 6, 1), sdBox(16.5, 20, 6.8, 3, 2.4)), RED, { depth: 3, spec: RED[5] });
      fill(q, sdBox(16.5, 23.5, 7.2, 1, 0.5), (x) => (x < 16 ? '#f4f1e8' : '#c8c2b0'));
      for (let x = 10; x <= 16; x++) q.set(x, 8, RED[4]);
    }),
    // Shield: a heater shield with a white chevron.
    token('purple', (q) => {
      const shield = sdUnion(2, sdBox(16, 11.5, 8, 4.5, 1), sdPoly([[8, 13], [24, 13], [16, 25.5]]));
      shape(q, shield, VIOLET, { lo: 1, hi: 4, depth: 3.5 });
      // A bright inner field and a bold white chevron.
      shape(q, (x, y) => shield(x, y) + 2, VIOLET, { lo: 2, hi: 3, depth: 3 });
      fill(q, sdPoly([[10.5, 10], [16, 14.5], [21.5, 10], [21.5, 14], [16, 19], [10.5, 14]]), (x, y) => (x + y < 27 ? '#ffffff' : VIOLET[4]));
      fill(q, sdPoly([[10.5, 14], [16, 19], [21.5, 14], [21.5, 15], [16, 20], [10.5, 15]]), VIOLET[1]);
    }),
    // Pierce: an arrow driven through a steel bar.
    token('purple', (q) => {
      shape(q, sdBox(13, 16, 1.6, 8.5, 0.6), STEEL, { lo: 2, hi: 6, depth: 1.5 });
      shape(q, sdBox(15, 16, 7, 1.2, 0.4), RED, { lo: 2, hi: 5, depth: 1 });
      shape(q, sdPoly([[19.5, 11.5], [25, 16], [19.5, 20.5]]), RED, { depth: 2, spec: RED[5] });
      for (const dy of [-2, 2]) line(7, 16 + dy, 9, 16, (x, y) => q.set(x, y, RED[4]));
    }),
    // Full fire: a starburst.
    token('gold', (q) => {
      const pts: [number, number][] = [];
      for (let k = 0; k < 16; k++) {
        const a = (k * Math.PI) / 8, r = k % 2 ? 4 : k % 4 ? 7.5 : 9.5;
        pts.push([16 + Math.cos(a) * r, 16 + Math.sin(a) * r]);
      }
      shape(q, sdPoly(pts), FIRE, { lo: 2, hi: 4, depth: 2 });
      shape(q, sdCircle(16, 16, 3.5), FIRE, { lo: 4, hi: 5, depth: 2 });
    }),
    // Mystery: a question mark.
    token('pink', (q) => {
      const hook = sdCut(sdRing(16, 12, 4.5, 1.7), sdPoly([[7, 12], [16, 12.5], [16, 20], [7, 20]]));
      shape(q, sdUnion(0.5, hook, sdCapsule(17.5, 15.5, 16, 18.5, 1.7)), PINK, { depth: 1.5, spec: '#ffffff' });
      shape(q, sdCircle(16, 23, 1.9), PINK, { depth: 1.5 });
    }),
    // Remote: a handset with a red button, sending a signal.
    token('blue', (q) => {
      shape(q, sdBox(13.5, 19.5, 4, 5.5, 1.5), STEEL, { lo: 1, hi: 5, depth: 2 });
      shape(q, sdCircle(13.5, 17, 1.8), RED, { depth: 1.2, spec: RED[5] });
      for (const x of [12, 15]) q.set(x, 21, STEEL[5]);
      line(11, 13, 11, 10, (x, y) => q.set(x, y, STEEL[4]));
      q.set(11, 9, '#ff6a5a');
      // Signal arcs, up and to the right of the aerial.
      const quarter = sdBox(20, 5, 8.5, 5);
      for (const r of [3, 5.5]) fill(q, (x, y) => Math.max(sdRing(11.5, 10, r, 0.75)(x, y), quarter(x, y)), r < 4 ? BLUE[4] : BLUE[3]);
    }),
    // Line bomb: three bombs in a row and an arrow.
    token('orange', (q) => {
      for (const x of [10, 16, 22]) {
        shape(q, sdCircle(x, 13.5, 2.8), IRON, { lo: 2, hi: 6, depth: 2, spec: '#ffffff' });
        q.set(x + 1, 10, '#ffd34a');
      }
      shape(q, sdBox(15, 21, 6.5, 0.9, 0), FIRE, { lo: 3, hi: 4, depth: 1 });
      shape(q, sdPoly([[20.5, 18], [25, 21], [20.5, 24]]), FIRE, { lo: 3, hi: 5, depth: 1.5 });
    }),
    // Punch: a red boxing glove.
    token('red', (q) => {
      shape(q, sdUnion(1.5, sdEllipse(17, 14, 6.5, 6), sdCircle(11.5, 15.5, 3)), RED, { depth: 4, spec: RED[5] });
      shape(q, sdBox(16, 22.5, 5, 2.2, 1), ['#4a4438', '#8a8270', '#c8c2b0', '#f4f1e8', '#ffffff'], { depth: 1.5 });
      line(13, 12, 15, 17, (x, y) => q.set(x, y, RED[1]));
    }),
    // Ghost: a friendly sheet ghost.
    token('lavender', (q) => {
      const body = sdUnion(0, sdCircle(16, 13, 6.5), sdBox(16, 19, 6.5, 5, 0));
      const hem = (x: number, y: number) => body(x, y) + (y > 21 ? (Math.sin(x * 1.6) + 1) * 1.6 : 0);
      shape(q, hem, LILAC, { depth: 4 });
      for (const ex of [13, 18]) fill(q, sdEllipse(ex + 0.5, 13.5, 1.2, 1.9), '#2a1f4a');
      q.set(13, 12, '#ffffff'); q.set(18, 12, '#ffffff');
      fill(q, sdEllipse(16, 18, 1.4, 1), '#2a1f4a');
    }),
    // Nuke: the radiation trefoil on a yellow disc.
    token('gold', (q) => {
      shape(q, sdCircle(16, 16, 8.5), GOLD, { lo: 2, hi: 4, depth: 3, spec: '#ffffff' });
      fill(q, (x, y) => {
        const dx = x - 16, dy = y - 16, d = Math.hypot(dx, dy);
        if (d < 1.6) return -1;
        if (d < 2.6 || d > 7) return 1;
        const a = (Math.atan2(dy, dx) * 180) / Math.PI + 360;
        return [270, 30, 150].some((c) => Math.abs(((a - c + 540) % 360) - 180) < 30) ? -1 : 1;
      }, '#1a1400');
    }),
    // Freeze: a snowflake.
    token('blue', (q) => snowflake(q, BLUE.slice(2), '#ffffff')),
    // Mine: a dark disc with a red light and spikes.
    token('orange', (q) => {
      for (const s of [-1, 1]) shape(q, sdPoly([[16 + s * 8, 19], [16 + s * 11, 17.5], [16 + s * 8, 16]]), STEEL, { lo: 2, hi: 5, depth: 1 });
      shape(q, sdEllipse(16, 18, 8.5, 4.5), IRON, { lo: 2, hi: 6, depth: 3 });
      shape(q, sdEllipse(16, 15.5, 2.6, 2), RED, { depth: 1.5, spec: '#ffffff' });
      for (const [x, y] of [[10, 9], [16, 8], [22, 9]]) { q.set(x, y, '#ffd34a'); q.set(x + (x < 16 ? 1 : x > 16 ? -1 : 0), y + 2, '#ffd34a90'); }
    }),
    // Rocket: a white rocket flying up and right on a flame.
    token('orange', (q) => {
      for (const s of [-1, 1]) shape(q, sdPoly([[13 + s * 0.5, 17.5 - s * 3.5], [10 + s * 3, 20 + s * 3], [10 - s * 1.5, 21.5 - s * 1.5]].map(([x, y]) => [x, y] as [number, number])), RED, { depth: 1.5 });
      shape(q, sdUnion(1, sdTaper(11.5, 20.5, 20, 12, 3.2, 2.6), sdTaper(20, 12, 23.5, 8.5, 2.6, 0.3)), ['#5a6070', '#9aa2b4', '#d8dde8', '#ffffff'], { depth: 2.5 });
      shape(q, sdCircle(17.5, 14.5, 1.5), BLUE, { lo: 2, hi: 5, depth: 1 });
      shape(q, sdTaper(10, 22, 6.5, 25.5, 2, 0.4), FIRE, { lo: 3, hi: 5, depth: 1.5 });
    }),
    // Swap: two arrows chasing each other round.
    token('purple', (q) => {
      const ring = sdRing(16, 16, 6.5, 1.3);
      fill(q, sdCut(ring, sdUnion(0, sdPoly([[16, 16], [27, 9], [27, 13]]), sdPoly([[16, 16], [5, 23], [5, 19]]))), (_x, y) => (y < 16 ? '#ffffff' : VIOLET[4]));
      fill(q, sdPoly([[19.5, 6], [25.5, 11.5], [18.5, 13]]), '#ffffff');
      fill(q, sdPoly([[12.5, 26], [6.5, 20.5], [13.5, 19]]), VIOLET[4]);
    }),
    // Stomp: a heavy boot with impact lines.
    token('gold', (q) => {
      shape(q, sdUnion(1.5, sdBox(13.5, 11.5, 3.5, 5.5, 1), sdBox(16.5, 18, 6.5, 2.8, 2.2)), LEATHER, { depth: 3, spec: LEATHER[4] });
      fill(q, sdBox(16.5, 21.5, 7, 1, 0.4), '#3a2010');
      for (const x of [8, 12, 16, 20, 24]) { q.set(x, 24, GOLD[4]); q.set(x + (x < 16 ? -1 : 1), 25, GOLD[3]); }
    }),
    // Drone.
    token('blue', (q) => droneAt(q, 16, 16, 1.6)),
    // Swarm: three small drones.
    token('pink', (q) => { droneAt(q, 11.5, 11.5, 0.9); droneAt(q, 20.5, 13, 0.9); droneAt(q, 14.5, 20.5, 0.9); }),
    // Heart: every lost heart back.
    token('red', (q) => {
      shape(q, heartSdf(16, 16.5, 1.2), RED, { depth: 4, spec: '#ffffff' });
      q.set(11, 12, '#ffffff'); q.set(12, 11, '#ffffff'); q.set(11, 13, RED[5]);
    }),
    // Plasma: a blaster grip and a glowing red orb.
    token('red', (q) => {
      shape(q, sdUnion(0.8, sdBox(13, 17.5, 5.5, 2, 0.8), sdBox(10, 21.5, 2, 3.5, 0.8)), STEEL, { lo: 1, hi: 5, depth: 1.5 });
      fill(q, sdCircle(20.5, 12, 5.2), '#ff3a3a50');
      shape(q, sdCircle(20.5, 12, 3.6), RED, { lo: 3, hi: 5, depth: 2.5, spec: '#ffffff' });
    }),
    // Cryo: an icy orb with a snowflake.
    token('blue', (q) => {
      fill(q, sdCircle(16, 16, 8.5), '#3ad8ff30');
      snowflake(q, CYAN.slice(1), '#ffffff');
    }),
    // Phase: a beam passing clean through a wooden crate.
    token('purple', (q) => {
      shape(q, sdBox(16, 16, 3.5, 7.5, 0.8), WOOD, { depth: 1.5 });
      for (let y = 10; y <= 22; y += 4) for (let x = 13; x <= 19; x++) q.set(x, y, WOOD[0]);
      fill(q, sdBox(16, 16, 9.5, 1.6, 1), (x, y) => (y === 16 ? '#ffffff' : x % 3 ? '#e6c8ff' : '#a64aff'));
    }),
    // Nova: three bolts fanning out from a star.
    token('gold', (q) => {
      for (const a of [-2.2, -Math.PI / 2, -0.94]) shape(q, sdTaper(16, 19, 16 + Math.cos(a) * 10, 19 + Math.sin(a) * 10, 1.4, 0.4), GOLD, { lo: 2, hi: 5, depth: 1 });
      const pts: [number, number][] = [];
      for (let k = 0; k < 8; k++) { const a = (k * Math.PI) / 4, r = k % 2 ? 1.8 : 4.6; pts.push([16 + Math.cos(a) * r, 19 + Math.sin(a) * r]); }
      shape(q, sdPoly(pts), GOLD, { lo: 3, hi: 5, depth: 1.5 });
    }),
    // Overdrive: double chevrons, rapid fire.
    token('blue', (q) => {
      for (const ox of [-4, 3]) shape(q, sdPoly([[10 + ox, 8], [17 + ox, 16], [10 + ox, 24], [13.5 + ox, 24], [20.5 + ox, 16], [13.5 + ox, 8]]), GREEN, { depth: 1.5, spec: '#ffffff' });
    }),
  ];
}
