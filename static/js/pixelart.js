// Pixel-art tile set: every tile is painted pixel by pixel onto a 16x16
// canvas and scaled up with smoothing off, so the pixels stay crisp. A
// seeded random generator keeps the art identical on every load.

const N = 16;

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Paints a 16x16 tile: `paint(px, rand)` with px(x, y, colour). */
function tile(seed, paint) {
  const c = document.createElement('canvas');
  c.width = c.height = N;
  const g = c.getContext('2d');
  const px = (x, y, color) => {
    if (x < 0 || y < 0 || x >= N || y >= N) return;
    g.fillStyle = color;
    g.fillRect(x, y, 1, 1);
  };
  paint(px, rng(seed), g);
  return c;
}

function fill(g, color) {
  g.fillStyle = color;
  g.fillRect(0, 0, N, N);
}

/** Scatters `count` single pixels of `color`. */
function speckle(px, rand, count, color) {
  for (let i = 0; i < count; i++) px(Math.floor(rand() * N), Math.floor(rand() * N), color);
}

function grass(seed) {
  return tile(seed, (px, rand, g) => {
    fill(g, '#5aa83c');
    speckle(px, rand, 22, '#6cbf48');
    // Little two-pixel blades.
    for (let i = 0; i < 7; i++) {
      const x = Math.floor(rand() * N), y = 1 + Math.floor(rand() * (N - 1));
      px(x, y, '#3f8a2a');
      px(x, y - 1, '#4f9a34');
    }
    if (rand() < 0.6) {
      const x = 2 + Math.floor(rand() * 12), y = 2 + Math.floor(rand() * 12);
      px(x, y, '#f4e36a');
      px(x + 1, y, '#ffffff');
    }
  });
}

function snow(seed) {
  return tile(seed, (px, rand, g) => {
    fill(g, '#eef4f8');
    for (let i = 0; i < 5; i++) {
      const x = Math.floor(rand() * 14), y = Math.floor(rand() * N);
      px(x, y, '#d6e2ea');
      px(x + 1, y, '#d6e2ea');
      px(x + 2, y, '#e2ebf1');
    }
    speckle(px, rand, 4, '#ffffff');
    speckle(px, rand, 3, '#b9cfdd');
  });
}

function sand(seed) {
  return tile(seed, (px, rand, g) => {
    fill(g, '#dcc08a');
    // Wind ripples.
    for (const row of [3, 9, 14]) {
      const phase = rand() * 6;
      for (let x = 0; x < N; x++) {
        const y = row + Math.round(Math.sin(x * 0.6 + phase));
        px(x, y, '#c9a96a');
        px(x, y - 1, '#ead3a4');
      }
    }
    speckle(px, rand, 4, '#b8955a');
  });
}

function ash(seed) {
  return tile(seed, (px, rand, g) => {
    fill(g, '#5a4a46');
    for (let i = 0; i < 4; i++) {
      const x = Math.floor(rand() * 13), y = Math.floor(rand() * 14);
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 3; dx++) px(x + dx, y + dy, '#6a5853');
      px(x, y + 2, '#4a3c39');
    }
    // A glowing crack.
    let x = 3 + Math.floor(rand() * 8), y = 2 + Math.floor(rand() * 5);
    for (let i = 0; i < 6; i++) {
      px(x, y, '#ff6a2a');
      if (i === 2) px(x, y, '#ffb02e');
      x += rand() < 0.5 ? 1 : 0;
      y += 1;
    }
    speckle(px, rand, 6, '#4a3c39');
  });
}

function pillar() {
  return tile(7, (px, rand) => {
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        let c = (x + y) % 2 ? '#b3bac3' : '#aab1ba';
        if (x === 0 || y === 0) c = '#f2f4f6';
        else if (x === 1 || y === 1) c = '#d9dde2';
        if (x === N - 1 || y === N - 1) c = '#3c4148';
        else if (x === N - 2 || y === N - 2) c = '#5f6670';
        px(x, y, c);
      }
    }
    // Cracks and pits.
    for (const [x, y] of [[4, 5], [5, 6], [6, 6], [7, 7], [10, 10], [11, 9], [5, 11]]) px(x, y, '#7b838d');
    px(6, 5, '#e6e9ec');
    speckle(px, rand, 3, '#9aa1aa');
  });
}

