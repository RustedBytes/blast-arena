// Pixel-art sprites: bombs, flames, scorch marks, power-ups, players and
// hats, drawn in code with the same rules as the tiles (pixelart.js):
// light from the top left, hue-shifted ramps, and a dark outline on
// everything you interact with so it pops off the quieter floor.
//
// Sprites are built at 16x16 and handed out as 4x canvases (see
// Pix.canvas), because they are drawn straight onto the game canvas.

import { N, Pix, SHADOW, STEEL, at, bitmap, clamp, cssColor, field, mix, rng } from './pixelkit.js';

const X4 = 4;

// Bomb iron: navy shadows, lilac highlights.
const IRON = ['#0b0a16', '#16162a', '#22233d', '#30344f', '#454c6b', '#6a7394', '#a9b3d1'];
const RED_IRON = ['#1a0a10', '#3a0f18', '#5c1420', '#82202a', '#ad3236', '#d9584e', '#ffb09a'];
const URANIUM = ['#1a1400', '#3a2e00', '#6b5600', '#a68600', '#d9b21a', '#ffd23f', '#fff2a8'];
const FIRE = ['#3a0a12', '#8c1a10', '#d63a12', '#ff7a1a', '#ffb532', '#ffe46b', '#fff9d6'];
const FUSE = ['#6b4a2a', '#c9a26b', '#e0bd84'];

// ------------------------------------------------------------------- bombs

/** A shaded sphere bomb with a cap, a fuse and a shadow on the ground. */
function bomb(ramp, spiked) {
  const p = new Pix();
  // Ground shadow first, so the body paints over it.
  for (let y = 12; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (((x - 7.5) / 5.5) ** 2 + ((y - 14) / 1.6) ** 2 <= 1) p.set(x, y, SHADOW);
    }
  }
  const cx = 7, cy = 9, r = 5.6;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy);
      if (d > r) continue;
      if (d > r - 1) { p.set(x, y, ramp[0]); continue; }
      // Lambert-ish shading towards the top-left light, with a cool rim on the far side.
      const lit = -(0.6 * dx + 0.8 * dy) / r;
      let k = clamp(Math.round(2.6 + lit * 2.4), 1, 5);
      if (d > r - 2 && dx + dy > 2) k = 2;
      p.set(x, y, ramp[k]);
    }
  }
  // Specular glint.
  p.set(4, 6, ramp[6]);
  p.set(5, 6, ramp[6]);
  p.set(4, 7, ramp[6]);
  p.set(4, 6, '#ffffff');
  // Metal cap and the fuse.
  bitmap(p, ['oxxo', 'oxyo'], { o: STEEL[1], x: STEEL[5], y: STEEL[3] }, 8, 3);
  bitmap(p, ['  b', ' a ', 'a  '], { a: FUSE[1], b: FUSE[2] }, 10, 0);
  if (spiked) {
    // Pierce bombs carry steel spikes.
    for (const [x, y] of [[0, 9], [1, 9], [13, 9], [14, 9], [2, 4], [3, 5], [12, 14], [11, 13]]) p.set(x, y, STEEL[5]);
    p.set(1, 9, STEEL[3]);
    p.set(13, 9, STEEL[3]);
  }
  return p;
}

/** The atomic bomb: a fat yellow bomb with a black radiation trefoil. */
function nukeBomb() {
  const p = bomb(URANIUM, false);
  const cx = 7, cy = 9;
  for (const [dx, dy] of [[0, 0], [-2, -2], [-1, -2], [-2, -1], [1, -2], [2, -2], [2, -1], [-1, 2], [0, 2], [1, 2]]) {
    p.set(cx + dx, cy + dy, URANIUM[0]);
  }
  return p;
}

/** Antenna and LED drawn over a remote bomb, in two blink states. */
function antenna(on) {
  const p = new Pix();
  if (on) for (const [x, y] of [[3, 0], [2, 1], [4, 1], [3, 2]]) p.set(x, y, '#4aa3e0b0');
  p.set(4, 2, STEEL[5]);
  p.set(5, 3, STEEL[4]);
  p.set(3, 1, on ? '#bff0ff' : '#2a4a6a');
  return p;
}

