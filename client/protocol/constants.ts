// Codes and flag bits shared with the server.

/** Bits of a player entry's flags; mirrors the server's snapshot encoding. */
export const PLAYER_FLAG = {
  MOVING: 1, SHIELD: 2, CURSED: 4, GHOST: 8, BOUNTY: 16, JUMPING: 32, STUNNED: 64, CARRYING: 128, DASHING: 256, GASSED: 512, HURT: 1024, WOUNDED: 2048,
} as const;
/** Bits of a bomb entry's flags; mirrors `game::snapshot::bomb_flags` (mines are 32). */
export const BOMB_FLAG = {
  PIERCE: 1, REMOTE: 2, NUKE: 4, FREEZE: 8, ROCKET: 16, MINE: 32, STICKY: 64, GAS: 128,
} as const;
/** True when `bit` is set in `flags`. */
export const hasFlag = (flags: number, bit: number): boolean => (flags & bit) !== 0;
/** Kinds of game events (`ev` messages); mirrors `protocol::ev`. */
export const EV = { SHRINK: 1, ANNOUNCE: 2, STRIKES: 3, LAVA: 4, FLAGS: 5, FLAG_NEWS: 6, SWAP: 7, ZONE: 8, ROYALE: 9, WINNER: 10, ABILITY: 11, WORM: 12, GUARD: 13, MONSTER: 14 } as const;
/** What a worm event reports (values: [what, x, y, player id + 1]); mirrors `game::worms::news`. */
export const WORM_NEWS = { ATE: 1, KILLED: 2, CUT: 3 } as const;
/** What a Warden event reports (values: [what, x, y, player id + 1]); mirrors `game::guard::news`. */
export const GUARD_NEWS = { CRUSHED: 1, KILLED: 2, BACK: 3, SLAM: 4, LOB: 5 } as const;
/** Warden flags in snapshots; mirrors `game::guard::flag`. */
export const GUARD_FLAG = { HUNTING: 1, SLAM: 2, CHARGE_WINDUP: 4, CHARGING: 8, SKIN: 16, ENRAGED: 32, HURT: 64 } as const;
/** What a monster event reports (values: [what, x, y, player id + 1, kind, hearts left]); mirrors `game::monsters::news`. */
export const MONSTER_NEWS = { BIT: 1, SLAIN: 2, HIT: 3, WOUNDED: 4 } as const;
/** Monster kinds; mirrors `game::monsters::Kind`. */
export const MONSTER_KIND = { SLIME: 1, SKELETON: 2, BAT: 3 } as const;
/** Monster flags in snapshots; mirrors `game::monsters::flag`. */
export const MONSTER_FLAG = { CHASING: 1, RISING: 2, HURT: 4 } as const;
/** Worm flags in snapshots; mirrors `game::worms::flag`. */
export const WORM_FLAG = { CHASING: 1, EMERGING: 2, FAR: 4, LUNGE: 8, LURK: 16 } as const;
/** Sub-kinds of ability events (values: [kind, tick, ...]); mirrors `game::abilities::ab`. */
export const AB = {
  ACTIVATED: 1, REJECTED: 2, COOLDOWN: 3, WALL_CREATED: 4, WALL_REMOVED: 5, GAS_CREATED: 6, GAS_EXPIRED: 7,
  GAS_IGNITED: 8, CLONE_SPAWNED: 9, CLONE_DESTROYED: 10, STICKY_ATTACHED: 11, STICKY_DETACHED: 12,
  PORTAL_CREATED: 13, PORTAL_LINKED: 14, PORTAL_DESTROYED: 15, TELEPORTED: 16, DASH_STARTED: 17, DASH_ENDED: 18,
} as const;

/** Order of the values in a snapshot's `me` block; mirrors the server. */
export const ME_FIELDS = ['ack', 'alive', 'active', 'shield', 'ghost', 'curse', 'curse_t', 'respawn', 'score', 'bombs',
  'range', 'speed', 'kick', 'pierce', 'remote', 'line', 'punch', 'killer', 'spec', 'aoi_w', 'aoi_h', 'team', 'streak',
  'nukes', 'jump', 'jump_cd', 'gadget', 'gadget_n', 'freeze', 'stomp', 'stun', 'blizzard', 'carrying', 'storm', 'storm_max',
  'ability', 'ability_n', 'ability_max', 'ability_cd', 'gas_bombs', 'sticky_bombs', 'stuck', 'detach', 'gassed', 'dash',
  'dash_dir', 'portal_wait', 'hp', 'hp_max'] as const;
