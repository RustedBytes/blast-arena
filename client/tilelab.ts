// Tile Lab: previews the pixel-art generators. A live scene and a sample
// map are drawn by the game's own renderer, so shadows, biome borders,
// animation and effects look exactly as they do in play; below them every
// generated tile and sprite is listed.

import { Assets, ITEM_SPRITES, playerColors } from './assets.js';
import { Particles } from './particles.js';
import { Renderer, T_ARMORED, T_CRATE, T_FLOOR, T_ICE, T_TELEPORT, T_WALL, biome } from './render.js';
import type { PixelSet } from './assets.js';
import { byId, context2d, makeCanvas, setChildren } from './dom.js';
import type { PlayerView } from './pixelsprites.js';
import type { FlameEntry } from './protocol.js';
import type { Frame, FrameBomb, FramePlayer, PlayerScene } from './render.js';
import type { GameMap } from './state.js';

/** Every element of the Tile Lab page, looked up once (see app/ui.ts). */
const ui = {
  map: byId('map', HTMLCanvasElement),
  scene: byId('scene', HTMLCanvasElement),
  sheet: byId('sheet'),
  seed: byId('seed', HTMLInputElement),
  style: byId('style', HTMLSelectElement),
  reroll: byId('reroll'),
  actualSize: byId('actual', HTMLInputElement),
} as const;

const SIZE = 49;
const CHUNK = 8;
const BIOMES = ['meadow', 'snow', 'desert', 'volcano', 'crypt', 'space'];

/** Small seeded generator for the sample map (separate from the art seed). */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** A map laid out like the server's: pillar grid, crates, and each region's features. */
function sampleMap(): GameMap {
  const rand = rng(7);
  const map: GameMap = { w: SIZE, h: SIZE, tiles: new Uint8Array(SIZE * SIZE) };
  const set = (x: number, y: number, t: number): void => { map.tiles[y * SIZE + x] = t; };
  const get = (x: number, y: number): number => map.tiles[y * SIZE + x];
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const edge = x === 0 || y === 0 || x === SIZE - 1 || y === SIZE - 1;
      if (edge || (x % 2 === 0 && y % 2 === 0)) set(x, y, T_WALL);
      else if (rand() < 0.4) set(x, y, biome(map, x, y) === 3 && rand() < 0.5 ? T_ARMORED : T_CRATE);
    }
  }
  // Ice ponds in the snow, conveyor runs in the desert.
  for (let i = 0; i < 40; i++) {
    let x = 1 + Math.floor(rand() * (SIZE - 2)), y = 1 + Math.floor(rand() * (SIZE - 2));
    if (biome(map, x, y) !== 1) continue;
    for (let k = 0; k < 6; k++) {
      if (get(x, y) !== T_WALL) set(x, y, T_ICE);
      x = Math.max(1, Math.min(SIZE - 2, x + (rand() < 0.5 ? 1 : -1)));
      y = Math.max(1, Math.min(SIZE - 2, y + (rand() < 0.5 ? 1 : -1)));
    }
  }
  for (let y = 1; y < SIZE - 1; y += 2) {
    for (let x = 1; x < SIZE - 6; x++) {
      if (biome(map, x, y) === 2 && rand() < 0.06) {
        const t = rand() < 0.5 ? 5 : 7;
        for (let k = 0; k < 5; k++) set(x + k, y, t);
        x += 6;
      }
    }
  }
  for (const [x, y] of [[9, 9], [39, 39], [9, 39], [39, 9], [24, 25]]) set(x, y, T_TELEPORT);
  // Clear a little plaza in the middle so floors and shadows show.
  for (let y = 21; y <= 27; y++) for (let x = 21; x <= 27; x++) if (get(x, y) !== T_WALL && get(x, y) !== T_TELEPORT) set(x, y, T_FLOOR);
  return map;
}

const assets = new Assets();
const renderer = new Renderer(document.createElement('canvas'), document.createElement('canvas'), assets, new Particles(16));
const map = sampleMap();

function drawMap(): void {
  const out = ui.map;
  const chunkPx = CHUNK * 64;
  out.width = out.height = SIZE * 64;
  const g = context2d(out);
  const chunk = makeCanvas(chunkPx);
  for (let cy = 0; cy * CHUNK < SIZE; cy++) {
    for (let cx = 0; cx * CHUNK < SIZE; cx++) {
      renderer.tiles.paintChunk(chunk, map, cx, cy);
      g.drawImage(chunk, cx * chunkPx, cy * chunkPx);
    }
  }
}

function figure(canvas: CanvasImageSource, caption: string, under?: CanvasImageSource): HTMLElement {
  const f = document.createElement('figure');
  // Tiles are 16px and sprites 64px (4x); both are shown at 64px, crisp.
  const c = makeCanvas(64);
  const g = context2d(c);
  g.imageSmoothingEnabled = false;
  for (const img of [under, canvas]) if (img) g.drawImage(img, 0, 0, 64, 64);
  const cap = document.createElement('figcaption');
  cap.textContent = caption;
  f.append(c, cap);
  return f;
}

