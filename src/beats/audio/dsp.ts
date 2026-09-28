// Audio analysis for map making, plus time-stretching. Pure functions: they
// run in a worker (worker.ts) and in unit tests.
//
// Analysis: the signal is resampled to 22 kHz and cut into 1024-sample
// frames (hop 256 ≈ 11.6 ms). Log-compressed spectral flux in four bands
// gives an onset envelope; peaks above an adaptive threshold become onset
// candidates, each with band strengths, a brightness value used as a pitch
// stand-in, and a sustain length. Tempo comes from the envelope's
// autocorrelation (with a prior around 120 BPM), refined by fitting a beat
// comb over the whole song, which also gives the beat phase.

import type { Analysis, Onset } from '../types';

export const ANALYSIS_VERSION = 6;
const SR = 22050;
const N = 1024;
const HOP = 256;
const FPS = SR / HOP;

// ------------------------------------------------------------------ FFT ----

class FFT {
  private rev: Uint32Array;
  private cos: Float64Array;
  private sin: Float64Array;
  constructor(readonly n: number) {
    const bits = Math.log2(n);
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = -Math.sin((2 * Math.PI * i) / n);
    }
  }
  /** In-place complex FFT. */
  run(re: Float64Array, im: Float64Array) {
    const n = this.n;
    for (let i = 0; i < n; i++) {
      const j = this.rev[i];
      if (j > i) {
        let t = re[i];
        re[i] = re[j];
        re[j] = t;
        t = im[i];
        im[i] = im[j];
        im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0; k < half; k++) {
          const wr = this.cos[k * step];
          const wi = this.sin[k * step];
          const a = start + k;
          const b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
        }
      }
    }
  }
}

// ------------------------------------------------------------ helpers ----

export function mixToMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const n = channels[0].length;
  const out = new Float32Array(n);
  for (const ch of channels) for (let i = 0; i < n; i++) out[i] += ch[i];
  const g = 1 / channels.length;
  for (let i = 0; i < n; i++) out[i] *= g;
  return out;
}

/** Low-passes (for downsampling) and resamples with linear interpolation. */
export function resample(x: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return x;
  let src = x;
  if (from > to * 1.2) {
    // Two passes of a 5-tap binomial filter: enough to keep aliasing out of the onset envelope.
    for (let pass = 0; pass < 2; pass++) {
      const y = new Float32Array(src.length);
      for (let i = 0; i < src.length; i++) {
        const a = src[Math.max(0, i - 2)];
        const b = src[Math.max(0, i - 1)];
        const c = src[i];
        const d = src[Math.min(src.length - 1, i + 1)];
        const e = src[Math.min(src.length - 1, i + 2)];
        y[i] = (a + 4 * b + 6 * c + 4 * d + e) / 16;
      }
      src = y;
    }
  }
  const ratio = from / to;
  const n = Math.floor(src.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * ratio;
    const j = Math.floor(p);
    const f = p - j;
    out[i] = src[j] * (1 - f) + (src[j + 1] ?? src[j]) * f;
  }
  return out;
}

function percentile(values: ArrayLike<number>, p: number): number {
  const a = Float64Array.from(values).sort();
  if (!a.length) return 0;
  return a[Math.min(a.length - 1, Math.max(0, Math.round((a.length - 1) * p)))];
}

// --------------------------------------------------------- analysis ----

/** Log-spaced bands (about a third of an octave) from 120 Hz to 6 kHz, for tracking sustained notes. */
const NB = 48;
const NB_LO = 120;
const NB_HI = 6000;

interface Frames {
  count: number;
  /** count × NB linear magnitudes in log-spaced bands. */
  spec: Float32Array;
  /** Per-band flux per frame. */
  flux: Float32Array[];
  /** Per-band energy per frame. */
  energy: Float32Array[];
  centroid: Float32Array;
  rms: Float32Array;
}

const BANDS: [number, number][] = [
  [30, 200],
  [200, 800],
  [800, 3000],
  [3000, 11000],
];

