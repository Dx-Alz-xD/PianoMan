// Audio for the 4K area: its own mixer (music, hitsounds, effects) on the
// piano engine's AudioContext, the song clock used during play, the record
// player's scratchable deck, hitsounds, keysounds and interface sounds.

import type { PianoEngine } from '../../audio/engine';
import type { BeatsSettings, Hitsound } from '../settings';

export class BeatsAudio {
  readonly ctx: AudioContext;
  readonly master: GainNode;
  readonly music: GainNode;
  readonly hits: GainNode;
  readonly keys: GainNode;
  readonly sfxBus: GainNode;
  readonly analyser: AnalyserNode;
  readonly deck: ScratchDeck;
  private limiter: DynamicsCompressorNode;
  private hitBuffers = new Map<string, AudioBuffer>();
  private lastHover = 0;

  constructor(readonly engine: PianoEngine) {
    const ctx = (this.ctx = engine.ctx);
    this.master = ctx.createGain();
    this.music = ctx.createGain();
    this.hits = ctx.createGain();
    this.keys = ctx.createGain();
    this.sfxBus = ctx.createGain();
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -2;
    this.limiter.knee.value = 2;
    this.limiter.ratio.value = 16;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.12;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.75;
    this.music.connect(this.analyser);
    this.music.connect(this.master);
    this.hits.connect(this.master);
    this.keys.connect(this.master);
    this.sfxBus.connect(this.master);
    this.master.connect(this.limiter).connect(ctx.destination);
    this.deck = new ScratchDeck(ctx, this.music);
  }

  setVolumes(s: BeatsSettings) {
    const t = this.ctx.currentTime;
    const set = (g: GainNode, v: number) => g.gain.setTargetAtTime(v, t, 0.03);
    set(this.master, s.masterVolume);
    set(this.music, s.musicVolume);
    set(this.hits, s.hitsoundVolume);
    set(this.keys, s.keysoundVolume);
    set(this.sfxBus, s.effectsVolume);
    this.deck.crackle(s.crackle);
  }

  /** Output latency (seconds) between scheduling a sound and hearing it. */
  get latency(): number {
    return ((this.ctx as AudioContext & { outputLatency?: number }).outputLatency || 0) + (this.ctx.baseLatency || 0);
  }

  async decode(bytes: Uint8Array): Promise<AudioBuffer> {
    const copy = bytes.slice().buffer;
    return this.ctx.decodeAudioData(copy);
  }

  // --------------------------------------------------------- hitsounds ----

  private hitBuffer(kind: Exclude<Hitsound, 'none' | 'piano'>): AudioBuffer {
    let b = this.hitBuffers.get(kind);
    if (!b) {
      b = makeHitsound(this.ctx, kind);
      this.hitBuffers.set(kind, b);
    }
    return b;
  }

  hitsound(kind: Hitsound, lane: number, when = this.ctx.currentTime, volume = 1) {
    if (kind === 'none') return;
    if (kind === 'piano') {
      const midi = [72, 76, 79, 84][lane] ?? 72;
      this.engine.noteOn(midi, Math.round(70 + 40 * volume), when);
      this.engine.noteOff(midi, when + 0.18);
      return;
    }
    this.playBuffer(this.hitBuffer(kind), when, volume, this.hits, (lane - 1.5) * 0.25);
  }

