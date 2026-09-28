// The PIANO-BEATS sound engine: voice allocation, velocity layers, pedals,
// damper behaviour, tuning and the master effects chain.
//
// Signal flow
//   voices → voiceBus → drive → tremolo/auto-pan → chorus → EQ → lid
//          → stereo width → compressor ─┬→ dry ────────────┬→ master → limiter → analyser → out
//                                        └→ pre-delay → reverb ┘

import { Emitter } from '../core/emitter';
import { clamp, dbToGain, lerp, midiToFreq } from '../core/music';
import { DEFAULT_SOUND, type SoundSettings } from '../core/settings';
import { FALLBACK_INSTRUMENT, getInstrument, type Instrument, type Region, type SampledInstrument } from './instruments';
import { createImpulse } from './reverb';
import { SampleStore, type LoadProgress, type SampleQuality } from './samples';
import { createSynthVoice, noiseBuffer } from './synth';
import { noteDetune, temperamentOffsets } from './tuning';

type DampState = 'free' | 'partial' | 'released';

interface Voice {
  id: number;
  key: number;
  note: number;
  kind: 'note' | 'resonance' | 'noise';
  start: number;
  velocity: number;
  peak: number;
  held: boolean;
  sostenuto: boolean;
  damp: DampState;
  undamped: boolean;
  env: GainNode;
  nodes: AudioNode[];
  sources: AudioScheduledSourceNode[];
  endAt: number;
}

export interface EngineEvents {
  progress: LoadProgress;
  ready: { id: string; loaded: number; failed: number };
  error: { id: string; message: string };
  pedal: { sustain: number; soft: boolean; sostenuto: boolean };
}

/** Sustain pedal thresholds (0–1). Between OFF and FULL the dampers only partially touch. */
const PEDAL_FULL = 0.6;
const PEDAL_OFF = 0.15;

const TOUCH: Record<string, (x: number) => number> = {
  light: (x) => Math.pow(x, 0.6),
  normal: (x) => Math.pow(x, 0.85),
  linear: (x) => x,
  heavy: (x) => Math.pow(x, 1.45),
};

const LID_DB = { open: 0, half: -3.5, closed: -9 };

export class PianoEngine extends Emitter<EngineEvents> {
  readonly ctx: AudioContext;
  settings: SoundSettings = { ...DEFAULT_SOUND };
  instrument: Instrument = getInstrument(FALLBACK_INSTRUMENT);
  readonly store: SampleStore;
  quality: SampleQuality = 'balanced';

  private voices: Voice[] = [];
  private nextId = 1;
  private holders = new Uint8Array(128);
  private sustain = 0;
  private soft = false;
  private sostenuto = false;
  private rr = new Uint16Array(128);
  private offsets = temperamentOffsets('equal', 0);
  private trim = 1;
  private trimMeasured = false;
  private attackIndex: Region[][] = [];
  private releaseIndex: Region[][] = [];
  private pedalRegions: { pd: Region[]; pu: Region[] } = { pd: [], pu: [] };
  private sortedAttacks: Region[] = [];
  private loadToken = 0;

  // nodes
  private voiceBus!: GainNode;
  private driveIn!: GainNode;
  private shaper!: WaveShaperNode;
  private driveOut!: GainNode;
  private tremL!: GainNode;
  private tremR!: GainNode;
  private tremLfo!: OscillatorNode;
  private tremDepthL!: GainNode;
  private tremDepthR!: GainNode;
  private chorusDry!: GainNode;
  private chorusWet!: GainNode;
  private chorusLfo!: OscillatorNode;
  private chorusDepth1!: GainNode;
  private chorusDepth2!: GainNode;
  private eqLow!: BiquadFilterNode;
  private eqMid!: BiquadFilterNode;
  private eqHigh!: BiquadFilterNode;
  private lidShelf!: BiquadFilterNode;
  private widthGains!: GainNode[];
  private compressor!: DynamicsCompressorNode;
  private dry!: GainNode;
  private reverbSend!: GainNode;
  private preDelay!: DelayNode;
  private convolver!: ConvolverNode;
  private master!: GainNode;
  private limiter!: DynamicsCompressorNode;
  readonly analyser: AnalyserNode;
  /** Metronome and UI sounds; bypasses the piano effects. */
  readonly clickBus: GainNode;
  private recordDest: MediaStreamAudioDestinationNode | null = null;
  private reverbKey = '';
  private reverbTimer = 0;
  private meterBuf = new Float32Array(1024);