// ------------------------------------------------------------------- flames

/**
 * Fire banded by a distance metric `q`: hot white at the core, through
 * yellow and orange, to a dark red rim. Noise per frame makes it flicker.
 */
function fire(q) {
  const p = new Pix();
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const v = q(x, y);
      const k = v < 1.6 ? 6 : v < 2.8 ? 5 : v < 4 ? 4 : v < 5 ? 3 : v < 5.9 ? 2 : v < 6.6 ? 1 : -1;
      if (k >= 0) p.set(x, y, FIRE[k]);
    }
  }
  return p;
}

/** Three flicker frames each of the flame centre, arm and end. */
function flames() {
  const frames = { center: [], arm: [], end: [] };
  for (let f = 0; f < 3; f++) {
    const rand = rng(101 + f);
    const n = field(rand, [[4, 0.6], [8, 0.4]]);
    const wob = (x, y) => (at(n, x, y) - 0.5) * 1.8;
    // Seamless along the arm: whole sine waves per tile.
    const tongue = (x) => Math.sin((2 * Math.PI * 2 * x) / N + f * 2.1) * 0.9;
    const across = (y) => Math.abs(y - 7.5) * 1.75;
    frames.arm.push(fire((x, y) => across(y) + tongue(x) + wob(x, y)));
    // A round fireball that also opens into the four arms.
    frames.center.push(fire((x, y) => {
      const d = Math.hypot(x - 7.5, y - 7.5);
      return Math.min(d, 1.75 * Math.min(Math.abs(x - 7.5), Math.abs(y - 7.5)) + 0.6) + wob(x, y);
    }));
    // The end tapers to a rounded tip on the right (the renderer rotates it).
    frames.end.push(fire((x, y) => Math.hypot(Math.max(0, x - 6) * 1.4, across(y)) + tongue(x) * 0.6 + wob(x, y)));
  }
  return frames;
}

/** A soot splat with radiating streaks; transparent around it. */
function scorch() {
  const rand = rng(77), n = field(rand), p = new Pix();
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const d = Math.hypot(x - 7.5, y - 7.5) + (at(n, x, y) - 0.5) * 3;
      const odd = (x + y) % 2 === 0;
      if (d < 3.5) p.set(x, y, '#120c10e0');
      else if (d < 5) p.set(x, y, '#1e1416c0');
      else if (d < 6.2 && odd) p.set(x, y, '#2a1c1aa0');
      else if (d < 7.2 && odd && (x * 7 + y * 3) % 3 === 0) p.set(x, y, '#2a1c1a80');
    }
  }
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + rand() * 0.5;
    for (let r = 4; r < 7.5; r += 1) p.set(Math.round(7.5 + Math.cos(a) * r), Math.round(7.5 + Math.sin(a) * r), '#1a1214b0');
  }
  p.set(7, 7, '#ff7a1a90');
  p.set(9, 8, '#ffb53270');
  return p;
}

// ---------------------------------------------------------------- power-ups

// Token frame colours by rarity (dark, mid, light), matching the item halos.
const FRAMES = {
  common: ['#5a6475', '#aeb9c9', '#f2f5fa'],
  blue: ['#1f5f9a', '#4aa3e0', '#a8dcff'],
  purple: ['#4b2a8c', '#8a5cf0', '#cdb8ff'],
  gold: ['#8a5a00', '#f2b11a', '#ffe58a'],
  pink: ['#8a2a78', '#ff7af0', '#ffc8f6'],
  orange: ['#8a3a00', '#ff9a2e', '#ffd09a'],
  red: ['#8c1f1a', '#ff5a4a', '#ffb0a0'],
  lavender: ['#4a3a8a', '#a898e8', '#e6deff'],
};

/**
 * Every power-up is the same family of object, a bevelled token with a
 * rarity-coloured frame and a bright glyph on a dark panel, so pickups are
 * recognisable at a glance and the glyph says which one.
 */
