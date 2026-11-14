// Pixel-art sprites: bombs, flames, scorch marks, power-ups, players and
// hats, drawn in code with the same rules as the tiles (pixelart.ts):
// light from the top left, hue-shifted ramps, and a dark outline on
// everything you interact with so it pops off the quieter floor.
//
// Sprites are built at 32x32 and handed out as 2x canvases (see
// Pix.canvas), because they are drawn straight onto the game canvas.
//
// The parts live in client/pixelsprites/.

import { Pix, UP } from './pixelkit.js';
import { antenna, boltSprite, bomb, flames, IRON, mine, nukeBomb, RED_IRON, rocket, scorch } from './pixelsprites/bombs.js';
import { hat, HATS, player, shieldBubble } from './pixelsprites/players.js';
import type { PixelHat, PlayerView } from './pixelsprites/players.js';
import { powerUps } from './pixelsprites/powerups.js';
import { monsterSprites } from './pixelsprites/monsters.js';
import { warden } from './pixelsprites/warden.js';
import { bloodSplat, crownMark, dizzyStar, drone, flagCloth, flagPole, frostPuff, gasPuff, goo, halo, nukePuffs, portal, PORTAL_ART } from './pixelsprites/marks.js';
import { wormHead, wormMound, wormSegment, wormTail } from './pixelsprites/worms.js';

export type { PixelHat, PlayerView };

// ------------------------------------------------------------------- export

/**
 * Builds every pixel sprite. Names match the classic sprites where one
 * exists, so the renderer can ask for either style by name. Players are
 * built per colour on demand with `pixelPlayer`.
 */
export function buildPixelSprites() {
  const big = (p: Pix): HTMLCanvasElement => p.canvas(UP);
  const f = flames();
  const items = powerUps();
  // Sprite names of the tokens, in the same order (item kinds 1, 2, ...).
  const names = ['pu_bomb', 'pu_range', 'pu_speed', 'pu_kick', 'pu_shield', 'pu_pierce',
    'pu_fullfire', 'pu_mystery', 'pu_remote', 'pu_line', 'pu_punch', 'pu_ghost', 'pu_nuke',
    'pu_freeze', 'pu_mine', 'pu_rocket', 'pu_swap', 'pu_stomp', 'pu_drone', 'pu_swarm', 'pu_heart',
    'pu_plasma', 'pu_cryo', 'pu_phase', 'pu_nova', 'pu_overdrive'];
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
    rocket: [big(rocket(0)), big(rocket(1))],
    // Bolt colours match protocol BOLT_COLORS (0 and 1 are the green blaster).
    bolts: [
      ['#7dff7a', '#2bd94a', '#146828'],
      ['#7dff7a', '#2bd94a', '#146828'],
      ['#ffb0a0', '#ff3a3a', '#8c1f1a'],
      ['#e8fbff', '#3ad8ff', '#146888'],
      ['#f0e0ff', '#a64aff', '#3d2280'],
      ['#fff6c8', '#ffb81a', '#8a5a00'],
    ].map(([core, mid, tail]) => big(boltSprite(core, mid, tail))),
    mine: [big(mine(false)), big(mine(true))],
    shield: [big(shieldBubble(false)), big(shieldBubble(true))],
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
    warden_step: big(warden(false, true)),
    warden_rage: big(warden(true)),
    warden_rage_step: big(warden(true, true)),
    goo: [big(goo(0)), big(goo(1))],
    gas: [big(gasPuff(0)), big(gasPuff(1))],
    frost: big(frostPuff()),
    portals: PORTAL_ART.map((c) => {
      const a = portal(c);
      return { ring: big(a.ring), spiral: big(a.spiral) };
    }),
    halo: big(halo()),
    drones: [0, 1, 2].map((team) => [0, 1].map((frame) => big(drone(frame, ['#ffd34a', '#ff5a4a', '#5aa0ff'][team])))),
    flagPole: big(flagPole()),
    flag: [big(flagCloth(0)), big(flagCloth(1))],
    star: big(dizzyStar()),
    crown: big(crownMark()),
    blood: big(bloodSplat()),
    nukePuffs: nukePuffs(),
    /** Dungeon monsters as [kind - 1][frame]: slime, skeleton, bat. */
    monsters: monsterSprites().map((frames) => frames.map(big)),
  };
}

/** A player sprite for given colours as a 2x canvas. */
export function pixelPlayer(colors: readonly [string, string], view: PlayerView, frame: number): HTMLCanvasElement {
  return player(colors, view, frame).canvas(UP);
}

export type PixelSprites = ReturnType<typeof buildPixelSprites>;
