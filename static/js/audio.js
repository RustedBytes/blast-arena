// Procedural audio for Blast Arena: a chiptune loop and synthesized SFX.
// No dependencies, no audio files. Every public method is a safe no-op
// until start() has been called from a user gesture.

const BPM = 132;
const STEP = 60 / BPM / 4; // sixteenth note, seconds
const STEPS = 64; // 4 bars of 16ths
const LOOKAHEAD = 0.12; // seconds scheduled ahead
const TICK_MS = 25;

const midiHz = (m) => 440 * Math.pow(2, (m - 69) / 12);
const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));

// A minor: Am - F - C - G. Each bar: bass root (MIDI) and chord tones.
const BARS = [
  { root: 45, tones: [57, 60, 64] }, // Am
  { root: 41, tones: [53, 57, 60] }, // F
  { root: 48, tones: [60, 64, 67] }, // C
  { root: 43, tones: [55, 59, 62] }, // G
];

// Bass offsets per eighth note (null = rest), relative to bar root.
const BASS = [0, 0, 12, 0, 7, 0, 12, 10];
// Lead: index into [t0, t1, t2, t0+12, t1+12], null = rest.
const LEAD_A = [0, 2, 4, 2, 3, null, 1, 2, 0, 2, 4, 3, 4, null, 2, 1];
const LEAD_B = [3, null, 2, 1, 2, 4, 3, null, 1, 2, 3, 4, 3, 2, 1, null];
// Drums per sixteenth: k = kick, s = snare.
const DRUMS = ['k', '', '', '', 's', '', '', 'k', 'k', '', '', '', 's', '', 'k', ''];

export class GameAudio {
  constructor() {
    this.ctx = null;
    this._muted = false;
    this._musicVol = 0.35;
    this._sfxVol = 0.6;
    this._intensity = 0;
    this._timer = null;
    this._step = 0;
    this._nextTime = 0;
    this._noise = null;
  }

  get muted() {
    return this._muted;
  }