function token(frame, glyph, colors) {
  const p = new Pix();
  const [dark, mid, light] = FRAMES[frame];
  for (let y = 1; y < N - 1; y++) {
    for (let x = 1; x < N - 1; x++) {
      const corner = (x === 1 || x === N - 2) && (y === 1 || y === N - 2);
      if (corner) continue;
      const edge = x === 1 || y === 1 || x === N - 2 || y === N - 2;
      const ring = x === 2 || y === 2 || x === N - 3 || y === N - 3;
      let c;
      if (edge) c = '#0d0b18';
      else if (ring) c = x === 2 || y === 2 ? light : x === N - 3 || y === N - 3 ? dark : mid;
      else c = y < 5 ? '#2c3252' : y > 10 ? '#151827' : '#1f2440';
      p.set(x, y, c);
    }
  }
  // A highlight corner on the frame.
  p.set(2, 2, '#ffffff');
  const w = Math.max(...glyph.map((r) => r.length)), h = glyph.length;
  bitmap(p, glyph, colors, Math.floor((N - w) / 2), Math.floor((N - h) / 2));
  return p;
}

const BOMB_GLYPH = [
  '       s  ',
  '      f s ',
  '     f    ',
  '   oxxo   ',
  '  o####o  ',
  ' o#+w###o ',
  ' o#+####o ',
  ' o#####-o ',
  ' o####--o ',
  '  oooooo  ',
];
const FLAME_GLYPH = [
  '    o     ',
  '   o#o    ',
  '   o#+o   ',
  '  o##+o o ',
  ' o-#++#o#o',
  ' o-#+w+##o',
  ' o-#+ww+#o',
  ' o--#++#-o',
  '  o--##-o ',
  '   oooooo ',
];

