// Loads the SVG artwork once and rasterises it at a fixed resolution.
// Sprites are scaled at draw time, so zooming never re-rasterises anything.
// Everything also comes in a pixel-art style, generated in code (see
// pixelart.js for tiles and pixelsprites.js for sprites).

import { buildPixelTiles } from './pixelart.js';
import { buildPixelSprites, pixelPlayer } from './pixelsprites.js';

const STATIC = [
  'floor', 'floor_b', 'floor_c', 'floor_sand', 'floor_snow', 'floor_ash',
  'pillar', 'crate', 'crate_armored', 'ice', 'conveyor', 'teleport',
  'bomb', 'bomb_pierce', 'scorch', 'flame_center', 'flame_arm', 'flame_end',
  'pu_bomb', 'pu_range', 'pu_speed', 'pu_kick', 'pu_shield', 'pu_pierce', 'pu_fullfire', 'pu_mystery',
  'pu_remote', 'pu_line', 'pu_punch', 'pu_ghost',
];
const PLAYER_VIEWS = ['player_down', 'player_up', 'player_side'];
const HUE_BUCKETS = 24;
/** Pixels per tile for every rasterised sprite. */
export const SPRITE_PX = 96;

/** Item kind (protocol code) → sprite name. */
export const ITEM_SPRITES = [null, 'pu_bomb', 'pu_range', 'pu_speed', 'pu_kick', 'pu_shield', 'pu_pierce',
  'pu_fullfire', 'pu_mystery', 'pu_remote', 'pu_line', 'pu_punch', 'pu_ghost'];

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
  c.width = c.height = size;
  c.getContext('2d').drawImage(img, 0, 0, size, size);
  return c;
}

/** Deterministic colour for a player id, spread around the hue wheel. */
export function playerHue(id) {
  return Math.round(((id * 137.508) % 360) / (360 / HUE_BUCKETS)) % HUE_BUCKETS * (360 / HUE_BUCKETS);
}

// Okabe-Ito palette: distinguishable with common colour-vision deficiencies.
const SAFE_COLORS = ['#E69F00', '#56B4E9', '#009E73', '#F0E442', '#0072B2', '#D55E00', '#CC79A7', '#999999'];

/**
 * Body colour of a player: team colours in team mode, otherwise a colour
 * from their id. Returns [body, shade] as CSS colours.
 */
export function playerColors(id, team, colorblind) {
  if (team === 1) return colorblind ? ['#E69F00', '#8a5f00'] : ['hsl(2,80%,52%)', 'hsl(2,75%,32%)'];
  if (team === 2) return colorblind ? ['#0072B2', '#00446b'] : ['hsl(215,85%,55%)', 'hsl(215,80%,33%)'];
  if (colorblind) {
    const c = SAFE_COLORS[id % SAFE_COLORS.length];
    return [c, `color-mix(in srgb, ${c} 55%, black)`];
  }
  const hue = playerHue(id);
  return [`hsl(${hue},78%,54%)`, `hsl(${hue},70%,34%)`];
}

export class Assets {
  constructor() {
    this.sprites = {};      // name -> canvas
    this.templates = {};    // player view -> SVG text with colour placeholders
    this.players = new Map(); // `${body}:${view}` -> canvas | 'loading'
    this.pixelPlayers = new Map(); // `${body}:${shade}:${view}:${frame}` -> canvas
    this.glow = null;
  }

  async load() {
    const fetchText = (n) => fetch(`assets/${n}.svg`).then((r) => r.text());
    await Promise.all([
      ...STATIC.map(async (n) => { this.sprites[n] = rasterize(await svgImage(await fetchText(n)), SPRITE_PX); }),
      ...PLAYER_VIEWS.map(async (n) => { this.templates[n] = await fetchText(n); }),
    ]);
    this.glow = this.makeGlow();
    this.setPixelSeed(1);
  }

  /** (Re)generates the pixel-art tiles from a seed; sprites never change. */
  setPixelSeed(seed) {
    this.pixelSprites ??= buildPixelSprites();
    this.pixel = { ...buildPixelTiles(seed), ...this.pixelSprites };
  }

  /** Pixel-art player sprite, built once per colour, view and walk frame. */
  pixelPlayer(colors, view, frame) {
    const key = `${colors[0]}:${colors[1]}:${view}:${frame}`;
    let c = this.pixelPlayers.get(key);
    if (!c) this.pixelPlayers.set(key, (c = pixelPlayer(colors, view, frame)));
    return c;
  }

  /** A map tile in the chosen style: 'pixel' art or the 'classic' vector look. */
  tile(name, style) {
    return (style === 'pixel' && this.pixel[name]) || this.sprites[name];
  }

  sprite(name) {
    return this.sprites[name];
  }

  /** Soft radial light used for additive glows. */
  makeGlow() {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, 'rgba(255,220,140,0.9)');
    grad.addColorStop(0.35, 'rgba(255,140,40,0.45)');
    grad.addColorStop(1, 'rgba(255,60,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    return c;
  }

  /** Tinted player sprite; returns null while the variant is being built. */
  player([body, shade], view) {
    const key = `${body}:${view}`;
    const c = this.players.get(key);
    if (c && c !== 'loading') return c;
    if (!c) {
      this.players.set(key, 'loading');
      const svg = this.templates[view]
        .replaceAll('#BODYDARK', shade)
        .replaceAll('#BODY', body);
      svgImage(svg).then((img) => this.players.set(key, rasterize(img, SPRITE_PX)));
    }
    return null;
  }
}