function computeFrames(x: Float32Array, onProgress?: (p: number) => void): Frames {
  const count = Math.max(0, Math.floor((x.length - N) / HOP) + 1);
  const fft = new FFT(N);
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);
  const binHz = SR / N;
  const bandBins = BANDS.map(([lo, hi]) => [Math.max(1, Math.round(lo / binHz)), Math.min(N / 2 - 1, Math.round(hi / binHz))]);
  const flux = BANDS.map(() => new Float32Array(count));
  const energy = BANDS.map(() => new Float32Array(count));
  const centroid = new Float32Array(count);
  const rms = new Float32Array(count);
  const spec = new Float32Array(count * NB);
  const binBand = new Int16Array(N / 2).fill(-1);
  for (let k = 1; k < N / 2; k++) {
    const f = k * binHz;
    if (f < NB_LO || f >= NB_HI) continue;
    binBand[k] = Math.min(NB - 1, Math.floor((Math.log(f / NB_LO) / Math.log(NB_HI / NB_LO)) * NB));
  }
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  let prev = new Float64Array(N / 2);
  let cur = new Float64Array(N / 2);
  const logFreq = new Float64Array(N / 2);
  for (let k = 1; k < N / 2; k++) logFreq[k] = Math.log2(k * binHz);
  for (let f = 0; f < count; f++) {
    const off = f * HOP;
    let sq = 0;
    for (let i = 0; i < N; i++) {
      const s = x[off + i];
      sq += s * s;
      re[i] = s * win[i];
      im[i] = 0;
    }
    rms[f] = Math.sqrt(sq / N);
    fft.run(re, im);
    let cw = 0;
    let cs = 0;
    for (let k = 1; k < N / 2; k++) {
      const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      cur[k] = Math.log1p(100 * mag);
      const bb = binBand[k];
      if (bb >= 0) spec[f * NB + bb] += mag;
      if (k * binHz > 80 && k * binHz < 8000) {
        cw += mag;
        cs += mag * logFreq[k];
      }
    }
    centroid[f] = cw > 1e-9 ? cs / cw : 0;
    for (let b = 0; b < BANDS.length; b++) {
      const [lo, hi] = bandBins[b];
      let fl = 0;
      let en = 0;
      for (let k = lo; k <= hi; k++) {
        const d = cur[k] - prev[k];
        if (d > 0) fl += d;
        en += cur[k];
      }
      const width = hi - lo + 1;
      flux[b][f] = f === 0 ? 0 : fl / width;
      energy[b][f] = en / width;
    }
    const t = prev;
    prev = cur;
    cur = t;
    if (onProgress && f % 2000 === 0) onProgress(0.1 + 0.6 * (f / count));
  }
  return { count, spec, flux, energy, centroid, rms };
}

/**
 * Frame index (fractional) → seconds. Flux peaks a little after an attack
 * reaches the middle of the window; ATTACK_BIAS was measured on synthetic
 * kicks and hi-hats.
 */
let ATTACK_BIAS = 0.0165;
export function setAttackBias(v: number) {
  ATTACK_BIAS = v;
}
const frameTime = (f: number) => (f * HOP + N / 2 - HOP / 2) / SR + ATTACK_BIAS;

/** Sub-frame peak position by parabolic interpolation. */
function refinePeak(env: Float32Array, p: number): number {
  const a = env[p - 1] ?? env[p];
  const b = env[p];
  const c = env[p + 1] ?? env[p];
  const d = a - 2 * b + c;
  return d < 0 ? p + Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / d)) : p;
}

function envelopeOf(fr: Frames): { env: Float32Array; bands: Float32Array[] } {
  const bands = fr.flux.map((band) => {
    const scale = percentile(band, 0.98) || 1;
    return band.map((v) => v / scale);
  });
  const w = [1.2, 1, 1, 0.8];
  const env = new Float32Array(fr.count);
  for (let f = 0; f < fr.count; f++) {
    let s = 0;
    for (let b = 0; b < bands.length; b++) s += bands[b][f] * w[b];
    env[f] = s / 4;
  }
  return { env, bands };
}