/** The 12 power-up tokens, indexed like the protocol's item kinds (1..12). */
function powerUps() {
  const flame = { o: '#5c140e', '#': '#ff7a1a', '+': '#ffd66b', w: '#fff4c2', '-': '#c2391b' };
  return [
    null,
    token('common', BOMB_GLYPH, { o: '#0b0a16', x: STEEL[5], '#': '#3a3f5c', '+': '#8a93b8', w: '#ffffff', '-': '#22233d', f: FUSE[2], s: '#ffd34a' }),
    token('common', FLAME_GLYPH, flame),
    token('blue', [
      '     oooo ',
      '    o++#o ',
      '   o+#-o  ',
      '  o+#-o   ',
      ' o+####oo ',
      ' oooo+#-o ',
      '    o+#o  ',
      '   o+-o   ',
      '  o+o     ',
      '  oo      ',
    ], { o: '#0f2a4a', '#': '#7fd4ff', '+': '#e6faff', '-': '#3a8fd6' }),
    token('blue', [
      '   oooo   ',
      '   o+#o   ',
      '   o+#o   ',
      '   o+#o   ',
      '   o+#ooo ',
      '  o+####o ',
      ' o+#####-o',
      ' o-######o',
      ' owwwwwwwo',
      '  ooooooo ',
    ], { o: '#2a1712', '#': '#d23a2f', '+': '#ff8a7a', '-': '#8c1f1a', w: '#f4f1e8' }),
    token('purple', [
      ' oooooooo ',
      ' o+w+##-o ',
      ' o+####-o ',
      ' o+#ww#-o ',
      ' o+#ww#-o ',
      ' o+####-o ',
      '  o+##-o  ',
      '  o+#--o  ',
      '   o--o   ',
      '    oo    ',
    ], { o: '#2a1650', '#': '#8a5cf0', '+': '#cdb8ff', '-': '#5b34b8', w: '#ffffff' }),
    token('purple', [
      '   hd     ',
      '   hd     ',
      '   hd  o  ',
      '   hd  #o ',
      '+++++++#+o',
      '-------##o',
      '   hd  #o ',
      '   hd  o  ',
      '   hd     ',
      '   hd     ',
    ], { o: '#5c1420', '#': '#ff5a5a', '+': '#ffc0b0', '-': '#d6403a', h: STEEL[5], d: STEEL[3] }),
    token('gold', [
      '    o    ',
      'o  o+o  o',
      ' o o+o o ',
      '  o+w+o  ',
      'oo+www+oo',
      '  o+w+o  ',
      ' o o+o o ',
      'o  o+o  o',
      '    o    ',
    ], { o: '#d63a12', '+': '#ffb532', w: '#fff9d6' }),
    token('pink', [
      '  oooooo  ',
      ' o++++##o ',
      ' o+oooo#o ',
      '  o   o#o ',
      '     o+#o ',
      '    o+#o  ',
      '    o#o   ',
      '    ooo   ',
      '    o+o   ',
      '    ooo   ',
    ], { o: '#4a1240', '#': '#ff7af0', '+': '#ffd6fa' }),
    token('blue', [
      '  o     s ',
      '  o   s  s',
      '  o  s s s',
      ' ooooo s s',
      ' o+++o  s ',
      ' o+rro    ',
      ' o+rro    ',
      ' o+##o    ',
      ' o###o    ',
      ' ooooo    ',
    ], { o: '#0f2a4a', '#': STEEL[3], '+': STEEL[5], r: '#ff4a3a', s: '#7fd4ff' }),
    token('orange', [
      '  s   s   s ',
      ' oo  oo  oo ',
      'o+#oo+#oo+#o',
      'o##oo##oo##o',
      ' oo  oo  oo ',
      '        a   ',
      ' aaaaaaaaaa ',
      '        a   ',
    ], { o: '#0b0a16', '#': '#5a6390', '+': '#c8d0f0', s: '#ffd34a', a: '#ffd09a' }),
    token('red', [
      '   ooooo  ',
      '  o++###o ',
      ' o+#o#o#o ',
      ' o+#####o ',
      'oo+#####o ',
      'o+o####-o ',
      'o+#####-o ',
      ' oo###--o ',
      '  owwwwo  ',
      '  oooooo  ',
    ], { o: '#3a0a0a', '#': '#ff4a3a', '+': '#ffb0a0', '-': '#b8241c', w: '#f4f1e8' }),
    token('lavender', [
      '   oooo   ',
      '  o++##o  ',
      ' o+####-o ',
      ' o#e##e-o ',
      ' o#e##e-o ',
      ' o#####-o ',
      ' o#####-o ',
      ' o######o ',
      ' o#o##o#o ',
      ' oo oo oo ',
    ], { o: '#3a2a6a', '#': '#e8e0ff', '+': '#ffffff', '-': '#a898d8', e: '#2a1f4a' }),
    // Atomic bomb: the radiation trefoil.
    token('gold', [
      '  oooooo  ',
      ' okkyykko ',
      'okkkyykkko',
      'okkyyyykko',
      'oyyykkyyyo',
      'oyyykkyyyo',
      'oyyyyyyyyo',
      ' oyykkyyo ',
      '  okkkko  ',
      '   oooo   ',
    ], { o: '#3a2a00', y: '#ffd23f', k: '#1a1400' }),
    // Freeze: a snowflake.
    token('blue', [
      '    w     ',
      ' w  w  w  ',
      '  w w w   ',
      '   www    ',
      'wwwwwwwww ',
      '   www    ',
      '  w w w   ',
      ' w  w  w  ',
      '    w     ',
      '          ',
    ], { w: '#e6faff' }),
    // Mine: a dark disc with a red light.
    token('orange', [
      '          ',
      '  y   y   ',
      '   y y    ',
      '   orro   ',
      ' oo#rr#oo ',
      'o########o',
      'o-######-o',
      ' oo----oo ',
      '   oooo   ',
      '          ',
    ], { o: '#16162a', '#': '#6a7394', '-': '#30344f', r: '#ff3a2a', y: '#ffd34a' }),
    // Rocket.
    token('orange', [
      '       rr ',
      '      r##r',
      '     ####r',
      '  r ####r ',
      '  r###### ',
      '   ####   ',
      '  f####   ',
      ' ff r r   ',
      'ff  r     ',
      'f         ',
    ], { r: '#d23a2f', '#': '#e8ecf4', f: '#ffb02e' }),
    // Swap: two arrows chasing each other.
    token('purple', [
      '   wwww   ',
      '  w    ww ',
      ' w     ww ',
      ' w    www ',
      '          ',
      '          ',
      ' www    w ',
      ' ww     w ',
      ' ww    w  ',
      '   wwww   ',
    ], { w: '#ffffff' }),
    // Stomp: a boot with impact lines.
    token('gold', [
      '  ###     ',
      '  ###     ',
      '  ###     ',
      '  #####   ',
      '  ######  ',
      '  ####### ',
      '  ooooooo ',
      '          ',
      'y  y  y  y',
      ' y  y  y  ',
    ], { '#': '#a86b3a', o: '#3a2010', y: '#ffe680' }),
    // Drone.
    token('blue', [
      'cc      cc',
      ' k      k ',
      '  k    k  ',
      '   yyyy   ',
      '   yrry   ',
      '   yyyy   ',
      '  k    k  ',
      ' k      k ',
      'cc  oo  cc',
      '    oo    ',
    ], { c: '#bfe6ff', k: '#2a2f3d', y: '#ffd34a', r: '#ff3a2a', o: '#16162a' }),
    // Swarm: three small drones.
    token('pink', [
      'c y c     ',
      ' yyy      ',
      '      c y ',
      '       yyy',
      '  c y c   ',
      '   yyy    ',
      '          ',
      ' o   o  o ',
      '          ',
      '          ',
    ], { c: '#bfe6ff', y: '#ffd34a', o: '#16162a' }),
  ];
}