function section(title: string, figures: HTMLElement[]): void {
  const h = document.createElement('h2');
  h.textContent = title;
  const div = document.createElement('div');
  div.className = 'sheet';
  div.append(...figures);
  ui.sheet.append(h, div);
}

function drawSheet(px: PixelSet): void {
  const grass = px.floors[0][0];
  section('Floors', px.floors.flatMap((vs, b) => vs.map((c, i) => figure(c, `${BIOMES[b]} ${i + 1}`))));
  section('Pillars', px.pillars.flatMap((vs, b) => vs.map((c, i) => figure(c, `${BIOMES[b]} ${i + 1}`))));
  section('Crates and special tiles', [
    figure(px.crate, 'crate', grass),
    figure(px.crate_armored, 'armored', grass),
    figure(px.ice, 'ice'),
    figure(px.conveyor, 'conveyor'),
    figure(px.teleport, 'teleport', grass),
  ]);
  const masks = ['', 'north', 'west', 'north+west', 'north-west', 'north + nw', 'west + nw', 'all'];
  section('Shadows (on grass)', px.shadows.flatMap((c, i) => (c ? [figure(c, masks[i], grass)] : [])));
  const dirs = ['from north', 'from east', 'from south', 'from west'];
  section('Biome borders (on desert sand)', px.edges.flatMap((ds, b) => (b === 2 ? [] : ds.map((c, d) => figure(c, `${BIOMES[b]} ${dirs[d]}`, px.floors[2][0])))));
}

function drawSprites(px: PixelSet): void {
  const grass = px.floors[0][0];
  section('Bombs and fire', [
    figure(px.bomb, 'bomb', grass),
    figure(px.bomb_pierce, 'pierce bomb', grass),
    figure(px.antenna[1], 'remote (on)', px.bomb),
    figure(px.scorch, 'scorch', grass),
    ...(['center', 'arm', 'end'] as const).flatMap((part) => px.flames[part].map((c, i) => figure(c, `${part} ${i + 1}`, grass))),
  ]);
  const names = ['bomb', 'range', 'speed', 'kick', 'shield', 'pierce', 'full fire', 'secret box', 'remote', 'line', 'punch', 'ghost'];
  section('Power-ups', ITEM_SPRITES.flatMap((n, kind) => (n ? [figure(assets.tile(n, 'pixel'), names[kind - 1] ?? n, grass)] : [])));
  const players: HTMLElement[] = [];
  for (const [id, team] of [[1, 1], [2, 2], [3, 0], [7, 0]]) {
    const colors = playerColors(id, team, false);
    const views: readonly PlayerView[] = ['down', 'up', 'side'];
    for (const view of views) {
      for (let frame = 0; frame < 3; frame++) {
        if (view === 'side' && frame === 2) continue;
        players.push(figure(assets.pixelPlayer(colors, view, frame), `${view} ${frame ? `step ${frame}` : 'stand'}`, grass));
      }
    }
  }
  section('Players (red team, blue team, two solo colours)', players);
  const hats = ['cap', 'party hat', 'horns', 'halo', 'crown', 'top hat'];
  section('Hats', px.hats.flatMap((h, id) => (h ? [figure(h.canvas, hats[id - 1] ?? `hat ${id}`, grass)] : [])));
  const monsters = ['slime', 'skeleton', 'bat'];
  section('Dungeon monsters (on flagstones)', px.monsters.flatMap((frames, k) => frames.map((c, i) => figure(c, `${monsters[k]} ${i + 1}`, px.floors[4][0]))));
}

// ------------------------------------------------------------- live scene

