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
//
// Jumps over stone pillars are part of the input (the held jump key) and
// are simulated exactly like the server does, so they replay correctly.
// A dash starts on the server (the ability key); once a snapshot shows it,
// replay continues it the way the server does (src/game/dash.rs).

const DIRS = [[0, 0], [0, -1], [1, 0], [0, 1], [-1, 0]];
const OPPOSITE = [0, 3, 4, 1, 2];
const BASE_SPEED = 3.5, SPEED_STEP = 0.6, CURSED_SPEED = 2.2, CONVEYOR_SPEED = 1.6;
const CORNER_ASSIST_MIN = 0.12;
const DT = 0.05;
const HISTORY = 64;
const T_WALL = 1, T_CRATE = 2, T_ICE = 3, T_ARMORED = 9, T_BUILT = 10;
// Dash sub-steps stay under half a cell, like the server's.
const DASH_SUB_STEP = 0.45;
const CONVEYOR = [0, 0, 0, 0, 1, 2, 3, 4]; // tile code -> direction
// Jumping, mirroring src/game/player.rs: ticks a hop takes, cells per tick,
// cooldown after landing, and how far off the lane centre you may be.
export const JUMP_TICKS = 8;
const JUMP_STEP = 2 / JUMP_TICKS;
const JUMP_COOLDOWN_TICKS = 10;
const JUMP_LANE_SLACK = 0.5;
// Speed factor in a blizzard (src/game/events.rs BLIZZARD_SLOW).
const BLIZZARD_SLOW = 0.65;
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
    this.hJump = new Uint8Array(HISTORY);
    this.pos = newState();
    this.acc = 0;
    this.active = false;
    this.tmp = newState();
    this.ext = newState();
    /** Called when a predicted jump takes off (for sound). */
    this.onJump = null;
    // Visual offset (drawn - predicted), decaying to zero.
    this.offX = 0;
    this.offY = 0;
    // Input the extrapolation used last frame.
    this.lastD = 0;
    this.lastS = 0;
    this.lastJ = false;
    this.lastInput = { d: 0, s: 0, j: false };
    this.stats = { samples: 0, sumError: 0, maxError: 0, corrections: 0 };
  }

  reset(x, y, facing = 3) {
    Object.assign(this.pos, newState());
    this.pos.x = x;
    this.pos.y = y;
    this.pos.facing = facing;
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
    this.hJump[k] = input.j ? 1 : 0;
    send(input.d, input.s, input.j, seq);
  }

  /**
   * Advances local time; for every elapsed 50 ms step, sends the current
   * input (via `send(d, s, j, seq)`) and applies it locally.
   */
  update(dt, input, world, send) {
    // Inputs keep flowing while inactive (dead): they also carry snapshot acks.
    this.acc += dt;
    let steps = 0;
    while (this.acc >= DT && steps < 4) {
      this.acc -= DT;
      steps++;
      const seq = this.seq = (this.seq + 1) & 0xffff;
      send(input.d, input.s, input.j, seq);
      const k = seq % HISTORY;
      this.hSeq[k] = seq;
      this.hDir[k] = input.d;
      this.hAlt[k] = input.s;
      this.hJump[k] = input.j ? 1 : 0;
      if (!this.active) continue;
      const wasJumping = this.pos.jumpLeft > 0;
      simulate(this.pos, input.d, input.s, input.j, world, 1);
      if (!wasJumping && this.pos.jumpLeft > 0) this.onJump?.();
    }
    if (steps === 4) this.acc = 0; // fell far behind (tab was hidden)
  }

  /**
   * Server snapshot: authoritative state after input `ack` (position, facing,
   * and the jump state from `world.me`).
   */
  reconcile(sx, sy, moving, facing, ack, world, input) {
    if (!this.active) return;
    // Where we'd draw now, before the correction.
    this.extrapolate(input, world);
    const bx = this.ext.x, by = this.ext.y;
    const p = this.tmp;
    p.x = sx; p.y = sy; p.moving = moving; p.slide = this.pos.slide; p.facing = facing;
    p.jumpLeft = world.me.jump ?? 0;
    p.jumpDir = p.jumpLeft > 0 ? facing : 0;
    p.jumpCd = world.me.jump_cd ?? 0;
    p.stun = world.me.stun ?? 0;
    p.dashLeft = world.me.dash ?? 0;
    p.dashDir = world.me.dash_dir ?? 0;
    // Replay the inputs the server hasn't applied yet, oldest first. An ack
    // ahead of our last step (an early-sent input) needs no replay.
    const behind = (this.seq - ack) & 0xffff;
    if (behind < HISTORY) {
      for (let i = behind - 1; i >= 0; i--) {
        const seq = (this.seq - i) & 0xffff;
        const k = seq % HISTORY;
        if (this.hSeq[k] !== seq) continue;
        simulate(p, this.hDir[k], this.hAlt[k], this.hJump[k] === 1, world, 1);
      }
    }
    const err = Math.hypot(p.x - this.pos.x, p.y - this.pos.y);
    // How far the server's view (after replay) was from our prediction.
    this.stats.samples++;
    this.stats.sumError += err;
    this.stats.maxError = Math.max(this.stats.maxError, err);
    if (err > 0.25) this.stats.corrections++;
    copyState(this.pos, p);
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
    const e = copyState(this.ext, this.pos);
    const f = Math.min(1, this.acc / DT);
    if (f > 0) simulate(e, input.d, input.s, input.j, world, f);
  }

  /** Direction of the jump being drawn, 0 when on the ground. */
  get jumpDir() {
    return this.ext.jumpLeft > 0 ? this.ext.jumpDir : 0;
  }

  /** Drawn position: extrapolated prediction plus the decaying correction. */
  render(out, input, world, dt) {
    if (input.d !== this.lastD || input.s !== this.lastS || input.j !== this.lastJ) {
      // The extrapolation switches direction: glide instead of jumping.
      this.lastInput.d = this.lastD;
      this.lastInput.s = this.lastS;
      this.lastInput.j = this.lastJ;
      this.extrapolate(this.lastInput, world);
      const ox = this.ext.x, oy = this.ext.y;
      this.extrapolate(input, world);
      this.offX += ox - this.ext.x;
      this.offY += oy - this.ext.y;
      this.lastD = input.d;
      this.lastS = input.s;
      this.lastJ = input.j;
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

/** Predicted player state (positions in tiles; jump timers in ticks). */
function newState() {
  return { x: 0, y: 0, moving: false, slide: 0, facing: 3, jumpDir: 0, jumpLeft: 0, jumpCd: 0, stun: 0, dashLeft: 0, dashDir: 0 };
}

function copyState(dst, src) {
  dst.x = src.x; dst.y = src.y; dst.moving = src.moving; dst.slide = src.slide; dst.facing = src.facing;
  dst.jumpDir = src.jumpDir; dst.jumpLeft = src.jumpLeft; dst.jumpCd = src.jumpCd; dst.stun = src.stun;
  dst.dashLeft = src.dashLeft; dst.dashDir = src.dashDir;
  return dst;
}

/**
 * How high a jumping player is (0 on the ground, 1 at the top), from where
 * they are: the hop arcs over the nearest stone pillar along `dir`.
 */
export function hopHeight(map, x, y, dir) {
  const horizontal = dir === 2 || dir === 4;
  const along = horizontal ? x : y, across = Math.floor(horizontal ? y : x);
  const c = Math.floor(along);
  let best = 1;
  for (let k = c - 1; k <= c + 1; k++) {
    const tx = horizontal ? k : across, ty = horizontal ? across : k;
    if (tx < 0 || ty < 0 || tx >= map.w || ty >= map.h || map.tiles[ty * map.w + tx] !== T_WALL) continue;
    best = Math.min(best, Math.abs(along - (k + 0.5)));
  }
  return Math.max(0, 1 - best * best);
}

/** Mirrors World::jump_landing: a stone pillar ahead and a free cell behind it. */
function canJump(p, dir, world) {
  if (dir < 1 || dir > 4) return false;
  const map = world.map;
  const [dx, dy] = DIRS[dir];
  const cx = Math.floor(p.x), cy = Math.floor(p.y);
  const off = dx !== 0 ? p.y - (cy + 0.5) : p.x - (cx + 0.5);
  if (Math.abs(off) > JUMP_LANE_SLACK) return false;
  const inside = (x, y) => x >= 0 && y >= 0 && x < map.w && y < map.h;
  const wx = cx + dx, wy = cy + dy, lx = cx + 2 * dx, ly = cy + 2 * dy;
  if (!inside(wx, wy) || map.tiles[wy * map.w + wx] !== T_WALL || !inside(lx, ly)) return false;
  const t = map.tiles[ly * map.w + lx];
  return t !== T_WALL && t !== T_CRATE && t !== T_ARMORED && t !== T_BUILT && !world.bombCells.has(ly * map.w + lx);
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
  if (t === T_WALL || t === T_BUILT || (!simGhost && (t === T_CRATE || t === T_ARMORED))) return true;
  return (cx !== simCx || cy !== simCy) && simBombs.has(cy * simMap.w + cx);
}

/**
 * One server tick of movement for the local player (mirrors
 * update_players); `frac` < 1 moves only that part of a tick. `j`: the
 * jump key is held.
 */
function simulate(p, d, s, j, world, frac) {
  const me = world.me;
  if (!me?.alive) return;
  if (me.curse === 3) { d = OPPOSITE[d]; s = OPPOSITE[s]; }
  // Stunned (by a stomp): no steering or jumping, ice and belts still carry.
  const stunNow = Math.max(0, p.stun - 1);
  if (frac === 1) p.stun = stunNow;
  if (stunNow > 0) { d = 0; s = 0; j = false; }
  if (me.carrying) j = false; // flag carriers can't jump
  // Jumping (mirrors World::update_jump): take off from the cell centre,
  // hop two cells in JUMP_TICKS, land on the centre, then cool down.
  const cdNow = Math.max(0, p.jumpCd - 1);
  if (frac === 1) p.jumpCd = cdNow;
  if (p.jumpLeft === 0 && j && cdNow === 0) {
    const dir = d || p.facing;
    if (canJump(p, dir, world)) {
      p.x = Math.floor(p.x) + 0.5;
      p.y = Math.floor(p.y) + 0.5;
      p.jumpDir = dir;
      p.jumpLeft = JUMP_TICKS;
      p.facing = dir;
    }
  }
  if (p.jumpLeft > 0) {
    const [jx, jy] = DIRS[p.jumpDir];
    p.x += jx * JUMP_STEP * frac;
    p.y += jy * JUMP_STEP * frac;
    p.moving = true;
    if (frac === 1 && --p.jumpLeft === 0) {
      p.x = Math.floor(p.x) + 0.5;
      p.y = Math.floor(p.y) + 0.5;
      p.jumpDir = 0;
      p.moving = false;
      p.jumpCd = JUMP_COOLDOWN_TICKS;
    }
    return;
  }
  simMap = world.map;
  simBombs = world.bombCells;
  simGhost = me.ghost > 0;
  if (p.dashLeft > 0) {
    dash(p, world, frac);
    return;
  }
  const sx = p.x, sy = p.y;
  simCx = Math.floor(sx);
  simCy = Math.floor(sy);
  const on = tileAt(simCx, simCy);
  const weather = me.blizzard > 0 ? BLIZZARD_SLOW : 1;
  // Gas doesn't stack with other slowdowns: the strongest one applies.
  const normal = BASE_SPEED + SPEED_STEP * me.speed;
  let speed = (me.curse === 1 ? CURSED_SPEED : normal) * weather;
  if (me.gassed > 0) speed = Math.min(speed, normal * (world.abilities?.gas_mult ?? 0.7));
  const dist = speed * DT * frac;
  let dir = d;
  // On ice you keep sliding until you steer or hit something.
  if (dir === 0 && on === T_ICE && p.moving && p.slide) dir = p.slide;
  let used = dir;
  if (dir) stepMove(p, dir, dist, blocked);
  if (p.x === sx && p.y === sy && s && s !== dir) { stepMove(p, s, dist, blocked); used = s; }
  const belt = CONVEYOR[on] ?? 0;
  if (belt) stepMove(p, belt, CONVEYOR_SPEED * DT * frac, blocked);
  p.moving = p.x !== sx || p.y !== sy;
  if (p.moving && used) { p.slide = used; p.facing = used; } else if (dir) p.facing = dir;
}

/** One tick (or `frac` of one) of a dash, mirroring World::dash_step without portals. */
function dash(p, world, frac) {
  const step = (world.abilities?.dash_step ?? 0.625) * frac;
  const parts = Math.max(1, Math.ceil(step / DASH_SUB_STEP));
  let ended = false;
  for (let i = 0; i < parts; i++) {
    const sx = p.x, sy = p.y;
    simCx = Math.floor(sx);
    simCy = Math.floor(sy);
    stepMove(p, p.dashDir, step / parts, blocked);
    if (p.x === sx && p.y === sy) { ended = true; break; }
  }
  p.moving = true;
  p.facing = p.dashDir;
  if (frac === 1) p.dashLeft = ended ? 0 : p.dashLeft - 1;
}
