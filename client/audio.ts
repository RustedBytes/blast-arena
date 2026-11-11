// Procedural audio for Blast Arena: a chiptune loop and synthesized SFX.
// No dependencies, no audio files. Every public method is a safe no-op
// until start() has been called from a user gesture.
//
// Two sound sets: the classic one, and a cosmos one for the space arena
// (laser blasters, plasma bursts, a slow synth-pad soundtrack); see
// `setTheme`.

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

// Bass offsets per eighth note (null = rest), relative to bar root.
const BASS: readonly (number | null)[] = [0, 0, 12, 0, 7, 0, 12, 10];
// Lead: index into [t0, t1, t2, t0+12, t1+12], null = rest.
const LEAD_A: readonly (number | null)[] = [0, 2, 4, 2, 3, null, 1, 2, 0, 2, 4, 3, 4, null, 2, 1];
const LEAD_B: readonly (number | null)[] = [3, null, 2, 1, 2, 4, 3, null, 1, 2, 3, 4, 3, 2, 1, null];
type Drum = 'k' | 's' | '';
// Drums per sixteenth: k = kick, s = snare.
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

/** Which set of sounds plays: see `GameAudio.setTheme`. */
export type SoundTheme = 'classic' | 'cosmos';
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
  private theme: SoundTheme = 'classic';

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
   * Switches the sound set: 'cosmos' for the space arena, 'classic'
   * everywhere else. The music changes from the next bar.
   */
  setTheme(theme: SoundTheme): void {
    this.theme = theme;
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
    const t = now(g);
    voice(g, 'square', 220, t, 0.09, 0.18, g.sfx, 1500, 110);
    noiseHit(g, t, 0.05, 'lowpass', 800, 1, 0.2, g.sfx);
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
    noiseHit(g, t, dur, 'lowpass', cutoff, 0.8, vol, out, 120);
    voice(g, 'sine', 90 + 40 * near, t, 0.3 + 0.3 * near, vol * near, out, null, 30);
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
    voice(g, 'square', 260, t, 0.16, 0.1, g.sfx, 2200, 720);
    noiseHit(g, t, 0.08, 'highpass', 3000, 0.7, 0.05, g.sfx);
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
    [72, 76, 79, 84].forEach((m, i) => voice(g, 'square', midiHz(m), t + i * 0.045, 0.08, 0.12, g.sfx, 4000));
  }

  mystery(): void {
    const g = this.live();
    if (!g) return;
    const t = now(g);
    for (let i = 0; i < 8; i++) {
      const m = 76 + i * 2 + (i % 2 ? 5 : 0);
      voice(g, 'triangle', midiHz(m), t + i * 0.04, 0.12, 0.16, g.sfx);
    }
    voice(g, 'sine', midiHz(96), t + 0.32, 0.25, 0.08, g.sfx);
  }

  curse(): void {
    const g = this.live();
    if (!g) return;
    const t = now(g);
    const osc = voice(g, 'sawtooth', 520, t, 0.6, 0.14, g.sfx, 1400, 110);
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
    [67, 63, 60, 55].forEach((m, i) =>
      voice(g, 'square', midiHz(m), t + i * 0.12, 0.14, 0.14, g.sfx, 2000, midiHz(m - 1)));
    voice(g, 'triangle', midiHz(43), t + 0.48, 0.5, 0.2, g.sfx, null, midiHz(31));
  }

  kick(): void {
    const g = this.live();
    if (!g) return;
    const t = now(g);
    voice(g, 'sine', 300, t, 0.08, 0.3, g.sfx, null, 90);
    noiseHit(g, t, 0.04, 'bandpass', 2000, 1.5, 0.15, g.sfx);
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
      this.nextTime += STEP;
      this.step = (this.step + 1) % STEPS;
    }
  }

  private playStep(g: Graph, step: number, t: number): void {
    if (this.theme === 'cosmos') {
      this.playSpaceStep(g, step, t);
      return;
    }
    const barIdx = Math.floor(step / 16);
    const s = step % 16;
    const bar = BARS[barIdx % BARS.length];
    const hot = this.intensity > 0.5;
    const out = g.music;

    // Bass on eighths.
    const off = s % 2 === 0 ? BASS[s / 2] : null;
    if (off != null) voice(g, 'square', midiHz(bar.root + off), t, STEP * 1.7, 0.16, out, 900);

    // Lead arpeggio on sixteenths; alternate patterns per bar.
    const idx = (barIdx % 2 === 0 ? LEAD_A : LEAD_B)[s];
    if (idx != null) {
      const tones = [...bar.tones, bar.tones[0] + 12, bar.tones[1] + 12];
      const note = (tones[idx] ?? bar.root) + 12 + (hot ? 12 : 0);
      voice(g, 'triangle', midiHz(note), t, STEP * 0.9, 0.22, out);
      if (s % 4 === 0) voice(g, 'square', midiHz(note), t, STEP * 0.6, 0.04, out, 3000);
    }

    // Drums; the last bar ends on a snare fill.
    const d = DRUMS[s] || (barIdx === 3 && s >= 13 ? 's' : '');
    if (d === 'k') kickDrum(g, t, 0.55, out);
    else if (d === 's') noiseHit(g, t, 0.12, 'bandpass', 1800, 0.8, 0.28, out);
    if (hot && s % 2 === 1) noiseHit(g, t, 0.03, 'highpass', 7000, 0.7, 0.12, out);
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
