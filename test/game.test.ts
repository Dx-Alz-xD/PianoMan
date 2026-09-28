import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bindToScore, estimateLevel, eventsFromAnalysis, eventsFromScore, generate, mapStats, presetOptions, timingFromScore } from '../src/beats/mapgen';
import type { GeneratorOptions, MapNote, Preset } from '../src/beats/types';
import { judge, osuWindows, scaledWindows, ScoreKeeper, gradeFor } from '../src/game/judge';
import { GameSession } from '../src/game/session';
import { finalizeScore, type Score, type ScoreNote } from '../src/score/model';
import { loadScore } from '../src/score/loader';
import { analyze } from '../src/beats/audio/dsp';

const PRESETS: Preset[] = ['easy', 'normal', 'hard', 'insane', 'expert'];

function checkPlayable(notes: MapNote[], o: GeneratorOptions) {
  const perOnset = new Map<number, number>();
  for (const n of notes) perOnset.set(n.t, (perOnset.get(n.t) || 0) + 1);
  for (const c of perOnset.values()) expect(c).toBeLessThanOrEqual(Math.max(1, o.maxChord));
  for (let lane = 0; lane < 4; lane++) {
    const ln = notes.filter((n) => n.l === lane);
    for (let i = 1; i < ln.length; i++) {
      const prev = ln[i - 1];
      expect(ln[i].t - prev.t).toBeGreaterThanOrEqual(o.jackGap - 1e-6);
      if (prev.e !== undefined) expect(ln[i].t).toBeGreaterThan(prev.e);
    }
  }
  for (const n of notes) {
    expect(n.l).toBeGreaterThanOrEqual(0);
    expect(n.l).toBeLessThanOrEqual(3);
    if (n.e !== undefined) expect(n.e).toBeGreaterThan(n.t);
  }
  for (let i = 1; i < notes.length; i++) expect(notes[i].t).toBeGreaterThanOrEqual(notes[i - 1].t);
}

const demo = (f: string) => loadScore(new Uint8Array(readFileSync(`public/demos/${f}`)), { fileName: f });
const scoreMap = (score: Score, o: GeneratorOptions) => generate({ events: eventsFromScore(score, o.hands, timingFromScore(score)), timing: timingFromScore(score), duration: score.duration }, o);

