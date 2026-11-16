// Procedural audio for Blast Arena: a chiptune loop and synthesized SFX.
// No audio files or libraries. Every public method is a safe no-op
// until start() has been called from a user gesture.

import type { ArenaMode } from './protocol.js';
//
// Each arena has its own set (see `setTheme`): the original chiptune for
// free-for-all, and a different tempo, arrangement and effects for teams,
// royale, worms, rockets and the dungeon. Cosmos keeps its laser blasters,
// plasma bursts and slow synth-pad soundtrack.

const BPM = 132;
const STEP = 60 / BPM / 4; // sixteenth note, seconds
const STEPS = 64; // 4 bars of 16ths
const LOOKAHEAD = 0.12; // seconds scheduled ahead
const TICK_MS = 25;

const midiHz = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);
const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);

interface Bar { root: number; tones: readonly [number, number, number] }

// A minor: Am - F - C - G. Each bar: bass root (MIDI) and chord tones.
const BARS: readonly Bar[] = [
  { root: 45, tones: [57, 60, 64] }, // Am
  { root: 41, tones: [53, 57, 60] }, // F
  { root: 48, tones: [60, 64, 67] }, // C
  { root: 43, tones: [55, 59, 62] }, // G
];

// Lead: index into [t0, t1, t2, t0+12, t1+12], null = rest.
const LEAD_A: readonly (number | null)[] = [0, 2, 4, 2, 3, null, 1, 2, 0, 2, 4, 3, 4, null, 2, 1];
const LEAD_B: readonly (number | null)[] = [3, null, 2, 1, 2, 4, 3, null, 1, 2, 3, 4, 3, 2, 1, null];
// Drums per sixteenth: k = kick, s = snare, b = both.
type Drum = 'k' | 's' | 'b' | '';
const DRUMS: readonly Drum[] = ['k', '', '', '', 's', '', '', 'k', 'k', '', '', '', 's', '', 'k', ''];

// The cosmos soundtrack: D minor drifting through Bb and C, with a
// suspended A to keep it floating. Pads hold whole bars, a sine arpeggio
// sparkles over them, and the drums are soft and sparse.
const SPACE_BARS: readonly Bar[] = [
  { root: 38, tones: [62, 65, 69] }, // Dm
  { root: 34, tones: [58, 62, 65] }, // Bb
  { root: 36, tones: [60, 64, 67] }, // C
  { root: 33, tones: [57, 62, 64] }, // Asus2
];
const SPACE_ARP: readonly (number | null)[] = [0, null, 2, 1, 4, null, 2, 3, 0, null, 3, 2, 4, 3, null, 1];
const SPACE_DRUMS: readonly Drum[] = ['k', '', '', '', '', '', 's', '', '', '', 'k', '', '', '', 's', ''];

/** Which set of sounds plays: one per arena. See `GameAudio.setTheme`. */
export type SoundTheme = ArenaMode;

/** Semitone shift for the shared mystery and curse stingers. Cosmos stays put. */
const PITCH: Record<SoundTheme, number> = {
  ffa: 0, teams: 3, royale: -5, worms: -7, rockets: 5, dungeon: -2, cosmos: 0,
};

/**
 * A 4-bar loop on the sixteenth grid. Bass and lead offsets are per
 * sixteenth (null rests); lead indexes the bar's chord tones.
 */
interface Score {
  bpm: number;
  bars: readonly Bar[];
  bass: readonly (number | null)[];
  bassWave: OscillatorType;
  bassGain: number;
  /** Note length in sixteenths. */
  bassDur: number;
  bassLp: number | null;
  /** Semitones the bass falls over the note. 0 holds the pitch. */
  bassSlide: number;
  leads: readonly (readonly (number | null)[])[];
  leadWave: OscillatorType;
  leadGain: number;
  leadDur: number;
  /** Added to the lead's MIDI note (the classic lead sits up an octave). */
  leadAdd: number;
  /** Odd bars answer an octave lower (teams: the other colour). */
  answer: boolean;
  /** A square ping on the lead's downbeats. */
  accent: boolean;
  /** Jump the lead up an octave while a bomb is close. */
  hotLift: boolean;
  drums: readonly Drum[];
  /** Last bar: snares on the empty sixteenths from 13 on. */
  fill: boolean;
  kickGain: number;
  snareDur: number;
  snareType: BiquadFilterType;
  snareFreq: number;
  snareQ: number;
  snareGain: number;
  snareEnd: number;
  /** Offbeat hats, only while a bomb is close. */
  hats: boolean;
  /** Offbeat hats all the time (the rocket march). */
  hatsAlways: boolean;
  /** Hold the chord under the bar. */
  pad: boolean;
  padGain: number;
  /** A band of wind across the bar (the royale storm). */
  wind: boolean;
  /** Fraction of a sixteenth the bass lands late on the off-eighth. */
  lump: number;
  /** Lead echo, in sixteenths. 0 plays none. */
  echo: number;
}