function crate(armored) {
  return tile(armored ? 13 : 11, (px) => {
    const wood = armored ? '#8a5426' : '#c98a4b';
    const grain = armored ? '#6b3e18' : '#a46a33';
    const brace = armored ? '#9aa3ad' : '#8a5426';
    const braceEdge = armored ? '#59606b' : '#6b3e18';
    const outline = armored ? '#1f2328' : '#5c3412';
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        let c = wood;
        if (y === 5 || y === 10) c = grain;
        if (y === 1 && x > 0 && x < N - 1) c = armored ? '#a0683a' : '#e2a868';
        if (x === 0 || y === 0 || x === N - 1 || y === N - 1) c = outline;
        px(x, y, c);
      }
    }
    // Diagonal braces, two pixels thick with a shaded edge.
    for (let i = 2; i < N - 2; i++) {
      px(i, i, brace);
      px(i + 1, i, brace);
      px(i, i + 1, braceEdge);
      px(N - 1 - i, i, brace);
      px(N - 2 - i, i, brace);
      px(N - 1 - i, i + 1, braceEdge);
    }
    const nail = armored ? '#c9ced6' : outline;
    for (const [x, y] of [[2, 2], [13, 2], [2, 13], [13, 13]]) px(x, y, nail);
    if (armored) {
      for (const [x, y] of [[7, 7], [8, 7], [7, 8], [8, 8]]) px(x, y, '#c9ced6');
      px(7, 7, '#ffffff');
      px(12, 11, '#ff6a2a');
    }
  });
}

function ice() {
  return tile(17, (px, rand) => {
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        let c = '#a9e4f5';
        if (x + y > 22 && (x + y) % 2) c = '#94d6ec';
        if (x === N - 1 || y === N - 1) c = '#7cc6e3';
        px(x, y, c);
      }
    }
    // Shine streaks.
    for (const k of [6, 9, 20]) {
      for (let x = 0; x < N; x++) {
        const y = k - x;
        if (y >= 0 && y < N && (x + k) % 5 !== 0) px(x, y, '#e8fbff');
      }
    }
    px(3, 2, '#ffffff');
    px(12, 11, '#ffffff');
    speckle(px, rand, 2, '#7cc6e3');
  });
}

/** A belt running left to right; the renderer rotates it and animates arrows. */
function conveyor() {
  return tile(19, (px) => {
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        let c = '#3b3f47';
        if (y < 2 || y > 13) c = '#cfb27a';
        else if (y === 2 || y === 13) c = '#9aa1ab';
        else if (x % 4 === 1) c = '#2b2e35';
        px(x, y, c);
      }
    }
    for (const x of [0, 7, 15]) {
      px(x, 2, '#5f6670');
      px(x, 13, '#5f6670');
    }
  });
}

function teleport() {
  const base = grass(23);
  return tile(23, (px, rand, g) => {
    g.drawImage(base, 0, 0);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const d = Math.hypot(x - 7.5, y - 7.5);
        let c = null;
        if (d < 1.6) c = '#ffffff';
        else if (d < 3.2) c = '#b98bff';
        else if (d < 5.2) c = (x + y) % 2 ? '#5b2fb8' : '#6a3ccc';
        else if (d < 6.2) c = '#3d4652';
        else if (d < 7.4) c = '#9aa1ab';
        if (c) px(x, y, c);
      }
    }
    for (const [x, y] of [[7, 1], [14, 7], [8, 14], [1, 8]]) px(x, y, '#6ff2ff');
  });
}

/** Builds the pixel-art versions of every map tile, keyed like the classic sprites. */
export function buildPixelTiles() {
  return {
    floor: grass(1),
    floor_b: grass(2),
    floor_c: grass(3),
    floor_snow: snow(4),
    floor_sand: sand(5),
    floor_ash: ash(6),
    pillar: pillar(),
    crate: crate(false),
    crate_armored: crate(true),
    ice: ice(),
    conveyor: conveyor(),
    teleport: teleport(),
  };
}
