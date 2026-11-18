// Procedural sound effects and ambient music with the Web Audio API (no audio files needed).
import { getSettings, onSettings } from './settings';

class AudioEngine {
  ctx: AudioContext | null = null;
  master!: GainNode;
  sfxBus!: GainNode;
  musicBus!: GainNode;
  private noise!: AudioBuffer;
  private hum: { osc: OscillatorNode; gain: GainNode; filter: BiquadFilterNode; kind: number } | null = null;
  private musicTimer: number | null = null;
  private lastPickup = 0;
  private pickupStreak = 0;
  private lastDamage = 0;

  /** Must be called from a user gesture (browsers block autoplay). */
  unlock(): void {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    this.ctx = new Ctx();
    this.master = this.ctx.createGain();
    this.sfxBus = this.ctx.createGain();
    this.musicBus = this.ctx.createGain();
    const comp = this.ctx.createDynamicsCompressor();
    this.sfxBus.connect(this.master);
    this.musicBus.connect(this.master);
    this.master.connect(comp).connect(this.ctx.destination);
    const len = this.ctx.sampleRate;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.applySettings();
    onSettings(() => this.applySettings());
    this.startMusic();
  }

  private applySettings(): void {
    if (!this.ctx) return;
    const s = getSettings();
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(s.muted ? 0 : s.volume, t, 0.05);
    this.sfxBus.gain.setTargetAtTime(s.sfx ? 0.9 : 0, t, 0.05);
    this.musicBus.gain.setTargetAtTime(s.music ? 0.35 : 0, t, 0.3);
  }

