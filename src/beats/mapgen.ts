// Turns a song into a 4K map.
//
// Both audio songs (onsets from the analysis) and piano scores (note groups)
// become a list of candidate events with a strength, a metrical weight, a
// pitch, a length and a chord size. The generator then
//  1. optionally snaps events to the beat grid,
//  2. picks the strongest events while keeping a minimum gap, where the gap
//     is searched so the map hits the requested density (and, with
//     "dynamics", quiet passages get sparser than loud ones),
//  3. assigns lanes with the chosen pattern style, following the melody's
//     contour as closely as asked, avoiding jacks that are too fast,
//  4. adds chords on strong, thick moments and holds on long notes,
//  5. checks that holds end before the next note in their lane.

import type { Score, ScoreNote } from '../score/model';
import type { Analysis, GeneratorOptions, MapNote, Preset, TimingPoint } from './types';
import { LANES } from './types';

export interface GenEvent {
  t: number;
  strength: number;
  weight: number;
  pitch: number;
  dur: number;
  size: number;
  sources?: ScoreNote[];
}

export const PRESETS: Record<Preset, Omit<GeneratorOptions, 'preset' | 'seed' | 'hands' | 'focus' | 'dynamics' | 'mirror'>> = {
  easy: { density: 1.5, snap: 2, chords: 0, maxChord: 1, holds: 0.25, holdMin: 0.8, jackGap: 0.7, pattern: 'flow', followPitch: 0.75, sensitivity: 0.45 },
  normal: { density: 2.8, snap: 2, chords: 0.15, maxChord: 2, holds: 0.3, holdMin: 0.6, jackGap: 0.42, pattern: 'flow', followPitch: 0.7, sensitivity: 0.55 },
  hard: { density: 4.6, snap: 4, chords: 0.3, maxChord: 2, holds: 0.35, holdMin: 0.5, jackGap: 0.26, pattern: 'flow', followPitch: 0.65, sensitivity: 0.62 },
  insane: { density: 6.8, snap: 4, chords: 0.42, maxChord: 3, holds: 0.35, holdMin: 0.4, jackGap: 0.18, pattern: 'flow', followPitch: 0.6, sensitivity: 0.72 },
  expert: { density: 9.5, snap: 4, chords: 0.55, maxChord: 3, holds: 0.4, holdMin: 0.35, jackGap: 0.13, pattern: 'jumps', followPitch: 0.55, sensitivity: 0.82 },
};

export const PRESET_NAMES: Record<Preset, string> = { easy: 'Easy', normal: 'Normal', hard: 'Hard', insane: 'Insane', expert: 'Expert' };

export function presetOptions(preset: Preset, extra: Partial<GeneratorOptions> = {}): GeneratorOptions {
  return { preset, seed: 1, hands: 'both', focus: 'all', dynamics: true, mirror: false, ...PRESETS[preset], ...extra };
}

// ------------------------------------------------------------ helpers ----

function rng(seed: number) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Beat position (in beats from the first timing point) of a time. */
export function beatAt(timing: TimingPoint[], t: number): number {
  if (!timing.length) return t * 2;
  let beats = 0;
  for (let i = 0; i < timing.length; i++) {
    const tp = timing[i];
    const next = timing[i + 1];
    const spb = 60 / tp.bpm;
    if (i === 0 && t < tp.t) return (t - tp.t) / spb;
    if (!next || t < next.t) return beats + (t - tp.t) / spb;
    beats += (next.t - tp.t) / spb;
  }
  return beats;
}

/** Time of a beat position (inverse of beatAt). */
export function timeAtBeat(timing: TimingPoint[], beat: number): number {
  if (!timing.length) return beat / 2;
  let beats = 0;
  for (let i = 0; i < timing.length; i++) {
    const tp = timing[i];
    const next = timing[i + 1];
    const spb = 60 / tp.bpm;
    const span = next ? (next.t - tp.t) / spb : Infinity;
    if (i === 0 && beat < 0) return tp.t + beat * spb;
    if (beat < beats + span) return tp.t + (beat - beats) * spb;
    beats += span;
  }
  return 0;
}

