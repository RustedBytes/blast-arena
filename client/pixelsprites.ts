// Pixel-art sprites: bombs, flames, scorch marks, power-ups, players and
// hats, drawn in code with the same rules as the tiles (pixelart.ts):
// light from the top left, hue-shifted ramps, and a dark outline on
// everything you interact with so it pops off the quieter floor.
//
// Sprites are built at 16x16 and handed out as 4x canvases (see
// Pix.canvas), because they are drawn straight onto the game canvas.
//
// The parts live in client/pixelsprites/.

import { Pix, X4 } from './pixelkit.js';
import { antenna, bomb, flames, IRON, nukeBomb, RED_IRON, scorch } from './pixelsprites/bombs.js';
import { hat, HATS, player } from './pixelsprites/players.js';
import type { PixelHat, PlayerView } from './pixelsprites/players.js';
import { powerUps } from './pixelsprites/powerups.js';
import { warden } from './pixelsprites/warden.js';
import { wormHead, wormMound, wormSegment, wormTail } from './pixelsprites/worms.js';

export type { PixelHat, PlayerView };

// ------------------------------------------------------------------- export

/**
 * Builds every pixel sprite. Names match the classic sprites where one
 * exists, so the renderer can ask for either style by name. Players are
 * built per colour on demand with `pixelPlayer`.
 */
export function buildPixelSprites() {
  const big = (p: Pix): HTMLCanvasElement => p.canvas(X4);
  const f = flames();
  const items = powerUps();
  // Sprite names of the tokens, in the same order (item kinds 1, 2, ...).
  const names = ['pu_bomb', 'pu_range', 'pu_speed', 'pu_kick', 'pu_shield', 'pu_pierce',
    'pu_fullfire', 'pu_mystery', 'pu_remote', 'pu_line', 'pu_punch', 'pu_ghost', 'pu_nuke',
    'pu_freeze', 'pu_mine', 'pu_rocket', 'pu_swap', 'pu_stomp', 'pu_drone', 'pu_swarm'];
  /** Power-up tokens by sprite name (looked up by name, see Assets.tile). */
  const tokens: Record<string, HTMLCanvasElement> = {};
  if (items.length !== names.length) throw new Error('pixelsprites: a power-up token without a name');
  names.forEach((name, i) => { tokens[name] = big(items[i]); });
  return {
    tokens,
    bomb_nuke: big(nukeBomb()),
    bomb: big(bomb(IRON, false)),
    bomb_pierce: big(bomb(RED_IRON, true)),
    antenna: [big(antenna(false)), big(antenna(true))],
    flames: { center: f.center.map(big), arm: f.arm.map(big), end: f.end.map(big) },
    flame_center: big(f.center[0]),
    flame_arm: big(f.arm[0]),
    flame_end: big(f.end[0]),
    scorch: big(scorch()),
    /** By cosmetic hat id; 0 (none) is null. */
    hats: HATS.map((h): PixelHat | null => (h ? hat(h) : null)),
    worm_segment: big(wormSegment()),
    worm_head: big(wormHead(false)),
    worm_head_angry: big(wormHead(true)),
    worm_head_lunge: big(wormHead(true, true)),
    worm_band: big(wormSegment(true)),
    worm_tail: big(wormTail()),
    worm_mound: big(wormMound()),
    warden: big(warden(false)),
    warden_rage: big(warden(true)),
  };
}

/** A player sprite for given colours as a 4x canvas. */
export function pixelPlayer(colors: readonly [string, string], view: PlayerView, frame: number): HTMLCanvasElement {
  return player(colors, view, frame).canvas(X4);
}

export type PixelSprites = ReturnType<typeof buildPixelSprites>;
