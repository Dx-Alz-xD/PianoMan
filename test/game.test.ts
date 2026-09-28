import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { generateChart, PROFILES, type Chart, type Difficulty } from '../src/game/chart';
import { judge, ScoreKeeper, gradeFor } from '../src/game/judge';
import { finalizeScore, type ScoreNote } from '../src/score/model';
import { loadScore } from '../src/score/loader';

const DIFFS: Difficulty[] = ['easy', 'normal', 'hard', 'expert'];

function checkPlayable(chart: Chart) {
  const p = PROFILES[chart.difficulty];
  const onsets = [...new Set(chart.notes.map((n) => n.time))].sort((a, b) => a - b);
  for (let i = 1; i < onsets.length; i++) expect(onsets[i] - onsets[i - 1]).toBeGreaterThanOrEqual(p.minGap - 1e-6);
  const perOnset = new Map<number, number>();
  for (const n of chart.notes) perOnset.set(n.time, (perOnset.get(n.time) || 0) + 1);
  for (const c of perOnset.values()) expect(c).toBeLessThanOrEqual(p.maxChord);
  for (let lane = 0; lane < 4; lane++) {
    const ln = chart.notes.filter((n) => n.lane === lane);
    for (let i = 1; i < ln.length; i++) {
      const prev = ln[i - 1];
      expect(ln[i].time - prev.time).toBeGreaterThanOrEqual(p.jackGap - 1e-6);
      if (prev.end !== null) expect(ln[i].time).toBeGreaterThan(prev.end);
    }
  }
  for (const n of chart.notes) {
    expect(n.lane).toBeGreaterThanOrEqual(0);
    expect(n.lane).toBeLessThanOrEqual(3);
    expect(n.sources.length).toBeGreaterThan(0);
    if (n.end !== null) expect(n.end - n.time).toBeGreaterThanOrEqual(p.holdMin - 1e-6);
  }
  // Each piano note belongs to at most one chart note.
  const seen = new Set<ScoreNote>();
  for (const n of chart.notes) for (const s of n.sources) {
    expect(seen.has(s)).toBe(false);
    seen.add(s);
  }
  expect(seen.size).toBe(chart.bound.size);
}

const demo = (f: string) => loadScore(new Uint8Array(readFileSync(`public/demos/${f}`)), { fileName: f });

describe('4K chart generator', () => {
  for (const f of readdirSync('public/demos').filter((x) => x.endsWith('.musicxml'))) {
    it(`maps ${f} playably on every difficulty`, () => {
      const score = demo(f);
      const counts = DIFFS.map((d) => {
        const chart = generateChart(score, { difficulty: d, source: 'both', holds: true });
        checkPlayable(chart);
        return chart.notes.length;
      });
      expect(counts[0]).toBeGreaterThan(0);
      // Harder difficulties never have fewer notes.
      for (let i = 1; i < counts.length; i++) expect(counts[i]).toBeGreaterThanOrEqual(counts[i - 1]);
    });
  }

  it('follows the melody contour', () => {
    const scale = [60, 62, 64, 65, 67, 69, 71, 72, 71, 69, 67, 65, 64, 62, 60];
    const notes = scale.map((m, i) => ({ midi: m, beat: i, beats: 0.9, time: 0, duration: 0, velocity: 0.7, hand: 'R' as const, track: 0 }));
    const score = finalizeScore({ title: 's', format: 'musicxml', notes, tempos: [{ beat: 0, bpm: 90 }], timing: 'beats' });
    const chart = generateChart(score, { difficulty: 'normal', source: 'melody', holds: false });
    const lanes = chart.notes.map((n) => n.lane);
    const up = lanes.slice(0, 8);
    const down = lanes.slice(7);
    for (let i = 1; i < up.length; i++) expect(up[i]).toBeGreaterThanOrEqual(up[i - 1]);
    for (let i = 1; i < down.length; i++) expect(down[i]).toBeLessThanOrEqual(down[i - 1]);
    expect(up[0]).toBe(0);
    expect(Math.max(...lanes)).toBe(3);
  });

  it('keeps only playable density for fast passages', () => {
    // 16th notes at 160 bpm (~10.7 notes per second).
    const notes = Array.from({ length: 64 }, (_, i) => ({ midi: 60 + ((i * 5) % 12), beat: i * 0.25, beats: 0.25, time: 0, duration: 0, velocity: 0.6, hand: 'R' as const, track: 0 }));
    const score = finalizeScore({ title: 'f', format: 'musicxml', notes, tempos: [{ beat: 0, bpm: 160 }], timing: 'beats' });
    const easy = generateChart(score, { difficulty: 'easy', source: 'melody', holds: true });
    const expert = generateChart(score, { difficulty: 'expert', source: 'melody', holds: true });
    checkPlayable(easy);
    checkPlayable(expert);
    expect(easy.stats.peakNps).toBeLessThanOrEqual(3);
    expect(expert.notes.length).toBeGreaterThan(easy.notes.length * 2);
  });

  it('turns long notes into holds and big chords into jumps on hard', () => {
    const notes = [
      ...[48, 55, 60, 64].map((m) => ({ midi: m, beat: 0, beats: 2, time: 0, duration: 0, velocity: 0.8, hand: 'R' as const, track: 0 })),
      { midi: 67, beat: 2, beats: 1, time: 0, duration: 0, velocity: 0.7, hand: 'R' as const, track: 0 },
      { midi: 72, beat: 3, beats: 4, time: 0, duration: 0, velocity: 0.7, hand: 'R' as const, track: 0 },
    ];
    const score = finalizeScore({ title: 'c', format: 'musicxml', notes, tempos: [{ beat: 0, bpm: 60 }], timing: 'beats' });
    const chart = generateChart(score, { difficulty: 'hard', source: 'both', holds: true });
    checkPlayable(chart);
    expect(chart.notes.filter((n) => n.time === 0).length).toBe(2);
    expect(chart.notes.some((n) => n.end !== null)).toBe(true);
  });
});