function timingPointAt(timing: TimingPoint[], t: number): TimingPoint | null {
  let cur: TimingPoint | null = timing[0] ?? null;
  for (const tp of timing) if (tp.t <= t + 1e-6) cur = tp;
  return cur;
}

/** 4 = downbeat, 3 = beat, 2 = half beat, 1.5 = quarter, 1 = anything else. */
export function metricWeight(timing: TimingPoint[], t: number): number {
  if (!timing.length) return 1;
  const tp = timingPointAt(timing, t)!;
  const spb = 60 / tp.bpm;
  const b = (t - tp.t) / spb;
  const near = (x: number, tol: number) => Math.abs(x - Math.round(x)) < tol;
  const tol = 0.035 / spb;
  if (near(b / (tp.meter || 4), tol / (tp.meter || 4))) return 4;
  if (near(b, tol)) return 3;
  if (near(b * 2, tol * 2)) return 2;
  if (near(b * 4, tol * 4)) return 1.5;
  return 1;
}

// ------------------------------------------------------------- events ----

export function eventsFromAnalysis(a: Analysis, focus: GeneratorOptions['focus'], timing: TimingPoint[]): GenEvent[] {
  return a.onsets.map((o) => {
    let strength = o.strength;
    let pitch = o.pitch;
    if (focus === 'drums') {
      strength = 0.6 * Math.max(o.low, o.high) + 0.4 * o.strength;
      const sum = o.low + o.mid + o.high || 1;
      pitch = (0.1 * o.low + 0.5 * o.mid + 0.95 * o.high) / sum;
    } else if (focus === 'melody') strength = 0.65 * o.mid + 0.35 * o.strength;
    else if (focus === 'bass') strength = 0.7 * o.low + 0.3 * o.strength;
    const bands = (o.low > 0.45 ? 1 : 0) + (o.mid > 0.45 ? 1 : 0) + (o.high > 0.45 ? 1 : 0);
    return { t: o.t, strength, weight: metricWeight(timing, o.t), pitch, dur: o.dur, size: Math.max(1, bands + (o.strength > 0.8 ? 1 : 0)) };
  });
}

export function eventsFromScore(score: Score, hands: 'both' | 'melody', timing: TimingPoint[]): GenEvent[] {
  const right = score.notes.filter((n) => n.hand === 'R');
  const pool = hands === 'melody' && right.length >= Math.min(8, score.notes.length) ? right : score.notes;
  const groups: GenEvent[] = [];
  let cur: GenEvent | null = null;
  for (const n of pool) {
    if (cur && n.time - cur.t < 0.03) {
      cur.sources!.push(n);
      cur.pitch = Math.max(cur.pitch, n.midi);
      cur.dur = Math.max(cur.dur, n.duration);
      cur.strength = Math.max(cur.strength, n.velocity);
    } else {
      cur = { t: n.time, strength: n.velocity, weight: 1, pitch: n.midi, dur: n.duration, size: 1, sources: [n] };
      groups.push(cur);
    }
  }
  const scoreWeight = (beat: number) => {
    const ms = score.measures;
    if (!ms.length) return 1;
    let lo = 0;
    let hi = ms.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ms[mid].beat <= beat + 1e-6) lo = mid;
      else hi = mid - 1;
    }
    const m = ms[lo];
    const rel = beat - m.beat;
    const unit = m.den === 8 && m.num % 3 === 0 ? 1.5 : 4 / m.den;
    const on = (x: number) => Math.abs(x - Math.round(x)) < 0.02;
    if (Math.abs(rel) < 0.02) return 4;
    if (on(rel / unit)) return 3;
    if (on(rel / (unit / 2))) return 2;
    if (on(rel / (unit / 4))) return 1.5;
    return 1;
  };
  let prevTop = -1;
  for (const g of groups) {
    g.size = g.sources!.length;
    g.weight = score.measures.length ? scoreWeight(g.sources![0].beat) : metricWeight(timing, g.t);
    // Normalise velocity (0–1) into a strength comparable with audio onsets; changes of pitch matter a little.
    g.strength = Math.min(1, 0.35 + 0.5 * g.strength + Math.min(0.25, (g.size - 1) * 0.08) + (g.pitch !== prevTop ? 0.05 : 0));
    prevTop = g.pitch;
  }
  return groups;
}