  /**
   * Pass a latency hint for the live engine, or an (offline) context plus the
   * live engine's sample store to render a performance faster than real time.
   */
  constructor(opts: AudioContextLatencyCategory | { context: BaseAudioContext; store: SampleStore } = 'interactive') {
    super();
    if (typeof opts === 'string') {
      this.ctx = new AudioContext({ latencyHint: opts });
      this.store = new SampleStore(this.ctx);
    } else {
      // Offline rendering: only the scheduling API of AudioContext is used.
      this.ctx = opts.context as AudioContext;
      this.store = opts.store;
    }
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.clickBus = this.ctx.createGain();
    this.buildGraph();
    this.applySettings(this.settings, true);
  }

  // ------------------------------------------------------------ graph ----

  private buildGraph() {
    const ctx = this.ctx;
    const stereo = (n: AudioNode) => {
      n.channelCount = 2;
      n.channelCountMode = 'explicit';
      n.channelInterpretation = 'speakers';
      return n;
    };

    this.voiceBus = stereo(ctx.createGain()) as GainNode;
    this.driveIn = ctx.createGain();
    this.shaper = ctx.createWaveShaper();
    this.shaper.oversample = '2x';
    this.driveOut = ctx.createGain();
    this.voiceBus.connect(this.driveIn).connect(this.shaper).connect(this.driveOut);

    // Tremolo / auto-pan: independent L/R gains modulated by one LFO.
    const tremIn = stereo(ctx.createGain());
    this.driveOut.connect(tremIn);
    const split = ctx.createChannelSplitter(2);
    const merge = ctx.createChannelMerger(2);
    this.tremL = ctx.createGain();
    this.tremR = ctx.createGain();
    tremIn.connect(split);
    split.connect(this.tremL, 0).connect(merge, 0, 0);
    split.connect(this.tremR, 1).connect(merge, 0, 1);
    this.tremLfo = ctx.createOscillator();
    this.tremDepthL = ctx.createGain();
    this.tremDepthR = ctx.createGain();
    this.tremLfo.connect(this.tremDepthL).connect(this.tremL.gain);
    this.tremLfo.connect(this.tremDepthR).connect(this.tremR.gain);
    this.tremLfo.start();

    // Chorus: two modulated delays panned apart.
    const chorusIn = stereo(ctx.createGain());
    merge.connect(chorusIn);
    this.chorusDry = ctx.createGain();
    this.chorusWet = ctx.createGain();
    const chorusOut = stereo(ctx.createGain());
    chorusIn.connect(this.chorusDry).connect(chorusOut);
    this.chorusLfo = ctx.createOscillator();
    this.chorusDepth1 = ctx.createGain();
    this.chorusDepth2 = ctx.createGain();
    const inv = ctx.createGain();
    inv.gain.value = -1;
    for (const [i, panVal] of [[0, -0.8], [1, 0.8]] as const) {
      const d = ctx.createDelay(0.05);
      d.delayTime.value = i ? 0.017 : 0.012;
      const p = ctx.createStereoPanner();
      p.pan.value = panVal;
      chorusIn.connect(d).connect(p).connect(this.chorusWet);
      if (i === 0) this.chorusLfo.connect(this.chorusDepth1).connect(d.delayTime);
      else this.chorusLfo.connect(inv).connect(this.chorusDepth2).connect(d.delayTime);
    }
    this.chorusWet.connect(chorusOut);
    this.chorusLfo.start();

    // EQ + lid.
    this.eqLow = ctx.createBiquadFilter();
    this.eqLow.type = 'lowshelf';
    this.eqLow.frequency.value = 120;
    this.eqMid = ctx.createBiquadFilter();
    this.eqMid.type = 'peaking';
    this.eqMid.Q.value = 0.8;
    this.eqHigh = ctx.createBiquadFilter();
    this.eqHigh.type = 'highshelf';
    this.eqHigh.frequency.value = 6000;
    this.lidShelf = ctx.createBiquadFilter();
    this.lidShelf.type = 'highshelf';
    this.lidShelf.frequency.value = 2500;
    chorusOut.connect(this.eqLow).connect(this.eqMid).connect(this.eqHigh).connect(this.lidShelf);

    // Stereo width (mid/side via a 2x2 gain matrix).
    const wIn = stereo(ctx.createGain());
    this.lidShelf.connect(wIn);
    const wSplit = ctx.createChannelSplitter(2);
    const wMerge = ctx.createChannelMerger(2);
    wIn.connect(wSplit);
    const ll = ctx.createGain();
    const rl = ctx.createGain();
    const rr = ctx.createGain();
    const lr = ctx.createGain();
    wSplit.connect(ll, 0).connect(wMerge, 0, 0);
    wSplit.connect(rl, 1).connect(wMerge, 0, 0);
    wSplit.connect(rr, 1).connect(wMerge, 0, 1);
    wSplit.connect(lr, 0).connect(wMerge, 0, 1);
    this.widthGains = [ll, rl, rr, lr];

    this.compressor = ctx.createDynamicsCompressor();
    wMerge.connect(this.compressor);

    this.dry = ctx.createGain();
    this.reverbSend = ctx.createGain();
    this.preDelay = ctx.createDelay(0.5);
    this.convolver = ctx.createConvolver();
    this.master = ctx.createGain();
    this.compressor.connect(this.dry).connect(this.master);
    this.compressor.connect(this.reverbSend).connect(this.preDelay).connect(this.convolver).connect(this.master);

    this.limiter = ctx.createDynamicsCompressor();
    this.master.connect(this.limiter);
    this.clickBus.connect(this.limiter);
    this.limiter.connect(this.analyser);
    this.analyser.connect(ctx.destination);
  }