// Free-for-all: the original loop, unchanged.
const CLASSIC: Score = {
  bpm: BPM,
  bars: BARS,
  bass: [0, null, 0, null, 12, null, 0, null, 7, null, 0, null, 12, null, 10, null],
  bassWave: 'square', bassGain: 0.16, bassDur: 1.7, bassLp: 900, bassSlide: 0,
  leads: [LEAD_A, LEAD_B],
  leadWave: 'triangle', leadGain: 0.22, leadDur: 0.9, leadAdd: 12,
  answer: false, accent: true, hotLift: true,
  drums: DRUMS, fill: true, kickGain: 0.55,
  snareDur: 0.12, snareType: 'bandpass', snareFreq: 1800, snareQ: 0.8, snareGain: 0.28, snareEnd: 0,
  hats: true, hatsAlways: false, pad: false, padGain: 0, wind: false, lump: 0, echo: 0,
};

// Teams: a brighter march. Odd bars answer an octave down, the other side.
const TEAMS: Score = {
  bpm: 120,
  bars: [
    { root: 48, tones: [60, 64, 67] }, // C
    { root: 43, tones: [55, 59, 62] }, // G
    { root: 45, tones: [57, 60, 64] }, // Am
    { root: 41, tones: [53, 57, 60] }, // F
  ],
  bass: [0, null, 7, null, 0, null, 12, null, 0, null, 7, null, 12, null, 0, null],
  bassWave: 'square', bassGain: 0.15, bassDur: 1.4, bassLp: 1200, bassSlide: 0,
  leads: [
    [0, 2, 4, null, 2, 4, 3, null, 0, 2, 4, null, 4, 3, 2, 0],
    [2, null, 0, 2, 4, null, 3, 2, 0, null, 2, 4, 3, null, 1, 0],
  ],
  leadWave: 'triangle', leadGain: 0.2, leadDur: 0.85, leadAdd: 12,
  answer: true, accent: true, hotLift: true,
  drums: ['k', '', '', '', 's', '', '', '', 'k', '', '', '', 's', '', 'k', ''],
  fill: false, kickGain: 0.5,
  snareDur: 0.1, snareType: 'bandpass', snareFreq: 2400, snareQ: 0.7, snareGain: 0.26, snareEnd: 0,
  hats: true, hatsAlways: false, pad: false, padGain: 0, wind: false, lump: 0, echo: 0,
};

// Royale: slow, minor, a heartbeat and wind. The lead never brightens.
const ROYALE: Score = {
  bpm: 92,
  bars: [
    { root: 40, tones: [52, 55, 59] }, // Em
    { root: 40, tones: [52, 55, 58] },
    { root: 36, tones: [48, 52, 55] }, // C
    { root: 38, tones: [50, 55, 59] }, // D
  ],
  bass: [0, null, null, null, null, null, null, null, 0, null, null, null, null, null, null, null],
  bassWave: 'sine', bassGain: 0.2, bassDur: 7, bassLp: null, bassSlide: 2,
  leads: [
    [0, null, 1, null, 0, null, null, 1, null, null, 0, null, null, null, 1, null],
    [1, null, null, 0, null, null, 2, null, 1, null, null, null, 0, null, null, null],
  ],
  leadWave: 'triangle', leadGain: 0.1, leadDur: 1.6, leadAdd: 0,
  answer: false, accent: false, hotLift: false,
  drums: ['k', '', '', 'k', '', '', '', '', '', '', '', '', 's', '', '', ''],
  fill: false, kickGain: 0.4,
  snareDur: 0.22, snareType: 'bandpass', snareFreq: 800, snareQ: 0.6, snareGain: 0.14, snareEnd: 0,
  hats: false, hatsAlways: false, pad: true, padGain: 0.04, wind: true, lump: 0, echo: 0,
};

// Worms: a low, lopsided squelch. The bass lands late and slides down.
const WORMS: Score = {
  bpm: 108,
  bars: [
    { root: 43, tones: [55, 58, 62] }, // G
    { root: 41, tones: [53, 56, 60] }, // F
    { root: 38, tones: [50, 53, 57] }, // D
    { root: 43, tones: [55, 58, 61] }, // Gm-ish
  ],
  bass: [0, null, null, 0, null, -5, null, 0, null, null, 7, null, 0, null, null, -2],
  bassWave: 'sawtooth', bassGain: 0.11, bassDur: 1.3, bassLp: 480, bassSlide: 7,
  leads: [
    [0, null, 1, 0, null, 2, null, 1, 0, null, null, 1, null, 0, 2, null],
    [2, null, null, 1, 0, null, 1, null, 2, 1, null, 0, null, null, 1, 0],
  ],
  leadWave: 'square', leadGain: 0.07, leadDur: 0.7, leadAdd: 0,
  answer: false, accent: false, hotLift: true,
  drums: ['k', '', '', '', '', 's', '', '', 'k', '', '', 's', '', '', '', ''],
  fill: false, kickGain: 0.46,
  snareDur: 0.18, snareType: 'bandpass', snareFreq: 520, snareQ: 2.2, snareGain: 0.2, snareEnd: 160,
  hats: false, hatsAlways: false, pad: false, padGain: 0, wind: false, lump: 0.45, echo: 0,
};

