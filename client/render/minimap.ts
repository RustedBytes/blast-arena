// The minimap: a tile layer rebuilt only when tiles change, and an overlay
// (view box, hills, zone, players) redrawn every MINIMAP_MS.

import { context2d } from '../dom.js';
import { GUARD_FLAG, MONSTER_FLAG, WORM_FLAG } from '../protocol.js';
import type { GameState } from '../state.js';
import { biome, BIOME_CRYPT, CONVEYOR_DIR, EVENT_BLIZZARD, MINIMAP_MS, NUKE_RADIUS, T_ARMORED, T_BUILT, T_CRATE, T_ICE, T_TELEPORT, T_WALL, TEAM_COLORS } from './constants.js';
import type { EventLayer } from './events.js';
import type { Stage } from './stage.js';
import type { WardenLayer } from './warden.js';

export class Minimap {
  /** When the overlay was last drawn (ms); 0 redraws it next frame. */
  lastMinimap = 0;
  private readonly mctx: CanvasRenderingContext2D;
  private readonly mapImage = document.createElement('canvas');
  private mapPixels: ImageData | null = null;
  /** The tile layer needs rebuilding. */
  private mapDirty = true;

  constructor(
    private readonly s: Stage,
    private readonly minimap: HTMLCanvasElement,
    private readonly warden: WardenLayer,
    private readonly events: EventLayer,
  ) {
    this.mctx = context2d(minimap);
  }

  /** The tiles changed: rebuild the tile layer on the next draw. */
  invalidate(): void {
    this.mapDirty = true;
  }

  /** Draws the minimap if its refresh period has passed. */
  update(state: GameState, now: number): void {
    if (now - this.lastMinimap <= MINIMAP_MS) return;
    this.lastMinimap = now;
    this.drawMinimap(state);
  }

