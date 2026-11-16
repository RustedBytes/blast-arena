// 16×16 pixel icons for the menus, HUD, alerts and emotes. One palette and
// a shared outline so the set reads as a single sheet. Drawn into a canvas
// only when the page asks for one; the rasters themselves need no DOM.

/** Emotes, in the order the protocol numbers them (keys 1–8). */
export const EMOTE_IDS = ['wave', 'laugh', 'angry', 'thumb', 'bomb', 'scream', 'gg', 'cool'] as const;

const INK: Record<string, readonly [number, number, number]> = {
  k: [20, 12, 8],
  w: [244, 239, 230],
  o: [255, 176, 46],
  y: [255, 225, 74],
  r: [226, 59, 50],
  d: [142, 30, 24],
  g: [60, 186, 74],
  n: [27, 107, 48],
  b: [58, 134, 255],
  u: [28, 63, 134],
  p: [176, 107, 255],
  c: [127, 246, 255],
  s: [154, 166, 184],
  m: [231, 238, 248],
  h: [240, 184, 136],
  a: [107, 58, 30],
  f: [255, 106, 34],
  q: [58, 50, 40],
  e: [92, 103, 120],
  i: [216, 246, 255],
  v: [106, 83, 68],
  z: [242, 210, 162],
};

const N = 16;

/** A 16×16 colour buffer. `.` is empty; anything else is an ink letter. */
class Spr {
  private readonly a: string[] = Array.from({ length: N * N }, () => '.');

  set(x: number, y: number, c: string): void {
    const xi = Math.round(x), yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= N || yi >= N) return;
    this.a[yi * N + xi] = c;
  }

  rect(x: number, y: number, w: number, h: number, c: string): void {
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) this.set(x + xx, y + yy, c);
  }

  disc(cx: number, cy: number, r: number, c: string): void {
    const r2 = r * r;
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
        if (dx * dx + dy * dy <= r2) this.set(x, y, c);
      }
    }
  }

  /** One-pixel dark rim around every filled pixel. */
  outline(): void {
    const copy = this.a.slice();
    const on = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < N && y < N && copy[y * N + x] !== '.';
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        if (on(x, y)) continue;
        if (on(x - 1, y) || on(x + 1, y) || on(x, y - 1) || on(x, y + 1)) this.set(x, y, 'k');
      }
    }
  }

  /** Clears fill that is not touching empty space, leaving a one-pixel rim. */
  hollow(): void {
    const copy = this.a.slice();
    const at = (x: number, y: number): string => (x < 0 || y < 0 || x >= N || y >= N ? '.' : copy[y * N + x]);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const c = at(x, y);
        if (c === '.' || c === 'k') continue;
        if ([at(x - 1, y), at(x + 1, y), at(x, y - 1), at(x, y + 1)].every((n) => n !== '.')) this.set(x, y, '.');
      }
    }
  }

  rgba(): Uint8ClampedArray {
    const data = new Uint8ClampedArray(N * N * 4);
    for (let i = 0; i < this.a.length; i++) {
      const c = this.a[i];
      if (c === '.') continue;
      const rgb = INK[c];
      const o = i * 4;
      data[o] = rgb[0];
      data[o + 1] = rgb[1];
      data[o + 2] = rgb[2];
      data[o + 3] = 255;
    }
    return data;
  }
}

const done = (paint: (s: Spr) => void): Uint8ClampedArray => {
  const s = new Spr();
  paint(s);
  return s.rgba();
};

function heart(s: Spr, c = 'r'): void {
  s.disc(5.2, 5.6, 2.7, c);
  s.disc(10.2, 5.6, 2.7, c);
  s.rect(3, 6, 10, 3, c);
  for (let i = 0; i < 6; i++) s.rect(4 + i, 9 + i, 8 - i * 2, 1, c);
}

function face(s: Spr, skin = 'y'): void {
  s.disc(8, 8.2, 6.2, skin);
}

function eyes(s: Spr, c = 'k', y = 7): void {
  s.rect(5, y, 2, 2, c);
  s.rect(9, y, 2, 2, c);
}