// Rockets: fast, four on the floor, a saw lead and hats that never stop.
const ROCKETS: Score = {
  bpm: 176,
  bars: [
    { root: 40, tones: [52, 55, 59] }, // Em
    { root: 38, tones: [50, 57, 62] },
    { root: 43, tones: [55, 59, 62] }, // G
    { root: 41, tones: [53, 57, 60] }, // F
  ],
  bass: [null, 0, null, 0, null, 12, null, 0, null, 7, null, 0, null, 12, null, 10],
  bassWave: 'square', bassGain: 0.13, bassDur: 0.7, bassLp: 1600, bassSlide: 0,
  leads: [
    [0, 2, 4, 2, 3, 4, 2, 1, 0, 2, 4, 3, 4, 2, 1, 0],
    [4, 3, 2, 4, 1, 2, 3, 4, 2, 4, 3, 1, 2, 0, 2, 4],
  ],
  leadWave: 'sawtooth', leadGain: 0.055, leadDur: 0.5, leadAdd: 12,
  answer: false, accent: true, hotLift: true,
  drums: ['k', '', '', '', 'b', '', '', '', 'k', '', '', '', 'b', '', 'k', ''],
  fill: false, kickGain: 0.4,
  snareDur: 0.05, snareType: 'highpass', snareFreq: 3500, snareQ: 0.7, snareGain: 0.16, snareEnd: 0,
  hats: false, hatsAlways: true, pad: false, padGain: 0, wind: false, lump: 0, echo: 0,
};

// Dungeon: slow bells over a held chord, with a drip and a cave echo.
const DUNGEON: Score = {
  bpm: 76,
  bars: [
    { root: 38, tones: [50, 53, 57] }, // Dm
    { root: 34, tones: [46, 50, 53] }, // Bb
    { root: 41, tones: [53, 57, 60] }, // F
    { root: 36, tones: [48, 52, 55] }, // C
  ],
  bass: [0, null, null, null, 0, null, null, null, 7, null, null, null, 0, null, null, null],
  bassWave: 'triangle', bassGain: 0.14, bassDur: 3.4, bassLp: 600, bassSlide: 0,
  leads: [
    [0, null, null, 2, null, null, 4, null, null, 2, null, null, 3, null, null, 1],
    [4, null, null, null, 2, null, null, 1, null, null, 0, null, null, 2, null, null],
  ],
  leadWave: 'sine', leadGain: 0.15, leadDur: 2.4, leadAdd: 12,
  answer: false, accent: false, hotLift: false,
  drums: ['k', '', '', '', '', '', '', '', '', '', 's', '', '', '', '', ''],
  fill: false, kickGain: 0.3,
  snareDur: 0.07, snareType: 'highpass', snareFreq: 5200, snareQ: 0.6, snareGain: 0.07, snareEnd: 0,
  hats: false, hatsAlways: false, pad: true, padGain: 0.045, wind: false, lump: 0, echo: 6,
};

const SCORES: Record<Exclude<SoundTheme, 'cosmos'>, Score> = {
  ffa: CLASSIC, teams: TEAMS, royale: ROYALE, worms: WORMS, rockets: ROCKETS, dungeon: DUNGEON,
};
/** Laser pitch (Hz) by blaster colour: green, red plasma, cyan cryo, violet phase, gold nova. */
const LASER_HZ = [1500, 1500, 820, 2300, 1150, 1900] as const;

declare global {
  interface Window { webkitAudioContext?: typeof AudioContext }
}

/** The audio graph, built on the first start(). */
interface Graph {
  ctx: AudioContext;
  master: GainNode;
  music: GainNode;
  sfx: GainNode;
  /** One second of white noise for drums and blasts. */
  noise: AudioBuffer;
}

export class GameAudio {
  private graph: Graph | null = null;
  private isMuted = false;
  private musicVol = 0.35;
  private sfxVol = 0.6;
  private intensity = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private step = 0;
  private nextTime = 0;
  private theme: SoundTheme = 'ffa';

  get muted(): boolean {
    return this.isMuted;
  }

  /** Starts (or resumes) audio; call from a user gesture. */
  start(): void {
    try {
      const g = (this.graph ??= this.build());
      if (!g) return;
      if (g.ctx.state === 'suspended') g.ctx.resume().catch((e: unknown) => console.warn('GameAudio: could not resume', e));
      if (!this.timer) {
        this.step = 0;
        this.nextTime = g.ctx.currentTime + 0.1;
        this.timer = setInterval(() => this.schedule(), TICK_MS);
      }
    } catch (e) {
      console.warn('GameAudio: could not start', e);
    }
  }

  setMusicVolume(v: number): void {
    this.musicVol = clamp01(v);
    const g = this.graph;
    g?.music.gain.setTargetAtTime(this.musicVol * 0.5, g.ctx.currentTime, 0.05);
  }

  setSfxVolume(v: number): void {
    this.sfxVol = clamp01(v);
    const g = this.graph;
    g?.sfx.gain.setTargetAtTime(this.sfxVol, g.ctx.currentTime, 0.05);
  }

  setMuted(m: boolean): void {
    this.isMuted = m;
    const g = this.graph;
    g?.master.gain.setTargetAtTime(m ? 0 : 1, g.ctx.currentTime, 0.03);
  }

  /**
   * Switches the sound set to this arena's. The new loop starts on its
   * next downbeat; cosmos is left on its own soundtrack.
   */
  setTheme(theme: SoundTheme): void {
    if (this.theme === theme) return;
    this.theme = theme;
    this.step = 0;
  }

