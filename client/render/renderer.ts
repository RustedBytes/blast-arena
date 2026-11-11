// The renderer: composes the layers in client/render/ into one frame.
// Static tiles are pre-rendered into chunk canvases that are redrawn only
// when a tile in them changes; entities are drawn from a pooled,
// interpolated frame; effects come from a fixed particle pool. The
// per-frame path allocates almost nothing.

import type { Assets, TileStyle } from '../assets.js';
import type { Particles } from '../particles.js';
import type { GameMap, GameState } from '../state.js';
import { clampCam } from './shapes.js';
import { EffectsLayer } from './effects.js';
import { EventLayer } from './events.js';
import { Interpolator } from './interpolate.js';
import { Minimap } from './minimap.js';
import { ObjectLayer } from './objects.js';
import { PlayerLayer } from './players.js';
import { Stage } from './stage.js';
import { TileLayer } from './tiles.js';
import type { Frame, FrameBomb } from './types.js';
import { WardenLayer } from './warden.js';
import { MonsterLayer } from './monsters.js';
import { WormLayer } from './worms.js';

export class Renderer {
  /** Zoom limits, set by resize(). */
  minZoom = 0.4;
  maxZoom = 2.2;
  /** The atomic bomb whose zone the local player is in (for the alerts), or null. */
  inNukeZone: FrameBomb | null = null;

  readonly tiles: TileLayer;
  readonly effects: EffectsLayer;
  readonly events: EventLayer;
  readonly objects: ObjectLayer;
  readonly players: PlayerLayer;
  private readonly s: Stage;
  private readonly worms: WormLayer;
  private readonly monsters: MonsterLayer;
  private readonly warden: WardenLayer;
  private readonly minimapLayer: Minimap;
  private readonly interpolator: Interpolator;

  constructor(readonly canvas: HTMLCanvasElement, minimap: HTMLCanvasElement, assets: Assets, readonly particles: Particles) {
    const s = (this.s = new Stage(canvas, assets, particles));
    this.tiles = new TileLayer(s);
    this.players = new PlayerLayer(s);
    this.effects = new EffectsLayer(s, this.players);
    this.events = new EventLayer(s);
    this.objects = new ObjectLayer(s);
    this.worms = new WormLayer(s);
    this.monsters = new MonsterLayer(s);
    this.warden = new WardenLayer(s);
    this.minimapLayer = new Minimap(s, minimap, this.warden, this.events);
    this.interpolator = new Interpolator(s);
  }

  get ctx(): CanvasRenderingContext2D { return this.s.ctx; }
  /** Tile size in pixels at the current zoom. */
  get T(): number { return this.s.T; }
  /** Camera position in pixels (top-left of the view). */
  get camX(): number { return this.s.camX; }
  get camY(): number { return this.s.camY; }
  /** Interpolated entities of the current frame. */
  get frame(): Frame { return this.s.frame; }

  get tileStyle(): TileStyle { return this.s.tileStyle; }
  set tileStyle(style: TileStyle) { this.s.tileStyle = style; }
  get highContrast(): boolean { return this.s.highContrast; }
  set highContrast(on: boolean) { this.s.highContrast = on; }
  get colorblind(): boolean { return this.s.colorblind; }
  set colorblind(on: boolean) { this.s.colorblind = on; }

  /** When the minimap overlay was last drawn (ms); set 0 to redraw it next frame. */
  get lastMinimap(): number { return this.minimapLayer.lastMinimap; }
  set lastMinimap(ms: number) { this.minimapLayer.lastMinimap = ms; }

  /** Recomputes the base tile size so the default view matches the server's default area. */
  resize(aoi: readonly [number, number], aoiMax: readonly [number, number]): void {
    const s = this.s;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.round(innerWidth * dpr), h = Math.round(innerHeight * dpr);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    if (s.dpr !== dpr) {
      s.dpr = dpr;
      this.players.forgetLooks();
      this.minimapLayer.invalidate();
    }
    // A hidden page can report 0x0; keep the last good sizes until it's shown.
    if (w === 0 || h === 0) return;
    s.baseT = Math.max(w / (2 * aoi[0] - 1), h / (2 * aoi[1] - 1));
    // Zooming out may show at most the largest area the server will send.
    const minT = Math.max(w / (2 * aoiMax[0] - 1), h / (2 * aoiMax[1] - 1));
    this.minZoom = Math.max(0.4, minT / s.baseT);
    this.maxZoom = 2.2;
  }

  /** Half extents in tiles the current zoom needs from the server. */
  viewHalfExtents(zoom: number): [number, number] {
    const T = this.s.baseT * zoom;
    return [Math.ceil(this.canvas.width / T / 2) + 1, Math.ceil(this.canvas.height / T / 2) + 1];
  }