// ---------------------------------------------------------- quantize ----

function quantize(events: GenEvent[], timing: TimingPoint[], snap: number): GenEvent[] {
  if (!snap || !timing.length) return events;
  const out: GenEvent[] = [];
  for (const e of events) {
    const tp = timingPointAt(timing, e.t)!;
    const grid = 60 / tp.bpm / snap;
    const k = Math.round((e.t - tp.t) / grid);
    const snapped = tp.t + k * grid;
    const tol = Math.min(0.05, grid * 0.42);
    const t = Math.abs(snapped - e.t) <= tol ? snapped : e.t;
    const prev = out[out.length - 1];
    if (prev && Math.abs(prev.t - t) < 0.012) {
      // Two onsets snapped together: keep the stronger, merge the rest.
      if (e.strength > prev.strength) Object.assign(prev, { ...e, t, sources: [...(prev.sources || []), ...(e.sources || [])] });
      else if (e.sources) prev.sources = [...(prev.sources || []), ...e.sources];
      prev.size = Math.max(prev.size, e.size);
      continue;
    }
    out.push({ ...e, t, weight: metricWeight(timing, t) || e.weight });
  }
  return out;
}

// --------------------------------------------------------- selection ----

function rankScore(e: GenEvent) {
  return e.strength * 2 + e.weight * 0.45 + Math.min(3, e.size) * 0.15 + (e.dur > 0.4 ? 0.2 : 0);
}

function selectWithGap(events: GenEvent[], gapAt: (t: number) => number): GenEvent[] {
  const order = events.map((e, i) => ({ e, i, s: rankScore(e) })).sort((a, b) => b.s - a.s || a.e.t - b.e.t);
  const taken: number[] = [];
  const chosen = new Set<number>();
  for (const { e, i } of order) {
    let lo = 0;
    let hi = taken.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (taken[mid] < e.t) lo = mid + 1;
      else hi = mid;
    }
    const gap = gapAt(e.t);
    const prev = taken[lo - 1];
    const next = taken[lo];
    if ((prev !== undefined && e.t - prev < gap) || (next !== undefined && next - e.t < gap)) continue;
    taken.splice(lo, 0, e.t);
    chosen.add(i);
  }
  return events.filter((_, i) => chosen.has(i));
}

// ------------------------------------------------------------ generate ----

export interface GenerateInput {
  events: GenEvent[];
  timing: TimingPoint[];
  duration: number;
  /** Loudness per half second (audio songs), for "dynamics". */
  energy?: number[];
}

