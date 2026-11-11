// What each tutorial slide shows. The text lives in the translations
// (`guide` in client/i18n/), keyed by the same slide ids.

import type { SpriteName } from '../assets.js';
import type { Scene } from './scene.js';

/** One picture in an icon grid: a sprite or an emoji, with its label. */
export type Icon =
  | { sprite: SpriteName; item: number }      // a power-up, labelled with its in-game name
  | { sprite: SpriteName; label: number }     // labelled with the slide's labels[label]
  | { emoji: string; label: number };

export type Visual = { scene: Scene } | { icons: readonly Icon[] };

export interface Slide {
  id: SlideId;
  visual: Visual;
  /** Keys to show as key caps under the picture. */
  keys?: readonly string[];
}

export const SLIDE_IDS = [
  'welcome', 'move', 'bomb', 'jump', 'crates', 'boosts', 'tricks', 'gadgets', 'abilities', 'secret',
  'arena', 'dangers', 'modes', 'scoring',
] as const;
export type SlideId = (typeof SLIDE_IDS)[number];

const item = (sprite: SpriteName, kind: number): Icon => ({ sprite, item: kind });

export const SLIDES: readonly Slide[] = [
  {
    id: 'welcome',
    visual: {
      scene: {
        rows: ['#.#.#c#', '.P...1.', '#c#b#.#', 'c..2..c', '#c#.#c#'],
        items: { 1: 'pu_speed', 2: 'pu_mystery' },
      },
    },
  },
  {
    id: 'move',
    visual: {
      scene: {
        rows: ['#.#.#', '.....', '#.P.#', '.....', '#.#.#'],
        arrows: [[2, 2, 2, 0.6], [2, 2, 3.4, 2], [2, 2, 2, 3.4], [2, 2, 0.6, 2]],
      },
    },
    keys: ['W', 'A', 'S', 'D', '←', '↑', '↓', '→'],
  },
  {
    id: 'bomb',
    visual: {
      scene: { rows: ['#.#U#.#', '...v..P', 'cLhxh#.', '#.#v#.#', '...D...'] },
    },
    keys: ['F', 'Enter'],
  },
  {
    id: 'jump',
    visual: {
      scene: { rows: ['#.#.#', '.P#..', '#.#.#'], arrows: [[1, 1, 3, 1, 'arc']] },
    },
    keys: ['Space'],
  },
  {
    id: 'crates',
    visual: {
      scene: { rows: ['c#c#c', 'P1.2c', 'c#3#c'], items: { 1: 'pu_bomb', 2: 'pu_range', 3: 'pu_shield' } },
    },
  },
  {
    id: 'boosts',
    visual: {
      icons: [item('pu_bomb', 1), item('pu_range', 2), item('pu_speed', 3), item('pu_fullfire', 7),
        item('pu_shield', 5), item('pu_pierce', 6), item('pu_ghost', 12)],
    },
  },
  {
    id: 'tricks',
    visual: {
      icons: [item('pu_kick', 4), item('pu_punch', 11), item('pu_remote', 9), item('pu_line', 10),
        item('pu_freeze', 14), item('pu_stomp', 18)],
    },
    keys: ['E'],
  },
  {
    id: 'gadgets',
    visual: {
      icons: [item('pu_mine', 15), item('pu_rocket', 16), item('pu_swap', 17), item('pu_drone', 19), item('pu_swarm', 20)],
    },
    keys: ['Q'],
  },
  {
    id: 'abilities',
    visual: {
      icons: [item('pu_builder', 21), item('pu_gas', 22), item('pu_clone', 23), item('pu_sticky', 24),
        item('pu_portal', 25), item('pu_dash', 26)],
    },
    keys: ['R'],
  },
  {
    id: 'secret',
    visual: { icons: [item('pu_mystery', 8), item('pu_nuke', 13)] },
  },
  {
    id: 'arena',
    visual: {
      icons: [{ sprite: 'ice', label: 0 }, { sprite: 'conveyor', label: 1 }, { sprite: 'crate_armored', label: 2 },
        { sprite: 'teleport', label: 3 }],
    },
  },
  {
    id: 'dangers',
    visual: {
      icons: [{ emoji: '☄️', label: 0 }, { emoji: '❄️', label: 1 }, { emoji: '🌋', label: 2 }, { emoji: '⏳', label: 3 }],
    },
  },
  {
    id: 'modes',
    visual: {
      icons: [{ emoji: '🚩', label: 0 }, { emoji: '🌀', label: 1 }, { emoji: '🪱', label: 2 }, { emoji: '🗿', label: 3 }],
    },
  },
  {
    id: 'scoring',
    visual: {
      icons: [{ emoji: '💥', label: 0 }, { emoji: '⭐', label: 1 }, { emoji: '🎯', label: 2 }, { emoji: '😵', label: 3 }],
    },
    keys: ['Tab', 'Esc'],
  },
];
