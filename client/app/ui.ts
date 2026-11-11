// Every element of the game page the client uses, looked up once and typed.
// A missing element or a changed tag fails at startup with a clear error
// (see `byId`), and a typo in a name fails to compile. Module scripts run
// after the page is parsed, so the elements exist by the time this runs.

import { byId } from '../dom.js';

export const ui = {
  game: byId('game', HTMLCanvasElement),
  minimap: byId('minimap', HTMLCanvasElement),
  vignette: byId('vignette'),
  alerts: byId('alerts'),
  tutorial: byId('tutorial'),
  reconnecting: byId('reconnecting'),

  /** The lobby and join form. */
  join: {
    screen: byId('join'),
    form: byId('join-form'),
    name: byId('name', HTMLInputElement),
    language: byId('join-lang', HTMLSelectElement),
    play: byId('play', HTMLButtonElement),
    howToPlay: byId('how-to-play', HTMLButtonElement),
    error: byId('join-error'),
    arenaList: byId('arena-list'),
    allTime: byId('alltime'),
    profileLevel: byId('pf-level'),
    profileXp: byId('pf-xp'),
    profileXpBar: byId('pf-xpbar'),
    profileStats: byId('pf-stats'),
    hatPicker: byId('hat-picker'),
    trailPicker: byId('trail-picker'),
  },

  /** The in-game HUD. */
  hud: {
    root: byId('hud'),
    online: byId('online'),
    roundTime: byId('round-time'),
    teamScores: byId('team-scores'),
    ctfCaptures: byId('ctf-caps'),
    leaderboard: byId('leaderboard'),
    leaderboardList: byId('lb-list'),
    leaderboardHint: byId('lb-hint'),
    killfeed: byId('killfeed'),
    lookPill: byId('look-pill'),
    emoteWheel: byId('emote-wheel'),
    emoteToggle: byId('emote-toggle'),
    invite: byId('invite'),
    gear: byId('gear'),
    perf: byId('perf'),
    fps: byId('fps'),
    netInfo: byId('netinfo'),
  },

  /** Power-up stats along the top of the HUD. */
  stats: {
    bombs: byId('st-bombs'),
    range: byId('st-range'),
    speed: byId('st-speed'),
    score: byId('st-score'),
    nuke: byId('st-nuke'),
    gadget: byId('st-gadget'),
    ability: byId('st-ability'),
    modifier: byId('st-modifier'),
    shield: byId('st-shield'),
    ghost: byId('st-ghost'),
    stun: byId('st-stun'),
    curse: byId('st-curse'),
    /** Power-ups that are simply on or off. */
    flags: {
      kick: byId('st-kick'),
      pierce: byId('st-pierce'),
      remote: byId('st-remote'),
      line: byId('st-line'),
      punch: byId('st-punch'),
      freeze: byId('st-freeze'),
      stomp: byId('st-stomp'),
    },
  },

  /** The death screen. */
  dead: {
    root: byId('dead'),
    message: byId('dead-msg'),
    timer: byId('dead-timer'),
  },

  /** The round-over card. */
  round: {
    root: byId('round-over'),
    winner: byId('round-winner'),
    mvp: byId('round-mvp'),
  },

  /** The settings menu. */
  settings: {
    root: byId('settings'),
    close: byId('settings-close'),
    music: byId('set-music', HTMLInputElement),
    sfx: byId('set-sfx', HTMLInputElement),
    zoom: byId('set-zoom', HTMLInputElement),
    muted: byId('set-muted', HTMLInputElement),
    fps: byId('set-fps', HTMLInputElement),
    minimap: byId('set-minimap', HTMLInputElement),
    minimapSize: byId('set-minimap-size', HTMLInputElement),
    colorblind: byId('set-colorblind', HTMLInputElement),
    contrast: byId('set-contrast', HTMLInputElement),
    style: byId('set-style', HTMLSelectElement),
    language: byId('set-lang', HTMLSelectElement),
    legend: byId('legend'),
    tutorialAgain: byId('tutorial-again'),
  },

  /** On-screen controls for touch devices. */
  touch: {
    root: byId('touch'),
    joyZone: byId('joy-zone'),
    joyBase: byId('joy-base'),
    joyKnob: byId('joy-knob'),
    bomb: byId('bomb-btn'),
    act: byId('act-btn'),
    jump: byId('jump-btn'),
    gadget: byId('gadget-btn'),
    ability: byId('ability-btn'),
    detach: byId('detach-btn'),
    emote: byId('emote-btn'),
  },
} as const;