export function generate(input: GenerateInput, o: GeneratorOptions): MapNote[] {
  const random = rng(o.seed * 7919 + 17);
  const from = o.from ?? -Infinity;
  const to = o.to ?? Infinity;
  const quantized = quantize(input.events.filter((e) => e.t >= from && e.t <= to && e.strength > 0.02), input.timing, o.snap);
  if (!quantized.length) return [];
  const minStrength = 0.9 - 0.85 * o.sensitivity;
  const strongest = Math.max(...quantized.map((e) => e.strength));
  let events = quantized.filter((e) => e.strength >= Math.min(minStrength * strongest, strongest * 0.5) || e.sources);
  if (events.length < 4) events = quantized;

  // Density: binary-search the base gap so the note count matches the target.
  const first = events[0].t;
  const last = events[events.length - 1].t;
  const span = Math.max(1, last - first);
  const target = Math.max(4, Math.round(o.density * span));
  const energy = input.energy;
  const dyn = (t: number) => {
    if (!o.dynamics || !energy?.length) return 1;
    const e = energy[Math.max(0, Math.min(energy.length - 1, Math.floor(t * 2)))] ?? 0.5;
    return 1.55 - 1.1 * Math.min(1, e);
  };
  let lo = 0.03;
  let hi = 2.5;
  let chosen = events;
  for (let iter = 0; iter < 22; iter++) {
    const gap = (lo + hi) / 2;
    const pick = selectWithGap(events, (t) => gap * dyn(t));
    chosen = pick;
    if (pick.length > target) lo = gap;
    else hi = gap;
    if (Math.abs(pick.length - target) <= Math.max(1, target * 0.01)) break;
  }
  chosen = selectWithGap(events, (t) => hi * dyn(t));
  if (chosen.length < Math.min(target, events.length) * 0.9) chosen = selectWithGap(events, (t) => lo * dyn(t));

  // Local pitch range (±2.5 s) for contour mapping.
  const ranges: { lo: number; hi: number }[] = [];
  {
    let a = 0;
    let b = 0;
    for (let i = 0; i < chosen.length; i++) {
      while (chosen[a].t < chosen[i].t - 2.5) a++;
      while (b + 1 < chosen.length && chosen[b + 1].t <= chosen[i].t + 2.5) b++;
      let mn = Infinity;
      let mx = -Infinity;
      for (let k = a; k <= b; k++) {
        mn = Math.min(mn, chosen[k].pitch);
        mx = Math.max(mx, chosen[k].pitch);
      }
      ranges.push({ lo: mn, hi: mx });
    }
  }
  const pitchSpan = Math.max(...chosen.map((e) => e.pitch)) - Math.min(...chosen.map((e) => e.pitch));
  const minRange = pitchSpan > 2 ? 5 : 0.18; // semitones for scores, 0–1 brightness for audio

  const notes: MapNote[] = [];
  const laneLast = [-Infinity, -Infinity, -Infinity, -Infinity];
  const laneBusy = [-Infinity, -Infinity, -Infinity, -Infinity];
  const free = (l: number, t: number) => t - laneLast[l] >= o.jackGap && t >= laneBusy[l] + 0.06;
  let prevLane = 1;
  let prevPitch = NaN;
  let stairDir = 1;
  let trill: [number, number] = [1, 2];
  let trillIdx = 0;
  const maxHolds = Math.max(1, Math.min(2, o.maxChord));

  chosen.forEach((e, gi) => {
    const { lo: rlo, hi: rhi } = ranges[gi];
    const contour = rhi - rlo >= minRange ? Math.round(((e.pitch - rlo) / (rhi - rlo)) * (LANES - 1)) : prevLane;
    const dir = Number.isNaN(prevPitch) ? 0 : Math.sign(e.pitch - prevPitch);
    let lane: number;
    switch (o.pattern) {
      case 'stairs': {
        if (dir !== 0 && random() < o.followPitch) stairDir = dir;
        let next = prevLane + stairDir;
        if (next < 0 || next >= LANES) {
          stairDir = -stairDir;
          next = prevLane + stairDir;
        }
        lane = next;
        break;
      }
      case 'trills': {
        if (e.weight >= 3 || trillIdx >= 6) {
          const base = Math.max(0, Math.min(LANES - 2, random() < o.followPitch ? Math.min(contour, LANES - 2) : Math.floor(random() * (LANES - 1))));
          trill = [base, base + 1];
          if (random() < 0.3 && LANES === 4) trill = [0, 3];
          trillIdx = 0;
        }
        lane = trill[trillIdx++ % 2];
        break;
      }
      case 'random': {
        lane = Math.floor(random() * LANES);
        if (lane === prevLane) lane = (lane + 1 + Math.floor(random() * (LANES - 1))) % LANES;
        break;
      }
      default: {
        // flow / jumps: follow the contour, move with the melody, stay on repeats.
        lane = random() < o.followPitch ? contour : prevLane;
        if (dir > 0 && lane <= prevLane) lane = Math.min(LANES - 1, prevLane + 1);
        else if (dir < 0 && lane >= prevLane) lane = Math.max(0, prevLane - 1);
        else if (dir === 0 && !Number.isNaN(prevPitch)) lane = prevLane;
      }
    }
    if (!free(lane, e.t)) {
      const d = dir >= 0 ? 1 : -1;
      const alt = [lane + d, lane - d, lane + 2 * d, lane - 2 * d, lane + 3 * d, lane - 3 * d].filter((l) => l >= 0 && l < LANES).find((l) => free(l, e.t));
      if (alt === undefined) return; // unplayable here: leave it out
      lane = alt;
    }

    // Chords on strong, thick moments.
    const lanes = [lane];
    if (o.maxChord > 1 && e.size >= 2) {
      const chordBoost = o.pattern === 'jumps' ? 1.5 : 1;
      const p = o.chords * chordBoost * (0.35 + 0.2 * e.weight) * (0.5 + e.strength);
      if (random() < p) {
        const want = Math.min(o.maxChord, e.size, e.strength > 0.85 && e.weight >= 3 ? 3 : 2);
        const others = [0, 1, 2, 3].filter((l) => l !== lane && free(l, e.t));
        others.sort((a, b) => (o.pattern === 'jumps' ? Math.abs(b - lane) - Math.abs(a - lane) : Math.abs(a - lane) - Math.abs(b - lane)) || a - b);
        lanes.push(...others.slice(0, want - 1));
      }
    }
    lanes.sort((a, b) => a - b);

    // Holds on long notes.
    const holding = laneBusy.filter((b) => b > e.t).length;
    const holdWanted = o.holds > 0 && e.dur >= o.holdMin && random() < Math.min(1, o.holds * (0.6 + e.dur / (o.holdMin * 3)));
    for (let k = 0; k < lanes.length; k++) {
      const l = lanes[k];
      const hold = holdWanted && holding + k < maxHolds && k === (lanes.indexOf(lane) >= 0 ? lanes.indexOf(lane) : 0);
      const n: MapNote = { t: Math.round(e.t * 10000) / 10000, l };
      if (hold) n.e = Math.round((e.t + e.dur) * 10000) / 10000;
      notes.push(n);
      laneLast[l] = e.t;
      laneBusy[l] = n.e ?? e.t;
    }
    prevLane = lane;
    prevPitch = e.pitch;
  });

  return finishNotes(notes, o.holdMin, o.mirror);
}

