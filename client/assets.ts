// Loads the SVG artwork once and rasterises it at a fixed resolution.
// Sprites are scaled at draw time, so zooming never re-rasterises anything.
// Everything also comes in a pixel-art style, generated in code (see
// pixelart.ts for tiles and pixelsprites.ts for sprites).

import { context2d, fireAndForget, makeCanvas } from './dom.js';
import { buildPixelTiles } from './pixelart.js';
import type { PixelTiles } from './pixelart.js';
import { buildPixelSprites, pixelPlayer } from './pixelsprites.js';
import type { PixelSprites, PlayerView } from './pixelsprites.js';

export type { TileStyle } from './settings.js';
import type { TileStyle } from './settings.js';

/** A player's [body, shade] CSS colours. */
export type PlayerColors = readonly [body: string, shade: string];
/** Every pixel-art tile and sprite (see `setPixelSeed`). */
export type PixelSet = PixelTiles & PixelSprites;

/** The classic SVG sprites, by file name under `assets/`. */
const SPRITES = [
  'floor', 'floor_b', 'floor_c', 'floor_sand', 'floor_snow', 'floor_ash',
  'pillar', 'crate', 'crate_armored', 'ice', 'conveyor', 'teleport',
  'bomb', 'bomb_pierce', 'scorch', 'flame_center', 'flame_arm', 'flame_end',
  'pu_bomb', 'pu_range', 'pu_speed', 'pu_kick', 'pu_shield', 'pu_pierce', 'pu_fullfire', 'pu_mystery',
  'pu_remote', 'pu_line', 'pu_punch', 'pu_ghost', 'pu_nuke', 'bomb_nuke',
  'pu_freeze', 'pu_mine', 'pu_rocket', 'pu_swap', 'pu_stomp', 'pu_drone', 'pu_swarm',
  'pu_builder', 'pu_gas', 'pu_clone', 'pu_sticky', 'pu_portal', 'pu_dash', 'pu_heart',
] as const;
export type SpriteName = (typeof SPRITES)[number];

const PLAYER_VIEWS = ['player_down', 'player_up', 'player_side'] as const;
export type ClassicPlayerView = (typeof PLAYER_VIEWS)[number];
const HUE_BUCKETS = 24;
/** Pixels per tile for every rasterised sprite. */
export const SPRITE_PX = 96;

/** Item kind (protocol code) → sprite name; 0 is no item. */
export const ITEM_SPRITES: readonly (SpriteName | null)[] = [null, 'pu_bomb', 'pu_range', 'pu_speed', 'pu_kick', 'pu_shield', 'pu_pierce',
  'pu_fullfire', 'pu_mystery', 'pu_remote', 'pu_line', 'pu_punch', 'pu_ghost', 'pu_nuke',
  'pu_freeze', 'pu_mine', 'pu_rocket', 'pu_swap', 'pu_stomp', 'pu_drone', 'pu_swarm',
  'pu_builder', 'pu_gas', 'pu_clone', 'pu_sticky', 'pu_portal', 'pu_dash', 'pu_heart'];

/** The sprite of an item kind, with the secret box for unknown kinds. */
export const itemSprite = (kind: number): SpriteName => ITEM_SPRITES[kind] ?? 'pu_mystery';

function svgImage(text: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('could not decode an SVG'));
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(text);
  });
}

async function fetchSvg(name: string): Promise<string> {
  const res = await fetch(`assets/${name}.svg`);
  if (!res.ok) throw new Error(`assets/${name}.svg: HTTP ${res.status}`);
  return res.text();
}

function rasterize(img: CanvasImageSource, size: number): HTMLCanvasElement {
  const c = makeCanvas(size);
  context2d(c).drawImage(img, 0, 0, size, size);
  return c;
}

/** Deterministic colour for a player id, spread around the hue wheel. */
export function playerHue(id: number): number {
  return Math.round(((id * 137.508) % 360) / (360 / HUE_BUCKETS)) % HUE_BUCKETS * (360 / HUE_BUCKETS);
}

// Okabe-Ito palette: distinguishable with common colour-vision deficiencies.
// Each with its shade: the colour mixed 55% with black.
const SAFE_COLORS: readonly PlayerColors[] = [
  ['#E69F00', '#7f5700'], ['#56B4E9', '#2f6380'], ['#009E73', '#00573f'], ['#F0E442', '#847d24'], ['#0072B2', '#003f62'], ['#D55E00', '#753400'], ['#CC79A7', '#70435c'], ['#999999', '#545454'],
];

/**
 * Body colour of a player: team colours in team mode, otherwise a colour
 * from their id. Returns [body, shade] as CSS colours.
 */