// ------------------------------------------------------------------ players

// The bomber: a round helmet in the player's colour with a visor, a body
// in the same colour, a gold belt, white gloves and dark boots.
// Letters: w/W/h helmet light/mid/dark, b/B/d body, v visor, g glint,
// e eyes, k gloves, y belt, s boots, o outline, p/q/r backpack.
const HEAD_DOWN = [
  '      oooo      ',
  '    oowwWWoo    ',
  '   owwWWWWWWo   ',
  '   owWWWWWWho   ',
  '  owWvvvvvvWho  ',
  '  owvgevvevvho  ',
  '  owvvevvevvho  ',
  '  ohWvvvvvvhho  ',
  '   ohhWWWhhho   ',
];
const HEAD_UP = [
  '      oooo      ',
  '    oowwWWoo    ',
  '   owwWWWWWWo   ',
  '   owWWWWWWho   ',
  '  owWWWWWWWWho  ',
  '  owWWWWWWWhho  ',
  '  owWWWWWWWhho  ',
  '  ohWWWWWWhhho  ',
  '   ohhWWWhhho   ',
];
const HEAD_SIDE = [
  '      oooo      ',
  '    oowwWWoo    ',
  '   owwWWWWWWo   ',
  '   owWWWWWWWho  ',
  '  owWWWWvvvvvo  ',
  '  owWWWWvgvevo  ',
  '  owWWWWvvvevo  ',
  '  ohWWWWvvvvho  ',
  '   ohhWWWhhho   ',
];
const BODY_DOWN = [
  '   ooBBBBBBoo   ',
  '  okbBByyBBdko  ',
  '  okbBByyBBdko  ',
  '   odBBBBBddo   ',
];
const BODY_UP = [
  '   ooppppppoo   ',
  '  okpqqqqqqpko  ',
  '  okpqrrqqqpko  ',
  '   odppppppdo   ',
];
const BODY_SIDE = [
  '    oBBBBBBo    ',
  '    obBBBBdko   ',
  '    obByyBdko   ',
  '    odBBBBdo    ',
];
// Legs: [standing, stepping, stepping the other way].
const LEGS_FRONT = [
  ['    odd  ddo    ', '    osso osso   ', '    oooo oooo   '],
  ['    osso ddo    ', '    oooo osso   ', '         oooo   '],
  ['    odd  osso   ', '    osso oooo   ', '    oooo        '],
];
const LEGS_SIDE = [
  ['     oddddo     ', '     ossssso    ', '     ooooooo    '],
  ['    oddo odo    ', '   osso  osso   ', '   oooo  oooo   '],
  ['    oddo odo    ', '   osso  osso   ', '   oooo  oooo   '],
];