/** Sorts notes, trims holds that run into the next note of their lane, and mirrors if asked. */
export function finishNotes(notes: MapNote[], holdMin = 0.3, mirror = false): MapNote[] {
  const out = notes.map((n) => ({ ...n, l: mirror ? LANES - 1 - n.l : n.l }));
  const byLane: MapNote[][] = [[], [], [], []];
  out.sort((a, b) => a.t - b.t || a.l - b.l);
  for (const n of out) byLane[n.l].push(n);
  for (const lane of byLane) {
    for (let i = 0; i < lane.length; i++) {
      const n = lane[i];
      const next = lane[i + 1];
      if (n.e !== undefined && next && n.e > next.t - 0.1) n.e = Math.round((next.t - 0.1) * 10000) / 10000;
      if (n.e !== undefined && n.e - n.t < Math.min(holdMin, 0.25)) delete n.e;
    }
  }
  return out;
}

// --------------------------------------------------------- statistics ----

/** Rough star rating from density, peaks, chords and jacks (0.5–12). */
export function estimateLevel(notes: MapNote[]): number {
  if (notes.length < 2) return 1;
  const span = Math.max(1, notes[notes.length - 1].t - notes[0].t);
  const nps = notes.length / span;
  let peak = 0;
  for (let i = 0, j = 0; i < notes.length; i++) {
    while (notes[i].t - notes[j].t > 2) j++;
    peak = Math.max(peak, (i - j + 1) / 2);
  }
  const times = new Set(notes.map((n) => Math.round(n.t * 100)));
  const chordRatio = 1 - times.size / notes.length;
  let jacks = 0;
  const last = [-9, -9, -9, -9];
  for (const n of notes) {
    if (n.t - last[n.l] < 0.2) jacks++;
    last[n.l] = n.t;
  }
  const level = 0.55 * nps + 0.35 * peak + 3 * chordRatio + (jacks / notes.length) * 3;
  return Math.max(0.5, Math.min(12, Math.round(level * 10) / 10));
}