  /** 0..1; above 0.5 the music shifts up and adds hi-hats. */
  setIntensity(level: number): void {
    this.intensity = clamp01(level);
  }

  // ---- SFX ----

  bombPlaced(): void {
    if (this.theme === 'cosmos') {
      this.laser(1);
      return;
    }
    const g = this.live();
    if (!g) return;
    placeBomb(this.theme, g, now(g));
  }

  /**
   * A blaster shot (cosmos arena): a fast falling zap, pitched by the
   * blaster's colour (see `LASER_HZ`), quieter and panned when far.
   * Plasma is fatter, cryo glassy, phase warbles, nova shoots three.
   */
  laser(colour = 1, distanceTiles = 0, pan = 0): void {
    const g = this.live();
    if (!g) return;
    const d = Math.max(0, distanceTiles);
    if (d > 16) return;
    const t = now(g);
    const near = 1 - d / 16;
    const vol = 0.04 + 0.12 * near * near;
    const out = panned(g, pan, t, 0.4);
    const hz = LASER_HZ[colour] ?? LASER_HZ[1];
    switch (colour) {
      case 2: // plasma: a thick saw with a low thump
        voice(g, 'sawtooth', hz, t, 0.22, vol, out, 3200, 140);
        voice(g, 'sine', 180, t, 0.12, vol * 0.8, out, null, 60);
        break;
      case 3: // cryo: glassy, with a high shimmer
        voice(g, 'triangle', hz, t, 0.2, vol * 1.2, out, null, 260);
        voice(g, 'sine', hz * 3, t, 0.12, vol * 0.35, out, null, hz * 1.5);
        break;
      case 4: { // phase: a warbling sweep
        const osc = voice(g, 'square', hz, t, 0.24, vol * 0.7, out, 2600, 200);
        const lfo = g.ctx.createOscillator();
        lfo.frequency.value = 38;
        const depth = g.ctx.createGain();
        depth.gain.value = hz * 0.12;
        lfo.connect(depth);
        depth.connect(osc.frequency);
        lfo.start(t);
        lfo.stop(t + 0.26);
        break;
      }
      case 5: // nova: three quick zaps
        for (let i = 0; i < 3; i++) voice(g, 'square', hz * (1 - i * 0.12), t + i * 0.035, 0.12, vol * 0.7, out, 4200, 300);
        break;
      default: // green: the classic pew
        voice(g, 'square', hz, t, 0.16, vol, out, 4000, 220);
    }
    noiseHit(g, t, 0.03, 'highpass', 5000, 0.7, vol * 0.4, out);
  }

  /** `pan` places the blast left/right of the listener (-1 .. 1). */
  explosion(distanceTiles = 0, pan = 0): void {
    const g = this.live();
    if (!g) return;
    const d = Math.max(0, distanceTiles);
    if (d > 20) return;
    const t = now(g);
    const near = 1 - d / 20; // 1 = on top of player
    if (this.theme === 'cosmos') {
      // A plasma burst: an electric crackle over a falling, ringing sweep.
      const vol = 0.12 + 0.6 * near * near;
      const out = panned(g, pan * (1 - near * 0.5), t, 0.9);
      noiseHit(g, t, 0.25 + 0.2 * near, 'bandpass', 2400, 2.5, vol * 0.8, out, 300);
      voice(g, 'sawtooth', 640 + 300 * near, t, 0.4 + 0.2 * near, vol * 0.45, out, 1800, 50);
      voice(g, 'sine', 70 + 30 * near, t, 0.35, vol * near, out, null, 28);
      return;
    }
    const vol = 0.15 + 0.75 * near * near;
    const cutoff = 500 + 2500 * near;
    const dur = 0.35 + 0.35 * near;
    const out = panned(g, pan * (1 - near * 0.5), t, dur + 0.4);
    blast(this.theme, g, t, near, vol, cutoff, dur, out);
  }

  /** An atomic blast: a sharp crack, then a long, deep, rolling rumble. */
  nuke(distanceTiles = 0, pan = 0): void {
    const g = this.live();
    if (!g) return;
    const t = now(g);
    const near = Math.max(0.25, 1 - Math.max(0, distanceTiles) / 40); // heard across the whole arena
    const out = panned(g, pan * (1 - near * 0.5), t, 4);
    noiseHit(g, t, 0.4, 'highpass', 1500, 0.7, 0.5 * near, out);
    noiseHit(g, t, 3.2, 'lowpass', 260 + 500 * near, 0.9, 0.95 * near, out, 60);
    voice(g, 'sine', 52, t, 2.6, 0.9 * near, out, null, 24);
    voice(g, 'triangle', 38, t + 0.05, 3.0, 0.5 * near, out, 400, 18);
  }

  /** A springy hop (a jetpack whoosh in space). */
  jump(): void {
    const g = this.live();
    if (!g) return;
    const t = now(g);
    if (this.theme === 'cosmos') {
      noiseHit(g, t, 0.3, 'bandpass', 600, 1.2, 0.12, g.sfx, 2600);
      voice(g, 'sine', 180, t, 0.25, 0.08, g.sfx, null, 520);
      return;
    }
    hop(this.theme, g, t);
  }

