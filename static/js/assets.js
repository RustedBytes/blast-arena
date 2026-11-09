// Loads the SVG artwork once and keeps rasterised copies at the current
// tile size, so drawing a frame is just a series of cheap drawImage calls.

const STATIC = [
  'floor', 'pillar', 'crate', 'bomb',
  'flame_center', 'flame_arm', 'flame_end',
  'pu_bomb', 'pu_range', 'pu_speed', 'pu_kick',
];
const PLAYER_VIEWS = ['player_down', 'player_up', 'player_side'];
const HUE_BUCKETS = 24;

function svgImage(text) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(text);
  });
}

function rasterize(img, size) {
  const c = document.createElement('canvas');
  c.width = c.height = Math.max(1, Math.round(size));
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return c;
}

/** Deterministic colour for a player id, spread around the hue wheel. */
export function playerHue(id) {
  return Math.round(((id * 137.508) % 360) / (360 / HUE_BUCKETS)) % HUE_BUCKETS * (360 / HUE_BUCKETS);
}

export class Assets {
  constructor() {
    this.images = {};       // name -> Image (vector source)
    this.templates = {};    // player view -> SVG text with colour placeholders
    this.sprites = {};      // name -> canvas at current tile size
    this.players = new Map(); // `${hue}:${view}` -> canvas | 'loading'
    this.size = 0;
  }

  async load() {
    const fetchText = (n) => fetch(`assets/${n}.svg`).then((r) => r.text());
    await Promise.all([
      ...STATIC.map(async (n) => { this.images[n] = await svgImage(await fetchText(n)); }),
      ...PLAYER_VIEWS.map(async (n) => { this.templates[n] = await fetchText(n); }),
    ]);
  }

  setTileSize(size) {
    if (size === this.size) return;
    this.size = size;
    for (const n of STATIC) this.sprites[n] = rasterize(this.images[n], size);
    this.players.clear();
  }

  sprite(name) {
    return this.sprites[name];
  }

  /** Tinted player sprite; returns null while the variant is being built. */
  player(hue, view) {
    const key = `${hue}:${view}`;
    const c = this.players.get(key);
    if (c && c !== 'loading') return c;
    if (!c) {
      this.players.set(key, 'loading');
      const size = this.size;
      const svg = this.templates[view]
        .replaceAll('#BODYDARK', `hsl(${hue},70%,34%)`)
        .replaceAll('#BODY', `hsl(${hue},78%,54%)`);
      svgImage(svg).then((img) => {
        if (this.size === size) this.players.set(key, rasterize(img, size));
      });
    }
    return null;
  }
}