  /** A tile changed. */
  invalidateTile(map: GameMap, x: number, y: number): void {
    this.minimapLayer.invalidate();
    this.tiles.invalidate(map, x, y);
  }

  /** The art style or palette changed: repaint everything. */
  invalidateAll(): void {
    this.tiles.invalidateAll();
    this.players.forgetLooks();
  }

  /** Called on welcome: forget everything cached about the old map. */
  resetMap(map: GameMap): void {
    this.tiles.reset(map);
    this.minimapLayer.invalidate();
    this.players.forgetLooks();
    this.effects.reset();
    this.s.blood.reset();
  }

  draw(state: GameState, now: number, dt: number): void {
    const s = this.s;
    const { ctx } = s;
    const W = this.canvas.width, H = this.canvas.height;
    const { map } = state;
    const T = (s.T = s.baseT * state.zoom);
    this.interpolator.interpolate(state, now);
    const f = s.frame;
    const sec = now / 1000;

    // Camera follows the focus (yourself, or whoever you're watching).
    s.shake = Math.max(s.shake * Math.exp(-dt * 7), this.events.quake(map, state.focus, now));
    const sx = (Math.random() - 0.5) * s.shake * T, sy = (Math.random() - 0.5) * s.shake * T;
    s.camX = clampCam(state.focus.x * T - W / 2, map.w * T, W);
    s.camY = clampCam(state.focus.y * T - H / 2, map.h * T, H);
    const camX = Math.round(s.camX + sx), camY = Math.round(s.camY + sy);

    // The chunks cover the whole view unless the map is smaller than it.
    if (camX < 0 || camY < 0 || camX + W > map.w * T || camY + H > map.h * T) {
      ctx.fillStyle = '#1b2a17';
      ctx.fillRect(0, 0, W, H);
    }

    // Ground: tiles, animated tiles, hills, the vault, scorch marks, map events.
    this.tiles.drawChunks(map, camX, camY, T, W, H);
    this.tiles.drawSpecials(camX, camY, T, sec, W, H);
    this.events.drawHills(state.hills, camX, camY, T, sec);
    this.warden.drawVault(state, camX, camY, T, sec);
    this.effects.drawDecals(map, now, camX, camY, T);
    s.blood.draw(ctx, now, camX, camY, T, W, H);
    this.events.drawGroundEvents(state, now, camX, camY, T, sec, W, H);

    // Objects on the ground.
    this.objects.drawPortals(state, camX, camY, T, sec);
    const inZone = this.objects.drawNukeZones(state, f, camX, camY, T, sec);
    this.inNukeZone = inZone;
    this.objects.drawItems(state.items, camX, camY, T, sec, W, H);
    this.objects.drawBombs(f, camX, camY, T, sec, dt);
    this.effects.drawExplosions(state.explosions, camX, camY, T);
    this.effects.drawNukeGround(now, camX, camY, T);
    this.objects.drawGas(state, camX, camY, T, sec, dt);
    this.worms.drawWorms(camX, camY, T, sec, W, H);
    this.monsters.drawMonsters(camX, camY, T, sec, W, H);
    this.warden.drawWarden(state, camX, camY, T, sec);

    // Players, back to front.
    this.players.sortByDepth(f);
    for (let i = 0; i < f.nPlayers; i++) this.players.drawPlayer(f.players[i], camX, camY, T, sec, dt, state);
    this.players.endFrame();
    this.objects.drawStuckBombs(f, camX, camY, T, sec);

    // Effects and overlays above everything.
    this.particles.pixel = s.tileStyle === 'pixel';
    this.particles.draw(ctx, camX, camY, T);
    this.effects.drawEffects(now, camX, camY, T);
    this.effects.drawNukeCloud(now, camX, camY, T);
    this.events.drawSky(now, camX, camY, T, sec);
    this.events.drawZone(state, now, camX, camY, T, sec, W, H);
    for (let i = 0; i < f.nPlayers; i++) this.players.drawName(f.players[i], camX, camY, T, state, now);
    this.objects.drawNukeCountdowns(f, camX, camY, T);
    if (inZone) this.objects.drawRunWarning(state, inZone, camX, camY, T, sec);
    this.events.drawWeather(now, dt, W, H);
    if (s.replaying) this.events.drawReplayFrame(sec, W, H);
    this.effects.drawFlash(now, W, H);
    // (The vignette is a CSS overlay: the compositor blends it for free.)

    this.minimapLayer.update(state, now);
  }
}