  playBuffer(buf: AudioBuffer, when = this.ctx.currentTime, volume = 1, bus: AudioNode = this.keys, pan = 0) {
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const g = this.ctx.createGain();
    g.gain.value = volume;
    let node: AudioNode = g;
    if (pan) {
      const p = this.ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan));
      g.connect(p);
      node = p;
    }
    src.connect(g);
    node.connect(bus);
    src.start(Math.max(this.ctx.currentTime, when));
    src.onended = () => {
      src.disconnect();
      node.disconnect();
      g.disconnect();
    };
    return src;
  }

  // -------------------------------------------------------------- sfx ----

  sfx(name: 'hover' | 'click' | 'back' | 'select' | 'start' | 'count' | 'go' | 'miss' | 'combobreak' | 'fail' | 'clear' | 'whoosh' | 'toggle' | 'error') {
    const ctx = this.ctx;
    if (ctx.state !== 'running') return;
    const t = ctx.currentTime + 0.005;
    if (name === 'hover') {
      if (t - this.lastHover < 0.04) return;
      this.lastHover = t;
    }
    const tone = (freq: number, start: number, dur: number, vol: number, type: OscillatorType = 'sine', slide?: number) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, t + start);
      if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + start + dur);
      g.gain.setValueAtTime(0, t + start);
      g.gain.linearRampToValueAtTime(vol, t + start + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + start + dur);
      o.connect(g).connect(this.sfxBus);
      o.start(t + start);
      o.stop(t + start + dur + 0.02);
      o.onended = () => g.disconnect();
    };
    const noise = (start: number, dur: number, vol: number, freq: number, q = 1, sweep?: number) => {
      const len = Math.ceil(dur * ctx.sampleRate);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.Q.value = q;
      f.frequency.setValueAtTime(freq, t + start);
      if (sweep) f.frequency.exponentialRampToValueAtTime(sweep, t + start + dur);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t + start);
      g.gain.exponentialRampToValueAtTime(vol, t + start + dur * 0.4);
      g.gain.exponentialRampToValueAtTime(0.0001, t + start + dur);
      src.connect(f).connect(g).connect(this.sfxBus);
      src.start(t + start);
      src.onended = () => g.disconnect();
    };
    switch (name) {
      case 'hover':
        tone(2400, 0, 0.03, 0.05, 'sine');
        break;
      case 'click':
        tone(1100, 0, 0.06, 0.18, 'triangle', 1700);
        break;
      case 'toggle':
        tone(900, 0, 0.05, 0.14, 'square', 1300);
        break;
      case 'back':
        tone(900, 0, 0.08, 0.16, 'triangle', 500);
        break;
      case 'select':
        tone(880, 0, 0.12, 0.14, 'sine');
        tone(1318.5, 0.06, 0.18, 0.12, 'sine');
        break;
      case 'start':
        noise(0, 0.55, 0.25, 400, 0.8, 6000);
        tone(523.25, 0.35, 0.5, 0.12, 'triangle');
        tone(659.25, 0.35, 0.5, 0.1, 'triangle');
        tone(783.99, 0.35, 0.55, 0.1, 'triangle');
        break;
      case 'whoosh':
        noise(0, 0.35, 0.18, 300, 0.7, 4000);
        break;
      case 'count':
        tone(880, 0, 0.09, 0.2, 'sine');
        break;
      case 'go':
        tone(1320, 0, 0.22, 0.24, 'sine');
        tone(1760, 0.02, 0.2, 0.08, 'sine');
        break;
      case 'miss':
        tone(140, 0, 0.12, 0.25, 'sine', 70);
        noise(0, 0.08, 0.08, 900, 2);
        break;
      case 'combobreak':
        tone(620, 0, 0.1, 0.14, 'square', 420);
        tone(420, 0.09, 0.16, 0.12, 'square', 240);
        break;
      case 'fail':
        tone(440, 0, 1.1, 0.2, 'sawtooth', 55);
        noise(0, 0.9, 0.12, 2000, 1, 200);
        break;
      case 'clear':
        [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((f, i) => tone(f, i * 0.07, 0.6, 0.1, 'triangle'));
        break;
      case 'error':
        tone(220, 0, 0.15, 0.18, 'square');
        tone(180, 0.12, 0.2, 0.16, 'square');
        break;
    }
  }
}

function makeHitsound(ctx: BaseAudioContext, kind: Exclude<Hitsound, 'none' | 'piano'>): AudioBuffer {
  const sr = ctx.sampleRate;
  const dur = kind === 'kick' ? 0.16 : kind === 'clap' ? 0.14 : kind === 'drum' ? 0.12 : kind === 'tick' ? 0.02 : 0.07;
  const n = Math.ceil(dur * sr);
  const buf = ctx.createBuffer(1, n, sr);
  const d = buf.getChannelData(0);
  let seed = 99;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  let lp = 0;
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let v = 0;
    if (kind === 'soft') v = (Math.sin(2 * Math.PI * 1320 * t) * 0.6 + Math.sin(2 * Math.PI * 2640 * t) * 0.25) * Math.exp(-t * 60) + rnd() * 0.15 * Math.exp(-t * 200);
    else if (kind === 'tick') {
      const x = rnd();
      v = (x - prev) * Math.exp(-t * 400);
      prev = x;
    } else if (kind === 'kick') v = Math.sin(2 * Math.PI * (50 * t + (100 / 35) * (1 - Math.exp(-t * 35)))) * Math.exp(-t * 18);
    else if (kind === 'clap') {
      const x = rnd();
      lp += (x - lp) * 0.35;
      const bursts = [0, 0.011, 0.022].reduce((s, b) => s + (t >= b ? Math.exp(-(t - b) * (b === 0.022 ? 28 : 160)) : 0), 0);
      v = (x - lp) * bursts * 0.6;
    } else {
      const x = rnd();
      v = (x * 0.55 * Math.exp(-t * 30) + Math.sin(2 * Math.PI * 190 * t) * 0.5 * Math.exp(-t * 40)) * 0.9;
    }
    d[i] = v * 0.8;
  }
  return buf;
}

// ------------------------------------------------------------- clock ----

/**
 * Plays a song's audio for gameplay and reports song time. With a
 * pitch-kept (time-stretched) buffer the source runs at 1× and the buffer
 * maps song time / rate; otherwise the original buffer plays at `rate`
 * (pitch shifts, like nightcore).
 */
export class MusicPlayer {
  private src: AudioBufferSourceNode | null = null;
  private buffer: AudioBuffer | null = null;
  private stretched = false;
  rate = 1;
  private startCtx = 0;
  private startPos = 0;
  private pausedAt = 0;
  playing = false;

