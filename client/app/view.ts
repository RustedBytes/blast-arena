// The camera: zoom, the area of interest asked from the server, and
// watching other parts of the map from the minimap.

import { byId as $ } from '../dom.js';
import { net } from './messages.js';
import { renderer, settings } from './services.js';
import { game, state } from './session.js';

const VIEW_DEBOUNCE_MS = 200;

// ------------------------------------------------------------------- zoom

let viewTimer = 0;

export function setZoom(z: number): void {
  let zz = Math.min(renderer.maxZoom, Math.max(renderer.minZoom, z));
  if (!Number.isFinite(zz)) zz = 1;
  if (state) state.zoomTarget = zz;
  settings.set('zoom', zz);
  $('set-zoom', HTMLInputElement).value = String(zz);
  requestView();
}

// ------------------------------------------------------- watching the map
// Dragging (or clicking) the minimap moves its view box: the camera goes
// there and the server sends what's around it. The pill, or moving,
// jumping, bombing or using an item, brings the camera back.
const LOOK_SEND_MS = 100;
/** While dragging: where the box was grabbed, in tiles from its centre. */
let lookDrag: { dx: number; dy: number } | null = null;
let lookSentAt = 0;
let lookTimer = 0;

/** The map position (in tiles) under a pointer event on the minimap. */
function minimapPoint(e: PointerEvent): [number, number] {
  const state = game();
  const r = $('minimap').getBoundingClientRect();
  const scale = r.width / Math.max(state.map.w, state.map.h);
  return [(e.clientX - r.left) / scale, (e.clientY - r.top) / scale];
}

function lookAt(x: number, y: number): void {
  const state = game();
  // Only as far as the camera can go, so the box on the minimap is where
  // the view really is (and grabbing it never makes it jump).
  const T = renderer.T || 1;
  const hw = renderer.canvas.width / T / 2, hh = renderer.canvas.height / T / 2;
  const fit = (v: number, half: number, size: number): number => (2 * half >= size ? size / 2 : Math.max(half, Math.min(size - half, v)));
  state.look = { x: fit(x, hw, state.map.w), y: fit(y, hh, state.map.h) };
  $('look-pill').classList.remove('hidden');
  renderer.lastMinimap = 0; // the box moves at once, not at the next refresh
  sendLook();
}

/** Tells the server where we watch, at most every `LOOK_SEND_MS`. */
function sendLook() {
  clearTimeout(lookTimer);
  const wait = LOOK_SEND_MS - (performance.now() - lookSentAt);
  if (wait > 0) {
    lookTimer = setTimeout(sendLook, wait);
    return;
  }
  lookSentAt = performance.now();
  const l = state?.look;
  net.send({ t: 'look', at: l ? [Math.floor(l.x), Math.floor(l.y)] : null });
}

export function stopLooking() {
  if (!state?.look) return;
  state.look = null;
  lookDrag = null;
  $('minimap').classList.remove('dragging');
  $('look-pill').classList.add('hidden');
  renderer.lastMinimap = 0;
  lookSentAt = 0; // right away
  sendLook();
}

/** Tells the server how much of the arena this client's zoom needs. */
function requestView() {
  clearTimeout(viewTimer);
  viewTimer = setTimeout(() => {
    if (!state) return;
    const [w, h] = renderer.viewHalfExtents(Math.min(state.zoom, state.zoomTarget));
    net.send({ t: 'view', w, h });
  }, VIEW_DEBOUNCE_MS);
}

export function resize() {
  if (!state) return;
  renderer.resize(state.aoi, state.aoiMax);
  $('set-zoom', HTMLInputElement).min = renderer.minZoom.toFixed(2);
  $('set-zoom', HTMLInputElement).max = String(renderer.maxZoom);
  setZoom(state.zoomTarget);
}

/** Wires the minimap drag and window resizes. */
export function setupView(): void {
  $('minimap').addEventListener('pointerdown', (e) => {
    if (!state || e.button !== 0) return;
    e.preventDefault();
    const [x, y] = minimapPoint(e);
    // Grabbing the box keeps it under the pointer; clicking elsewhere centres it there.
    const T = renderer.T || 1;
    const vw = renderer.canvas.width / T, vh = renderer.canvas.height / T;
    const cx = renderer.camX / T + vw / 2, cy = renderer.camY / T + vh / 2;
    const grabbed = Math.abs(x - cx) <= vw / 2 && Math.abs(y - cy) <= vh / 2;
    lookDrag = grabbed ? { dx: cx - x, dy: cy - y } : { dx: 0, dy: 0 };
    $('minimap').classList.add('dragging');
    try {
      $('minimap').setPointerCapture(e.pointerId); // keep dragging outside the minimap
    } catch { /* a pointer that's already gone: just this click */ }
    lookAt(x + lookDrag.dx, y + lookDrag.dy);
  });
  $('minimap').addEventListener('pointermove', (e) => {
    if (!lookDrag || !state) return;
    const [x, y] = minimapPoint(e);
    lookAt(x + lookDrag.dx, y + lookDrag.dy);
  });
  for (const end of ['pointerup', 'pointercancel']) {
    $('minimap').addEventListener(end, () => {
      lookDrag = null;
      $('minimap').classList.remove('dragging');
    });
  }
  $('look-pill').addEventListener('click', stopLooking);
  addEventListener('resize', resize);
  // Moving the window to a screen with another pixel ratio (or browser zoom)
  // changes devicePixelRatio, which doesn't always fire 'resize'.
  (function watchDpr() {
    matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener('change', () => { resize(); watchDpr(); }, { once: true });
  })();
}

/** A new game watches your own player (the server too). */
export function forgetLook(): void {
  lookDrag = null;
  $('look-pill').classList.add('hidden');
  net.send({ t: 'look', at: null });
}

/** Whether the minimap's view box is being dragged. */
export function isDraggingLook(): boolean {
  return lookDrag !== null;
}
