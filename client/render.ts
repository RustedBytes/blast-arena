// The canvas renderer's public face; the layers live in client/render/.

export { Renderer } from './render/renderer.js';
export { EMOTES, NUKE_SHOW_TICKS, REPLAY_RATE, T_ARMORED, T_BUILT, T_CRATE, T_FLOOR, T_ICE, T_TELEPORT, T_WALL, biome } from './render/constants.js';
export type { Frame, FrameBomb, FrameDrone, FramePlayer, PlayerScene } from './render/types.js';