  // --------------------------------------------------------- settings ----

  setSettings(patch: Partial<SoundSettings>) {
    const next = { ...this.settings, ...patch };
    const instrumentChanged = patch.instrument !== undefined && patch.instrument !== this.instrument.id;
    this.applySettings(next, false);
    if (instrumentChanged) void this.loadInstrument(next.instrument);
  }

  private applySettings(s: SoundSettings, force: boolean) {
    const prev = this.settings;
    this.settings = s;
    const t = this.ctx.currentTime;
    const smooth = (p: AudioParam, v: number) => p.setTargetAtTime(v, t, 0.02);

    smooth(this.master.gain, dbToGain(s.volume));
    smooth(this.eqLow.gain, s.eqLow);
    smooth(this.eqMid.gain, s.eqMid);
    smooth(this.eqMid.frequency, s.eqMidFreq);
    smooth(this.eqHigh.gain, s.eqHigh);
    smooth(this.lidShelf.gain, LID_DB[s.lid] ?? 0);

    const w = clamp(s.stereoWidth, 0, 2);
    const a = (1 + w) / 2;
    const b = (1 - w) / 2;
    [a, b, a, b].forEach((g, i) => smooth(this.widthGains[i].gain, g));

    // Tremolo: base gain 1 - depth/2, modulated ±depth/2.
    const depth = clamp(s.tremoloDepth, 0, 1);
    this.tremLfo.frequency.setTargetAtTime(s.tremoloRate, t, 0.05);
    smooth(this.tremL.gain, 1 - depth / 2);
    smooth(this.tremR.gain, 1 - depth / 2);
    smooth(this.tremDepthL.gain, depth / 2);
    smooth(this.tremDepthR.gain, s.autoPan ? -depth / 2 : depth / 2);

    this.chorusLfo.frequency.setTargetAtTime(s.chorusRate, t, 0.05);
    smooth(this.chorusDepth1.gain, 0.004 * s.chorusDepth);
    smooth(this.chorusDepth2.gain, 0.004 * s.chorusDepth);
    smooth(this.chorusWet.gain, s.chorusMix * 0.8);
    smooth(this.chorusDry.gain, 1 - s.chorusMix * 0.35);

    if (force || prev.drive !== s.drive) {
      if (s.drive <= 0.001) {
        this.shaper.curve = null;
        smooth(this.driveIn.gain, 1);
        smooth(this.driveOut.gain, 1);
      } else {
        const k = 1 + s.drive * 18;
        const n = 2048;
        const curve = new Float32Array(n);
        const norm = Math.tanh(k);
        for (let i = 0; i < n; i++) {
          const x = (i / (n - 1)) * 2 - 1;
          curve[i] = Math.tanh(k * x) / norm;
        }
        this.shaper.curve = curve;
        smooth(this.driveIn.gain, 1 + s.drive * 1.5);
        smooth(this.driveOut.gain, 1 / (1 + s.drive * 1.2));
      }
    }

    const c = this.compressor;
    if (s.compressor) {
      smooth(c.threshold, s.compThreshold);
      smooth(c.ratio, s.compRatio);
      c.knee.value = 8;
      c.attack.value = 0.012;
      c.release.value = 0.25;
    } else {
      smooth(c.threshold, 0);
      smooth(c.ratio, 1);
    }
    const l = this.limiter;
    if (s.limiter) {
      smooth(l.threshold, -1.5);
      smooth(l.ratio, 20);
      l.knee.value = 0;
      l.attack.value = 0.002;
      l.release.value = 0.12;
    } else {
      smooth(l.threshold, 0);
      smooth(l.ratio, 1);
    }

    smooth(this.reverbSend.gain, s.reverbMix * 1.1);
    smooth(this.dry.gain, 1 - s.reverbMix * 0.35);
    smooth(this.preDelay.delayTime, clamp(s.reverbPreDelay / 1000, 0, 0.5));
    const rk = `${s.reverbType}|${s.reverbDecay.toFixed(2)}|${s.reverbDamping.toFixed(2)}`;
    if (rk !== this.reverbKey) {
      this.reverbKey = rk;
      clearTimeout(this.reverbTimer);
      const build = () => (this.convolver.buffer = createImpulse(this.ctx, s.reverbType, s.reverbDecay, s.reverbDamping));
      if (force) build();
      else this.reverbTimer = window.setTimeout(build, 120);
    }

    if (force || prev.temperament !== s.temperament || prev.temperamentRoot !== s.temperamentRoot) {
      this.offsets = temperamentOffsets(s.temperament, s.temperamentRoot);
    }
    if (!force && (prev.a4 !== s.a4 || prev.fineTune !== s.fineTune || prev.temperament !== s.temperament || prev.temperamentRoot !== s.temperamentRoot || prev.stretch !== s.stretch)) {
      this.retuneActiveVoices();
    }
  }

