// Interpolates the latest snapshots into the pooled frame the layers draw:
// remote players, clones, bombs, decoys and drones.

import { BOMB_FLAG, hasFlag, PLAYER_FLAG } from '../protocol.js';
import type { CloneEntry, DroneEntry, PlayerEntry } from '../protocol.js';
import type { BombView, GameState } from '../state.js';
import { POOL, REPLAY_RATE } from './constants.js';
import type { Stage } from './stage.js';
import type { FramePlayer } from './types.js';

export class Interpolator {
  private readonly playerPrev = new Map<number, PlayerEntry>();
  private readonly bombPrev = new Map<number, BombView>();
  private readonly clonePrev = new Map<number, CloneEntry>();
  private readonly dronePrev = new Map<number, DroneEntry>();
  /** Bomb id -> carrier id (this frame). */
  private readonly stuckBy = new Map<number, number>();

  constructor(private readonly s: Stage) {}

  /**
   * Fills the pooled frame: other players and bombs interpolated between the
   * two snapshots around the render time; the local player uses its
   * predicted position so controls feel immediate.
   */
  interpolate(state: GameState, now: number) {
    const ring = state.snaps;
    const latest = ring.latest();
    // A death replay plays recent snapshots again, slowly.
    const rp = state.replay;
    this.s.replaying = !!rp;
    const rt = rp
      ? Math.min(latest.k, rp.from + ((now - rp.t0) / state.tickMs) * REPLAY_RATE)
      : now / state.tickMs - (state.offset ?? 0) - state.interpDelay;
    let a = ring.get(0), b = a;
    for (let i = ring.len - 1; i >= 0; i--) {
      const s = ring.get(i);
      if (s.k <= rt) {
        a = s;
        b = i + 1 < ring.len ? ring.get(i + 1) : s;
        break;
      }
    }
    const alpha = b.k > a.k ? Math.min(1, Math.max(0, (rt - a.k) / (b.k - a.k))) : 0;
    // Worms slide between cells from their own step timing (see drawWorms).
    this.s.wormSnap = b;
    this.s.wormTime = rt;
    const f = this.s.frame;
    const prev = this.playerPrev;
    prev.clear();
    for (const e of a.p) prev.set(e[0], e);
    let n = 0;
    for (const q of b.p) {
      if (n >= POOL - 1) break;
      if (q[0] === state.myId && !rp) continue;
      const p = prev.get(q[0]) ?? q;
      const jump = Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]) > 200; // teleport or respawn
      const t = jump ? 1 : alpha;
      const o = f.players[n++];
      setPlayer(o, q, (p[1] + (q[1] - p[1]) * t) / 100, (p[2] + (q[2] - p[2]) * t) / 100);
    }
    // Clones look like their owners: they're drawn as players with the
    // owner's id (name, colours, hat), interpolated by the clone's own id.
    const cp = this.clonePrev;
    cp.clear();
    for (const c of a.x.clones) cp.set(c[0], c);
    for (const c of b.x.clones) {
      if (n >= POOL - 1) break;
      const p = cp.get(c[0]) ?? c;
      const o = f.players[n++];
      setPlayer(o, [c[1], 0, 0, c[4], c[5]], (p[2] + (c[2] - p[2]) * alpha) / 100, (p[3] + (c[3] - p[3]) * alpha) / 100);
      o.clone = c[1];
      o.anim = -c[0]; // walks apart from its owner
    }
    if (state.me?.alive && state.mine) {
      const o = f.players[n++];
      setPlayer(o, state.mine, state.self.x, state.self.y);
      // Our own hop comes from prediction, not the (older) snapshot.
      o.jumpDir = state.selfJump ?? 0;
      if (o.jumpDir) o.facing = o.jumpDir;
    }
    f.nPlayers = n;

    this.stuckBy.clear();
    for (const [bid, carrier] of b.x.stuck) this.stuckBy.set(bid, carrier);
    const bprev = this.bombPrev;
    bprev.clear();
    for (const e of a.b) bprev.set(e[0], e);
    let m = 0;
    for (const q of b.b) {
      if (m >= POOL) break;
      const p = bprev.get(q[0]) ?? q;
      const jump = Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]) > 2; // punched
      const t = jump ? 1 : alpha;
      const o = f.bombs[m++];
      o.x = p[1] + (q[1] - p[1]) * t;
      o.y = p[2] + (q[2] - p[2]) * t;
      o.fuse = q[3];
      const flags = q[4];
      o.pierce = hasFlag(flags, BOMB_FLAG.PIERCE);
      o.remote = hasFlag(flags, BOMB_FLAG.REMOTE);
      o.nuke = hasFlag(flags, BOMB_FLAG.NUKE);
      o.freeze = hasFlag(flags, BOMB_FLAG.FREEZE);
      o.rocket = hasFlag(flags, BOMB_FLAG.ROCKET);
      o.mine = hasFlag(flags, BOMB_FLAG.MINE);
      o.sticky = hasFlag(flags, BOMB_FLAG.STICKY);
      o.gas = hasFlag(flags, BOMB_FLAG.GAS);
      o.carrier = this.stuckBy.get(q[0]) ?? 0;
      o.dx = q[1] - p[1];
      o.dy = q[2] - p[2];
    }
    // A clone's decoy bombs look like real ones.
    for (const d of b.x.decoys) {
      if (m >= POOL) break;
      const o = f.bombs[m++];
      o.x = d[1];
      o.y = d[2];
      o.fuse = Math.max(0, d[3]);
      o.pierce = o.remote = o.nuke = o.freeze = o.rocket = o.mine = o.sticky = o.gas = false;
      o.carrier = 0;
      o.dx = o.dy = 0;
    }
    f.nBombs = m;

    // Drones, interpolated by id.
    const dp = this.dronePrev;
    dp.clear();
    for (const d of a.d) dp.set(d[0], d);
    let nd = 0;
    for (const d of b.d) {
      if (nd >= f.drones.length) break;
      const p = dp.get(d[0]) ?? d;
      const o = f.drones[nd++];
      o.id = d[0];
      o.x = p[1] + (d[1] - p[1]) * alpha;
      o.y = p[2] + (d[2] - p[2]) * alpha;
      o.team = d[3];
    }
    f.nDrones = nd;
    // Replaying a death shows the flames of that moment.
    state.explosions = this.s.replaying ? b.e : latest.e;
  }
}

/** Fills a pooled frame player from a snapshot entry, drawn at (x, y) in tiles. */
function setPlayer(o: FramePlayer, q: Readonly<PlayerEntry>, x: number, y: number): void {
  const [id, , , facing, flags] = q;
  o.id = id;
  o.anim = id;
  o.x = x;
  o.y = y;
  o.facing = facing;
  o.moving = hasFlag(flags, PLAYER_FLAG.MOVING);
  o.shield = hasFlag(flags, PLAYER_FLAG.SHIELD);
  o.cursed = hasFlag(flags, PLAYER_FLAG.CURSED);
  o.ghost = hasFlag(flags, PLAYER_FLAG.GHOST);
  o.bounty = hasFlag(flags, PLAYER_FLAG.BOUNTY);
  o.jumpDir = hasFlag(flags, PLAYER_FLAG.JUMPING) ? facing : 0;
  o.stunned = hasFlag(flags, PLAYER_FLAG.STUNNED);
  o.carrying = hasFlag(flags, PLAYER_FLAG.CARRYING);
  o.dashing = hasFlag(flags, PLAYER_FLAG.DASHING);
  o.gassed = hasFlag(flags, PLAYER_FLAG.GASSED);
  o.clone = 0;
}