  pickup(): void {
    const g = this.live();
    if (!g) return;
    const t = now(g);
    if (this.theme === 'cosmos') {
      // A rising, shimmering power-up chime.
      [74, 81, 86, 93].forEach((m, i) => voice(g, 'sine', midiHz(m), t + i * 0.05, 0.22, 0.11, g.sfx, null, midiHz(m + 2)));
      voice(g, 'triangle', midiHz(62), t, 0.3, 0.08, g.sfx, null, midiHz(74));
      return;
    }
    collect(this.theme, g, t);
  }

  mystery(): void {
    const g = this.live();
    if (!g) return;
    const t = now(g);
    const shift = PITCH[this.theme];
    for (let i = 0; i < 8; i++) {
      const m = 76 + shift + i * 2 + (i % 2 ? 5 : 0);
      voice(g, 'triangle', midiHz(m), t + i * 0.04, 0.12, 0.16, g.sfx);
    }
    voice(g, 'sine', midiHz(96 + shift), t + 0.32, 0.25, 0.08, g.sfx);
  }

  curse(): void {
    const g = this.live();
    if (!g) return;
    const t = now(g);
    const osc = voice(g, 'sawtooth', 520 + PITCH[this.theme] * 18, t, 0.6, 0.14, g.sfx, 1400, 110);
    const lfo = g.ctx.createOscillator();
    lfo.frequency.value = 11;
    const depth = g.ctx.createGain();
    depth.gain.value = 30;
    lfo.connect(depth);
    depth.connect(osc.frequency);
    lfo.start(t);
    lfo.stop(t + 0.65);
  }

  death(): void {
    const g = this.live();
    if (!g) return;
    const t = now(g);
    if (this.theme === 'cosmos') {
      // Powering down: a long falling saw and a fading sine.
      voice(g, 'sawtooth', 880, t, 0.9, 0.12, g.sfx, 2000, 40);
      voice(g, 'sine', midiHz(62), t + 0.1, 1.1, 0.14, g.sfx, null, midiHz(38));
      noiseHit(g, t, 0.5, 'lowpass', 1800, 0.8, 0.12, g.sfx, 120);
      return;
    }
    downed(this.theme, g, t);
  }

  kick(): void {
    const g = this.live();
    if (!g) return;
    const t = now(g);
    boot(this.theme, g, t);
  }

  uiClick(): void {
    const g = this.live();
    if (!g) return;
    voice(g, 'square', 1200, now(g), 0.03, 0.08, g.sfx, 5000, 900);
  }

  // ---- internals ----

  /** The graph, if started and not closed. */
  private live(): Graph | null {
    const g = this.graph;
    return g && g.ctx.state !== 'closed' ? g : null;
  }

  private build(): Graph | null {
    const AC = window.AudioContext as typeof AudioContext | undefined ?? window.webkitAudioContext;
    if (!AC) return null;
    const ctx = new AC();

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12;
    comp.ratio.value = 4;
    comp.connect(ctx.destination);

    const master = ctx.createGain();
    master.gain.value = this.isMuted ? 0 : 1;
    master.connect(comp);

    const music = ctx.createGain();
    music.gain.value = this.musicVol * 0.5;
    music.connect(master);

    const sfx = ctx.createGain();
    sfx.gain.value = this.sfxVol;
    sfx.connect(master);

    const len = ctx.sampleRate; // 1 s of white noise
    const noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = noise.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return { ctx, master, music, sfx, noise };
  }

  private schedule(): void {
    const g = this.graph;
    if (g?.ctx.state !== 'running') return;
    const ctx = g.ctx;
    // Background tabs throttle timers; skip ahead rather than burst-play.
    if (this.nextTime < ctx.currentTime - 0.05) this.nextTime = ctx.currentTime + 0.05;
    while (this.nextTime < ctx.currentTime + LOOKAHEAD) {
      this.playStep(g, this.step, this.nextTime);
      this.nextTime += this.stepLen();
      this.step = (this.step + 1) % STEPS;
    }
  }

  /** Sixteenth-note length for the arena that's playing. */
  private stepLen(): number {
    return this.theme === 'cosmos' ? STEP : 60 / SCORES[this.theme].bpm / 4;
  }

  private playStep(g: Graph, step: number, t: number): void {
    if (this.theme === 'cosmos') {
      this.playSpaceStep(g, step, t);
      return;
    }
    this.playScore(g, step, t, SCORES[this.theme]);
  }