/** Player colours as a palette for the bitmaps. */
function playerPalette([body, shade]) {
  const mid = cssColor(body), dark = cssColor(shade);
  const light = mix(mid, '#fff3c4', 0.38);
  return {
    o: mix(dark, '#120a24', 0.55),
    w: light, W: mid, h: dark,
    b: light, B: mid, d: dark,
    v: '#1b2340', g: '#7ff6ff', e: '#e8fbff',
    k: '#f4f1e8', y: '#ffd34a', s: '#2a2433',
    p: STEEL[3], q: STEEL[4], r: '#ff4a3a',
  };
}

/** One player frame: `view` is down, up or side; `frame` 0 stands, 1 and 2 step. */
function player(colors, view, frame) {
  const p = new Pix(), pal = playerPalette(colors);
  const head = view === 'down' ? HEAD_DOWN : view === 'up' ? HEAD_UP : HEAD_SIDE;
  const body = view === 'down' ? BODY_DOWN : view === 'up' ? BODY_UP : BODY_SIDE;
  const legs = (view === 'side' ? LEGS_SIDE : LEGS_FRONT)[frame];
  bitmap(p, [...head, ...body, ...legs], pal, 0, 0);
  return p;
}

// --------------------------------------------------------------------- hats

/** Hat bitmaps, indexed like the cosmetic hat ids (1..6), each with its colours. */
const HATS = [
  null,
  [['   oooo     ', '  o+##-o    ', ' o+####-o   ', ' o######oooo', ' oooooooo--o'],
    { o: '#4a0f0c', '#': '#d23a2f', '+': '#ff8a7a', '-': '#8c1f1a' }],
  [['     y      ', '    oyo     ', '    o#o     ', '   o#w#o    ', '   ow##o    ', '  o##w#-o   ', '  ow###wo   ', '  oooooooo  '],
    { o: '#4a1240', '#': '#ff7af0', w: '#ffffff', '-': '#b8329c', y: '#ffd34a' }],
  [[' o        o ', 'o+o      o+o', 'o#o      o#o', ' o#o    o#o ', '  o#o  o#o  ', '   oo  oo   '],
    { o: '#3a0a0a', '#': '#b8312f', '+': '#ff8a7a' }],
  [['   yyyyyy   ', ' yyw    wyy ', 'y          y', ' yy      yy ', '   yyyyyy   '],
    { y: '#ffe680', w: '#ffffff' }],
  [[' o   o   o  ', 'o+o o+o o+o ', 'o#oo#+#oo#o ', 'o+########o ', 'o#r##b##r-o ', ' oooooooooo '],
    { o: '#6a4200', '#': '#ffd34a', '+': '#fff1a8', '-': '#c98a0a', r: '#ff4a5a', b: '#4ab0ff' }],
  [['  oooooooo  ', '  o+#####o  ', '  o+#####o  ', '  o+#####o  ', '  orrrrrro  ', 'oooooooooooo', 'o++########o', 'oooooooooooo'],
    { o: '#0b0c10', '#': '#22242c', '+': '#4a4f60', r: '#d23a2f' }],
];

/** A hat as a 4x canvas (16 wide, bitmap at the top, centred), plus its art-pixel height. */
function hat(id) {
  const [rows, colors] = HATS[id];
  const p = new Pix();
  bitmap(p, rows, colors, Math.floor((N - rows[0].length) / 2), 0);
  return { canvas: p.canvas(X4), rows: rows.length };
}

// ------------------------------------------------------------------- worms

// Worm flesh: plum shadows up to a pale coral highlight.
const WORM = ['#1d0818', '#3d1030', '#651a45', '#922a55', '#c2465f', '#ea7476', '#ffbfa3'];
const DIRT = ['#2a1a10', '#4a2f1a', '#6e4826', '#94673a', '#b98b55'];
// The saddle band (clitellum): swollen, paler, warmer.
const BAND = ['#2a0c18', '#6b2236', '#a8434d', '#d86a62', '#f39a83', '#ffd2b4'];

