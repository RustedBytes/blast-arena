// Shapes of the messages and snapshot entries; mirrors src/protocol.rs.

import { ME_FIELDS } from './constants.js';

/** Four flame/gas arm lengths: up, down, left, right (each 0..15). */
export type Arms = readonly number[];
/** [id, x*100, y*100, facing, flags] */
export type PlayerEntry = [id: number, x: number, y: number, facing: number, flags: number];
/** [id, x, y, explode tick (0: remote), flags] */
export type BombEntry = [id: number, x: number, y: number, explodeTick: number, flags: number];
/** [x, y, arms, ticks left, nuke radius (0: normal blast)] */
export type FlameEntry = [x: number, y: number, arms: Arms, ticks: number, nuke: number];
/** [id, x, y, team], positions in tiles. */
export type DroneEntry = [id: number, x: number, y: number, team: number];
/** [id, x, y, arms, ticks left] */
export type GasEntry = [id: number, x: number, y: number, arms: Arms, ticks: number];
/** [id, x, y, owner, partner (0 waiting), ticks left] */
export type PortalEntry = [id: number, x: number, y: number, owner: number, partner: number, ticks: number];
/** [id, owner, x*100, y*100, facing, flags] */
export type CloneEntry = [id: number, owner: number, x: number, y: number, facing: number, flags: number];
/** [id, x, y, fuse ticks shown] */
export type DecoyEntry = [id: number, x: number, y: number, fuse: number];
/** [bomb id, carrier id] */
export type StuckEntry = [bomb: number, carrier: number];
/** [id, flags, ticks per step, ticks since the last step, [x0, y0, x1, y1, ...]] */
export type WormEntry = [id: number, flags: number, step: number, since: number, cells: number[]];
/** [id, x, y, from x, from y, flags, ticks per step, ticks since the last step, hp, max hp, ticks until the wound-up skill, skill direction] */
export type WardenEntry = [
  id: number, x: number, y: number, fromX: number, fromY: number, flags: number,
  step: number, since: number, hp: number, maxHp: number, windup: number, dir: number,
];
export interface GuardInfo {
  vault: [number, number, number, number];
  /** Ticks until the Warden returns (0: here). */
  back: number;
  warden: WardenEntry | null;
}
export interface Extras {
  gas: GasEntry[];
  portals: PortalEntry[];
  clones: CloneEntry[];
  decoys: DecoyEntry[];
  stuck: StuckEntry[];
  worms: WormEntry[];
  guard?: GuardInfo;
}


export type MeField = (typeof ME_FIELDS)[number];

export type MeFlag = 'alive' | 'kick' | 'pierce' | 'remote' | 'line' | 'punch' | 'freeze' | 'stomp';

/** The decoded `me` block (see `meObject`). */
export type Me = Readonly<
  Record<Exclude<MeField, MeFlag | 'killer' | 'spec'>, number> & Record<MeFlag, boolean> & {
    /** Who killed us last, if anyone. */
    killer: number | null;
    /** Who we watch while dead, if anyone. */
    spec: number | null;
    /** Half extents of the area the server sends, in tiles. */
    aoi: readonly [number, number];
  }
>;

/** Arena modes; mirrors `game::Mode`. */
export type ArenaMode = 'ffa' | 'teams' | 'royale' | 'worms';

/** A full snapshot rebuilt from a delta. */
export interface Snapshot {
  t: 's';
  k: number;
  /** Tick of the base snapshot (0: none). */
  bk: number;
  p: PlayerEntry[];
  rawB: BombEntry[];
  e: FlameEntry[];
  d: DroneEntry[];
  x: Extras;
  rawMe: number[];
}

export interface ProfileView {
  level: number; xp: number; next_xp: number; kills: number; deaths: number; wins: number; best_streak: number;
}

export interface AbilityInfo {
  v: number;
  /** Cooldown per active ability: [item code, ticks]. */
  cooldowns: [number, number][];
  wall: number; gas: number; gas_fuse: number; gas_mult: number; clone: number; portal: number;
  portal_wait: number; sticky_fuse: number; detach: number; dash: number; dash_step: number;
  /** Item codes of abilities switched off. */
  disabled: number[];
}

/** The first message after joining; mirrors `protocol::Welcome`. */
export interface WelcomeMsg {
  t: 'welcome';
  id: number; w: number; h: number;
  /** Run-length encoded tiles: [tile, count] pairs, row-major. */
  map: [number, number][];
  /** Region centres: [x, y as fractions of the map size, biome code]. */
  biomes: [number, number, number][];
  /** Every item on the map: [x, y, kind]. */
  items: [number, number, number][];
  rate: number;
  aoi: [number, number];
  aoi_max: [number, number];
  /** Everyone online: [id, name, team, hat, trail]. */
  roster: [number, string, number, number, number][];
  arena: string;
  mode: ArenaMode;
  team: number;
  hills: [number, number][];
  round: number;
  resumed: boolean;
  profile: ProfileView | null;
  abilities: AbilityInfo;
}

export interface ErrMsg { t: 'err'; m: string }
export interface PlayerJoinMsg { t: 'pj'; id: number; name: string; team: number; hat: number; trail: number }
export interface PlayerLeaveMsg { t: 'pl'; id: number }
export interface KillMsg { t: 'kill'; k: number | null; v: number; x: number; y: number; b: boolean }
/** Leaderboard: top is [id, name, score, kills, streak]. */
export interface LeaderboardMsg { t: 'lb'; n: number; top: [number, string, number, number, number][]; teams: [number, number]; r: number }
/** World changes: tile and item cells as [x, y, value]. */
export interface WorldMsg { t: 'w'; tc: [number, number, number][]; ic: [number, number, number][] }
export interface FxMsg { t: 'fx'; f: number; m: boolean }
export interface EmoteMsg { t: 'emote'; id: number; e: number }
export interface StreakMsg { t: 'streak'; id: number; n: number }
export interface HillsMsg { t: 'hills'; h: [number, number][] }
/** Round end: mvp is [id, name, score, kills]. */
export interface RoundMsg { t: 'round'; mvp: [number, string, number, number][]; teams: [number, number]; win: number; next: number }
export interface PongMsg { t: 'pong'; c: number }
export interface EventMsg { t: 'ev'; kind: number; v: number[] }

export type ServerMsg = WelcomeMsg | ErrMsg | Snapshot | PlayerJoinMsg | PlayerLeaveMsg | KillMsg | LeaderboardMsg
  | WorldMsg | FxMsg | EmoteMsg | StreakMsg | HillsMsg | RoundMsg | PongMsg | EventMsg;
/** The server message with tag `T`. */
export type ServerMsgOf<T extends ServerMsg['t']> = Extract<ServerMsg, { t: T }>;

/** Join fields sent with the join message. */
export interface JoinFields { name: string; token?: string; hat?: number; trail?: number; near?: number }

export type ClientMsg =
  | ({ t: 'join' } & JoinFields)
  /** Input: direction, sequence, jump, hold, ack q and tick k. */
  | { t: 'in'; d: number; s: number; j?: boolean; h?: boolean; q?: number; k?: number }
  | { t: 'emote'; e: number }
  | { t: 'ping'; c: number }
  | { t: 'view'; w: number; h: number }
  | { t: 'look'; at: [number, number] | null }
  | { t: 'bomb' | 'act' | 'gadget' | 'ability' | 'cancel' };

/** Returns the snapshot for tick `k`, the base of deltas (or null/undefined if unknown). */
export type SnapshotBase = (k: number) => Snapshot | null | undefined;