  /** Tuning changes apply to notes that are already ringing, like turning a tuning knob. */
  private retuneActiveVoices() {
    const t = this.ctx.currentTime;
    for (const v of this.voices) {
      const src = v.sources[0];
      if (src instanceof AudioBufferSourceNode) {
        const base = (src as AudioBufferSourceNode & { _baseDetune?: number })._baseDetune ?? 0;
        src.detune.setTargetAtTime(base + this.tuning(v.note), t, 0.03);
      }
    }
  }

  private tuning(note: number) {
    return noteDetune(note, this.settings, this.offsets);
  }

  // ------------------------------------------------------- instrument ----

  async loadInstrument(id: string, quality = this.quality): Promise<void> {
    this.quality = quality;
    const inst = getInstrument(id);
    const token = ++this.loadToken;
    this.instrument = inst;
    this.settings.instrument = inst.id;
    this.trim = 1;
    this.trimMeasured = inst.kind === 'synth';
    this.buildIndexes(inst);
    if (inst.kind === 'synth') {
      this.store.retainOnly([]);
      this.emit('ready', { id: inst.id, loaded: 1, failed: 0 });
      return;
    }
    this.store.retainOnly([inst.id]);
    const sampled = inst;
    const result = await this.store.load(sampled, quality, (p) => {
      if (token !== this.loadToken) return;
      if (!this.trimMeasured) this.measureTrim(sampled);
      this.emit('progress', p);
    });
    if (token !== this.loadToken) return;
    if (result.loaded === 0) {
      this.emit('error', {
        id: inst.id,
        message: `Couldn't download "${inst.name}". Check your internet connection – the offline synth piano is used meanwhile.`,
      });
    } else {
      if (!this.trimMeasured) this.measureTrim(inst);
      this.emit('ready', { id: inst.id, loaded: result.loaded, failed: result.failed });
    }
  }

  /** Copies the instrument, loudness trim and sound settings of another engine (whose samples this one shares). */
  copyFrom(other: PianoEngine) {
    this.quality = other.quality;
    this.instrument = other.instrument;
    this.buildIndexes(other.instrument);
    this.trim = other.trim;
    this.trimMeasured = true;
    this.reverbKey = '';
    this.applySettings({ ...other.settings }, true);
  }

  private buildIndexes(inst: Instrument) {
    this.attackIndex = Array.from({ length: 128 }, () => []);
    this.releaseIndex = Array.from({ length: 128 }, () => []);
    this.pedalRegions = { pd: [], pu: [] };
    this.sortedAttacks = [];
    if (inst.kind !== 'sampled') return;
    for (const r of inst.regions()) {
      if (r.trigger === 'pd' || r.trigger === 'pu') {
        this.pedalRegions[r.trigger].push(r);
        continue;
      }
      const index = r.trigger === 'a' ? this.attackIndex : this.releaseIndex;
      for (let k = Math.max(0, r.lo); k <= Math.min(127, r.hi); k++) index[k].push(r);
      if (r.trigger === 'a') this.sortedAttacks.push(r);
    }
    this.sortedAttacks.sort((a, b) => a.key - b.key);
  }