function smile(s: Spr, y0 = 10): void {
  s.rect(5, y0, 6, 1, 'k');
  s.set(4, y0 - 1, 'k');
  s.set(11, y0 - 1, 'k');
}

const ICONS = {
  heart: done((s) => { heart(s); s.outline(); }),
  heartEmpty: done((s) => { heart(s); s.hollow(); s.outline(); }),
  star: done((s) => {
    s.rect(7, 1, 2, 3, 'y');
    s.rect(5, 4, 6, 2, 'y');
    s.rect(1, 6, 14, 2, 'y');
    s.rect(3, 8, 10, 2, 'y');
    s.rect(2, 10, 4, 2, 'y');
    s.rect(10, 10, 4, 2, 'y');
    s.rect(4, 12, 3, 2, 'y');
    s.rect(9, 12, 3, 2, 'y');
    s.rect(7, 8, 2, 3, 'y');
    s.outline();
  }),
  flag: done((s) => {
    s.rect(3, 2, 2, 12, 's');
    s.rect(5, 2, 8, 6, 'r');
    s.rect(5, 4, 8, 2, 'w');
    s.outline();
  }),
  bomb: done((s) => {
    s.disc(8, 10, 4.4, 'q');
    s.rect(7, 4, 2, 3, 'a');
    s.rect(9, 2, 2, 2, 'f');
    s.set(10, 1, 'y');
    s.rect(6, 9, 2, 2, 'e');
    s.outline();
  }),
  skull: done((s) => {
    s.disc(8, 6.5, 4.6, 'm');
    s.rect(4, 8, 8, 4, 'm');
    s.rect(5, 6, 2, 2, 'k');
    s.rect(9, 6, 2, 2, 'k');
    s.rect(6, 11, 4, 2, 'k');
    s.set(7, 12, 'm'); s.set(9, 12, 'm');
    s.outline();
  }),
  smile: done((s) => { face(s); eyes(s); smile(s); s.outline(); }),
  gear: done((s) => {
    s.disc(8, 8, 5, 's');
    s.disc(8, 8, 2.1, '.');
    s.rect(6, 1, 4, 3, 's');
    s.rect(6, 12, 4, 3, 's');
    s.rect(1, 6, 3, 4, 's');
    s.rect(12, 6, 3, 4, 's');
    s.rect(3, 3, 3, 3, 's');
    s.rect(10, 3, 3, 3, 's');
    s.rect(3, 10, 3, 3, 's');
    s.rect(10, 10, 3, 3, 's');
    s.outline();
  }),
  hand: done((s) => {
    s.rect(3, 8, 9, 6, 'h');
    s.rect(4, 2, 2, 7, 'h');
    s.rect(6, 3, 2, 6, 'h');
    s.rect(8, 3, 2, 6, 'h');
    s.rect(10, 5, 2, 5, 'h');
    s.rect(2, 9, 2, 4, 'h');
    s.outline();
  }),
  close: done((s) => {
    for (let i = 2; i < 14; i++) {
      s.rect(i, i, 2, 2, 'w');
      s.rect(15 - i, i, 2, 2, 'w');
    }
    s.outline();
  }),
  jump: done((s) => {
    s.rect(7, 2, 2, 12, 'c');
    s.rect(4, 5, 8, 2, 'c');
    s.rect(5, 4, 6, 1, 'c');
    s.rect(6, 3, 4, 1, 'c');
    s.outline();
  }),
  pad: done((s) => {
    s.rect(1, 5, 14, 8, 'e');
    s.rect(3, 4, 10, 1, 'e');
    s.rect(2, 7, 1, 3, 's');
    s.rect(3, 8, 3, 1, 's');
    s.rect(4, 7, 1, 3, 's');
    s.rect(10, 6, 2, 2, 'r');
    s.rect(12, 8, 2, 2, 'b');
    s.outline();
  }),
  phone: done((s) => {
    s.rect(4, 1, 8, 14, 'u');
    s.rect(5, 3, 6, 8, 'c');
    s.rect(7, 12, 2, 2, 'w');
    s.outline();
  }),
  book: done((s) => {
    s.rect(1, 2, 7, 12, 'a');
    s.rect(8, 2, 7, 12, 'z');
    s.rect(7, 2, 2, 12, 'd');
    s.rect(2, 4, 4, 1, 'y');
    s.rect(2, 6, 4, 1, 'y');
    s.rect(2, 8, 4, 1, 'y');
    s.rect(10, 5, 4, 1, 'o');
    s.rect(10, 7, 4, 1, 'o');
    s.rect(10, 9, 4, 1, 'o');
    s.outline();
  }),
  lock: done((s) => {
    s.rect(4, 7, 8, 7, 'y');
    s.rect(5, 3, 6, 5, 's');
    s.rect(6, 4, 4, 3, '.');
    s.rect(7, 10, 2, 2, 'q');
    s.outline();
  }),
  user: done((s) => {
    s.disc(8, 5, 3.1, 'h');
    s.rect(3, 10, 10, 4, 'b');
    s.disc(8, 10, 3.2, 'b');
    s.outline();
  }),
  bot: done((s) => {
    s.rect(3, 4, 10, 9, 's');
    s.rect(7, 1, 2, 3, 'e');
    s.set(8, 1, 'r');
    s.rect(5, 7, 2, 2, 'c');
    s.rect(9, 7, 2, 2, 'c');
    s.rect(5, 11, 6, 1, 'q');
    s.outline();
  }),
  storm: done((s) => {
    for (let i = 0; i < 22; i++) {
      const t = i / 21 * Math.PI * 2.4;
      const rad = 1.2 + i * 0.24;
      s.disc(8 + Math.cos(t) * rad, 8 + Math.sin(t) * rad, 1.15, i % 2 ? 'b' : 'c');
    }
    s.outline();
  }),
  worm: done((s) => {
    s.disc(4, 10, 2.4, 'g');
    s.disc(8, 8, 2.5, 'n');
    s.disc(12, 6, 2.3, 'g');
    s.set(11, 5, 'k'); s.set(13, 5, 'k');
    s.outline();
  }),
  rocket: done((s) => {
    s.rect(6, 3, 4, 8, 'm');
    s.rect(7, 1, 2, 3, 'r');
    s.rect(4, 8, 2, 3, 'r');
    s.rect(10, 8, 2, 3, 'r');
    s.rect(7, 5, 2, 2, 'b');
    s.rect(7, 12, 2, 2, 'f');
    s.set(7, 14, 'y');
    s.outline();
  }),
  key: done((s) => {
    s.disc(5.5, 5.5, 3, 'y');
    s.disc(5.5, 5.5, 1.3, '.');
    s.rect(7, 7, 2, 6, 'y');
    s.rect(9, 10, 3, 2, 'y');
    s.rect(9, 13, 2, 1, 'y');
    s.outline();
  }),
  planet: done((s) => {
    s.disc(8, 8, 4.5, 'p');
    s.rect(2, 7, 12, 2, 'c');
    s.disc(8, 8, 3.2, 'p');
    s.rect(5, 6, 3, 2, 'u');
    s.outline();
  }),
  clock: done((s) => {
    s.disc(8, 8, 6, 'm');
    s.rect(7, 4, 2, 5, 'k');
    s.rect(8, 8, 4, 2, 'r');
    s.outline();
  }),
  slime: done((s) => {
    s.disc(8, 10, 5.2, 'g');
    s.rect(3, 8, 10, 4, 'g');
    s.rect(5, 7, 2, 2, 'w');
    s.rect(9, 7, 2, 2, 'w');
    s.set(6, 8, 'k'); s.set(10, 8, 'k');
    s.outline();
  }),
  bat: done((s) => {
    s.disc(8, 8, 2.4, 'p');
    s.rect(2, 6, 4, 2, 'u');
    s.rect(10, 6, 4, 2, 'u');
    s.rect(1, 4, 3, 2, 'u');
    s.rect(12, 4, 3, 2, 'u');
    s.set(6, 8, 'r'); s.set(9, 8, 'r');
    s.outline();
  }),
  ogre: done((s) => {
    s.disc(8, 9, 5.4, 'n');
    s.rect(3, 3, 2, 3, 'z');
    s.rect(11, 3, 2, 3, 'z');
    s.rect(4, 8, 2, 2, 'w');
    s.rect(10, 8, 2, 2, 'w');
    s.rect(6, 11, 4, 2, 'd');
    s.outline();
  }),
  moai: done((s) => {
    s.rect(4, 2, 8, 12, 'v');
    s.rect(3, 5, 10, 3, 'v');
    s.rect(5, 6, 2, 2, 'q');
    s.rect(9, 6, 2, 2, 'q');
    s.rect(6, 10, 4, 2, 'q');
    s.rect(5, 1, 2, 2, 's');
    s.rect(9, 1, 2, 2, 's');
    s.outline();
  }),
  boom: done((s) => {
    s.rect(7, 1, 2, 14, 'f');
    s.rect(1, 7, 14, 2, 'y');
    s.rect(3, 3, 3, 3, 'o');
    s.rect(10, 3, 3, 3, 'o');
    s.rect(3, 10, 3, 3, 'o');
    s.rect(10, 10, 3, 3, 'o');
    s.disc(8, 8, 2.2, 'y');
    s.outline();
  }),
  target: done((s) => {
    s.disc(8, 8, 6.4, 'r');
    s.disc(8, 8, 4.4, 'w');
    s.disc(8, 8, 2.5, 'r');
    s.disc(8, 8, 1.1, 'y');
    s.outline();
  }),
  fire: done((s) => {
    s.disc(8, 10, 4, 'f');
    s.rect(6, 4, 4, 6, 'f');
    s.rect(7, 2, 2, 4, 'o');
    s.disc(8, 11, 2.2, 'y');
    s.set(8, 1, 'y');
    s.outline();
  }),
  rad: done((s) => {
    s.disc(8, 8, 1.6, 'y');
    s.rect(7, 1, 2, 4, 'y');
    s.rect(2, 10, 4, 2, 'y');
    s.rect(3, 12, 2, 2, 'y');
    s.rect(10, 10, 4, 2, 'y');
    s.rect(11, 12, 2, 2, 'y');
    s.outline();
  }),
  stun: done((s) => {
    const spark = (x: number, y: number): void => {
      s.rect(x, y - 2, 1, 5, 'y');
      s.rect(x - 2, y, 5, 1, 'y');
    };
    spark(4, 5); spark(11, 4); spark(8, 11);
    s.outline();
  }),
  comet: done((s) => {
    s.rect(1, 10, 2, 2, 'o');
    s.rect(3, 8, 2, 2, 'f');
    s.rect(5, 6, 2, 2, 'y');
    s.disc(11, 5, 3.2, 'm');
    s.disc(10, 4.2, 1.2, 'c');
    s.outline();
  }),
  snow: done((s) => {
    s.rect(7, 1, 2, 14, 'i');
    s.rect(1, 7, 14, 2, 'i');
    s.rect(3, 3, 2, 2, 'i');
    s.rect(11, 3, 2, 2, 'i');
    s.rect(3, 11, 2, 2, 'i');
    s.rect(11, 11, 2, 2, 'i');
    s.outline();
  }),
  volcano: done((s) => {
    s.rect(1, 12, 14, 3, 'v');
    for (let i = 0; i < 6; i++) s.rect(2 + i, 11 - i, 12 - i * 2, 1, 'e');
    s.rect(6, 3, 4, 4, 'f');
    s.rect(7, 1, 2, 3, 'y');
    s.outline();
  }),
  hourglass: done((s) => {
    s.rect(3, 1, 10, 2, 'o');
    s.rect(3, 13, 10, 2, 'o');
    for (let i = 0; i < 5; i++) s.rect(4 + i, 3 + i, 8 - i * 2, 1, 'y');
    for (let i = 0; i < 5; i++) s.rect(4 + i, 12 - i, 8 - i * 2, 1, 'y');
    s.outline();
  }),
  earth: done((s) => {
    s.disc(8, 8, 6, 'b');
    s.rect(4, 5, 3, 3, 'g');
    s.rect(8, 8, 4, 3, 'g');
    s.rect(5, 10, 2, 2, 'g');
    s.outline();
  }),
  bang: done((s) => {
    s.rect(6, 1, 4, 9, 'y');
    s.rect(6, 12, 4, 3, 'y');
    s.outline();
  }),
  trophy: done((s) => {
    s.rect(5, 2, 6, 5, 'y');
    s.rect(3, 3, 2, 3, 'y');
    s.rect(11, 3, 2, 3, 'y');
    s.rect(7, 7, 2, 3, 'o');
    s.rect(5, 10, 6, 2, 'y');
    s.rect(4, 12, 8, 2, 'o');
    s.outline();
  }),
  cut: done((s) => {
    s.disc(4, 12.5, 2.3, 's');
    s.disc(11, 12.5, 2.3, 's');
    s.disc(4, 12.5, 1, '.');
    s.disc(11, 12.5, 1, '.');
    for (let i = 0; i < 9; i++) {
      s.rect(4 + i, 10 - i, 2, 2, 'm');
      s.rect(10 - i, 10 - i, 2, 2, 'm');
    }
    s.outline();
  }),
  crown: done((s) => {
    s.rect(2, 9, 12, 4, 'y');
    s.rect(2, 5, 2, 4, 'y');
    s.rect(7, 3, 2, 6, 'y');
    s.rect(12, 5, 2, 4, 'y');
    s.set(3, 6, 'r'); s.set(8, 5, 'b'); s.set(12, 6, 'r');
    s.outline();
  }),
  wave: done((s) => {
    s.rect(6, 8, 6, 5, 'h');
    s.rect(6, 4, 2, 5, 'h');
    s.rect(8, 5, 2, 4, 'h');
    s.rect(10, 6, 2, 3, 'h');
    s.rect(4, 6, 2, 4, 'h');
    s.rect(3, 3, 2, 3, 'h');
    s.outline();
  }),
  laugh: done((s) => {
    face(s, 'y');
    s.rect(4, 6, 3, 1, 'k'); s.set(4, 7, 'k');
    s.rect(9, 6, 3, 1, 'k'); s.set(11, 7, 'k');
    s.rect(5, 10, 6, 2, 'k');
    s.rect(6, 10, 4, 1, 'w');
    s.outline();
  }),
  angry: done((s) => {
    face(s, 'r');
    s.rect(4, 5, 3, 1, 'k'); s.set(6, 6, 'k');
    s.rect(9, 5, 3, 1, 'k'); s.set(9, 6, 'k');
    s.rect(5, 7, 2, 2, 'k');
    s.rect(9, 7, 2, 2, 'k');
    s.rect(5, 11, 6, 1, 'k');
    s.outline();
  }),
  thumb: done((s) => {
    s.rect(6, 6, 6, 7, 'h');
    s.rect(4, 3, 3, 5, 'h');
    s.rect(7, 8, 1, 4, 'z');
    s.rect(9, 8, 1, 4, 'z');
    s.outline();
  }),
  scream: done((s) => {
    face(s, 'y');
    s.rect(5, 6, 2, 2, 'k');
    s.rect(9, 6, 2, 2, 'k');
    s.disc(8, 11, 2.1, 'k');
    s.disc(8, 11, 1.1, 'w');
    s.outline();
  }),
  cool: done((s) => {
    face(s, 'y');
    s.rect(3, 6, 10, 3, 'k');
    s.rect(4, 7, 3, 1, 'c');
    s.rect(9, 7, 3, 1, 'c');
    smile(s, 11);
    s.outline();
  }),
  gg: done((s) => {
    const letter = (x: number): void => {
      s.rect(x, 1, 6, 14, 'o');
      s.rect(x + 2, 3, 4, 10, '.');
      s.rect(x + 4, 9, 2, 4, 'o');
      s.rect(x + 2, 8, 4, 2, 'o');
    };
    letter(1);
    letter(9);
    s.outline();
  }),
  wind: done((s) => {
    s.rect(2, 4, 10, 2, 'c');
    s.rect(4, 7, 10, 2, 'm');
    s.rect(2, 10, 8, 2, 'c');
    s.outline();
  }),
  blood: done((s) => {
    s.disc(8, 10, 4, 'r');
    s.rect(6, 4, 4, 5, 'r');
    s.rect(7, 2, 2, 3, 'd');
    s.outline();
  }),
  dizzy: done((s) => {
    face(s, 'y');
    s.rect(4, 6, 3, 1, 'k'); s.rect(5, 7, 1, 2, 'k'); s.rect(4, 8, 2, 1, 'k');
    s.rect(9, 6, 3, 1, 'k'); s.rect(10, 7, 1, 2, 'k'); s.rect(9, 8, 2, 1, 'k');
    s.rect(6, 11, 4, 1, 'k');
    s.outline();
  }),
  link: done((s) => {
    s.rect(1, 2, 7, 8, 'o');
    s.rect(2, 3, 5, 6, '.');
    s.rect(7, 6, 8, 8, 'y');
    s.rect(8, 7, 6, 6, '.');
    s.rect(5, 6, 4, 3, 'o');
    s.outline();
  }),
} satisfies Record<string, Uint8ClampedArray>;