export function mapStats(notes: MapNote[]) {
  const n = notes.length;
  const span = n > 1 ? notes[n - 1].t - notes[0].t : 1;
  let peak = 0;
  for (let i = 0, j = 0; i < n; i++) {
    while (notes[i].t - notes[j].t > 1) j++;
    peak = Math.max(peak, i - j + 1);
  }
  const onsets = new Set(notes.map((x) => Math.round(x.t * 1000))).size;
  return { notes: n, holds: notes.filter((x) => x.e !== undefined).length, chords: n - onsets, nps: span > 0 ? n / span : n, peakNps: peak, length: n ? (notes[n - 1].e ?? notes[n - 1].t) : 0 };
}

// ------------------------------------------------------ score binding ----

export interface BoundNote {
  id: number;
  time: number;
  lane: number;
  end: number | null;
  sources: ScoreNote[];
  samples: string[];
  volume: number;
}

/**
 * Attaches score notes to chart notes: every chart onset takes the score
 * notes that start with it (low notes to the left lanes). Unbound score
 * notes are the accompaniment.
 */
export function bindToScore(notes: MapNote[], score: Score | null, hands: 'both' | 'melody'): { notes: BoundNote[]; bound: Set<ScoreNote> } {
  const out: BoundNote[] = notes.map((n, i) => ({ id: i, time: n.t, lane: n.l, end: n.e ?? null, sources: [], samples: n.s ? n.s.split('|') : [], volume: n.v ?? 1 }));
  const bound = new Set<ScoreNote>();
  if (!score) return { notes: out, bound };
  const events = eventsFromScore(score, hands, []);
  let gi = 0;
  for (let i = 0; i < out.length; ) {
    let j = i;
    while (j < out.length && out[j].time - out[i].time < 0.005) j++;
    const t = out[i].time;
    while (gi < events.length - 1 && events[gi + 1].t <= t + 0.035) gi++;
    const cands = [events[gi - 1], events[gi], events[gi + 1]].filter((g): g is GenEvent => !!g && Math.abs(g.t - t) < 0.035);
    const g = cands.sort((a, b) => Math.abs(a.t - t) - Math.abs(b.t - t))[0];
    if (g && g.sources && !g.sources.some((s) => bound.has(s))) {
      const group = out.slice(i, j).sort((a, b) => a.lane - b.lane);
      const sorted = [...g.sources].sort((a, b) => a.midi - b.midi);
      const per = Math.ceil(sorted.length / group.length);
      group.forEach((n, k) => {
        n.sources = group.length === 1 ? sorted : sorted.slice(k * per, k === group.length - 1 ? undefined : (k + 1) * per);
        for (const s of n.sources) bound.add(s);
      });
    }
    i = j;
  }
  return { notes: out, bound };
}

/** Timing points for a score (its tempo map), for the editor grid and snapping. */
export function timingFromScore(score: Score): TimingPoint[] {
  const tempos = score.tempos.length ? score.tempos : [{ beat: 0, bpm: 120, time: 0 }];
  const out: TimingPoint[] = [];
  for (const tp of tempos) {
    const t = tp.time;
    const ts = [...score.timeSignatures].reverse().find((x) => x.beat <= tp.beat + 1e-6) ?? score.timeSignatures[0];
    const meter = ts ? Math.round((ts.num * 4) / ts.den) || 4 : 4;
    if (out.length && Math.abs(out[out.length - 1].t - t) < 1e-4) out[out.length - 1] = { t, bpm: tp.bpm, meter };
    else out.push({ t, bpm: tp.bpm, meter });
  }
  return out;
}