  /** Normalises loudness across instruments using a mid-keyboard, mf sample. */
  private measureTrim(inst: SampledInstrument) {
    const candidates = this.attackIndex[60].filter((r) => this.store.has(inst, r.path) && r.pedal !== 'd');
    if (!candidates.length) return;
    const ref = candidates.reduce((best, r) => (Math.abs((r.vl + r.vh) / 2 - 100) < Math.abs((best.vl + best.vh) / 2 - 100) ? r : best));
    const buf = this.store.get(inst, ref.path)!;
    let peak = 0;
    const n = Math.min(buf.length, Math.floor(buf.sampleRate * 1.5));
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < n; i++) {
        const a = Math.abs(d[i]);
        if (a > peak) peak = a;
      }
    }
    if (peak > 0) {
      this.trim = clamp(0.32 / (peak * dbToGain(ref.db)), 0.05, 30);
      this.trimMeasured = true;
    }
  }

  private pickRegion(note: number, vel127: number, trigger: 'a' | 'r'): { region: Region; buffer: AudioBuffer } | null {
    const inst = this.instrument;
    if (inst.kind !== 'sampled') return null;
    const index = trigger === 'a' ? this.attackIndex : this.releaseIndex;
    let pool = (index[note] || []).filter((r) => this.store.has(inst, r.path));
    if (!pool.length && trigger === 'a') {
      // Nothing loaded for this key yet (or missing upstream): borrow the nearest loaded sample.
      let best: Region | null = null;
      for (const r of this.sortedAttacks) {
        if (!this.store.has(inst, r.path)) continue;
        if (!best || Math.abs(r.key - note) < Math.abs(best.key - note)) best = r;
      }
      if (!best) return null;
      pool = this.sortedAttacks.filter((r) => r.key === best!.key && this.store.has(inst, r.path));
    }
    if (!pool.length) return null;
    const pedalWanted = this.sustain >= 0.5 ? 'd' : 'u';
    if (pool.some((r) => r.pedal)) {
      const matching = pool.filter((r) => !r.pedal || r.pedal === pedalWanted);
      if (matching.length) pool = matching;
    }
    let inRange = pool.filter((r) => r.vl <= vel127 && vel127 <= r.vh);
    if (!inRange.length) {
      const dist = (r: Region) => (vel127 < r.vl ? r.vl - vel127 : vel127 - r.vh);
      const d = Math.min(...pool.map(dist));
      inRange = pool.filter((r) => dist(r) === d);
    }
    let region = inRange[0];
    const rrLen = region.rrLen || 1;
    if (rrLen > 1) {
      const pos = (this.rr[note]++ % rrLen) + 1;
      region = inRange.find((r) => (r.rrPos || 1) === pos) || inRange[this.rr[note] % inRange.length];
    }
    const buffer = this.store.get(inst, region.path)!;
    return { region, buffer };
  }

  // ------------------------------------------------------------ notes ----

  private effectiveVelocity(vel127: number): number {
    const s = this.settings;
    if (s.touch === 'fixed') return clamp(s.fixedVelocity / 127, 0.01, 1);
    return clamp((TOUCH[s.touch] || TOUCH.normal)(clamp(vel127, 1, 127) / 127), 0.01, 1);
  }

  private velocityGain(v: number, veltrack: number) {
    const exp = (this.settings.dynamicRange / 20) * veltrack;
    return Math.pow(Math.max(v, 0.015), exp);
  }

  private cutoff(v: number, freq: number, regionCutoff?: number) {
    const s = this.settings;
    const t = 1 - s.hardness + s.hardness * v;
    let fc = 320 * Math.pow(20000 / 320, t) * Math.pow(2, s.brightness * 2.5);
    if (this.soft) fc *= 1 - 0.55 * s.softAmount;
    if (regionCutoff) fc = Math.min(fc, regionCutoff * Math.pow(2, s.brightness * 2 + 1));
    return clamp(Math.max(fc, freq * 2.5), 40, 20000);
  }

  private isUndamped(note: number, region?: Region) {
    const inst = this.instrument;
    if (inst.sustaining) return false;
    return !!region?.undamped || (inst.undampedFrom !== undefined && note >= inst.undampedFrom);
  }

  noteOn(key: number, velocity: number, when = this.ctx.currentTime) {
    if (key < 0 || key > 127) return;
    const now = this.ctx.currentTime;
    when = Math.max(when, now);
    const s = this.settings;
    const note = key + s.transpose;
    if (note < 0 || note > 127) return;
    const v = this.effectiveVelocity(velocity) * (this.soft ? 1 - 0.3 * s.softAmount : 1);
    this.holders[key] = Math.min(255, this.holders[key] + 1);

    for (const vc of this.voices) {
      if (vc.key !== key || vc.kind !== 'note' || vc.damp === 'released') continue;
      // Re-striking a string stops its previous vibration.
      if (s.retrigger === 'cut') this.releaseVoice(vc, when, 0.07);
    }
    this.enforcePolyphony(when);

    const detunes = s.unisonDetune > 0 ? [-s.unisonDetune / 2, s.unisonDetune / 2] : [0];
    const unison = detunes.length > 1 ? 0.72 : 1;
    for (const d of detunes) this.spawn(key, note, v, when, d, unison, 'note');

    if (this.instrument.piano && s.resonance > 0 && this.sustain >= 0.5) {
      this.spawn(key, note, v, when, 0, s.resonance * 0.3, 'resonance');
    }
  }

  private spawn(key: number, note: number, v: number, when: number, extraDetune: number, gainMul: number, kind: Voice['kind']) {
    const s = this.settings;
    const inst = this.instrument;
    const freq = midiToFreq(note);
    const pan = clamp(s.keyPan * ((note - 64) / 44), -1, 1);
    const panner = this.ctx.createStereoPanner();
    panner.pan.value = pan;
    panner.connect(this.voiceBus);

    const picked = kind === 'resonance' ? this.pickRegion(Math.min(127, note + 12), v * 127, 'a') : this.pickRegion(note, v * 127, 'a');
    if (inst.kind === 'synth' || !picked) {
      if (kind === 'resonance') {
        panner.disconnect();
        return;
      }
      const engine = inst.kind === 'synth' ? inst.engine : 'piano';
      const peak = 0.34 * this.velocityGain(v, 1) * gainMul;
      const sv = createSynthVoice(this.ctx, engine, midiToFreq(note, 440) * Math.pow(2, (this.tuning(note) + extraDetune) / 1200), note, v, when, peak, s.attack, s.brightness, panner);
      this.register({
        key, note, kind, start: when, velocity: v, peak, held: true, sostenuto: false, damp: 'free',
        undamped: false, env: sv.env, nodes: [...sv.nodes, panner], sources: sv.sources, endAt: sv.endAt,
      });
      return;
    }

    const { region, buffer } = picked;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const semis = region.noKeytrack ? 0 : note - region.key;
    src.playbackRate.value = Math.pow(2, semis / 12);
    const baseDetune = region.tune + extraDetune;
    (src as AudioBufferSourceNode & { _baseDetune?: number })._baseDetune = baseDetune;
    src.detune.value = baseDetune + this.tuning(note);

    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 0;
    filter.frequency.value = this.cutoff(v, freq, region.cutoff) * (kind === 'resonance' ? 0.55 : 1);

    const env = this.ctx.createGain();
    const veltrack = inst.kind === 'sampled' ? inst.veltrack : 1;
    const peak = this.trim * dbToGain(region.db) * this.velocityGain(v, veltrack) * gainMul;
    const attack = kind === 'resonance' ? 0.12 : Math.max(0.0015, s.attack, region.attack || 0);
    env.gain.setValueAtTime(0, when);
    env.gain.linearRampToValueAtTime(peak, when + attack);
    if (s.holdDecay > 0 && kind === 'note') env.gain.setTargetAtTime(0, when + attack, s.holdDecay);

    src.connect(filter).connect(env).connect(panner);
    const offset = Math.min(region.offset, Math.max(0, buffer.duration - 0.05));
    src.start(when, offset);
    const endAt = when + (buffer.duration - offset) / src.playbackRate.value;
    const voice = this.register({
      key, note, kind, start: when, velocity: v, peak, held: kind === 'note', sostenuto: false,
      damp: 'free', undamped: this.isUndamped(note, region), env, nodes: [filter, env, panner], sources: [src], endAt,
    });
    src.onended = () => this.cleanup(voice);
  }

  private register(v: Omit<Voice, 'id'>): Voice {
    const voice = { ...v, id: this.nextId++ } as Voice;
    this.voices.push(voice);
    return voice;
  }

  private cleanup(v: Voice) {
    const i = this.voices.indexOf(v);
    if (i >= 0) this.voices.splice(i, 1);
    for (const n of v.nodes) {
      try {
        n.disconnect();
      } catch {
        /* already gone */
      }
    }
  }

  private enforcePolyphony(when: number) {
    const now = this.ctx.currentTime;
    // Forget voices whose sound has already finished.
    for (const v of [...this.voices]) if (v.endAt < now - 0.05) this.cleanup(v);
    const max = Math.max(8, this.settings.polyphony);
    while (this.voices.length >= max) {
      const victim =
        this.voices.find((v) => v.damp === 'released') ||
        this.voices.find((v) => v.kind !== 'note') ||
        this.voices.find((v) => !v.held) ||
        this.voices[0];
      this.releaseVoice(victim, when, 0.012);
      this.cleanup(victim);
    }
  }

  private releaseTau(v: Voice) {
    const s = this.settings;
    const scale = this.instrument.sustaining ? 0.2 : 1;
    const bass = clamp(1 + (60 - v.note) / 90, 0.6, 1.6);
    return Math.max(0.02, s.release * scale * bass);
  }

  private releaseVoice(v: Voice, when: number, tau: number) {
    if (v.damp === 'released') return;
    v.damp = 'released';
    const g = v.env.gain;
    g.cancelAndHoldAtTime(when);
    g.setTargetAtTime(0, when, tau);
    const stopAt = when + tau * 8 + 0.03;
    for (const s of v.sources) {
      try {
        s.stop(stopAt);
      } catch {
        /* not started */
      }
    }
    v.endAt = Math.min(v.endAt, stopAt);
    if (!(v.sources[0] instanceof AudioBufferSourceNode)) {
      window.setTimeout(() => this.cleanup(v), Math.max(0, (stopAt - this.ctx.currentTime) * 1000 + 100));
    }
  }

  /** Dampers fall on a string: release it (undamped treble strings keep ringing). */
  private damp(v: Voice, when: number, withNoise: boolean) {
    if (v.damp === 'released') return;
    if (v.undamped && v.kind === 'note') {
      this.releaseVoice(v, when, Math.max(2.5, this.releaseTau(v)));
      return;
    }
    const tau = this.releaseTau(v);
    this.releaseVoice(v, when, tau);
    if (withNoise && v.kind === 'note') this.releaseNoise(v, when);
  }

  /** Half-pedalling: dampers lightly touch the strings, so notes fade faster the higher the pedal. */
  private partialDamp(v: Voice, when: number) {
    const t = (this.sustain - PEDAL_OFF) / (PEDAL_FULL - PEDAL_OFF);
    const tau = lerp(this.releaseTau(v), 3.5, t * t);
    v.damp = 'partial';
    v.env.gain.cancelAndHoldAtTime(when);
    v.env.gain.setTargetAtTime(0, when, tau);
  }

  private undamp(v: Voice, when: number) {
    if (v.damp !== 'partial') return;
    v.damp = 'free';
    v.env.gain.cancelAndHoldAtTime(when);
  }

  noteOff(key: number, when = this.ctx.currentTime) {
    if (key < 0 || key > 127) return;
    when = Math.max(when, this.ctx.currentTime);
    if (this.holders[key] > 0) this.holders[key]--;
    if (this.holders[key] > 0) return;
    const half = this.settings.halfPedal;
    for (const v of this.voices) {
      if (v.key !== key || v.kind !== 'note' || !v.held) continue;
      v.held = false;
      if (v.sostenuto || v.damp === 'released') continue;
      if (this.instrument.sustaining && this.sustain < 0.5) {
        this.damp(v, when, false);
      } else if (this.sustain >= PEDAL_FULL || (!half && this.sustain >= 0.5)) {
        // Sustained by the pedal.
      } else if (half && this.sustain > PEDAL_OFF) {
        this.partialDamp(v, when);
      } else {
        this.damp(v, when, true);
      }
    }
  }

  /** Sustain (damper) pedal, 0 = up … 1 = fully down. */
  setSustain(value: number, when = this.ctx.currentTime) {
    when = Math.max(when, this.ctx.currentTime);
    const s = this.settings;
    let val = clamp(value, 0, 1);
    if (!s.halfPedal) val = val >= 0.5 ? 1 : 0;
    const prev = this.sustain;
    if (Math.abs(prev - val) < 0.005) return;
    this.sustain = val;
    const wasDown = prev >= 0.5;
    const isDown = val >= 0.5;
    if (!wasDown && isDown) this.pedalNoise('pd', when);
    if (wasDown && !isDown) this.pedalNoise('pu', when);

    let noises = 0;
    for (const v of [...this.voices]) {
      if (v.held || v.sostenuto || v.damp === 'released' || v.kind === 'noise') continue;
      if (val >= PEDAL_FULL || (!s.halfPedal && isDown)) {
        this.undamp(v, when);
      } else if (s.halfPedal && val > PEDAL_OFF) {
        this.partialDamp(v, when);
      } else {
        this.damp(v, when, noises++ < 6);
      }
    }
    this.emit('pedal', { sustain: this.sustain, soft: this.soft, sostenuto: this.sostenuto });
  }

  /** Soft pedal (una corda): affects notes struck while it is held. */
  setSoft(down: boolean) {
    this.soft = down;
    this.emit('pedal', { sustain: this.sustain, soft: this.soft, sostenuto: this.sostenuto });
  }

  /** Sostenuto: sustains only the notes held at the moment it is pressed. */
  setSostenuto(down: boolean, when = this.ctx.currentTime) {
    when = Math.max(when, this.ctx.currentTime);
    if (down === this.sostenuto) return;
    this.sostenuto = down;
    for (const v of this.voices) {
      if (v.kind !== 'note' || v.damp === 'released') continue;
      if (down) {
        if (v.held) v.sostenuto = true;
      } else if (v.sostenuto) {
        v.sostenuto = false;
        if (!v.held && this.sustain < 0.5) this.damp(v, when, true);
      }
    }
    this.emit('pedal', { sustain: this.sustain, soft: this.soft, sostenuto: this.sostenuto });
  }

  get pedals() {
    return { sustain: this.sustain, soft: this.soft, sostenuto: this.sostenuto };
  }

  private pedalNoise(kind: 'pd' | 'pu', when: number) {
    const level = this.settings.pedalNoise;
    if (level <= 0) return;
    const inst = this.instrument;
    const regions = this.pedalRegions[kind].filter((r) => inst.kind === 'sampled' && this.store.has(inst, r.path));
    if (regions.length && inst.kind === 'sampled') {
      const r = regions[Math.floor(Math.random() * regions.length)];
      this.oneShot(this.store.get(inst, r.path)!, when, this.trim * dbToGain(r.db) * level * 0.8, r.offset, 0);
      return;
    }
    if (!inst.piano) return;
    // Synthesised felt thump.
    const src = this.ctx.createBufferSource();
    src.buffer = noiseBuffer(this.ctx);
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = kind === 'pd' ? 380 : 260;
    const g = this.ctx.createGain();
    const peak = (kind === 'pd' ? 0.05 : 0.035) * level;
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(peak, when + 0.006);
    g.gain.setTargetAtTime(0, when + 0.006, kind === 'pd' ? 0.035 : 0.05);
    src.connect(lp).connect(g).connect(this.voiceBus);
    src.start(when);
    src.stop(when + 0.4);
    src.onended = () => g.disconnect();
  }

  private releaseNoise(v: Voice, when: number) {
    const level = this.settings.releaseNoise;
    if (level <= 0) return;
    const heldFor = Math.max(0, when - v.start);
    const picked = this.pickRegion(v.note, v.velocity * 127, 'r');
    if (picked) {
      // Release samples get quieter the longer the note was held (SFZ rt_decay ≈ 2 dB/s).
      const gain = this.trim * dbToGain(picked.region.db - 2 * heldFor) * this.velocityGain(v.velocity, 0.6) * level;
      const semis = picked.region.noKeytrack ? 0 : v.note - picked.region.key;
      this.oneShot(picked.buffer, when, gain, picked.region.offset, semis);
    } else if (this.instrument.piano && heldFor > 0.05) {
      const src = this.ctx.createBufferSource();
      src.buffer = noiseBuffer(this.ctx);
      const bp = this.ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = clamp(midiToFreq(v.note) * 2, 150, 1800);
      bp.Q.value = 2;
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.012 * level * Math.min(1, v.velocity * 1.5), when);
      g.gain.setTargetAtTime(0, when, 0.03);
      src.connect(bp).connect(g).connect(this.voiceBus);
      src.start(when);
      src.stop(when + 0.25);
      src.onended = () => g.disconnect();
    }
  }

  private oneShot(buffer: AudioBuffer, when: number, gain: number, offset: number, semis: number) {
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = Math.pow(2, semis / 12);
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(this.voiceBus);
    src.start(when, Math.min(offset, Math.max(0, buffer.duration - 0.05)));
    src.onended = () => g.disconnect();
  }

  /** Lets every note ring out naturally (keys up, pedals up). */
  allNotesOff(when = this.ctx.currentTime) {
    this.holders.fill(0);
    this.sustain = 0;
    this.sostenuto = false;
    for (const v of [...this.voices]) {
      v.held = false;
      v.sostenuto = false;
      this.damp(v, Math.max(when, this.ctx.currentTime), false);
    }
    this.emit('pedal', { sustain: this.sustain, soft: this.soft, sostenuto: this.sostenuto });
  }

  /** Silences everything immediately, including notes scheduled in the future. */
  panic() {
    const t = this.ctx.currentTime;
    this.holders.fill(0);
    this.sustain = 0;
    this.sostenuto = false;
    this.soft = false;
    for (const v of [...this.voices]) {
      this.releaseVoice(v, t, 0.01);
      if (v.start > t) {
        for (const s of v.sources) {
          try {
            s.stop(t);
          } catch {
            /* ignore */
          }
        }
      }
    }
    this.emit('pedal', { sustain: 0, soft: false, sostenuto: false });
  }

  /** Stops notes that were scheduled to start after `from` (used when seeking). */
  cancelScheduled(from = this.ctx.currentTime) {
    for (const v of [...this.voices]) {
      if (v.start > from) {
        for (const s of v.sources) {
          try {
            s.stop();
          } catch {
            /* ignore */
          }
        }
        this.cleanup(v);
      }
    }
  }

  // ------------------------------------------------------------ misc ----

  async resume() {
    if (this.ctx.state !== 'running') await this.ctx.resume();
  }

  get voiceCount() {
    const now = this.ctx.currentTime;
    return this.voices.filter((v) => v.endAt > now && v.start <= now + 0.05).length;
  }

  /** Output peak level (0..1+) for the meter. */
  level(): number {
    this.analyser.getFloatTimeDomainData(this.meterBuf);
    let peak = 0;
    for (let i = 0; i < this.meterBuf.length; i++) {
      const a = Math.abs(this.meterBuf[i]);
      if (a > peak) peak = a;
    }
    return peak;
  }

  /** A MediaStream of the final output, for audio recording. */
  recordStream(): MediaStream {
    if (!this.recordDest) {
      this.recordDest = this.ctx.createMediaStreamDestination();
      this.limiter.connect(this.recordDest);
    }
    return this.recordDest.stream;
  }

  latencyMs(): number {
    return Math.round(((this.ctx.baseLatency || 0) + ((this.ctx as AudioContext & { outputLatency?: number }).outputLatency || 0)) * 1000);
  }
}
