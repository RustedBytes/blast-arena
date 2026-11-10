// Client-side prediction for the local player.
//
// The client runs the same movement rules as the server, at the same 20 Hz
// step, applying each input the moment it's pressed. Every input carries a
// sequence number; snapshots say which one the server has applied ("ack").
// On each snapshot we restart from the server's authoritative position and
// replay the inputs it hasn't seen yet, so controls feel instant on any
// ping while the server stays in charge.
//
// Latency: a changed input is sent at once, tagged with the *next* step's
// sequence number, so the server can apply it on its very next tick instead
// of up to 50 ms later. The drawn position is extrapolated from the last
// step with the input held right now, so a key press shows on the next
// frame. Any jump (a reconcile correction, or the extrapolation switching
// direction) goes into a visual offset that decays over a few frames
// instead of snapping.

const DIRS = [[0, 0], [0, -1], [1, 0], [0, 1], [-1, 0]];
const OPPOSITE = [0, 3, 4, 1, 2];
const BASE_SPEED = 3.5, SPEED_STEP = 0.6, CURSED_SPEED = 2.2, CONVEYOR_SPEED = 1.6;
const CORNER_ASSIST_MIN = 0.12;
const DT = 0.05;
const HISTORY = 64;
const T_WALL = 1, T_CRATE = 2, T_ICE = 3, T_ARMORED = 9;
const CONVEYOR = [0, 0, 0, 0, 1, 2, 3, 4]; // tile code -> direction
const SMOOTH_TAU = 0.06;   // s, decay time of visual corrections
const SNAP_DIST = 2;       // tiles: larger errors jump instead of gliding

/** Port of the server's `step_move`: grid-lane movement with corner assist. */
export function stepMove(p, dir, dist, blocked) {
  const dx = DIRS[dir][0], dy = DIRS[dir][1];
  if (!dx && !dy) return;
  const horizontal = dx !== 0;
  const step = horizontal ? dx : dy;
  let main = horizontal ? p.x : p.y;
  let side = horizontal ? p.y : p.x;
  const cm = Math.floor(main), cs = Math.floor(side);
  const off = side - (cs + 0.5);
  let rem = dist;

  if (Math.abs(off) > 1e-4) {
    if (!cellAt(blocked, horizontal, cm + step, cs)) {
      const a = Math.min(rem, Math.abs(off));
      side -= a * Math.sign(off);
      rem -= a;
      if (rem <= 0) return write(p, horizontal, main, side);
    } else {
      const ns = cs + Math.sign(off);
      if (Math.abs(off) >= CORNER_ASSIST_MIN && !cellAt(blocked, horizontal, cm + step, ns) && !cellAt(blocked, horizontal, cm, ns)) {
        side += Math.min(rem, 1 - Math.abs(off)) * Math.sign(off);
      }
      return write(p, horizontal, main, side);
    }
  }
  const center = cm + 0.5;
  let next = main + step * rem;
  if (cellAt(blocked, horizontal, cm + step, cs)) {
    next = step > 0 ? Math.min(next, Math.max(center, main)) : Math.max(next, Math.min(center, main));
  }
  write(p, horizontal, next, side);
}

const cellAt = (blocked, horizontal, m, s) => (horizontal ? blocked(m, s) : blocked(s, m));
function write(p, horizontal, main, side) {
  if (horizontal) { p.x = main; p.y = side; } else { p.y = main; p.x = side; }
}

export class Predictor {
  constructor() {
    this.seq = 0;
    // Ring of recent steps: input used and position after it.
    this.hSeq = new Int32Array(HISTORY).fill(-1);
    this.hDir = new Uint8Array(HISTORY);
    this.hAlt = new Uint8Array(HISTORY);
    this.pos = { x: 0, y: 0, moving: false, slide: 0 };
    this.acc = 0;
    this.active = false;
    this.tmp = { x: 0, y: 0, moving: false, slide: 0 };
    this.ext = { x: 0, y: 0, moving: false, slide: 0 };
    // Visual offset (drawn - predicted), decaying to zero.
    this.offX = 0;
    this.offY = 0;
    // Input the extrapolation used last frame.
    this.lastD = 0;
    this.lastS = 0;
    this.lastInput = { d: 0, s: 0 };
    this.stats = { samples: 0, sumError: 0, maxError: 0, corrections: 0 };
  }

  reset(x, y) {
    this.pos.x = x;
    this.pos.y = y;
    this.pos.moving = false;
    this.offX = this.offY = 0;
    this.hSeq.fill(-1);
    this.active = true;
  }

  /**
   * The held input changed: send it right away as the next step's input,
   * so the server can use it on its next tick. The step itself still runs
   * on the regular 20 Hz clock (see `update`), which re-sends it.
   */
  inputChanged(input, send) {
    const seq = (this.seq + 1) & 0xffff;
    const k = seq % HISTORY;
    this.hSeq[k] = seq;
    this.hDir[k] = input.d;
    this.hAlt[k] = input.s;
    send(input.d, input.s, seq);
  }

  /**
   * Advances local time; for every elapsed 50 ms step, sends the current
   * input (via `send(d, s, seq)`) and applies it locally.
   */
  update(dt, input, world, send) {
    // Inputs keep flowing while inactive (dead): they also carry snapshot acks.
    this.acc += dt;
    let steps = 0;
    while (this.acc >= DT && steps < 4) {
      this.acc -= DT;
      steps++;
      const seq = this.seq = (this.seq + 1) & 0xffff;
      send(input.d, input.s, seq);
      const k = seq % HISTORY;
      this.hSeq[k] = seq;
      this.hDir[k] = input.d;
      this.hAlt[k] = input.s;
      if (!this.active) continue;
      simulate(this.pos, input.d, input.s, world, 1);
    }
    if (steps === 4) this.acc = 0; // fell far behind (tab was hidden)
  }

