// Power-up tokens: a bevelled token with a rarity-coloured frame and a
// bright glyph on a dark panel.

import { bitmap, N, Pix, STEEL } from '../pixelkit.js';
import { FUSE } from './bombs.js';

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

/**
 * Every power-up is the same family of object, a bevelled token with a
 * rarity-coloured frame and a bright glyph on a dark panel, so pickups are
 * recognisable at a glance and the glyph says which one.
 */
function token(frame: Rarity, glyph: readonly string[], colors: Record<string, string>): Pix {
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

/** The power-up tokens, in the order of the protocol's item kinds (from 1). */
export function powerUps(): Pix[] {
  const flame = { o: '#5c140e', '#': '#ff7a1a', '+': '#ffd66b', w: '#fff4c2', '-': '#c2391b' };
  return [
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
    // Heart (dungeon): every lost heart back.
    token('red', [
      ' oo  oo   ',
      'o+#oo##o  ',
      'o+w####o  ',
      'o+######o ',
      'o#######o ',
      ' o#####-o ',
      '  o###-o  ',
      '   o#-o   ',
      '    oo    ',
      '          ',
    ], { o: '#3a0610', '#': '#ff3a4a', '+': '#ff9aa2', '-': '#a8101e', w: '#ffffff' }),
    // Cosmos blaster cores: a blaster grip and a glowing orb of the colour.
    // Plasma (red): bigger blasts.
    token('red', [
      '      rr  ',
      '     rRRr ',
      '    rRwwRr',
      ' ggggRwwRr',
      ' gggg rRr ',
      ' g  g  r  ',
      ' gg       ',
      '  g       ',
      '          ',
      '          ',
    ], { g: '#5a6478', r: '#ff3a3a', R: '#ff8a7a', w: '#ffffff' }),
    // Cryo (cyan): blasts leave ice.
    token('blue', [
      '    w     ',
      ' w  c  w  ',
      '  c c c   ',
      '   ccc    ',
      'wccCwCccw ',
      '   ccc    ',
      '  c c c   ',
      ' w  c  w  ',
      '    w     ',
      '          ',
    ], { c: '#3ad8ff', C: '#c8fbff', w: '#ffffff' }),
    // Phase (violet): through crates.
    token('purple', [
      '   bb     ',
      '   bb     ',
      '   bb     ',
      'vvVVwwVVvv',
      '   bb     ',
      '   bb     ',
      '   bb     ',
      '          ',
      '          ',
      '          ',
    ], { b: '#8a5a36', v: '#a64aff', V: '#e6c8ff', w: '#ffffff' }),
    // Nova (gold): three bolts at once.
    token('gold', [
      'y   y   y ',
      ' y  y  y  ',
      '  y y y   ',
      '   yyy    ',
      '    Y     ',
      '   YwY    ',
      '    Y     ',
      '          ',
      '          ',
      '          ',
    ], { y: '#ffb81a', Y: '#fff3a8', w: '#ffffff' }),
    // Overdrive: rapid fire.
    token('blue', [
      '     gg   ',
      '    gg    ',
      '   gg     ',
      '  gGGGg   ',
      '    gg    ',
      '   gg     ',
      '  gg      ',
      '  g       ',
      '          ',
      '          ',
    ], { g: '#2bd94a', G: '#b6ffb0' }),
  ];
}