export function playerColors(id: number, team: number, colorblind: boolean): PlayerColors {
  if (team === 1) return colorblind ? ['#E69F00', '#8a5f00'] : ['hsl(2,80%,52%)', 'hsl(2,75%,32%)'];
  if (team === 2) return colorblind ? ['#0072B2', '#00446b'] : ['hsl(215,85%,55%)', 'hsl(215,80%,33%)'];
  if (colorblind) {
    return SAFE_COLORS[id % SAFE_COLORS.length];
  }
  const hue = playerHue(id);
  return [`hsl(${hue},78%,54%)`, `hsl(${hue},70%,34%)`];
}

export class Assets {
  /** Soft radial light used for additive glows. */
  readonly glow = makeGlow();
  private readonly sprites = new Map<SpriteName, HTMLCanvasElement>();
  /** Player view -> SVG text with colour placeholders. */
  private readonly templates = new Map<ClassicPlayerView, string>();
  /** `${body}:${view}` -> canvas, or 'loading' while it rasterises. */
  private readonly players = new Map<string, HTMLCanvasElement | 'loading'>();
  /** `${body}:${shade}:${view}:${frame}` -> canvas. */
  private readonly pixelPlayers = new Map<string, HTMLCanvasElement>();
  private readonly pixelSprites = buildPixelSprites();
  private pixelSet: PixelSet = { ...buildPixelTiles(1), ...this.pixelSprites };
  /** Every single-canvas pixel-art sprite by name, for lookups by sprite name. */
  private pixelByName = new Map<string, HTMLCanvasElement>();

  constructor() {
    this.indexPixelSprites();
  }

  /** Every pixel-art tile and sprite. */
  get pixel(): PixelSet {
    return this.pixelSet;
  }

  async load(): Promise<void> {
    await Promise.all([
      ...SPRITES.map(async (n) => { this.sprites.set(n, rasterize(await svgImage(await fetchSvg(n)), SPRITE_PX)); }),
      ...PLAYER_VIEWS.map(async (n) => { this.templates.set(n, await fetchSvg(n)); }),
    ]);
  }

  /** (Re)generates the pixel-art tiles from a seed; sprites never change. */
  setPixelSeed(seed: number): void {
    this.pixelSet = { ...buildPixelTiles(seed), ...this.pixelSprites };
    this.indexPixelSprites();
  }

  /** Pixel-art player sprite, built once per colour, view and walk frame. */
  pixelPlayer(colors: PlayerColors, view: PlayerView, frame: number): HTMLCanvasElement {
    const key = `${colors[0]}:${colors[1]}:${view}:${frame}`;
    let c = this.pixelPlayers.get(key);
    if (!c) this.pixelPlayers.set(key, (c = pixelPlayer(colors, view, frame)));
    return c;
  }

  /** A sprite in the chosen style: 'pixel' art (when there is one) or the 'classic' vector look. */
  tile(name: SpriteName, style: TileStyle): HTMLCanvasElement {
    return (style === 'pixel' ? this.pixelByName.get(name) : undefined) ?? this.sprite(name);
  }

  /** A classic sprite; they're all loaded before the first frame (see `load`). */
  sprite(name: SpriteName): HTMLCanvasElement {
    const c = this.sprites.get(name);
    if (!c) throw new Error(`sprite ${name} isn't loaded`);
    return c;
  }

  /** Tinted player sprite; returns null while the variant is being built. */
  player([body, shade]: PlayerColors, view: ClassicPlayerView): HTMLCanvasElement | null {
    const key = `${body}:${view}`;
    const c = this.players.get(key);
    if (c !== undefined) return c === 'loading' ? null : c;
    const template = this.templates.get(view);
    if (template === undefined) return null;
    this.players.set(key, 'loading');
    const svg = template.split('#BODYDARK').join(shade).split('#BODY').join(body);
    fireAndForget(svgImage(svg).then((img) => this.players.set(key, rasterize(img, SPRITE_PX))), 'player sprite');
    return null;
  }

  private indexPixelSprites(): void {
    const byName = new Map<string, HTMLCanvasElement>(Object.entries(this.pixelSprites.tokens));
    for (const [name, value] of Object.entries(this.pixelSet)) {
      if (value instanceof HTMLCanvasElement) byName.set(name, value);
    }
    this.pixelByName = byName;
  }
}

/** Soft radial light used for additive glows. */
function makeGlow(): HTMLCanvasElement {
  const c = makeCanvas(128);
  const g = context2d(c);
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,220,140,0.9)');
  grad.addColorStop(0.35, 'rgba(255,140,40,0.45)');
  grad.addColorStop(1, 'rgba(255,60,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return c;
}