  constructor(private ctx: AudioContext, private out: AudioNode) {}

  /** `buffer` is either the original (pitch follows rate) or already stretched by `rate`. */
  set(buffer: AudioBuffer, rate: number, stretched: boolean) {
    this.stop();
    this.buffer = buffer;
    this.rate = rate;
    this.stretched = stretched;
    this.pausedAt = 0;
  }

  get duration(): number {
    if (!this.buffer) return 0;
    return this.stretched ? this.buffer.duration * this.rate : this.buffer.duration;
  }

  /** Starts playback of song time `pos` (may be negative for a lead-in) at context time `when`. */
  start(pos: number, when = this.ctx.currentTime + 0.05) {
    if (!this.buffer) return;
    this.stop();
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.playbackRate.value = this.stretched ? 1 : this.rate;
    src.connect(this.out);
    const bufPos = (p: number) => (this.stretched ? p / this.rate : p);
    if (pos < 0) src.start(when + -pos / this.rate, 0);
    else src.start(when, Math.min(bufPos(pos), this.buffer.duration));
    this.src = src;
    this.startCtx = when;
    this.startPos = pos;
    this.playing = true;
  }

  /** Stops and returns the song time it stopped at. */
  stop(): number {
    const t = this.playing ? this.time(this.ctx.currentTime, false) : this.pausedAt;
    if (this.src) {
      try {
        this.src.stop();
      } catch {
        /* not started */
      }
      this.src.disconnect();
      this.src = null;
    }
    this.playing = false;
    this.pausedAt = t;
    return t;
  }

  /** Song time now; `compensate` subtracts the output latency (time as heard). */
  time(ctxNow = this.ctx.currentTime, compensate = true): number {
    if (!this.playing) return this.pausedAt;
    const lat = compensate ? ((this.ctx as AudioContext & { outputLatency?: number }).outputLatency || 0) + (this.ctx.baseLatency || 0) : 0;
    return this.startPos + (ctxNow - lat - this.startCtx) * this.rate;
  }

  /** Context time at which song time `pos` is (or would be) scheduled. */
  ctxTimeFor(pos: number): number {
    return this.startCtx + (pos - this.startPos) / this.rate;
  }
}

// -------------------------------------------------------------- deck ----

/** The record player's voice (see scratch.worklet.js). */
export class ScratchDeck {
  private node: AudioWorkletNode | null = null;
  private ready: Promise<boolean> | null = null;
  private crackleLevel = 0.3;
  /** Latest playback position (seconds into the loaded window) and speed. */
  pos = 0;
  rate = 0;
  loadedKey = '';
  windowStart = 0;
  windowLength = 0;

  constructor(private ctx: AudioContext, private out: AudioNode) {}

  private init(): Promise<boolean> {
    if (!this.ready) {
      this.ready = (async () => {
        try {
          await this.ctx.audioWorklet.addModule(new URL('./scratch.worklet.js', import.meta.url));
          this.node = new AudioWorkletNode(this.ctx, 'pb-scratch', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
          this.node.connect(this.out);
          this.node.port.onmessage = (e: MessageEvent<{ pos: number; rate: number }>) => {
            this.pos = e.data.pos;
            this.rate = e.data.rate;
          };
          this.node.port.postMessage({ type: 'crackle', value: this.crackleLevel });
          return true;
        } catch (err) {
          console.warn('Record player audio unavailable', err);
          return false;
        }
      })();
    }
    return this.ready;
  }

  /** Loads a window of a song (seconds) onto the record. */
  async load(key: string, buffer: AudioBuffer, from: number, length: number) {
    if (!(await this.init()) || !this.node) return;
    const sr = buffer.sampleRate;
    const a = Math.max(0, Math.floor(from * sr));
    const b = Math.min(buffer.length, a + Math.floor(length * sr));
    const channels: Float32Array[] = [];
    for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) channels.push(buffer.getChannelData(c).slice(a, b));
    this.loadedKey = key;
    this.windowStart = a / sr;
    this.windowLength = (b - a) / sr;
    this.node.port.postMessage({ type: 'load', channels, sampleRate: sr, pos: 0 }, channels.map((c) => c.buffer));
  }

  unload() {
    this.loadedKey = '';
    this.node?.port.postMessage({ type: 'unload' });
  }

  motor(on: boolean) {
    this.node?.port.postMessage({ type: 'motor', on });
  }

  hand(rate: number) {
    this.node?.port.postMessage({ type: 'hand', rate });
  }

  release() {
    this.node?.port.postMessage({ type: 'release' });
  }

  gain(value: number) {
    this.node?.port.postMessage({ type: 'gain', value });
  }

  crackle(value: number) {
    this.crackleLevel = value;
    this.node?.port.postMessage({ type: 'crackle', value });
  }

  seek(pos: number) {
    this.node?.port.postMessage({ type: 'seek', pos });
  }
}