  private tone(freq: number, dur: number, opts: { type?: OscillatorType; vol?: number; slide?: number; delay?: number } = {}): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime + (opts.delay ?? 0);
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = opts.type ?? 'sine';
    o.frequency.setValueAtTime(freq, t);
    if (opts.slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq * opts.slide), t + dur);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(opts.vol ?? 0.2, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.sfxBus);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  private burst(dur: number, opts: { freq?: number; q?: number; vol?: number; type?: BiquadFilterType; sweepTo?: number } = {}): void {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const f = this.ctx.createBiquadFilter();
    f.type = opts.type ?? 'bandpass';
    f.frequency.setValueAtTime(opts.freq ?? 1000, t);
    if (opts.sweepTo) f.frequency.exponentialRampToValueAtTime(opts.sweepTo, t + dur);
    f.Q.value = opts.q ?? 1;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(opts.vol ?? 0.3, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.sfxBus);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.05);
  }

  pickup(value: number): void {
    if (!this.ctx) return;
    const now = performance.now();
    this.pickupStreak = now - this.lastPickup < 400 ? Math.min(this.pickupStreak + 1, 12) : 0;
    this.lastPickup = now;
    const base = value >= 5 ? 520 : 660;
    this.tone(base * Math.pow(1.06, this.pickupStreak), value >= 5 ? 0.35 : 0.09, { type: 'sine', vol: value >= 5 ? 0.18 : 0.07, slide: 1.5 });
    if (value >= 5) this.tone(base * 1.5, 0.3, { type: 'triangle', vol: 0.1, delay: 0.06 });
  }

  /** Continuous hum while a gravity ability is held. kind: 0 none, 1 attract, 2 repel */
  ability(kind: number): void {
    if (!this.ctx) return;
    if (this.hum && this.hum.kind === kind) return;
    if (this.hum) {
      const h = this.hum;
      h.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
      h.osc.stop(this.ctx.currentTime + 0.3);
      this.hum = null;
    }
    if (kind === 0) return;
    const osc = this.ctx.createOscillator();
    const lfo = this.ctx.createOscillator();
    const lfoGain = this.ctx.createGain();
    const filter = this.ctx.createBiquadFilter();
    const gain = this.ctx.createGain();
    osc.type = 'sawtooth';
    osc.frequency.value = kind === 1 ? 70 : 110;
    lfo.frequency.value = kind === 1 ? 5 : 9;
    lfoGain.gain.value = kind === 1 ? 14 : 30;
    lfo.connect(lfoGain).connect(osc.frequency);
    filter.type = 'lowpass';
    filter.frequency.value = kind === 1 ? 380 : 900;
    gain.gain.value = 0;
    gain.gain.setTargetAtTime(0.09, this.ctx.currentTime, 0.04);
    osc.connect(filter).connect(gain).connect(this.sfxBus);
    osc.start();
    lfo.start();
    osc.onended = () => lfo.stop();
    this.hum = { osc, gain, filter, kind };
  }

  dash(): void {
    this.burst(0.35, { freq: 400, sweepTo: 3000, q: 2, vol: 0.35 });
    this.tone(180, 0.25, { type: 'triangle', vol: 0.12, slide: 2.2 });
  }

  hit(power: number): void {
    this.tone(90, 0.18, { type: 'sine', vol: 0.15 + power * 0.25, slide: 0.5 });
    this.burst(0.12, { freq: 1600, q: 0.8, vol: 0.08 + power * 0.15 });
  }

  elimination(near: number): void {
    const v = 0.1 + near * 0.35;
    this.tone(160, 0.8, { type: 'sine', vol: v, slide: 0.15 });
    this.burst(0.9, { freq: 900, sweepTo: 120, type: 'lowpass', vol: v * 1.2 });
  }

  damage(): void {
    const now = performance.now();
    if (now - this.lastDamage < 450) return;
    this.lastDamage = now;
    this.tone(110, 0.15, { type: 'square', vol: 0.05, slide: 0.8 });
  }

  warning(): void {
    for (let i = 0; i < 3; i++) this.tone(440, 0.18, { type: 'triangle', vol: 0.1, delay: i * 0.25, slide: 0.7 });
  }

  beep(high = false): void {
    this.tone(high ? 880 : 440, high ? 0.4 : 0.15, { type: 'triangle', vol: 0.15 });
  }

  win(): void {
    [523, 659, 784, 1047, 1319].forEach((f, i) => this.tone(f, 0.5, { type: 'triangle', vol: 0.14, delay: i * 0.11 }));
  }

  lose(): void {
    [392, 330, 262].forEach((f, i) => this.tone(f, 0.45, { type: 'sine', vol: 0.12, delay: i * 0.16 }));
  }

  click(): void {
    this.tone(1200, 0.05, { type: 'sine', vol: 0.05 });
  }

  private startMusic(): void {
    if (!this.ctx || this.musicTimer !== null) return;
    // Slow evolving pad: minor-ish chords through a breathing low-pass filter.
    const chords = [[110, 164.8, 220, 261.6], [98, 146.8, 196, 246.9], [87.3, 130.8, 174.6, 220], [98, 146.8, 196, 233.1]];
    let i = 0;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 600;
    filter.Q.value = 0.7;
    const lfo = this.ctx.createOscillator();
    const lfoG = this.ctx.createGain();
    lfo.frequency.value = 0.05;
    lfoG.gain.value = 300;
    lfo.connect(lfoG).connect(filter.frequency);
    lfo.start();
    filter.connect(this.musicBus);
    const play = () => {
      if (!this.ctx) return;
      const t = this.ctx.currentTime;
      const dur = 9;
      for (const f of chords[i++ % chords.length]) {
        for (const det of [-6, 6]) {
          const o = this.ctx.createOscillator();
          const g = this.ctx.createGain();
          o.type = 'triangle';
          o.frequency.value = f;
          o.detune.value = det;
          g.gain.setValueAtTime(0, t);
          g.gain.linearRampToValueAtTime(0.035, t + 3);
          g.gain.linearRampToValueAtTime(0.0001, t + dur + 1.5);
          o.connect(g).connect(filter);
          o.start(t);
          o.stop(t + dur + 2);
        }
      }
    };
    play();
    this.musicTimer = window.setInterval(play, 8000);
  }
}

export const audio = new AudioEngine();