function pickPeaks(env: Float32Array, sensitivity: number): number[] {
  const n = env.length;
  const win = Math.round(0.12 * FPS);
  const k = 0.6 - 0.45 * sensitivity;
  const floor = percentile(env, 0.5) * (0.6 - 0.5 * sensitivity) + 1e-4;
  // Running mean for the adaptive threshold.
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + env[i];
  const peaks: number[] = [];
  const minGap = Math.round(0.035 * FPS);
  let last = -Infinity;
  for (let i = 2; i < n - 2; i++) {
    const v = env[i];
    if (v < floor) continue;
    let isMax = true;
    for (let j = Math.max(0, i - 3); j <= Math.min(n - 1, i + 3); j++) {
      if (env[j] > v || (env[j] === v && j < i)) {
        isMax = false;
        break;
      }
    }
    if (!isMax) continue;
    const a = Math.max(0, i - win);
    const b = Math.min(n, i + win + 1);
    const mean = (prefix[b] - prefix[a]) / (b - a);
    if (v < mean * (1 + k) + floor * 0.5) continue;
    if (i - last < minGap) {
      if (v > env[peaks[peaks.length - 1]]) peaks[peaks.length - 1] = i;
      continue;
    }
    peaks.push(i);
    last = i;
  }
  return peaks;
}

/** Tempo from the envelope autocorrelation, refined with a beat comb. Returns BPM, first beat and confidence. */
export function estimateTempo(raw: Float32Array, fps = FPS): { bpm: number; phase: number; confidence: number } {
  const n = raw.length;
  if (n < fps * 4) return { bpm: 120, phase: 0, confidence: 0 };
  // A slightly smoothed envelope makes the comb fit tolerant of ±1 frame of jitter.
  const env = new Float32Array(n);
  for (let i = 0; i < n; i++) env[i] = (raw[i] + 0.6 * ((raw[i - 1] ?? 0) + (raw[i + 1] ?? 0)) + 0.25 * ((raw[i - 2] ?? 0) + (raw[i + 2] ?? 0))) / 2.7;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += env[i];
  mean /= n;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = Math.max(0, env[i] - mean);
  const minLag = Math.floor((60 * fps) / 210);
  const maxLag = Math.ceil((60 * fps) / 55);
  const ac = new Float64Array(maxLag * 2 + 2);
  const limit = Math.min(n, Math.round(fps * 120)); // two minutes is plenty
  for (let lag = 1; lag < ac.length; lag++) {
    let s = 0;
    for (let i = 0; i + lag < limit; i++) s += x[i] * x[i + lag];
    ac[lag] = s / (limit - lag);
  }
  let bestLag = minLag;
  let bestScore = -Infinity;
  const scores: number[] = [];
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (60 * fps) / lag;
    const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 120) / 0.75, 2));
    const s = (ac[lag] + 0.5 * (ac[2 * lag] || 0) + 0.25 * (ac[Math.round(lag / 2)] || 0)) * prior;
    scores.push(s);
    if (s > bestScore) {
      bestScore = s;
      bestLag = lag;
    }
  }
  // Parabolic refinement of the lag.
  const y0 = ac[bestLag - 1] || 0;
  const y1 = ac[bestLag];
  const y2 = ac[bestLag + 1] || 0;
  const denom = y0 - 2 * y1 + y2;
  const lag = denom < 0 ? bestLag + (0.5 * (y0 - y2)) / denom : bestLag;
  let bpm = (60 * fps) / lag;

  // Comb fit over the whole song: fine BPM and phase.
  const combAt = (period: number, ph: number) => {
    let s = 0;
    for (let t = ph; t < n - 1; t += period) {
      const i = Math.floor(t);
      const f = t - i;
      s += env[i] * (1 - f) + env[i + 1] * f;
    }
    return s;
  };
  const combScore = (b: number) => {
    const period = (60 * fps) / b;
    const phases = 48;
    let best = -Infinity;
    let bestPhase = 0;
    for (let p = 0; p < phases; p++) {
      const ph = (p / phases) * period;
      const s = combAt(period, ph);
      if (s > best) {
        best = s;
        bestPhase = ph;
      }
    }
    for (let ph = bestPhase - period / phases; ph <= bestPhase + period / phases; ph += 0.2) {
      if (ph < 0) continue;
      const s = combAt(period, ph);
      if (s > best) {
        best = s;
        bestPhase = ph;
      }
    }
    return { s: best / (n / period), phase: bestPhase };
  };
  let fit = combScore(bpm);
  for (const step of [0.5, 0.1, 0.02]) {
    for (let d = -5; d <= 5; d++) {
      if (!d) continue;
      const b = bpm + d * step;
      const c = combScore(b);
      if (c.s > fit.s) {
        fit = c;
        bpm = b;
      }
    }
  }
  const rounded = Math.round(bpm);
  if (Math.abs(rounded - bpm) < 0.12) {
    const c = combScore(rounded);
    if (c.s >= fit.s * 0.985) {
      bpm = rounded;
      fit = c;
    }
  }
  // Refine the phase to a single frame.
  const period = (60 * fps) / bpm;
  let bestPhase = fit.phase;
  let best = -Infinity;
  for (let ph = fit.phase - period / 24; ph <= fit.phase + period / 24; ph += 0.25) {
    let s = 0;
    for (let t = ((ph % period) + period) % period; t < n - 1; t += period) {
      const i = Math.floor(t);
      const f = t - i;
      s += env[i] * (1 - f) + env[i + 1] * f;
    }
    if (s > best) {
      best = s;
      bestPhase = ((ph % period) + period) % period;
    }
  }
  const sorted = [...scores].sort((a, b) => b - a);
  const confidence = sorted.length > 1 && sorted[0] > 0 ? Math.max(0, Math.min(1, 1 - sorted[Math.min(sorted.length - 1, 6)] / sorted[0])) : 0;
  return { bpm: Math.round(bpm * 100) / 100, phase: bestPhase, confidence };
}

