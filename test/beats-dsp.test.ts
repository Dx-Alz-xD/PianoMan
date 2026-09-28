import { describe, expect, it } from 'vitest';
import { analyze, estimateTempo, timeStretch } from '../src/beats/audio/dsp';

const SR = 44100;

/** Kick on every beat, snare on 2 and 4, hi-hat on off-beats, a held synth chord every 2 bars. */
function drumLoop(bpm: number, seconds: number, start = 0.37) {
  const n = Math.floor(seconds * SR);
  const x = new Float32Array(n);
  const beat = 60 / bpm;
  const hits: { t: number; kind: string }[] = [];
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let b = 0; start + b * beat < seconds - 0.5; b++) {
    const t = start + b * beat;
    hits.push({ t, kind: 'kick' });
    const i0 = Math.floor(t * SR);
    for (let i = 0; i < 0.4 * SR && i0 + i < n; i++) {
      const tt = i / SR;
      x[i0 + i] += 0.9 * Math.sin(2 * Math.PI * (55 + 90 * Math.exp(-tt * 30)) * tt) * Math.exp(-tt * 18);
    }
    if (b % 2 === 1) {
      for (let i = 0; i < 0.12 * SR && i0 + i < n; i++) x[i0 + i] += 0.5 * rnd() * Math.exp(-(i / SR) * 25);
    }
    const th = t + beat / 2;
    const ih = Math.floor(th * SR);
    for (let i = 0; i < 0.04 * SR && ih + i < n; i++) {
      // crude hi-hat: noise high-passed by differencing
      x[ih + i] += 0.25 * (rnd() - rnd()) * Math.exp(-(i / SR) * 90);
    }
    hits.push({ t: th, kind: 'hat' });
    if (b % 8 === 0) {
      const len = beat * 3;
      for (let i = 0; i < len * SR && i0 + i < n; i++) {
        const tt = i / SR;
        x[i0 + i] += 0.12 * (Math.sin(2 * Math.PI * 440 * tt) + Math.sin(2 * Math.PI * 554.4 * tt)) * Math.min(1, tt * 50, (len - tt) * 20);
      }
    }
  }
  return { x, hits };
}

describe('audio analysis', () => {
  it('finds tempo, beat phase and onsets of a drum loop', () => {
    const { x, hits } = drumLoop(128, 30);
    const a = analyze([x], SR);
    expect(a.bpm).toBe(128);
    const beat = 60 / 128;
    // Offset lands on a beat of the loop.
    const phaseErr = Math.abs(((a.offset - 0.37) / beat) - Math.round((a.offset - 0.37) / beat)) * beat;
    expect(phaseErr).toBeLessThan(0.02);
    // Nearly every kick is detected within 20 ms.
    const kicks = hits.filter((h) => h.kind === 'kick');
    const found = kicks.filter((k) => a.onsets.some((o) => Math.abs(o.t - k.t) < 0.02));
    expect(found.length / kicks.length).toBeGreaterThan(0.95);
    const errs = kicks.map((k) => Math.min(...a.onsets.map((o) => Math.abs(o.t - k.t))));
    const mean = errs.reduce((s, e) => s + e, 0) / errs.length;
    console.log('bpm', a.bpm, 'offset', a.offset, 'onsets', a.onsets.length, 'kicks', kicks.length, 'mean err ms', (mean * 1000).toFixed(1));
    expect(mean).toBeLessThan(0.012);
    // Kicks are low, hats are high.
    const at = (t: number) => a.onsets.reduce((b, o) => (Math.abs(o.t - t) < Math.abs(b.t - t) ? o : b));
    const kickLow = kicks.slice(2, 20).map((k) => at(k.t).low);
    const hatHigh = hits.filter((h) => h.kind === 'hat').slice(2, 20).map((k) => at(k.t).high);
    expect(kickLow.reduce((s, v) => s + v, 0) / kickLow.length).toBeGreaterThan(0.3);
    expect(hatHigh.reduce((s, v) => s + v, 0) / hatHigh.length).toBeGreaterThan(0.2);
    expect(a.peaks.min.length).toBeGreaterThan(2900);
  });

  it('handles several tempos', () => {
    for (const bpm of [92, 140, 174]) {
      const { x } = drumLoop(bpm, 25, 0.2);
      const t = analyze([x], SR).bpm;
      const ok = [bpm, bpm * 2, bpm / 2].some((b) => Math.abs(t - b) < 0.5);
      console.log('tempo', bpm, '->', t);
      expect(ok).toBe(true);
    }
  });

  it('measures how long melodic notes sustain, even over drums', () => {
    const { x } = drumLoop(120, 20, 0.5);
    const notes: { t: number; len: number }[] = [];
    for (let i = 0; i < 8; i++) notes.push({ t: 1.0 + i * 2, len: i % 2 ? 0.15 : 1.4 });
    for (const n of notes) {
      const i0 = Math.floor(n.t * SR);
      for (let i = 0; i < n.len * SR; i++) {
        const tt = i / SR;
        x[i0 + i] += 0.3 * (Math.sin(2 * Math.PI * 659.3 * tt) + 0.5 * Math.sin(2 * Math.PI * 1318.5 * tt)) * Math.min(1, tt * 300, (n.len - tt) * 60);
      }
    }
    const a = analyze([x], SR);
    const at = (t: number) => a.onsets.reduce((b, o) => (Math.abs(o.t - t) < Math.abs(b.t - t) ? o : b));
    const long = notes.filter((n) => n.len > 1).map((n) => at(n.t).dur);
    const short = notes.filter((n) => n.len < 1).map((n) => at(n.t).dur);
    console.log('long', long, 'short', short);
    for (const d of long) expect(d).toBeGreaterThan(0.9);
    for (const d of short) expect(d).toBeLessThan(0.45);
  });

  it('estimateTempo copes with a short signal', () => {
    expect(estimateTempo(new Float32Array(10)).bpm).toBe(120);
  });
});

describe('time stretch', () => {
  it('changes duration but keeps pitch', () => {
    const n = SR * 2;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = Math.sin((2 * Math.PI * 440 * i) / SR) * 0.5;
    for (const rate of [0.75, 1.5]) {
      const [y] = timeStretch([x], rate, SR);
      expect(Math.abs(y.length - n / rate)).toBeLessThan(2);
      // Count zero crossings in the middle: same frequency as the input.
      let zc = 0;
      const a = Math.floor(y.length * 0.25);
      const b = Math.floor(y.length * 0.75);
      for (let i = a + 1; i < b; i++) if (y[i - 1] < 0 && y[i] >= 0) zc++;
      const freq = zc / ((b - a) / SR);
      expect(Math.abs(freq - 440)).toBeLessThan(6);
    }
  });
});