describe('4K map generator – scores', () => {
  for (const f of readdirSync('public/demos').filter((x) => x.endsWith('.musicxml'))) {
    it(`maps ${f} playably on every preset and binds each piano note once`, () => {
      const score = demo(f);
      const counts = PRESETS.map((p) => {
        const o = presetOptions(p);
        const notes = scoreMap(score, o);
        checkPlayable(notes, o);
        const { notes: bound, bound: set } = bindToScore(notes, score, o.hands);
        const seen = new Set<ScoreNote>();
        for (const n of bound) {
          expect(n.sources.length).toBeGreaterThan(0);
          for (const s of n.sources) {
            expect(seen.has(s)).toBe(false);
            seen.add(s);
          }
        }
        expect(seen.size).toBe(set.size);
        return notes.length;
      });
      expect(counts[0]).toBeGreaterThan(0);
      // Harder presets don't get sparser (jump patterns can drop a note or two that has no free lane).
      for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeGreaterThanOrEqual(Math.floor(counts[i - 1] * 0.95));
      const levels = PRESETS.map((p) => estimateLevel(scoreMap(score, presetOptions(p))));
      expect(levels[4]).toBeGreaterThan(levels[0]);
    });
  }

  it('follows the melody contour', () => {
    const scale = [60, 62, 64, 65, 67, 69, 71, 72, 71, 69, 67, 65, 64, 62, 60];
    const notes = scale.map((m, i) => ({ midi: m, beat: i, beats: 0.9, time: 0, duration: 0, velocity: 0.7, hand: 'R' as const, track: 0 }));
    const score = finalizeScore({ title: 's', format: 'musicxml', notes, tempos: [{ beat: 0, bpm: 90 }], timing: 'beats' });
    const o = presetOptions('normal', { hands: 'melody', holds: 0, followPitch: 1, dynamics: false, density: 2 });
    const lanes = scoreMap(score, o).map((n) => n.l);
    expect(lanes.length).toBe(scale.length);
    const up = lanes.slice(0, 8);
    const down = lanes.slice(7);
    for (let i = 1; i < up.length; i++) expect(up[i]).toBeGreaterThanOrEqual(up[i - 1]);
    for (let i = 1; i < down.length; i++) expect(down[i]).toBeLessThanOrEqual(down[i - 1]);
    expect(Math.max(...lanes)).toBe(3);
  });

  it('keeps easy maps sparse on fast passages', () => {
    const notes = Array.from({ length: 64 }, (_, i) => ({ midi: 60 + ((i * 5) % 12), beat: i * 0.25, beats: 0.25, time: 0, duration: 0, velocity: 0.6, hand: 'R' as const, track: 0 }));
    const score = finalizeScore({ title: 'f', format: 'musicxml', notes, tempos: [{ beat: 0, bpm: 160 }], timing: 'beats' });
    const easy = scoreMap(score, presetOptions('easy'));
    const expert = scoreMap(score, presetOptions('expert'));
    checkPlayable(easy, presetOptions('easy'));
    checkPlayable(expert, presetOptions('expert'));
    expect(mapStats(easy).peakNps).toBeLessThanOrEqual(3);
    expect(expert.length).toBeGreaterThan(easy.length * 2);
  });

  it('makes holds and chords on hard, none when turned off', () => {
    const notes = [
      ...[48, 55, 60, 64].map((m) => ({ midi: m, beat: 0, beats: 2, time: 0, duration: 0, velocity: 0.9, hand: 'R' as const, track: 0 })),
      { midi: 67, beat: 2, beats: 1, time: 0, duration: 0, velocity: 0.7, hand: 'R' as const, track: 0 },
      { midi: 72, beat: 3, beats: 4, time: 0, duration: 0, velocity: 0.7, hand: 'R' as const, track: 0 },
    ];
    const score = finalizeScore({ title: 'c', format: 'musicxml', notes, tempos: [{ beat: 0, bpm: 60 }], timing: 'beats' });
    const o = presetOptions('hard', { chords: 1, holds: 1 });
    const m = scoreMap(score, o);
    checkPlayable(m, o);
    expect(m.filter((n) => n.t === 0).length).toBe(2);
    expect(m.some((n) => n.e !== undefined)).toBe(true);
    const none = scoreMap(score, presetOptions('hard', { chords: 0, holds: 0 }));
    expect(none.every((n) => n.e === undefined)).toBe(true);
    expect(new Set(none.map((n) => n.t)).size).toBe(none.length);
  });

  it('mirrors and honours a time range', () => {
    const score = demo(readdirSync('public/demos').find((x) => x.endsWith('.musicxml'))!);
    const a = scoreMap(score, presetOptions('normal', { seed: 3 }));
    const b = scoreMap(score, presetOptions('normal', { seed: 3, mirror: true }));
    expect(b.map((n) => 3 - n.l)).toEqual(a.map((n) => n.l));
    const part = scoreMap(score, presetOptions('normal', { from: 4, to: 8 }));
    expect(part.every((n) => n.t >= 4 && n.t <= 8)).toBe(true);
  });
});

describe('4K map generator – audio', () => {
  const SR = 22050;
  const bpm = 120;
  const x = new Float32Array(SR * 24);
  for (let b = 0; b < 46; b++) {
    for (const sub of [0, 0.5]) {
      const i0 = Math.floor((0.5 + (b + sub) * 0.5) * SR);
      const amp = sub ? 0.35 : 0.9;
      for (let i = 0; i < 0.25 * SR && i0 + i < x.length; i++) {
        const tt = i / SR;
        x[i0 + i] += amp * Math.sin(2 * Math.PI * (sub ? 900 : 60 + 80 * Math.exp(-tt * 30)) * tt) * Math.exp(-tt * (sub ? 40 : 14));
      }
    }
  }
  const analysis = analyze([x], SR);
  const timing = [{ t: analysis.offset, bpm: analysis.bpm, meter: 4 }];

  it('detects the grid and maps at the requested density, on the grid', () => {
    expect(Math.abs(analysis.bpm - bpm)).toBeLessThan(0.5);
    for (const p of PRESETS) {
      const o = presetOptions(p);
      const notes = generate({ events: eventsFromAnalysis(analysis, o.focus, timing), timing, duration: analysis.duration, energy: analysis.energy }, o);
      checkPlayable(notes, o);
      const stats = mapStats(notes);
      const onsets = new Set(notes.map((n) => n.t)).size;
      expect(onsets).toBeGreaterThan(8);
      // Never denser than the requested density (onsets, not counting chord notes) by much.
      expect(onsets / (analysis.duration - 1)).toBeLessThan(o.density * 1.3 + 0.5);
      // Snapped to eighths of the detected beat.
      const grid = 60 / analysis.bpm / 2;
      const off = notes.filter((n) => Math.abs(((n.t - analysis.offset) / grid) - Math.round((n.t - analysis.offset) / grid)) * grid > 0.006).length;
      expect(off / notes.length).toBeLessThan(0.05);
      void stats;
    }
  });
});