export interface AnalyzeOptions {
  sensitivity?: number;
  onProgress?: (p: number) => void;
}

export function analyze(channels: Float32Array[], sampleRate: number, opts: AnalyzeOptions = {}): Analysis {
  const onProgress = opts.onProgress;
  const duration = channels[0].length / sampleRate;
  onProgress?.(0.02);
  const mono = resample(mixToMono(channels), sampleRate, SR);
  onProgress?.(0.1);
  const fr = computeFrames(mono, onProgress);
  const { env, bands } = envelopeOf(fr);
  onProgress?.(0.75);

  const tempo = estimateTempo(env);
  const period = (60 * FPS) / tempo.bpm;
  // Downbeat: the beat of the bar (assuming 4/4) with the most low-band energy.
  const beatAcc = [0, 0, 0, 0];
  let bi = 0;
  for (let t = tempo.phase; t < fr.count - 1; t += period, bi++) {
    const i = Math.round(t);
    beatAcc[bi % 4] += bands[0][i] * 1.5 + env[i];
  }
  const down = beatAcc.indexOf(Math.max(...beatAcc));
  const offsetFrames = tempo.phase + down * period;
  const offset = Math.max(0, frameTime(offsetFrames));

  // Onsets.
  const peaks = pickPeaks(env, opts.sensitivity ?? 0.6);
  const top = percentile(peaks.map((p) => env[p]), 0.97) || 1;
  const cents = peaks.map((p) => fr.centroid[Math.min(fr.count - 1, p + 1)]).filter((c) => c > 0);
  const cLo = percentile(cents, 0.05);
  const cHi = percentile(cents, 0.95);
  const bandTop = bands.map((b) => percentile(peaks.map((p) => b[p]), 0.95) || 1);
  // Sustain: follow the frequency band where the attack happened. A drum's
  // energy there dies away quickly; a held note's stays up until it is
  // released or the same band is struck again.
  const sp = fr.spec;
  const band = (f: number, j: number) => (f >= 0 && f < fr.count ? sp[f * NB + j] : 0);
  const onsets: Onset[] = [];
  for (let k = 0; k < peaks.length; k++) {
    const p = peaks[k];
    if (env[p] / top < 0.05) continue; // too faint to ever be mapped
    // Several sounds often start together (kick + bass + lead): measure the
    // bands that rose most and keep the longest-lasting one.
    const rises: [number, number][] = [];
    for (let j = 0; j < NB; j++) {
      const rise = band(p + 2, j) - band(p - 2, j);
      if (rise > 0) rises.push([rise, j]);
    }
    rises.sort((a, b) => b[0] - a[0]);
    const bestRise = rises[0]?.[0] ?? 0;
    const maxEnd = Math.min(fr.count - 1, p + Math.round(4 * FPS));
    let end = p + 2;
    for (const [rise, bj] of rises.slice(0, 6)) {
      if (rise < bestRise * 0.2) break;
      // Include the neighbouring bands so vibrato or slight detuning doesn't end the note.
      const level = (f: number) => band(f, bj) + 0.5 * (band(f, bj - 1) + band(f, bj + 1));
      const ref = Math.max(level(p + 1), level(p + 2), level(p + 3));
      let e = p + 3;
      while (e < maxEnd) {
        const v = level(e);
        if (v < ref * 0.3) break;
        if (e > p + 6 && v - level(e - 3) > ref * 0.6) break; // struck again
        e++;
      }
      end = Math.max(end, e);
    }
    const c = fr.centroid[Math.min(fr.count - 1, p + 1)];
    onsets.push({
      t: Math.round(frameTime(refinePeak(env, p)) * 10000) / 10000,
      strength: Math.round(Math.min(1, env[p] / top) * 1000) / 1000,
      low: Math.round(Math.min(1, bands[0][p] / bandTop[0]) * 1000) / 1000,
      mid: Math.round(Math.min(1, (bands[1][p] + bands[2][p]) / (bandTop[1] + bandTop[2])) * 1000) / 1000,
      high: Math.round(Math.min(1, bands[3][p] / bandTop[3]) * 1000) / 1000,
      pitch: cHi > cLo ? Math.round(Math.max(0, Math.min(1, (c - cLo) / (cHi - cLo))) * 1000) / 1000 : 0.5,
      dur: Math.round(((end - p) / FPS) * 1000) / 1000,
    });
  }
  onProgress?.(0.88);

  // Waveform overview: 100 bins per second from the 22 kHz signal, band colours from the frames.
  const rate = 100;
  const binLen = SR / rate;
  const bins = Math.ceil(mono.length / binLen);
  const q = (v: number) => Math.round(Math.max(-1, Math.min(1, v)) * 127);
  const min: number[] = new Array(bins);
  const max: number[] = new Array(bins);
  const low: number[] = new Array(bins);
  const mid: number[] = new Array(bins);
  const high: number[] = new Array(bins);
  const eTop = fr.energy.map((e) => percentile(e, 0.99) || 1);
  for (let b = 0; b < bins; b++) {
    let lo = 0;
    let hi = 0;
    const s = Math.floor(b * binLen);
    const e = Math.min(mono.length, Math.floor((b + 1) * binLen));
    for (let i = s; i < e; i++) {
      const v = mono[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    min[b] = q(lo);
    max[b] = q(hi);
    const f = Math.min(fr.count - 1, Math.max(0, Math.round(((b + 0.5) / rate) * FPS - N / 2 / HOP)));
    low[b] = fr.count ? Math.round(Math.min(1, fr.energy[0][f] / eTop[0]) * 255) : 0;
    mid[b] = fr.count ? Math.round(Math.min(1, (fr.energy[1][f] + fr.energy[2][f]) / (eTop[1] + eTop[2])) * 255) : 0;
    high[b] = fr.count ? Math.round(Math.min(1, fr.energy[3][f] / eTop[3]) * 255) : 0;
  }
  // Loudness per half second.
  const energy: number[] = [];
  const half = Math.round(FPS / 2);
  for (let f = 0; f < fr.count; f += half) {
    let s = 0;
    for (let i = f; i < Math.min(fr.count, f + half); i++) s += fr.rms[i];
    energy.push(s / half);
  }
  const eMax = Math.max(1e-6, percentile(energy, 0.98));
  onProgress?.(1);
  return {
    version: ANALYSIS_VERSION,
    duration,
    sampleRate,
    bpm: tempo.bpm,
    bpmConfidence: Math.round(tempo.confidence * 100) / 100,
    offset: Math.round(offset * 10000) / 10000,
    onsets,
    peaks: { rate, min, max, low, mid, high },
    energy: energy.map((e) => Math.round(Math.min(1, e / eMax) * 1000) / 1000),
  };
}

// ------------------------------------------------------ time stretch ----

/**
 * WSOLA time-stretch: plays `rate` times faster without changing pitch.
 * All channels use the same splice points (found on the mono mix).
 */
export function timeStretch(channels: Float32Array[], rate: number, sampleRate: number, onProgress?: (p: number) => void): Float32Array[] {
  if (Math.abs(rate - 1) < 1e-4) return channels.map((c) => c.slice());
  const frame = sampleRate >= 32000 ? 2048 : 1024;
  const hs = frame / 2;
  const ha = hs * rate;
  const tol = Math.round(frame / 4);
  const len = channels[0].length;
  const outLen = Math.floor(len / rate);
  const mono = mixToMono(channels);
  const win = new Float32Array(frame);
  for (let i = 0; i < frame; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / frame);
  const out = channels.map(() => new Float32Array(outLen + frame));
  const norm = new Float32Array(outLen + frame);
  const frames = Math.ceil(outLen / hs);
  let prev = 0;
  const cmpLen = frame / 2;
  const corr = (a: number, b: number, step: number, dec: number) => {
    let s = 0;
    for (let i = 0; i < cmpLen; i += dec) s += mono[a + i] * mono[b + i];
    void step;
    return s;
  };
  for (let k = 0; k < frames; k++) {
    let pos = Math.round(k * ha);
    if (k > 0) {
      const natural = prev + hs;
      const lo = Math.max(0, pos - tol);
      const hi = Math.min(len - frame - 1, pos + tol);
      if (natural + cmpLen < len && hi > lo) {
        let best = pos;
        let bestS = -Infinity;
        for (let p = lo; p <= hi; p += 8) {
          const s = corr(p, natural, 8, 4);
          if (s > bestS) {
            bestS = s;
            best = p;
          }
        }
        const lo2 = Math.max(lo, best - 8);
        const hi2 = Math.min(hi, best + 8);
        for (let p = lo2; p <= hi2; p++) {
          const s = corr(p, natural, 1, 2);
          if (s > bestS) {
            bestS = s;
            best = p;
          }
        }
        pos = best;
      }
    }
    if (pos + frame > len) pos = Math.max(0, len - frame);
    const o = k * hs;
    for (let c = 0; c < channels.length; c++) {
      const src = channels[c];
      const dst = out[c];
      for (let i = 0; i < frame; i++) dst[o + i] += src[pos + i] * win[i];
    }
    for (let i = 0; i < frame; i++) norm[o + i] += win[i];
    prev = pos;
    if (onProgress && k % 500 === 0) onProgress(k / frames);
  }
  return out.map((d) => {
    const r = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) r[i] = norm[i] > 1e-3 ? d[i] / norm[i] : d[i];
    return r;
  });
}