export type IconName = keyof typeof ICONS;

const RGBA: Record<IconName, Uint8ClampedArray> = ICONS;

export function isIconName(name: string): name is IconName {
  return Object.prototype.hasOwnProperty.call(RGBA, name);
}

/** Raw 16×16 RGBA, for tests and the icon sheet. */
export function iconRgba(name: IconName): Uint8ClampedArray {
  return RGBA[name];
}

export const ICON_NAMES = Object.keys(RGBA) as IconName[];

const canvases = new Map<IconName, HTMLCanvasElement>();
const urls = new Map<IconName, string>();

/** A 16×16 canvas of one icon (cached). */
export function iconCanvas(name: IconName): HTMLCanvasElement {
  const hit = canvases.get(name);
  if (hit) return hit;
  const canvas = document.createElement('canvas');
  canvas.width = N;
  canvas.height = N;
  const g = canvas.getContext('2d');
  if (!g) throw new Error('canvas 2d unavailable');
  g.putImageData(new ImageData(new Uint8ClampedArray(RGBA[name]), N, N), 0, 0);
  canvases.set(name, canvas);
  return canvas;
}

/** A PNG data URL of one icon (cached). */
export function iconUrl(name: IconName): string {
  const hit = urls.get(name);
  if (hit) return hit;
  const url = iconCanvas(name).toDataURL();
  urls.set(name, url);
  return url;
}

/** An `<img>` showing one icon. */
export function iconEl(name: IconName, className = 'px'): HTMLImageElement {
  const img = document.createElement('img');
  img.className = className.split(' ').includes('px') ? className : `${className} px`;
  img.src = iconUrl(name);
  img.alt = '';
  img.draggable = false;
  return img;
}

/** Markup for one icon. The URL is a data URL we generated, not user text. */
export function iconHtml(name: IconName): string {
  return `<img class="px" src="${iconUrl(name)}" alt="" draggable="false">`;
}

/** Alert icon value: `px:heart` and the like. */
export function px(name: IconName): string {
  return `px:${name}`;
}

/** Fills every `<img data-px="name">` under `root`. */
export function mountPixelIcons(root: ParentNode = document): void {
  for (const img of root.querySelectorAll('img[data-px]')) {
    if (!(img instanceof HTMLImageElement)) continue;
    const name = img.dataset.px ?? '';
    if (!isIconName(name)) continue;
    img.src = iconUrl(name);
    img.classList.add('px');
    img.alt = '';
    img.draggable = false;
  }
}
