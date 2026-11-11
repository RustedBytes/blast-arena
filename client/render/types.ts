// Types shared by the render layers.

import type { PlayerColors } from '../assets.js';
import type { GameState } from '../state.js';

/** What drawing players and their name tags reads from the game state. */
export type PlayerScene = Pick<GameState, 'myId' | 'rosterInfo' | 'emotes' | 'map'>;

/** A player as drawn this frame (pooled, see `Renderer.frame`). */
export interface FramePlayer {
  id: number; x: number; y: number; facing: number; moving: boolean; shield: boolean; cursed: boolean; ghost: boolean;
  bounty: boolean; jumpDir: number; lift: number; stunned: boolean; carrying: boolean; dashing: boolean; gassed: boolean;
  /** Just bitten by a monster: blinks while immune. */
  hurt: boolean;
  /** Missing hearts (dungeon): leaves a trail of blood. */
  wounded: boolean;
  /** Owner id when this is a clone, else 0. */
  clone: number;
  /** Key of the walk animation state. */
  anim: number;
}
/** A bomb as drawn this frame. */
export interface FrameBomb {
  x: number; y: number; fuse: number; pierce: boolean; remote: boolean; nuke: boolean; freeze: boolean; rocket: boolean;
  mine: boolean; sticky: boolean; gas: boolean; carrier: number; dx: number; dy: number;
  /** A cosmos blaster bolt's colour code (0: not a bolt). */
  bolt: number;
  /** Last heading of a rocket, kept while it stands still. */
  rocketA?: number;
}
export interface FrameDrone { id: number; x: number; y: number; team: number }
/** Interpolated entities of the current frame; arrays are pools, `n*` the counts in use. */
export interface Frame {
  players: FramePlayer[]; nPlayers: number;
  bombs: FrameBomb[]; nBombs: number;
  drones: FrameDrone[]; nDrones: number;
}
/** A cached chunk canvas with the chunk index it shows (-1: none). */
/** A cached chunk picture and the chunk index it shows (-1: none yet). */
export interface Chunk { canvas: HTMLCanvasElement; key: number }
export type Effect =
  | { kind: 'die'; x: number; y: number; start: number; duration: number; colors: PlayerColors; facing: number }
  | { kind: 'shock' | 'beam'; x: number; y: number; start: number; duration: number };
export interface NukeShow { x: number; y: number; r: number; start: number; cells: number[] }
export interface Meteor { x: number; y: number; at: number; hit: boolean }
export interface LavaSurge { cells: number[]; warn: number; start: number; end: number }
export interface Weather { kind: number; start: number; end: number }
export interface Gait {
  x: number; y: number; dist: number; vx: number; vy: number; amp: number; lean: number; settle: number; step: number;
  walking: boolean; seen: number;
}
export interface Look { team: number; cb: boolean; colors: PlayerColors; sprites: (HTMLCanvasElement | null)[] }
export interface Label {
  canvas: HTMLCanvasElement; name?: string; fs?: number; me?: boolean; team?: number; hc?: boolean; cb?: boolean;
  ax: number; ay: number;
}
export interface Puffs { fire: HTMLCanvasElement; smoke: HTMLCanvasElement; dark: HTMLCanvasElement; dust: HTMLCanvasElement }