/** A shaded ball of flesh with a darker ring across it, for the body. */
function wormSegment(band = false) {
  const ramp = band ? BAND : WORM;
  const p = new Pix();
  for (let y = 11; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (((x - 7.5) / 5.5) ** 2 + ((y - 13.5) / 1.6) ** 2 <= 1) p.set(x, y, SHADOW);
    }
  }
  const cx = 7.5, cy = 8, r = 5.8;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy);
      if (d > r) continue;
      if (d > r - 1) { p.set(x, y, ramp[0]); continue; }
      const lit = -(0.6 * dx + 0.8 * dy) / r;
      let k = clamp(Math.round(3 + lit * 2.4), 1, ramp.length - 2);
      // A ring of muscle round the middle (two on the band).
      if (band ? Math.abs(Math.abs(dx) - 2) < 0.6 : Math.abs(dx) < 1) k = Math.max(1, k - 2);
      p.set(x, y, ramp[k]);
    }
  }
  p.set(5, 5, ramp[ramp.length - 1]);
  p.set(4, 6, ramp[ramp.length - 1]);
  return p;
}

/** The tail tip, pointing right: a tapering cone of rings. */
function wormTail() {
  const p = new Pix();
  for (let y = 11; y < N; y++) {
    for (let x = 0; x < 13; x++) {
      if (((x - 6) / 6) ** 2 + ((y - 13) / 1.3) ** 2 <= 1) p.set(x, y, SHADOW);
    }
  }
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      // Radius shrinks from 5 at the left edge to a point at x = 14.
      const r = 5 * (1 - x / 14);
      const dy = y - 8;
      if (r <= 0 || Math.abs(dy) > r) continue;
      if (Math.abs(dy) > r - 1 || x >= 13) { p.set(x, y, WORM[0]); continue; }
      const lit = -dy / Math.max(1, r);
      let k = clamp(Math.round(3 + lit * 2), 1, 5);
      if (x % 4 === 3) k = Math.max(1, k - 1);
      p.set(x, y, WORM[k]);
    }
  }
  p.set(2, 5, WORM[6]);
  return p;
}

/**
 * The head, facing right: a bigger ball with a jaw of teeth and two eyes,
 * yellow while it roams and red while it hunts; lunging, the jaws gape.
 */
function wormHead(angry, lunge = false) {
  const p = new Pix();
  for (let y = 11; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (((x - 7.5) / 6.5) ** 2 + ((y - 14) / 1.7) ** 2 <= 1) p.set(x, y, SHADOW);
    }
  }
  const cx = 7, cy = 8, r = 6.6;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const dx = x - cx, dy = y - cy, d = Math.hypot(dx, dy);
      if (d > r) continue;
      if (d > r - 1) { p.set(x, y, WORM[0]); continue; }
      const lit = -(0.6 * dx + 0.8 * dy) / r;
      p.set(x, y, WORM[clamp(Math.round(3.2 + lit * 2.4), 1, 6)]);
    }
  }
  // An open mouth with a row of teeth at the front; a lunge gapes, all fangs.
  if (lunge) {
    bitmap(p, ['oot ', 'ommt', 'omm ', 'ommm', 'omm ', 'ommt', 'oot '], { o: WORM[0], m: '#2a0410', t: '#f4ead2' }, 10, 5);
  } else {
    bitmap(p, [' oo', 'omt', 'om ', 'omt', ' oo'], { o: WORM[0], m: '#2a0410', t: '#f4ead2' }, 11, 6);
  }
  // Eyes up top, over the mouth.
  const eye = angry ? ['#ff3a2a', '#ffd0a0'] : ['#ffd34a', '#fff6c8'];
  bitmap(p, ['oo', 'ab'], { o: WORM[0], a: eye[0], b: eye[1] }, 8, 3);
  bitmap(p, ['oo', 'ab'], { o: WORM[0], a: eye[0], b: eye[1] }, 11, 4);
  if (angry) {
    // Furrowed brows.
    p.set(8, 2, WORM[0]);
    p.set(12, 3, WORM[0]);
  }
  return p;
}