  /** One sixteenth of an arena's loop. */
  private playScore(g: Graph, step: number, t: number, score: Score): void {
    const stepDur = 60 / score.bpm / 4;
    const barIdx = Math.floor(step / 16);
    const s = step % 16;
    const bar = score.bars[barIdx % score.bars.length];
    const hot = this.intensity > 0.5;
    const out = g.music;
    const when = t + (s % 4 === 2 ? stepDur * score.lump : 0);

    const off = score.bass[s];
    if (off != null) {
      const note = bar.root + off;
      voice(g, score.bassWave, midiHz(note), when, stepDur * score.bassDur, score.bassGain, out, score.bassLp, score.bassSlide ? midiHz(note - score.bassSlide) : 0);
    }
    if (score.pad && s === 0) {
      for (const m of bar.tones) voice(g, 'triangle', midiHz(m), t, stepDur * 16, score.padGain, out, 900);
    }
    if (score.wind && s === 0) noiseHit(g, t, stepDur * 15, 'bandpass', 420, 0.35, 0.05, out, 700);

    const idx = score.leads[barIdx % score.leads.length]?.[s];
    if (idx != null) {
      const tones = [bar.tones[0], bar.tones[1], bar.tones[2], bar.tones[0] + 12, bar.tones[1] + 12];
      const add = score.leadAdd + (score.answer && barIdx % 2 === 1 ? -12 : 0) + (hot && score.hotLift ? 12 : 0);
      const note = (tones[idx] ?? bar.root) + add;
      voice(g, score.leadWave, midiHz(note), t, stepDur * score.leadDur, score.leadGain, out);
      if (score.accent && s % 4 === 0) voice(g, 'square', midiHz(note), t, stepDur * 0.6, 0.04, out, 3000);
      if (score.echo) voice(g, score.leadWave, midiHz(note), t + stepDur * score.echo, stepDur * score.leadDur, score.leadGain * 0.35, out);
    }

    let d = score.drums[s] ?? '';
    if (!d && score.fill && barIdx % score.bars.length === score.bars.length - 1 && s >= 13) d = 's';
    if (d === 'k' || d === 'b') kickDrum(g, t, score.kickGain, out);
    if (d === 's' || d === 'b') noiseHit(g, t, score.snareDur, score.snareType, score.snareFreq, score.snareQ, score.snareGain, out, score.snareEnd);
    if ((score.hatsAlways || (score.hats && hot)) && s % 2 === 1) {
      noiseHit(g, t, 0.03, 'highpass', 7000, 0.7, score.hatsAlways ? 0.07 : 0.12, out);
    }
  }

  /** The cosmos soundtrack: pads, a sine arpeggio and a soft pulse. */
  private playSpaceStep(g: Graph, step: number, t: number): void {
    const barIdx = Math.floor(step / 16);
    const s = step % 16;
    const bar = SPACE_BARS[barIdx % SPACE_BARS.length];
    const hot = this.intensity > 0.5;
    const out = g.music;
    // A slow pad: the chord, slightly detuned, held for the whole bar.
    if (s === 0) {
      for (const [k, m] of bar.tones.entries()) {
        voice(g, 'triangle', midiHz(m) * (1 + (k - 1) * 0.003), t, STEP * 16, 0.07, out, 1400);
      }
      voice(g, 'sine', midiHz(bar.root), t, STEP * 15, 0.22, out);
    }
    // A pulsing sub-bass on quarter notes.
    if (s % 4 === 2) voice(g, 'sine', midiHz(bar.root + 12), t, STEP * 2, 0.1, out, null, midiHz(bar.root));
    // A sparkling sine arpeggio, an octave up and twice as busy when hot.
    const idx = SPACE_ARP[s];
    if (idx != null && (hot || s % 2 === 0)) {
      const tones = [...bar.tones, bar.tones[0] + 12, bar.tones[1] + 12];
      const note = (tones[idx] ?? bar.root) + 12 + (hot ? 12 : 0);
      voice(g, 'sine', midiHz(note), t, STEP * 2.5, 0.13, out);
      // A quiet echo a dotted eighth later.
      voice(g, 'sine', midiHz(note), t + STEP * 3, STEP * 2, 0.04, out);
    }
    const d = SPACE_DRUMS[s];
    if (d === 'k') kickDrum(g, t, 0.35, out);
    else if (d === 's') noiseHit(g, t, 0.2, 'highpass', 3500, 0.6, 0.1, out, 9000);
    if (hot && s % 2 === 1) noiseHit(g, t, 0.025, 'highpass', 9000, 0.7, 0.07, out);
  }
}

// ---- synthesis primitives ----

const now = (g: Graph): number => g.ctx.currentTime + 0.005;

function voice(
  g: Graph, type: OscillatorType, freq: number, t: number, dur: number, gain: number, dest: AudioNode,
  lowpass: number | null = null, freqEnd = 0,
): OscillatorNode {
  const { ctx } = g;
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (freqEnd) osc.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), t + dur);
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(gain, t + 0.005);
  env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  let node: AudioNode = osc;
  if (lowpass) {
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = lowpass;
    osc.connect(f);
    node = f;
  }
  node.connect(env);
  env.connect(dest);
  osc.start(t);
  osc.stop(t + dur + 0.02);
  return osc;
}

function noiseHit(
  g: Graph, t: number, dur: number, filterType: BiquadFilterType, freq: number, q: number, gain: number,
  dest: AudioNode, freqEnd = 0,
): void {
  const { ctx } = g;
  const src = ctx.createBufferSource();
  src.buffer = g.noise;
  const f = ctx.createBiquadFilter();
  f.type = filterType;
  f.frequency.setValueAtTime(freq, t);
  if (freqEnd) f.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
  f.Q.value = q;
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(gain, t + 0.003);
  env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f);
  f.connect(env);
  env.connect(dest);
  src.start(t, Math.random() * 0.5);
  src.stop(t + dur + 0.02);
}

function kickDrum(g: Graph, t: number, gain: number, dest: AudioNode): void {
  voice(g, 'sine', 150, t, 0.16, gain, dest, null, 45);
  noiseHit(g, t, 0.02, 'lowpass', 1200, 0.7, gain * 0.3, dest);
}

