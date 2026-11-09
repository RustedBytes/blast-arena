// Client-side prediction for the local player.
//
// The client runs the same movement rules as the server, at the same 20 Hz
// step, applying each input the moment it's pressed. Every input carries a
// sequence number; snapshots say which one the server has applied ("ack").
// On each snapshot we restart from the server's authoritative position and
// replay the inputs it hasn't seen yet, so controls feel instant on any
// ping while the server stays in charge.

const DIRS = [[0, 0], [0, -1], [1, 0], [0, 1], [-1, 0]];
const OPPOSITE = [0, 3, 4, 1, 2];
const BASE_SPEED = 3.5, SPEED_STEP = 0.6, CURSED_SPEED = 2.2, CONVEYOR_SPEED = 1.6;
const CORNER_ASSIST_MIN = 0.12;
const DT = 0.05;
const HISTORY = 64;
const T_WALL = 1, T_CRATE = 2, T_ICE = 3, T_ARMORED = 9;
const CONVEYOR = [0, 0, 0, 0, 1, 2, 3, 4]; // tile code -> direction

/** Port of the server's `step_move`: grid-lane movement with corner assist. */
export function stepMove(p, dir, dist, blocked) {
  const [dx, dy] = DIRS[dir];
  if (!dx && !dy) return;
  const horizontal = dx !== 0;
  const step = horizontal ? dx : dy;
  const cellAt = (m, s) => (horizontal ? blocked(m, s) : blocked(s, m));
  let main = horizontal ? p.x : p.y;
  let side = horizontal ? p.y : p.x;
  const cm = Math.floor(main), cs = Math.floor(side);
  const off = side - (cs + 0.5);
  let rem = dist;
  const write = () => { if (horizontal) { p.x = main; p.y = side; } else { p.y = main; p.x = side; } };

  if (Math.abs(off) > 1e-4) {
    if (!cellAt(cm + step, cs)) {
      const a = Math.min(rem, Math.abs(off));
      side -= a * Math.sign(off);
      rem -= a;
      if (rem <= 0) return write();
    } else {
      const ns = cs + Math.sign(off);
      if (Math.abs(off) >= CORNER_ASSIST_MIN && !cellAt(cm + step, ns) && !cellAt(cm, ns)) {
        side += Math.min(rem, 1 - Math.abs(off)) * Math.sign(off);
      }
      return write();
    }
  }
  const center = cm + 0.5;
  let next = main + step * rem;
  if (cellAt(cm + step, cs)) {
    next = step > 0 ? Math.min(next, Math.max(center, main)) : Math.max(next, Math.min(center, main));
  }
  main = next;
  write();
}

export class Predictor {
  constructor() {
    this.seq = 0;
    // Ring of recent steps: input used and position after it.
    this.hSeq = new Int32Array(HISTORY).fill(-1);
    this.hDir = new Uint8Array(HISTORY);
    this.hAlt = new Uint8Array(HISTORY);
    this.pos = { x: 0, y: 0, moving: false, slide: 0 };
    this.prev = { x: 0, y: 0 };
    this.acc = 0;
    this.active = false;
    this.tmp = { x: 0, y: 0, moving: false, slide: 0 };
  }

  reset(x, y) {
    this.pos.x = this.prev.x = x;
    this.pos.y = this.prev.y = y;
    this.pos.moving = false;
    this.hSeq.fill(-1);
    this.active = true;
  }

  /**
   * Advances local time; for every elapsed 50 ms step, sends the current
   * input (via `send(d, s, seq)`) and applies it locally.
   */
  update(dt, input, world, send) {
    if (!this.active) return;
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
      this.prev.x = this.pos.x;
      this.prev.y = this.pos.y;
      simulate(this.pos, input.d, input.s, world);
    }
    if (steps === 4) this.acc = 0; // fell far behind (tab was hidden)
  }

  /** Server snapshot: authoritative position after input `ack`. */
  reconcile(sx, sy, moving, ack, world) {
    if (!this.active) return;
    const p = this.tmp;
    p.x = sx; p.y = sy; p.moving = moving; p.slide = this.pos.slide;
    // Replay the inputs the server hasn't applied yet, oldest first.
    const behind = (this.seq - ack) & 0xffff;
    if (behind < HISTORY) {
      for (let i = behind - 1; i >= 0; i--) {
        const seq = (this.seq - i) & 0xffff;
        const k = seq % HISTORY;
        if (this.hSeq[k] !== seq) continue;
        simulate(p, this.hDir[k], this.hAlt[k], world);
      }
    }
    const err = Math.hypot(p.x - this.pos.x, p.y - this.pos.y);
    if (err > 2) {
      // Teleport or big desync: jump.
      this.prev.x = p.x; this.prev.y = p.y;
    }
    this.pos.x = p.x; this.pos.y = p.y; this.pos.moving = p.moving; this.pos.slide = p.slide;
  }

  /** Smooth position between the last two local steps. */
  render(out) {
    const t = Math.min(1, this.acc / DT);
    out.x = this.prev.x + (this.pos.x - this.prev.x) * t;
    out.y = this.prev.y + (this.pos.y - this.prev.y) * t;
  }
}

/** One server tick of movement for the local player (mirrors update_players). */
function simulate(p, d, s, world) {
  const me = world.me;
  if (!me?.alive) return;
  if (me.curse === 3) { d = OPPOSITE[d]; s = OPPOSITE[s]; }
  const { map } = world;
  const sx = p.x, sy = p.y;
  const startCx = Math.floor(sx), startCy = Math.floor(sy);
  const tileAt = (x, y) => (x < 0 || y < 0 || x >= map.w || y >= map.h ? T_WALL : map.tiles[y * map.w + x]);
  const on = tileAt(startCx, startCy);
  let dist = (me.curse === 1 ? CURSED_SPEED : BASE_SPEED + SPEED_STEP * me.speed) * DT;
  let dir = d;
  if (dir === 0 && on === T_ICE && p.moving && p.slide) {
    const [dx, dy] = DIRS[p.slide];
    const along = dx ? p.x * dx : p.y * dy;
    const toCentre = Math.ceil(along - 0.5) + 0.5 - along;
    if (toCentre > 0.01) { dir = p.slide; dist = Math.min(dist, toCentre); }
  }
  const ghost = me.ghost > 0;
  const bombs = world.bombCells;
  const blocked = (cx, cy) => {
    const t = tileAt(cx, cy);
    if (t === T_WALL || (!ghost && (t === T_CRATE || t === T_ARMORED))) return true;
    return (cx !== startCx || cy !== startCy) && bombs.has(cy * map.w + cx);
  };
  let used = dir;
  if (dir) stepMove(p, dir, dist, blocked);
  if (p.x === sx && p.y === sy && s && s !== dir) { stepMove(p, s, dist, blocked); used = s; }
  const belt = CONVEYOR[on] ?? 0;
  if (belt) stepMove(p, belt, CONVEYOR_SPEED * DT, blocked);
  p.moving = p.x !== sx || p.y !== sy;
  if (p.moving && used) p.slide = used;
}