describe('judgements & scoring', () => {
  it('maps timing errors to judgements', () => {
    expect(judge(0.01)).toBe('perfect');
    expect(judge(-0.04)).toBe('excellent');
    expect(judge(0.08)).toBe('good');
    expect(judge(-0.12)).toBe('bad');
    expect(judge(0.2)).toBeNull();
    expect(judge(0.03, scaledWindows(1.4))).toBe('perfect');
    expect(judge(0.03, scaledWindows(0.7))).toBe('excellent');
    expect(osuWindows(10).excellent).toBeCloseTo(0.034);
    expect(judge(0.1, osuWindows(8))).toBe('bad');
  });

  it('tracks score, combo, accuracy, grade and unstable rate', () => {
    const k = new ScoreKeeper();
    for (let i = 0; i < 10; i++) k.apply('perfect', i % 2 ? 0.01 : -0.01, i);
    expect(k.accuracy).toBe(1);
    expect(k.combo).toBe(10);
    expect(k.grade).toBe('SS');
    expect(k.unstableRate).toBeCloseTo(100, 0);
    k.apply('miss');
    expect(k.combo).toBe(0);
    expect(k.maxCombo).toBe(10);
    expect(k.fullCombo).toBe(false);
    expect(k.accuracy).toBeCloseTo(10 / 11);
    expect(gradeFor(0.96, { perfect: 5, excellent: 5, good: 0, bad: 0, miss: 0 })).toBe('S');
    expect(gradeFor(0.5, { perfect: 1, excellent: 0, good: 0, bad: 0, miss: 1 })).toBe('D');
    const before = k.health;
    k.apply('miss');
    expect(k.health).toBeLessThan(before);
  });
});

describe('game session', () => {
  const notes = (list: { time: number; lane: number; end?: number }[]) => list.map((n, i) => ({ id: i, time: n.time, lane: n.lane, end: n.end ?? null }));

  it('judges presses, ignores ghost taps and misses late notes', () => {
    const s = new GameSession(notes([{ time: 1, lane: 0 }, { time: 2, lane: 1 }, { time: 3, lane: 2 }]));
    expect(s.press(0, 0.5)).toBeNull();
    expect(s.press(0, 1.01)!.judgement).toBe('perfect');
    expect(s.press(1, 2.07)!.judgement).toBe('good');
    expect(s.update(3.2).map((e) => e.judgement)).toEqual(['miss']);
    expect(s.finished).toBe(true);
    expect(s.keeper.counts).toMatchObject({ perfect: 1, good: 1, miss: 1 });
  });

  it('handles hold notes and the no-holds mod', () => {
    const s = new GameSession(notes([{ time: 1, lane: 0, end: 2 }, { time: 1, lane: 3, end: 3 }]));
    s.press(0, 1);
    s.press(3, 1);
    expect(s.release(0, 1.5)!.judgement).toBe('miss');
    expect(s.update(3.01).map((e) => [e.kind, e.judgement])).toEqual([['tail', 'perfect']]);
    expect(s.finished).toBe(true);
    expect(s.keeper.counts.miss).toBe(1);
    const n = new GameSession(notes([{ time: 1, lane: 0, end: 2 }]), { noHolds: true });
    n.press(0, 1);
    n.update(1.5);
    expect(n.finished).toBe(true);
  });

  it('uses real-time windows at other speeds and custom windows', () => {
    const s = new GameSession(notes([{ time: 1, lane: 0 }]), 0.5);
    expect(s.press(0, 1.04)!.judgement).toBe('good');
    const strict = new GameSession(notes([{ time: 1, lane: 0 }]), { windows: scaledWindows(0.5) });
    expect(strict.press(0, 1.02)!.judgement).toBe('excellent');
  });

  it('skips notes before a practice start point', () => {
    const s = new GameSession(notes([{ time: 1, lane: 0 }, { time: 5, lane: 0 }]));
    s.skipBefore(4);
    expect(s.update(4.5)).toEqual([]);
    expect(s.press(0, 5)!.judgement).toBe('perfect');
    expect(s.keeper.total).toBe(1);
  });
});