  /** Server snapshot: authoritative position after input `ack`. */
  reconcile(sx, sy, moving, ack, world, input) {
    if (!this.active) return;
    // Where we'd draw now, before the correction.
    this.extrapolate(input, world);
    const bx = this.ext.x, by = this.ext.y;
    const p = this.tmp;
    p.x = sx; p.y = sy; p.moving = moving; p.slide = this.pos.slide;
    // Replay the inputs the server hasn't applied yet, oldest first. An ack
    // ahead of our last step (an early-sent input) needs no replay.
    const behind = (this.seq - ack) & 0xffff;
    if (behind < HISTORY) {
      for (let i = behind - 1; i >= 0; i--) {
        const seq = (this.seq - i) & 0xffff;
        const k = seq % HISTORY;
        if (this.hSeq[k] !== seq) continue;
        simulate(p, this.hDir[k], this.hAlt[k], world, 1);
      }
    }
    const err = Math.hypot(p.x - this.pos.x, p.y - this.pos.y);
    // How far the server's view (after replay) was from our prediction.
    this.stats.samples++;
    this.stats.sumError += err;
    this.stats.maxError = Math.max(this.stats.maxError, err);
    if (err > 0.25) this.stats.corrections++;
    this.pos.x = p.x; this.pos.y = p.y; this.pos.moving = p.moving; this.pos.slide = p.slide;
    if (err > SNAP_DIST) {
      // Teleport or big desync: jump.
      this.offX = this.offY = 0;
      return;
    }
    // Glide from where we were drawn to the corrected spot.
    this.extrapolate(input, world);
    this.offX += bx - this.ext.x;
    this.offY += by - this.ext.y;
  }

  /** `ext` = the last step's position advanced by the part of a step elapsed since. */
  extrapolate(input, world) {
    const e = this.ext;
    e.x = this.pos.x; e.y = this.pos.y; e.moving = this.pos.moving; e.slide = this.pos.slide;
    const f = Math.min(1, this.acc / DT);
    if (f > 0) simulate(e, input.d, input.s, world, f);
  }

  /** Drawn position: extrapolated prediction plus the decaying correction. */
  render(out, input, world, dt) {
    if (input.d !== this.lastD || input.s !== this.lastS) {
      // The extrapolation switches direction: glide instead of jumping.
      this.lastInput.d = this.lastD;
      this.lastInput.s = this.lastS;
      this.extrapolate(this.lastInput, world);
      const ox = this.ext.x, oy = this.ext.y;
      this.extrapolate(input, world);
      this.offX += ox - this.ext.x;
      this.offY += oy - this.ext.y;
      this.lastD = input.d;
      this.lastS = input.s;
    } else {
      this.extrapolate(input, world);
    }
    const k = Math.exp(-dt / SMOOTH_TAU);
    this.offX *= k;
    this.offY *= k;
    if (Math.abs(this.offX) < 1e-4) this.offX = 0;
    if (Math.abs(this.offY) < 1e-4) this.offY = 0;
    out.x = this.ext.x + this.offX;
    out.y = this.ext.y + this.offY;
  }
}

// Collision context for `blocked`, set by `simulate` (module-level so the
// per-frame extrapolation creates no closures).
let simMap = null, simBombs = null, simGhost = false, simCx = 0, simCy = 0;

function tileAt(x, y) {
  const map = simMap;
  return x < 0 || y < 0 || x >= map.w || y >= map.h ? T_WALL : map.tiles[y * map.w + x];
}

function blocked(cx, cy) {
  const t = tileAt(cx, cy);
  if (t === T_WALL || (!simGhost && (t === T_CRATE || t === T_ARMORED))) return true;
  return (cx !== simCx || cy !== simCy) && simBombs.has(cy * simMap.w + cx);
}

/**
 * One server tick of movement for the local player (mirrors
 * update_players); `frac` < 1 moves only that part of a tick.
 */
function simulate(p, d, s, world, frac) {
  const me = world.me;
  if (!me?.alive) return;
  if (me.curse === 3) { d = OPPOSITE[d]; s = OPPOSITE[s]; }
  simMap = world.map;
  simBombs = world.bombCells;
  simGhost = me.ghost > 0;
  const sx = p.x, sy = p.y;
  simCx = Math.floor(sx);
  simCy = Math.floor(sy);
  const on = tileAt(simCx, simCy);
  const dist = (me.curse === 1 ? CURSED_SPEED : BASE_SPEED + SPEED_STEP * me.speed) * DT * frac;
  let dir = d;
  // On ice you keep sliding until you steer or hit something.
  if (dir === 0 && on === T_ICE && p.moving && p.slide) dir = p.slide;
  let used = dir;
  if (dir) stepMove(p, dir, dist, blocked);
  if (p.x === sx && p.y === sy && s && s !== dir) { stepMove(p, s, dist, blocked); used = s; }
  const belt = CONVEYOR[on] ?? 0;
  if (belt) stepMove(p, belt, CONVEYOR_SPEED * DT * frac, blocked);
  p.moving = p.x !== sx || p.y !== sy;
  if (p.moving && used) p.slide = used;
}