  start() {
    try {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        const ctx = new AC();
        this.ctx = ctx;

        const comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -12;
        comp.ratio.value = 4;
        comp.connect(ctx.destination);

        this.master = ctx.createGain();
        this.master.gain.value = this._muted ? 0 : 1;
        this.master.connect(comp);

        this.musicGain = ctx.createGain();
        this.musicGain.gain.value = this._musicVol * 0.5;
        this.musicGain.connect(this.master);

        this.sfxGain = ctx.createGain();
        this.sfxGain.gain.value = this._sfxVol;
        this.sfxGain.connect(this.master);

        const len = ctx.sampleRate; // 1 s of white noise
        this._noise = ctx.createBuffer(1, len, ctx.sampleRate);
        const data = this._noise.getChannelData(0);
        for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      }
      if (this.ctx.state === 'suspended') this.ctx.resume();
      if (!this._timer) {
        this._step = 0;
        this._nextTime = this.ctx.currentTime + 0.1;
        this._timer = setInterval(() => this._schedule(), TICK_MS);
      }
    } catch (e) {
      console.warn('GameAudio: could not start', e);
    }
  }

  setMusicVolume(v) {
    this._musicVol = clamp01(v);
    if (this.ctx) this.musicGain.gain.setTargetAtTime(this._musicVol * 0.5, this.ctx.currentTime, 0.05);
  }

  setSfxVolume(v) {
    this._sfxVol = clamp01(v);
    if (this.ctx) this.sfxGain.gain.setTargetAtTime(this._sfxVol, this.ctx.currentTime, 0.05);
  }

  setMuted(m) {
    this._muted = !!m;
    if (this.ctx) this.master.gain.setTargetAtTime(this._muted ? 0 : 1, this.ctx.currentTime, 0.03);
  }

  setIntensity(level) {
    this._intensity = clamp01(level);
  }

  // ---- music ----

  _schedule() {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    // Background tabs throttle timers; skip ahead rather than burst-play.
    if (this._nextTime < ctx.currentTime - 0.05) this._nextTime = ctx.currentTime + 0.05;
    while (this._nextTime < ctx.currentTime + LOOKAHEAD) {
      this._playStep(this._step, this._nextTime);
      this._nextTime += STEP;
      this._step = (this._step + 1) % STEPS;
    }
  }

  _playStep(step, t) {
    const barIdx = Math.floor(step / 16);
    const s = step % 16;
    const bar = BARS[barIdx];
    const hot = this._intensity > 0.5;
    const out = this.musicGain;

    // Bass on eighths.
    if (s % 2 === 0) {
      const off = BASS[s / 2];
      if (off !== null) this._voice('square', midiHz(bar.root + off), t, STEP * 1.7, 0.16, out, 900);
    }

    // Lead arpeggio on sixteenths; alternate patterns per bar.
    const pat = barIdx % 2 === 0 ? LEAD_A : LEAD_B;
    const idx = pat[s];
    if (idx !== null) {
      const tones = [...bar.tones, bar.tones[0] + 12, bar.tones[1] + 12];
      const note = tones[idx] + 12 + (hot ? 12 : 0);
      this._voice('triangle', midiHz(note), t, STEP * 0.9, 0.22, out);
      if (s % 4 === 0) this._voice('square', midiHz(note), t, STEP * 0.6, 0.04, out, 3000);
    }

    // Drums.
    const d = DRUMS[s] || (barIdx === 3 && s >= 13 ? 's' : '');
    if (d === 'k') this._kick(t, 0.55, out);
    else if (d === 's') this._noiseHit(t, 0.12, 'bandpass', 1800, 0.8, 0.28, out);
    if (hot && s % 2 === 1) this._noiseHit(t, 0.03, 'highpass', 7000, 0.7, 0.12, out);
  }

  // ---- synthesis primitives ----

  _voice(type, freq, t, dur, gain, dest, lowpass, freqEnd) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (freqEnd) osc.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let node = osc;
    if (lowpass) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = lowpass;
      osc.connect(f);
      node = f;
    }
    node.connect(g);
    g.connect(dest);
    osc.start(t);
    osc.stop(t + dur + 0.02);
    return osc;
  }

  _noiseHit(t, dur, filterType, freq, q, gain, dest, freqEnd) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this._noise;
    const f = ctx.createBiquadFilter();
    f.type = filterType;
    f.frequency.setValueAtTime(freq, t);
    if (freqEnd) f.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f);
    f.connect(g);
    g.connect(dest);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.02);
  }

  _kick(t, gain, dest) {
    this._voice('sine', 150, t, 0.16, gain, dest, null, 45);
    this._noiseHit(t, 0.02, 'lowpass', 1200, 0.7, gain * 0.3, dest);
  }

  _now() {
    if (!this.ctx || this.ctx.state === 'closed') return null;
    return this.ctx.currentTime + 0.005;
  }

  // ---- SFX ----

  bombPlaced() {
    const t = this._now();
    if (t === null) return;
    this._voice('square', 220, t, 0.09, 0.18, this.sfxGain, 1500, 110);
    this._noiseHit(t, 0.05, 'lowpass', 800, 1, 0.2, this.sfxGain);
  }

  /**
   * A stereo panner feeding the SFX bus, for positional sounds. `pan` is
   * -1 (left) .. 1 (right). Returns the plain SFX bus when panning isn't
   * available.
   */
  _panned(pan, t, dur) {
    const ctx = this.ctx;
    if (!ctx.createStereoPanner || !pan) return this.sfxGain;
    const p = ctx.createStereoPanner();
    p.pan.setValueAtTime(Math.max(-1, Math.min(1, pan)), t);
    p.connect(this.sfxGain);
    setTimeout(() => p.disconnect(), (dur + 0.2) * 1000);
    return p;
  }

  /** `pan` places the blast left/right of the listener (-1 .. 1). */
  explosion(distanceTiles = 0, pan = 0) {
    const t = this._now();
    if (t === null) return;
    const d = Math.max(0, Number(distanceTiles) || 0);
    if (d > 20) return;
    const near = 1 - d / 20; // 1 = on top of player
    const vol = 0.15 + 0.75 * near * near;
    const cutoff = 500 + 2500 * near;
    const dur = 0.35 + 0.35 * near;
    const out = this._panned(pan * (1 - near * 0.5), t, dur + 0.4);
    this._noiseHit(t, dur, 'lowpass', cutoff, 0.8, vol, out, 120);
    this._voice('sine', 90 + 40 * near, t, 0.3 + 0.3 * near, vol * near, out, null, 30);
  }

  /** An atomic blast: a sharp crack, then a long, deep, rolling rumble. */
  nuke(distanceTiles = 0, pan = 0) {
    const t = this._now();
    if (t === null) return;
    const d = Math.max(0, Number(distanceTiles) || 0);
    const near = Math.max(0.25, 1 - d / 40); // heard across the whole arena
    const out = this._panned(pan * (1 - near * 0.5), t, 4);
    this._noiseHit(t, 0.4, 'highpass', 1500, 0.7, 0.5 * near, out);
    this._noiseHit(t, 3.2, 'lowpass', 260 + 500 * near, 0.9, 0.95 * near, out, 60);
    this._voice('sine', 52, t, 2.6, 0.9 * near, out, null, 24);
    this._voice('triangle', 38, t + 0.05, 3.0, 0.5 * near, out, 400, 18);
  }

  pickup() {
    const t = this._now();
    if (t === null) return;
    [72, 76, 79, 84].forEach((m, i) =>
      this._voice('square', midiHz(m), t + i * 0.045, 0.08, 0.12, this.sfxGain, 4000));
  }

  mystery() {
    const t = this._now();
    if (t === null) return;
    for (let i = 0; i < 8; i++) {
      const m = 76 + i * 2 + (i % 2 ? 5 : 0);
      this._voice('triangle', midiHz(m), t + i * 0.04, 0.12, 0.16, this.sfxGain);
    }
    this._voice('sine', midiHz(96), t + 0.32, 0.25, 0.08, this.sfxGain);
  }

  curse() {
    const t = this._now();
    if (t === null) return;
    const ctx = this.ctx;
    const osc = this._voice('sawtooth', 520, t, 0.6, 0.14, this.sfxGain, 1400, 110);
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 11;
    const depth = ctx.createGain();
    depth.gain.value = 30;
    lfo.connect(depth);
    depth.connect(osc.frequency);
    lfo.start(t);
    lfo.stop(t + 0.65);
  }

  death() {
    const t = this._now();
    if (t === null) return;
    [67, 63, 60, 55].forEach((m, i) =>
      this._voice('square', midiHz(m), t + i * 0.12, 0.14, 0.14, this.sfxGain, 2000, midiHz(m - 1)));
    this._voice('triangle', midiHz(43), t + 0.48, 0.5, 0.2, this.sfxGain, null, midiHz(31));
  }

  kick() {
    const t = this._now();
    if (t === null) return;
    this._voice('sine', 300, t, 0.08, 0.3, this.sfxGain, null, 90);
    this._noiseHit(t, 0.04, 'bandpass', 2000, 1.5, 0.15, this.sfxGain);
  }

  uiClick() {
    const t = this._now();
    if (t === null) return;
    this._voice('square', 1200, t, 0.03, 0.08, this.sfxGain, 5000, 900);
  }
}