describe('judgements & scoring', () => {
  it('maps timing errors to judgements', () => {
    expect(judge(0.01)).toBe('perfect');
    expect(judge(-0.04)).toBe('excellent');
    expect(judge(0.08)).toBe('good');
    expect(judge(-0.12)).toBe('bad');
    expect(judge(0.2)).toBeNull();
  });

  it('tracks score, combo, accuracy and grade', () => {
    const k = new ScoreKeeper();
    for (let i = 0; i < 10; i++) k.apply('perfect');
    expect(k.accuracy).toBe(1);
    expect(k.combo).toBe(10);
    expect(k.grade).toBe('SS');
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

describe('game session', async () => {
  const { GameSession } = await import('../src/game/session');
  const chart = (notes: { time: number; lane: number; end?: number }[]): Chart => ({
    notes: notes.map((n, i) => ({ id: i, time: n.time, lane: n.lane, end: n.end ?? null, sources: [] })),
    bound: new Set(),
    difficulty: 'normal',
    source: 'both',
    duration: 10,
    stats: { notes: notes.length, holds: 0, chords: 0, nps: 1, peakNps: 1 },
  });

  it('judges presses, ignores ghost taps and misses late notes', () => {
    const s = new GameSession(chart([{ time: 1, lane: 0 }, { time: 2, lane: 1 }, { time: 3, lane: 2 }]));
    expect(s.press(0, 0.5)).toBeNull(); // far too early: ghost
    expect(s.press(0, 1.01)!.judgement).toBe('perfect');
    expect(s.press(1, 2.07)!.judgement).toBe('good');
    expect(s.update(3.2).map((e) => e.judgement)).toEqual(['miss']);
    expect(s.finished).toBe(true);
    expect(s.keeper.counts).toMatchObject({ perfect: 1, good: 1, miss: 1 });
  });

  it('handles hold notes', () => {
    const s = new GameSession(chart([{ time: 1, lane: 0, end: 2 }, { time: 1, lane: 3, end: 3 }]));
    s.press(0, 1);
    s.press(3, 1);
    expect(s.release(0, 1.5)!.judgement).toBe('miss'); // let go too early
    expect(s.update(3.01).map((e) => [e.kind, e.judgement])).toEqual([['tail', 'perfect']]);
    expect(s.finished).toBe(true);
    expect(s.keeper.counts.miss).toBe(1);
  });

  it('uses real-time windows at other speeds', () => {
    const s = new GameSession(chart([{ time: 1, lane: 0 }]), 0.5);
    // 40 ms of song time at half speed is 80 ms of real time → good.
    expect(s.press(0, 1.04)!.judgement).toBe('good');
  });
});
