// Types of the client-side game state that main.ts keeps and render.ts
// draws. Type-only module: it compiles to nothing.

import type { AbilityInfo, ArenaMode, FlameEntry, Me, PlayerEntry, Snapshot } from './protocol.js';

/** The arena's tiles plus the biome regions they are coloured by. */
export interface GameMap {
  w: number;
  h: number;
  tiles: Uint8Array;
  /** Region centres: [x, y as fractions of the map size, biome code]. */
  biomes?: readonly (readonly [number, number, number])[];
}

/** A bomb as the client keeps it: [id, x, y, fuse ticks left (99: remote), flags]. */
export type BombView = [id: number, x: number, y: number, fuse: number, flags: number];

/** A decoded snapshot with the derived fields the client adds on arrival. */
export interface GameSnapshot extends Snapshot {
  b: BombView[];
  me: Me;
}

/** Fixed-capacity ring of snapshots, oldest first. */
export interface SnapshotRing {
  readonly len: number;
  push(s: GameSnapshot): void;
  get(i: number): GameSnapshot;
  latest(): GameSnapshot;
}

export interface RosterInfo { name: string; team: number; hat: number; trail: number }

/** Sudden death: the shrinking square. */
export interface SuddenDeath { cx: number; cy: number; r: number; nextAt: number }

/** Capture the flag: one per team. */
export interface FlagInfo { base: [number, number]; state: number; pos: [number, number]; carrier: number }

export interface Circle { x: number; y: number; r: number }

/** Battle royale zone: state 0 waiting, 1 closing. */
export interface Zone { state: number; start: number; end: number; from: Circle; to: Circle; phase: number }

/** Battle royale match. */
export interface Royale { alive: number; on: boolean; nextAt: number }

/** Death replay: from server tick `from`, started at local time `t0`. */
export interface Replay { from: number; t0: number }

export interface Vec { x: number; y: number }

export interface GameState {
  myId: number;
  arena: number;
  arenaName: string;
  mode: ArenaMode;
  team: number;
  map: GameMap;
  aoi: [number, number];
  aoiMax: [number, number];
  tickMs: number;
  rosterInfo: Map<number, RosterInfo>;
  snaps: SnapshotRing;
  sd: SuddenDeath | null;
  flags: FlagInfo[] | null;
  captures: [number, number];
  replay: Replay | null;
  /** Server ticks mapped onto local time (see the snapshot handler). */
  offset: number | null;
  lateness: number;
  /** Interpolation delay for remote entities, in ticks. */
  interpDelay: number;
  interpTarget: number;
  lastK?: number;
  me: Me | null;
  /** This player's entry in the latest snapshot. */
  mine: PlayerEntry | null;
  /** Where this player is drawn (predicted). */
  self: Vec;
  /** What the camera follows. */
  focus: Vec;
  selfJump?: number;
  /** The map spot watched from the minimap, if any. */
  look: Vec | null;
  lookFrom: Vec | null;
  lookBlend: number;
  zone: Zone | null;
  royale: Royale | null;
  zoom: number;
  zoomTarget: number;
  /** Cell index -> item kind. */
  itemMap: Map<number, number>;
  /** [x, y, kind] per item. */
  items: [number, number, number][];
  explosions: FlameEntry[];
  hills: [number, number][];
  emotes: Map<number, { e: number; until: number }>;
  bombCells: Set<number>;
  /** Players a worm just ate (their kill message follows). */
  wormMeals: Set<number>;
  eatenByWorm: boolean;
  /** Players the Warden just crushed (likewise). */
  wardenMeals: Set<number>;
  crushedByWarden: boolean;
  lastLb: string;
  roundSecs: number;
  movedAt: number | null;
  /** Ability tuning from the server (ticks). */
  abilities: AbilityInfo | null;
}