/** A heap of fresh dirt where a worm is burrowing out. */
function wormMound() {
  const p = new Pix();
  const rand = rng(77);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const e = ((x - 7.5) / 7) ** 2 + ((y - 10) / 4.6) ** 2;
      if (e > 1) continue;
      const lit = -((x - 7.5) * 0.5 + (y - 8) * 0.9) / 6;
      const k = e > 0.8 ? 0 : clamp(Math.round(2 + lit * 1.6 + (rand() - 0.5)), 1, 4);
      p.set(x, y, DIRT[k]);
    }
  }
  // The hole in the middle.
  for (let x = 5; x <= 10; x++) p.set(x, 9, DIRT[0]);
  for (let x = 6; x <= 9; x++) p.set(x, 10, '#120a06');
  return p;
}

// ------------------------------------------------------------------ warden

const STONE = ['#16171d', '#2c2f38', '#454955', '#626774', '#838a97', '#aab1bc', '#d3d8de'];
const GOLD = ['#4a2e06', '#94600e', '#d69a26', '#ffd25a', '#fff1b0'];

/**
 * The vault's Warden, facing the viewer: a hulking stone golem with a gold
 * crown, a glowing rune on its chest and huge fists. Enraged, the rune and
 * eyes burn red and cracks glow through the stone.
 */
function warden(rage) {
  const p = new Pix();
  for (let y = 13; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (((x - 7.5) / 7.5) ** 2 + ((y - 14.5) / 1.5) ** 2 <= 1) p.set(x, y, SHADOW);
    }
  }
  const glow = rage ? ['#7a1206', '#ff3a1a', '#ffb08a'] : ['#6a4a06', '#ffd25a', '#fff6c8'];
  // Stone with light from the top left: k from the distance to the light.
  const stone = (x, y, cx, cy, r) => {
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

// ------------------------------------------------------------------- export

/**
 * Builds every pixel sprite. Names match the classic sprites where one
 * exists, so the renderer can ask for either style by name. Players are
 * built per colour on demand with `pixelPlayer`.
 */
export function buildPixelSprites() {
  const big = (p) => p.canvas(X4);
  const f = flames();
  const items = powerUps();
  const names = [null, 'pu_bomb', 'pu_range', 'pu_speed', 'pu_kick', 'pu_shield', 'pu_pierce',
    'pu_fullfire', 'pu_mystery', 'pu_remote', 'pu_line', 'pu_punch', 'pu_ghost', 'pu_nuke',
    'pu_freeze', 'pu_mine', 'pu_rocket', 'pu_swap', 'pu_stomp', 'pu_drone', 'pu_swarm'];
  const out = {
    bomb_nuke: big(nukeBomb()),
    bomb: big(bomb(IRON, false)),
    bomb_pierce: big(bomb(RED_IRON, true)),
    antenna: [big(antenna(false)), big(antenna(true))],
    flames: { center: f.center.map(big), arm: f.arm.map(big), end: f.end.map(big) },
    flame_center: big(f.center[0]),
    flame_arm: big(f.arm[0]),
    flame_end: big(f.end[0]),
    scorch: big(scorch()),
    hats: HATS.map((h, i) => h && hat(i)),
    worm_segment: big(wormSegment()),
    worm_head: big(wormHead(false)),
    worm_head_angry: big(wormHead(true)),
    worm_head_lunge: big(wormHead(true, true)),
    worm_band: big(wormSegment(true)),
    worm_tail: big(wormTail()),
    worm_mound: big(wormMound()),
    warden: big(warden(false)),
    warden_rage: big(warden(true)),
  };
  for (let k = 1; k < names.length; k++) out[names[k]] = big(items[k]);
  return out;
}

/** A player sprite for given colours as a 4x canvas. */
export function pixelPlayer(colors, view, frame) {
  return player(colors, view, frame).canvas(X4);
}