// A second renderer draws straight into the scene canvas, so players,
// bombs, fire and particles are animated by the game's own code.
const sceneRenderer = new Renderer(ui.scene, document.createElement('canvas'), assets, new Particles(512));
const SCENE = { w: 12, h: 5 };
const sceneMap: GameMap = { w: SCENE.w, h: SCENE.h, tiles: new Uint8Array(SCENE.w * SCENE.h) };
for (const [x, y] of [[0, 0], [11, 0], [4, 1], [7, 1], [0, 4], [11, 4]]) sceneMap.tiles[y * SCENE.w + x] = T_WALL;
for (const [x, y] of [[5, 0], [6, 4], [10, 2]]) sceneMap.tiles[y * SCENE.w + x] = T_CRATE;
sceneMap.tiles[1 * SCENE.w + 9] = T_ARMORED;
const sceneState: PlayerScene = {
  map: sceneMap,
  myId: 1,
  emotes: new Map(),
  rosterInfo: new Map([
    [1, { name: 'You', team: 1, hat: 5, trail: 1 }],
    [2, { name: 'Blue', team: 2, hat: 6, trail: 0 }],
    [3, { name: 'Solo', team: 0, hat: 2, trail: 3 }],
    [7, { name: 'Ghost', team: 0, hat: 4, trail: 2 }],
  ]),
};
const sceneItems: [number, number, number][] = [[1, 3, 1], [2, 3, 2], [3, 3, 3], [4, 3, 8], [5, 3, 5], [6, 3, 7]];
const bomb = (o: Partial<FrameBomb>): FrameBomb => ({
  x: 0, y: 0, fuse: 0, pierce: false, remote: false, nuke: false, freeze: false, rocket: false, mine: false, sticky: false,
  gas: false, carrier: 0, dx: 0, dy: 0, bolt: 0, ...o,
});
const bombs: Frame = {
  nBombs: 3,
  bombs: [
    bomb({ x: 1, y: 1, fuse: 40 }),
    bomb({ x: 2, y: 1, fuse: 40, pierce: true }),
    bomb({ x: 3, y: 1, fuse: 0, remote: true }),
  ],
  players: [], nPlayers: 0, drones: [], nDrones: 0,
};
const player = (o: Partial<FramePlayer> & { id: number }): FramePlayer => ({
  x: 0, y: 0, facing: 3, moving: false, shield: false, cursed: false, ghost: false, bounty: false, jumpDir: 0, lift: 0,
  stunned: false, carrying: false, dashing: false, gassed: false, hurt: false, wounded: false, clone: 0, anim: o.id, ...o,
});
let sceneLast = performance.now();

function drawScene(now: number): void {
  const r = sceneRenderer, c = r.canvas, T = 48;
  c.width = SCENE.w * T;
  c.height = SCENE.h * T;
  const ctx = r.ctx, sec = now / 1000, dt = Math.min(0.05, (now - sceneLast) / 1000);
  sceneLast = now;
  r.tileStyle = renderer.tileStyle;
  const chunk = document.createElement('canvas');
  chunk.width = chunk.height = CHUNK * 64;
  r.tiles.paintChunk(chunk, sceneMap, 0, 0);
  ctx.drawImage(chunk, 0, 0, CHUNK * T, CHUNK * T);
  r.tiles.paintChunk(chunk, sceneMap, 1, 0);
  ctx.drawImage(chunk, CHUNK * T, 0, CHUNK * T, CHUNK * T);
  r.objects.drawItems(sceneItems, 0, 0, T, sec, c.width, c.height);
  r.objects.drawBombs(bombs, 0, 0, T, sec, dt);
  // An explosion that goes off every two seconds.
  const left = Math.max(0, 10 - ((now / 50) % 40));
  const blast: FlameEntry = [8, 3, [1, 2, 1, 2], left, 0];
  if (left > 0) r.effects.drawExplosions([blast], 0, 0, T);
  const walk = (sec * 1.2) % 1;
  const players = [
    player({ id: 1, x: 7.5 + walk * 2, y: 2.5, facing: 2, moving: true, shield: false, cursed: false, ghost: false, bounty: true }),
    player({ id: 2, x: 10.5, y: 3.5 - walk * 0.01, facing: 1, moving: true, shield: true, cursed: false, ghost: false, bounty: false }),
    player({ id: 3, x: 1.5, y: 2.5, facing: 3, moving: true, shield: false, cursed: true, ghost: false, bounty: false }),
    player({ id: 7, x: 3.5 - walk, y: 2.5, facing: 4, moving: true, shield: false, cursed: false, ghost: true, bounty: false }),
  ];
  for (const p of players) r.players.drawPlayer(p, 0, 0, T, sec, dt, sceneState);
  r.particles.update(dt);
  r.particles.pixel = r.tileStyle === 'pixel';
  r.particles.draw(ctx, 0, 0, T);
  for (const p of players) r.players.drawName(p, 0, 0, T, sceneState, now);
  requestAnimationFrame(drawScene);
}

function update(): void {
  const seed = Math.max(1, Math.floor(Number(ui.seed.value)) || 1);
  assets.setPixelSeed(seed);
  renderer.tileStyle = ui.style.value === 'classic' ? 'classic' : 'pixel';
  drawMap();
  setChildren(ui.sheet);
  drawSheet(assets.pixel);
  drawSprites(assets.pixel);
}

ui.seed.addEventListener('change', update);
ui.style.addEventListener('change', update);
ui.reroll.addEventListener('click', () => {
  ui.seed.value = String(1 + Math.floor(Math.random() * 99999));
  update();
});
ui.actualSize.addEventListener('change', () => ui.map.classList.toggle('actual', ui.actualSize.checked));
// Start once the art is in (no top-level await: some supported browsers lack it).
assets.load().then(
  () => {
    update();
    requestAnimationFrame(drawScene);
  },
  (e: unknown) => console.error('could not load the art', e),
);
