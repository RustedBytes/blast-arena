// State shared by all render layers: the canvas, the camera, the art style
// and the pooled frame of interpolated entities.

import type { Assets, PixelSet, SpriteName, TileStyle } from '../assets.js';
import { context2d } from '../dom.js';
import type { Particles } from '../particles.js';
import { BloodTrail } from './blood.js';
import type { GameSnapshot } from '../state.js';
import { POOL } from './constants.js';
import type { Frame, FrameBomb, FramePlayer } from './types.js';

export class Stage {
  readonly ctx: CanvasRenderingContext2D;
  /** Blood drops of wounded players (dungeon arena). */
  readonly blood = new BloodTrail();
  /** Tile size in pixels at zoom 1, and at the current zoom. */
  baseT = 48;
  T = 48;
  /** Camera position in pixels (top-left of the view). */
  camX = 0;
  camY = 0;
  /** Screen shake strength (decays every frame). */
  shake = 0;
  dpr = window.devicePixelRatio || 1;
  highContrast = false;
  colorblind = false;
  tileStyle: TileStyle = 'pixel';
  /** Whether a death replay is playing (set by the interpolator). */
  replaying = false;
  /** The snapshot worms and the Warden are drawn from, and the (fractional) tick they're drawn at. */
  wormSnap: GameSnapshot | null = null;
  wormTime = 0;
  /** Pooled frame data, reused every frame. */
  readonly frame: Frame = {
    players: Array.from({ length: POOL }, newPlayer),
    nPlayers: 0,
    bombs: Array.from({ length: POOL }, newBomb),
    nBombs: 0,
    drones: Array.from({ length: 64 }, () => ({ id: 0, x: 0, y: 0, team: 0 })),
    nDrones: 0,
  };
  private readonly fonts = new Map<number, string>();

  constructor(readonly canvas: HTMLCanvasElement, readonly assets: Assets, readonly particles: Particles) {
    this.ctx = context2d(canvas);
  }

  /** The pixel-art set when that style is on, otherwise null. */
  pixelArt(): PixelSet | null {
    return this.tileStyle === 'pixel' ? this.assets.pixel : null;
  }

  /** A sprite in the current art style (pixel art falls back to the classic one). */
  art(name: SpriteName): HTMLCanvasElement {
    return this.assets.tile(name, this.tileStyle);
  }

  /** A cached CSS font string for a size and weight. */
  font(px: number, weight: number | string) {
    const key = weight ? -px : px;
    let f = this.fonts.get(key);
    if (!f) this.fonts.set(key, (f = `${weight ? `${weight} ` : ''}${px}px system-ui, sans-serif`));
    return f;
  }
}

const newPlayer = (): FramePlayer => ({
  id: 0, x: 0, y: 0, facing: 3, moving: false, shield: false, cursed: false, ghost: false, bounty: false, jumpDir: 0,
  lift: 0, stunned: false, carrying: false, dashing: false, gassed: false, hurt: false, wounded: false, clone: 0, anim: 0,
});
const newBomb = (): FrameBomb => ({
  x: 0, y: 0, fuse: 0, pierce: false, remote: false, nuke: false, freeze: false, rocket: false, mine: false,
  sticky: false, gas: false, carrier: 0, dx: 0, dy: 0,
});
