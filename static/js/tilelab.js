// Tile Lab: previews the pixel-art tile generator. It paints a sample map
// with the game's own renderer, so shadows, biome borders and variants look
// exactly as they do in play, and lists every generated tile.

import { Assets } from './assets.js';
import { buildPixelTiles } from './pixelart.js';
import { Particles } from './particles.js';
import { Renderer, T_ARMORED, T_CRATE, T_FLOOR, T_ICE, T_TELEPORT, T_WALL, biome } from './render.js';

const SIZE = 49;
const CHUNK = 8;
const BIOMES = ['meadow', 'snow', 'desert', 'volcano'];
const $ = (id) => document.getElementById(id);

/** Small seeded generator for the sample map (separate from the art seed). */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** A map laid out like the server's: pillar grid, crates, and each region's features. */
function sampleMap() {
  const rand = rng(7);
  const map = { w: SIZE, h: SIZE, tiles: new Uint8Array(SIZE * SIZE) };
  const set = (x, y, t) => { map.tiles[y * SIZE + x] = t; };
  const get = (x, y) => map.tiles[y * SIZE + x];
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
await assets.load();
const renderer = new Renderer(document.createElement('canvas'), document.createElement('canvas'), assets, new Particles(16));
const map = sampleMap();

function drawMap() {
  const out = $('map');
  const chunkPx = CHUNK * 64;
  out.width = out.height = SIZE * 64;
  const g = out.getContext('2d');
  const chunk = document.createElement('canvas');
  chunk.width = chunk.height = chunkPx;
  for (let cy = 0; cy * CHUNK < SIZE; cy++) {
    for (let cx = 0; cx * CHUNK < SIZE; cx++) {
      renderer.paintChunk(chunk, map, cx, cy);
      g.drawImage(chunk, cx * chunkPx, cy * chunkPx);
    }
  }
}

function figure(canvas, caption, under) {
  const f = document.createElement('figure');
  const c = document.createElement('canvas');
  c.width = c.height = 16;
  const g = c.getContext('2d');
  if (under) g.drawImage(under, 0, 0);
  g.drawImage(canvas, 0, 0);
  const cap = document.createElement('figcaption');
  cap.textContent = caption;
  f.append(c, cap);
  return f;
}

function section(title, figures) {
  const h = document.createElement('h2');
  h.textContent = title;
  const div = document.createElement('div');
  div.className = 'sheet';
  div.append(...figures);
  $('sheet').append(h, div);
}

function drawSheet(px) {
  $('sheet').replaceChildren();
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
  section('Shadows (on grass)', px.shadows.slice(1).map((c, i) => figure(c, masks[i + 1], grass)));
  const dirs = ['from north', 'from east', 'from south', 'from west'];
  section('Biome borders (on desert sand)', px.edges.flatMap((ds, b) => (b === 2 ? [] : ds.map((c, d) => figure(c, `${BIOMES[b]} ${dirs[d]}`, px.floors[2][0])))));
}

function update() {
  const seed = Math.max(1, Math.floor(Number($('seed').value)) || 1);
  assets.pixel = buildPixelTiles(seed);
  renderer.tileStyle = $('style').value;
  drawMap();
  drawSheet(assets.pixel);
}

$('seed').addEventListener('change', update);
$('style').addEventListener('change', update);
$('reroll').addEventListener('click', () => {
  $('seed').value = 1 + Math.floor(Math.random() * 99999);
  update();
});
$('actual').addEventListener('change', (e) => $('map').classList.toggle('actual', e.target.checked));
update();