/**
 * A stereo panner feeding the SFX bus, for positional sounds. `pan` is
 * -1 (left) .. 1 (right). Returns the plain SFX bus when there's no pan.
 */
function panned(g: Graph, pan: number, t: number, dur: number): AudioNode {
  if (!pan) return g.sfx;
  const p = g.ctx.createStereoPanner();
  p.pan.setValueAtTime(Math.max(-1, Math.min(1, pan)), t);
  p.connect(g.sfx);
  setTimeout(() => p.disconnect(), (dur + 0.2) * 1000);
  return p;
}

// ---- arena effects (cosmos keeps its own, in GameAudio) ----

type Ground = Exclude<SoundTheme, 'cosmos'>;

/** Dropping a bomb, or launching a rocket. */
function placeBomb(theme: Ground, g: Graph, t: number): void {
  switch (theme) {
    case 'teams':
      voice(g, 'square', 523, t, 0.06, 0.14, g.sfx, 3000);
      voice(g, 'square', 659, t + 0.06, 0.08, 0.14, g.sfx, 3000);
      break;
    case 'royale':
      voice(g, 'square', 140, t, 0.08, 0.16, g.sfx, 700, 70);
      noiseHit(g, t, 0.07, 'lowpass', 400, 0.8, 0.16, g.sfx);
      break;
    case 'worms':
      voice(g, 'sine', 90, t, 0.12, 0.2, g.sfx, null, 180);
      noiseHit(g, t, 0.1, 'bandpass', 420, 1.6, 0.16, g.sfx, 180);
      break;
    case 'rockets':
      noiseHit(g, t, 0.28, 'bandpass', 500, 0.8, 0.2, g.sfx, 4200);
      voice(g, 'sawtooth', 180, t, 0.22, 0.08, g.sfx, 2400, 980);
      break;
    case 'dungeon':
      voice(g, 'square', 190, t, 0.04, 0.12, g.sfx, 900);
      voice(g, 'sine', 74, t, 0.16, 0.18, g.sfx, null, 48);
      break;
    case 'ffa':
      voice(g, 'square', 220, t, 0.09, 0.18, g.sfx, 1500, 110);
      noiseHit(g, t, 0.05, 'lowpass', 800, 1, 0.2, g.sfx);
      break;
  }
}

/** The blast itself, after distance has set `vol`, `cutoff` and `dur`. */
function blast(theme: Ground, g: Graph, t: number, near: number, vol: number, cutoff: number, dur: number, out: AudioNode): void {
  switch (theme) {
    case 'teams':
      noiseHit(g, t, 0.05, 'highpass', 2500, 0.7, vol * 0.35, out);
      noiseHit(g, t, dur, 'lowpass', cutoff, 0.8, vol, out, 140);
      voice(g, 'square', 180, t, 0.08, vol * 0.2, out, 2000);
      voice(g, 'sine', 96 + 30 * near, t, 0.28 + 0.2 * near, vol * near, out, null, 34);
      break;
    case 'royale':
      noiseHit(g, t, dur + 0.2, 'lowpass', 280 + 700 * near, 0.7, vol, out, 50);
      voice(g, 'sine', 48 + 16 * near, t, 0.5 + 0.3 * near, vol * near, out, null, 22);
      break;
    case 'worms':
      noiseHit(g, t, dur + 0.1, 'bandpass', 360 + 200 * near, 1.8, vol * 0.9, out, 90);
      voice(g, 'sine', 70, t, 0.3, vol * 0.5, out, null, 40);
      break;
    case 'rockets':
      noiseHit(g, t, 0.06, 'highpass', 1800, 0.6, vol * 0.55, out);
      noiseHit(g, t, 0.22 + 0.1 * near, 'lowpass', 900 + cutoff * 0.3, 0.7, vol, out, 80);
      voice(g, 'sawtooth', 240 + 80 * near, t, 0.16, vol * 0.25, out, 1600, 60);
      break;
    case 'dungeon':
      noiseHit(g, t, dur, 'lowpass', cutoff * 0.7, 0.7, vol * 0.85, out, 90);
      voice(g, 'sine', 64, t, 0.4, vol * near, out, null, 28);
      noiseHit(g, t + 0.2, dur * 0.7, 'lowpass', cutoff * 0.4, 0.6, vol * 0.4, out, 70);
      break;
    case 'ffa':
      noiseHit(g, t, dur, 'lowpass', cutoff, 0.8, vol, out, 120);
      voice(g, 'sine', 90 + 40 * near, t, 0.3 + 0.3 * near, vol * near, out, null, 30);
      break;
  }
}

/** Leaving the ground. */
function hop(theme: Ground, g: Graph, t: number): void {
  switch (theme) {
    case 'teams':
      voice(g, 'square', 340, t, 0.12, 0.1, g.sfx, 2800, 880);
      break;
    case 'royale':
      noiseHit(g, t, 0.16, 'bandpass', 900, 0.6, 0.08, g.sfx, 300);
      break;
    case 'worms':
      voice(g, 'sine', 110, t, 0.18, 0.14, g.sfx, null, 260);
      break;
    case 'rockets':
      noiseHit(g, t, 0.18, 'bandpass', 700, 0.8, 0.1, g.sfx, 3600);
      voice(g, 'sawtooth', 220, t, 0.14, 0.05, g.sfx, 2000, 700);
      break;
    case 'dungeon':
      noiseHit(g, t, 0.1, 'highpass', 2400, 0.5, 0.05, g.sfx);
      break;
    case 'ffa':
      voice(g, 'square', 260, t, 0.16, 0.1, g.sfx, 2200, 720);
      noiseHit(g, t, 0.08, 'highpass', 3000, 0.7, 0.05, g.sfx);
      break;
  }
}

