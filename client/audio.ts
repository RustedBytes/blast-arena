// Procedural audio for Blast Arena: a chiptune loop and synthesized SFX.
// No dependencies, no audio files. Every public method is a safe no-op
// until start() has been called from a user gesture.

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

  /** 0..1; above 0.5 the music shifts up and adds hi-hats. */
  setIntensity(level: number): void {
    this.intensity = clamp01(level);
  }

  // ---- SFX ----

  bombPlaced(): void {
    const g = this.live();
    if (!g) return;
    const t = now(g);
    voice(g, 'square', 220, t, 0.09, 0.18, g.sfx, 1500, 110);
    noiseHit(g, t, 0.05, 'lowpass', 800, 1, 0.2, g.sfx);
  }

  /** `pan` places the blast left/right of the listener (-1 .. 1). */
  explosion(distanceTiles = 0, pan = 0): void {
    const g = this.live();
    if (!g) return;
    const d = Math.max(0, distanceTiles);
    if (d > 20) return;
    const t = now(g);
    const near = 1 - d / 20; // 1 = on top of player
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

  /** A springy hop. */
  jump(): void {
    const g = this.live();
    if (!g) return;
    const t = now(g);
    voice(g, 'square', 260, t, 0.16, 0.1, g.sfx, 2200, 720);
    noiseHit(g, t, 0.08, 'highpass', 3000, 0.7, 0.05, g.sfx);
  }

  pickup(): void {
    const g = this.live();
    if (!g) return;
    const t = now(g);
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
