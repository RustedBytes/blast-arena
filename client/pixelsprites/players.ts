// Players (three views, two walk frames) and the cosmetic hats.

import { bitmap, cssColor, mix, N, Pix, STEEL, X4 } from '../pixelkit.js';

/** Which way a player sprite faces. */
export type PlayerView = 'down' | 'up' | 'side';

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
function playerPalette([body, shade]: readonly [string, string]): Record<string, string> {
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
export function player(colors: readonly [string, string], view: PlayerView, frame: number): Pix {
  const p = new Pix(), pal = playerPalette(colors);
  const head = view === 'down' ? HEAD_DOWN : view === 'up' ? HEAD_UP : HEAD_SIDE;
  const body = view === 'down' ? BODY_DOWN : view === 'up' ? BODY_UP : BODY_SIDE;
  const legs = (view === 'side' ? LEGS_SIDE : LEGS_FRONT)[frame];
  bitmap(p, [...head, ...body, ...legs], pal, 0, 0);
  return p;
}

// --------------------------------------------------------------------- hats

/** Hat bitmaps, indexed like the cosmetic hat ids (1..6), each with its colours. */
type HatArt = readonly [rows: readonly string[], colors: Readonly<Record<string, string>>];
/** A hat sprite and its height in art pixels. */
export interface PixelHat { canvas: HTMLCanvasElement; rows: number }

export const HATS: readonly (HatArt | null)[] = [
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
export function hat([rows, colors]: HatArt): PixelHat {
  const p = new Pix();
  bitmap(p, rows, colors, Math.floor((N - (rows[0]?.length ?? 0)) / 2), 0);
  return { canvas: p.canvas(X4), rows: rows.length };
}