  /**
   * Minimap: the tile layer is rebuilt only when tiles change; the overlay
   * (view box, hills, players) is redrawn every MINIMAP_MS. The canvas has
   * a device-pixel backing store, so it stays sharp on high-DPI screens.
   */
  drawMinimap(state: GameState) {
    const { map } = state;
    const m = this.minimap, c = this.mctx;
    // Hidden (the setting, touch layout, small screens): nothing to draw.
    if (!m.offsetWidth) return;
    // Its CSS size comes from the settings; the backing store follows it.
    const size = Math.round(m.offsetWidth * this.s.dpr);
    if (m.width !== size || m.height !== size) {
      m.width = m.height = size;
    }
    if (this.mapImage.width !== map.w || this.mapImage.height !== map.h || !this.mapPixels) {
      this.mapImage.width = map.w;
      this.mapImage.height = map.h;
      this.mapPixels = context2d(this.mapImage).createImageData(map.w, map.h);
      this.mapDirty = true;
    }
    if (this.mapDirty) {
      this.mapDirty = false;
      const data = this.mapPixels.data;
      for (let i = 0; i < map.tiles.length; i++) {
        const t = map.tiles[i], o = i * 4;
        // Grass, or dungeon flagstones in the crypt.
        let [r, g, b] = biome(map, i % map.w, Math.floor(i / map.w)) === BIOME_CRYPT ? [92, 84, 74] : [70, 135, 50];
        if (t === T_WALL) { r = 120; g = 128; b = 138; }
        else if (t === T_CRATE) { r = 150; g = 100; b = 52; }
        else if (t === T_ARMORED) { r = 95; g = 80; b = 70; }
        else if (t === T_BUILT) { r = 210; g = 120; b = 60; }
        else if (t === T_ICE) { r = 170; g = 225; b = 245; }
        else if (t === T_TELEPORT) { r = 185; g = 140; b = 255; }
        else if (CONVEYOR_DIR[t]) { r = 70; g = 74; b = 84; }
        data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255;
      }
      context2d(this.mapImage).putImageData(this.mapPixels, 0, 0);
    }
    const scale = size / Math.max(map.w, map.h);
    c.imageSmoothingEnabled = false;
    c.clearRect(0, 0, size, size);
    c.drawImage(this.mapImage, 0, 0, map.w * scale, map.h * scale);
    c.fillStyle = 'rgba(255,211,74,0.8)';
    for (const [hx, hy] of state.hills) c.fillRect((hx - 1) * scale, (hy - 1) * scale, 3 * scale, 3 * scale);
    // Battle royale: the zone and the next circle.
    const nz = state.zone;
    if (nz && state.royale?.on !== false) {
      const zone = this.events.zoneNow(nz, performance.now());
      c.save();
      c.fillStyle = 'rgba(40,80,220,0.45)';
      c.beginPath();
      c.rect(0, 0, size, size);
      c.moveTo((zone.x + zone.r) * scale, zone.y * scale);
      c.arc(zone.x * scale, zone.y * scale, Math.max(0, zone.r * scale), 0, 6.2832, true);
      c.fill('evenodd');
      c.strokeStyle = '#8ab8ff';
      c.lineWidth = this.s.dpr * 1.5;
      c.stroke();
      if (nz.state === 0 || nz.state === 1) {
        c.strokeStyle = '#ffffff';
        c.beginPath();
        c.arc(nz.to.x * scale, nz.to.y * scale, Math.max(1, nz.to.r * scale), 0, 6.2832);
        c.stroke();
      }
      c.restore();
    }
    // The vault (gold) and its Warden.
    const guard = this.warden.guardInfo(state);
    if (guard) {
      const [x0, y0, x1, y1] = guard.vault;
      c.strokeStyle = '#ffcf4a';
      c.lineWidth = this.s.dpr * 1.5;
      c.strokeRect(x0 * scale, y0 * scale, (x1 - x0 + 1) * scale, (y1 - y0 + 1) * scale);
      c.fillStyle = 'rgba(255,207,74,0.3)';
      c.fillRect(x0 * scale, y0 * scale, (x1 - x0 + 1) * scale, (y1 - y0 + 1) * scale);
      const wd = guard.warden;
      if (wd) {
        const s = Math.max(this.s.dpr * 5, scale * 2);
        c.fillStyle = '#16171d';
        c.fillRect((wd[1] + 0.5) * scale - s / 2 - this.s.dpr, (wd[2] + 0.5) * scale - s / 2 - this.s.dpr, s + 2 * this.s.dpr, s + 2 * this.s.dpr);
        c.fillStyle = wd[5] & GUARD_FLAG.ENRAGED ? '#ff4a2a' : wd[5] & GUARD_FLAG.HUNTING ? '#ff9a3a' : '#ffd25a';
        c.fillRect((wd[1] + 0.5) * scale - s / 2, (wd[2] + 0.5) * scale - s / 2, s, s);
      }
    }
    // Ticking atomic bombs: their danger zones.
    const fb = this.s.frame;
    for (let i = 0; i < fb.nBombs; i++) {
      const b = fb.bombs[i];
      if (!b.nuke) continue;
      c.beginPath();
      c.arc((Math.round(b.x) + 0.5) * scale, (Math.round(b.y) + 0.5) * scale, (NUKE_RADIUS + 0.5) * scale, 0, 6.2832);
      c.fillStyle = 'rgba(255,40,20,0.35)';
      c.fill();
      c.strokeStyle = '#ff5a3a';
      c.lineWidth = this.s.dpr * 1.5;
      c.stroke();
    }
    if (state.sd) {
      const r = state.sd.r;
      c.strokeStyle = '#ff5a3a';
      c.lineWidth = this.s.dpr * 1.5;
      c.strokeRect((state.sd.cx - r + 1) * scale, (state.sd.cy - r + 1) * scale, (2 * r - 1) * scale, (2 * r - 1) * scale);
    }
    if (state.flags) {
      for (let k = 0; k < 2; k++) {
        const f = state.flags[k];
        let fx = f.pos[0] + 0.5, fy = f.pos[1] + 0.5;
        if (f.state === 1) {
          // Carried: show it on the carrier, if in view.
          const fr = this.s.frame;
          let found = false;
          for (let i = 0; i < fr.nPlayers; i++) {
            if (fr.players[i].id === f.carrier) { fx = fr.players[i].x; fy = fr.players[i].y; found = true; }
          }
          if (!found) continue;
        }
        c.fillStyle = TEAM_COLORS[k + 1];
        c.fillRect(fx * scale - 3 * this.s.dpr, fy * scale - 3 * this.s.dpr, 6 * this.s.dpr, 6 * this.s.dpr);
      }
    }
    const T = this.s.T;
    // The view box (yellow while watching elsewhere: drag it to look around).
    c.strokeStyle = state.look ? '#ffd34a' : 'rgba(255,255,255,0.7)';
    c.lineWidth = this.s.dpr * (state.look ? 2 : 1);
    c.strokeRect(this.s.camX / T * scale, this.s.camY / T * scale, this.s.canvas.width / T * scale, this.s.canvas.height / T * scale);
    const f = this.s.frame;
    const dot = this.s.dpr * 1.5;
    // Worms, wherever they are: the body when in view, else the head.
    for (const [, flags, , , cells] of state.snaps.latest().x.worms) {
      const n = flags & WORM_FLAG.FAR ? 1 : cells.length / 2 - 1;
      for (let i = n - 1; i >= 0; i--) {
        const s = i === 0 ? Math.max(dot * 3.4, scale * 1.6) : Math.max(dot * 2, scale);
        const x = (cells[2 * i] + 0.5) * scale - s / 2, y = (cells[2 * i + 1] + 0.5) * scale - s / 2;
        if (i === 0) {
          c.fillStyle = '#1d0818';
          c.fillRect(x - this.s.dpr, y - this.s.dpr, s + 2 * this.s.dpr, s + 2 * this.s.dpr);
        }
        c.fillStyle = flags & WORM_FLAG.CHASING ? '#ff5a8a' : '#e070ff';
        c.fillRect(x, y, s, s);
      }
    }
    // Monsters in view.
    for (const [, , flags, mx, my] of state.snaps.latest().x.monsters) {
      const s = Math.max(dot * 2, scale);
      c.fillStyle = flags & MONSTER_FLAG.CHASING ? '#ff5a8a' : '#c070ff';
      c.fillRect((mx + 0.5) * scale - s / 2, (my + 0.5) * scale - s / 2, s, s);
    }
    for (let i = 0; i < f.nPlayers; i++) {
      const p = f.players[i];
      const me = p.id === state.myId;
      const team = state.rosterInfo.get(p.id)?.team ?? 0;
      c.fillStyle = me ? '#ffd34a' : team === 1 ? '#ff5a4a' : team === 2 ? '#5aa0ff' : '#ff4a4a';
      const s = me ? dot * 2.5 : dot * 1.5;
      c.fillRect(p.x * scale - s / 2, p.y * scale - s / 2, s, s);
    }
    // A blizzard fogs the minimap.
    const w = this.events.weather;
    if (w?.kind === EVENT_BLIZZARD && performance.now() < w.end) {
      c.fillStyle = 'rgba(235,242,255,0.82)';
      c.fillRect(0, 0, size, size);
    }
  }
}