/** Picking a power-up up. */
function collect(theme: Ground, g: Graph, t: number): void {
  const chime = (notes: readonly number[], wave: OscillatorType, gap: number, dur: number, gain: number): void => {
    notes.forEach((m, i) => voice(g, wave, midiHz(m), t + i * gap, dur, gain, g.sfx, wave === 'square' ? 4000 : null));
  };
  switch (theme) {
    case 'teams':
      chime([72, 76, 79, 84], 'triangle', 0.04, 0.12, 0.13);
      break;
    case 'royale':
      chime([68, 71, 75], 'sine', 0.08, 0.2, 0.12);
      break;
    case 'worms':
      chime([55, 62, 67], 'sine', 0.06, 0.14, 0.14);
      break;
    case 'rockets':
      chime([76, 84, 88, 96], 'sawtooth', 0.03, 0.07, 0.07);
      break;
    case 'dungeon':
      chime([79, 83, 86, 91], 'sine', 0.09, 0.32, 0.11);
      break;
    case 'ffa':
      chime([72, 76, 79, 84], 'square', 0.045, 0.08, 0.12);
      break;
  }
}

/** The local player is knocked out. */
function downed(theme: Ground, g: Graph, t: number): void {
  switch (theme) {
    case 'teams':
      [67, 64, 60, 55].forEach((m, i) => voice(g, 'square', midiHz(m), t + i * 0.09, 0.12, 0.13, g.sfx, 2200));
      noiseHit(g, t, 0.08, 'bandpass', 2200, 0.8, 0.12, g.sfx);
      break;
    case 'royale':
      voice(g, 'sine', midiHz(48), t, 1.1, 0.2, g.sfx, null, midiHz(30));
      noiseHit(g, t, 0.6, 'lowpass', 500, 0.6, 0.1, g.sfx, 80);
      break;
    case 'worms': {
      const osc = voice(g, 'sine', midiHz(58), t, 0.7, 0.16, g.sfx, null, midiHz(34));
      const lfo = g.ctx.createOscillator();
      lfo.frequency.value = 14;
      const depth = g.ctx.createGain();
      depth.gain.value = 20;
      lfo.connect(depth);
      depth.connect(osc.frequency);
      lfo.start(t);
      lfo.stop(t + 0.72);
      noiseHit(g, t, 0.25, 'bandpass', 400, 1.4, 0.1, g.sfx, 140);
      break;
    }
    case 'rockets':
      noiseHit(g, t, 0.12, 'highpass', 2000, 0.6, 0.14, g.sfx);
      voice(g, 'sawtooth', 740, t, 0.35, 0.08, g.sfx, 1800, 70);
      break;
    case 'dungeon':
      [72, 67, 64, 60, 55].forEach((m, i) => voice(g, 'sine', midiHz(m), t + i * 0.16, 0.4, 0.12, g.sfx));
      break;
    case 'ffa':
      [67, 63, 60, 55].forEach((m, i) =>
        voice(g, 'square', midiHz(m), t + i * 0.12, 0.14, 0.14, g.sfx, 2000, midiHz(m - 1)));
      voice(g, 'triangle', midiHz(43), t + 0.48, 0.5, 0.2, g.sfx, null, midiHz(31));
      break;
  }
}

/** A bomb kicked across the floor. */
function boot(theme: SoundTheme, g: Graph, t: number): void {
  switch (theme) {
    case 'worms':
      voice(g, 'sine', 160, t, 0.1, 0.22, g.sfx, null, 50);
      noiseHit(g, t, 0.08, 'bandpass', 500, 1.8, 0.14, g.sfx, 160);
      break;
    case 'rockets':
      voice(g, 'square', 480, t, 0.05, 0.16, g.sfx, 2400, 160);
      noiseHit(g, t, 0.04, 'highpass', 3000, 0.7, 0.1, g.sfx);
      break;
    case 'dungeon':
      voice(g, 'sine', 140, t, 0.1, 0.24, g.sfx, null, 50);
      noiseHit(g, t, 0.05, 'lowpass', 700, 0.7, 0.12, g.sfx);
      break;
    case 'royale':
      voice(g, 'sine', 220, t, 0.09, 0.22, g.sfx, null, 60);
      noiseHit(g, t, 0.05, 'lowpass', 900, 0.8, 0.1, g.sfx);
      break;
    case 'teams':
      voice(g, 'sine', 360, t, 0.07, 0.26, g.sfx, null, 110);
      noiseHit(g, t, 0.04, 'bandpass', 2600, 1.2, 0.14, g.sfx);
      break;
    case 'cosmos':
    case 'ffa':
      voice(g, 'sine', 300, t, 0.08, 0.3, g.sfx, null, 90);
      noiseHit(g, t, 0.04, 'bandpass', 2000, 1.5, 0.15, g.sfx);
      break;
  }
}
