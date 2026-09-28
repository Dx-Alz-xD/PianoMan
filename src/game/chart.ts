// Converts any score into a 4-key rhythm-game chart.
//
// 1. Notes are grouped into onsets (chords) from the chosen hands.
// 2. Onsets are ranked by musical importance (downbeats, beats, accents,
//    chord size, long notes) and picked strongest-first while keeping a
//    minimum gap for the difficulty, so dense passages thin out on beats
//    instead of randomly.
// 3. Lanes follow the melody's contour: higher pitch = further right,
//    rising melodies move right, falling ones left, repeated pitches stay
//    in place (unless that would make an unplayably fast jack).
// 4. Big chords on strong beats become jumps/hands on harder levels, and
//    long notes become holds.
// Every chart note keeps the piano notes it stands for; those sound when you
// hit it. Everything else is accompaniment and plays automatically.

import type { Score, ScoreNote } from '../score/model';

export type Difficulty = 'easy' | 'normal' | 'hard' | 'expert';
export type ChartSource = 'melody' | 'both';

export interface ChartNote {
  id: number;
  time: number;
  lane: number;
  end: number | null;
  sources: ScoreNote[];
}

export interface Chart {
  notes: ChartNote[];
  bound: Set<ScoreNote>;
  difficulty: Difficulty;
  source: ChartSource;
  duration: number;
  stats: { notes: number; holds: number; chords: number; nps: number; peakNps: number };
}

export interface ChartOptions {
  difficulty: Difficulty;
  source: ChartSource;
  holds: boolean;
}

interface Profile {
  /** Minimum time between two chart onsets. */
  minGap: number;
  /** Minimum time between two notes in the same lane. */
  jackGap: number;
  /** Minimum length for a hold note. */
  holdMin: number;
  /** Maximum lanes pressed together. */
  maxChord: number;
  /** Chord size needed for a jump, and the beat strength it must fall on. */
  chordSize: number;
  chordWeight: number;
}

export const PROFILES: Record<Difficulty, Profile> = {
  easy: { minGap: 0.42, jackGap: 0.7, holdMin: 0.9, maxChord: 1, chordSize: 99, chordWeight: 9 },
  normal: { minGap: 0.24, jackGap: 0.4, holdMin: 0.6, maxChord: 2, chordSize: 3, chordWeight: 4 },
  hard: { minGap: 0.14, jackGap: 0.24, holdMin: 0.45, maxChord: 2, chordSize: 2, chordWeight: 3 },
  expert: { minGap: 0.085, jackGap: 0.15, holdMin: 0.35, maxChord: 3, chordSize: 2, chordWeight: 2 },
};

interface Group {
  time: number;
  notes: ScoreNote[];
  top: number;
  maxDur: number;
  weight: number;
  strength: number;
}

const CHORD_WINDOW = 0.03;

function beatWeight(score: Score, beat: number): number {
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
  return 1;
}

function groupNotes(score: Score, notes: ScoreNote[]): Group[] {
  const groups: Group[] = [];
  for (const n of notes) {
    const g = groups[groups.length - 1];
    if (g && n.time - g.time < CHORD_WINDOW) {
      g.notes.push(n);
      g.top = Math.max(g.top, n.midi);
      g.maxDur = Math.max(g.maxDur, n.duration);
    } else {
      groups.push({ time: n.time, notes: [n], top: n.midi, maxDur: n.duration, weight: 1, strength: 0 });
    }
  }
  let prevTop = -1;
  for (const g of groups) {
    g.weight = beatWeight(score, g.notes[0].beat);
    const vel = Math.max(...g.notes.map((n) => n.velocity));
    g.strength = g.weight + Math.min(2, (g.notes.length - 1) * 0.5) + vel * 1.5 + (g.maxDur > 0.5 ? 0.5 : 0) + (g.top !== prevTop ? 0.3 : 0);
    prevTop = g.top;
  }
  return groups;
}

/** Picks the strongest onsets that keep at least `minGap` between each other. */
function selectOnsets(groups: Group[], minGap: number): Group[] {
  const order = [...groups].sort((a, b) => b.strength - a.strength || a.time - b.time);
  const taken: number[] = [];
  const chosen = new Set<Group>();
  for (const g of order) {
    let lo = 0;
    let hi = taken.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (taken[mid] < g.time) lo = mid + 1;
      else hi = mid;
    }
    const prev = taken[lo - 1];
    const next = taken[lo];
    if ((prev !== undefined && g.time - prev < minGap) || (next !== undefined && next - g.time < minGap)) continue;
    taken.splice(lo, 0, g.time);
    chosen.add(g);
  }
  return groups.filter((g) => chosen.has(g));
}

export function generateChart(score: Score, opts: ChartOptions): Chart {
  const p = PROFILES[opts.difficulty];
  const right = score.notes.filter((n) => n.hand === 'R');
  const pool = opts.source === 'melody' && right.length >= Math.min(8, score.notes.length) ? right : score.notes;
  const groups = selectOnsets(groupNotes(score, pool), p.minGap);

  // Local pitch range (±2.5 s) for mapping pitch to lanes.
  const ranges: { lo: number; hi: number }[] = [];
  {
    let a = 0;
    let b = 0;
    for (let i = 0; i < groups.length; i++) {
      while (groups[a].time < groups[i].time - 2.5) a++;
      while (b + 1 < groups.length && groups[b + 1].time <= groups[i].time + 2.5) b++;
      let lo = Infinity;
      let hi = -Infinity;
      for (let k = a; k <= b; k++) {
        lo = Math.min(lo, groups[k].top);
        hi = Math.max(hi, groups[k].top);
      }
      ranges.push({ lo, hi });
    }
  }

  const notes: ChartNote[] = [];
  const laneLast = [-Infinity, -Infinity, -Infinity, -Infinity];
  const laneBusyUntil = [-Infinity, -Infinity, -Infinity, -Infinity];
  let prevLane = 1;
  let prevPitch = -1;
  let id = 0;
  const free = (lane: number, t: number) => t - laneLast[lane] >= p.jackGap && t >= laneBusyUntil[lane] + 0.06;

  groups.forEach((g, gi) => {
    const { lo, hi } = ranges[gi];
    let lane = hi - lo >= 5 ? Math.round(((g.top - lo) / (hi - lo)) * 3) : prevLane;
    if (prevPitch >= 0) {
      if (g.top > prevPitch && lane <= prevLane) lane = Math.min(3, prevLane + 1);
      else if (g.top < prevPitch && lane >= prevLane) lane = Math.max(0, prevLane - 1);
      else if (g.top === prevPitch) lane = prevLane;
    }
    if (!free(lane, g.time)) {
      // Too soon for this lane (fast repeat or a hold in the way): nearest free lane,
      // preferring the direction the melody is moving.
      const dir = g.top >= prevPitch ? 1 : -1;
      const candidates = [lane + dir, lane - dir, lane + 2 * dir, lane - 2 * dir, lane + 3 * dir, lane - 3 * dir].filter((l) => l >= 0 && l <= 3);
      const alt = candidates.find((l) => free(l, g.time));
      if (alt === undefined) return; // no playable lane: leave it to the autoplayer
      lane = alt;
    }

    // Jumps / hands for big chords on strong beats.
    const lanes = [lane];
    const want = g.notes.length >= p.chordSize && g.weight >= p.chordWeight ? Math.min(p.maxChord, g.notes.length, g.notes.length >= 4 ? 3 : 2) : 1;
    if (want > 1) {
      const others = [0, 1, 2, 3].filter((l) => l !== lane && free(l, g.time)).sort((a, b) => Math.abs(b - lane) - Math.abs(a - lane));
      lanes.push(...others.slice(0, want - 1));
    }
    lanes.sort((a, b) => a - b);

    // Split the chord between the lanes: lowest notes to the leftmost lane.
    const sorted = [...g.notes].sort((a, b) => a.midi - b.midi);
    const per = Math.ceil(sorted.length / lanes.length);
    lanes.forEach((l, k) => {
      const sources = lanes.length === 1 ? sorted : sorted.slice(k * per, k === lanes.length - 1 ? undefined : (k + 1) * per);
      if (!sources.length) return;
      const dur = Math.max(...sources.map((n) => n.duration));
      const end = opts.holds && dur >= p.holdMin ? g.time + dur : null;
      notes.push({ id: id++, time: g.time, lane: l, end, sources });
      laneLast[l] = g.time;
      laneBusyUntil[l] = end ?? g.time;
    });
    prevLane = lane;
    prevPitch = g.top;
  });

  // Holds must end before the next note in their lane.
  const byLane: ChartNote[][] = [[], [], [], []];
  for (const n of notes) byLane[n.lane].push(n);
  for (const lane of byLane) {
    for (let i = 0; i < lane.length; i++) {
      const n = lane[i];
      const next = lane[i + 1];
      if (n.end !== null && next && n.end > next.time - 0.12) n.end = next.time - 0.12;
      if (n.end !== null && n.end - n.time < p.holdMin) n.end = null;
    }
  }

  notes.sort((a, b) => a.time - b.time || a.lane - b.lane);
  const bound = new Set<ScoreNote>();
  for (const n of notes) for (const s of n.sources) bound.add(s);

  const onsets = [...new Set(notes.map((n) => n.time))];
  const span = notes.length > 1 ? notes[notes.length - 1].time - notes[0].time : 1;
  let peak = 0;
  for (let i = 0, j = 0; i < notes.length; i++) {
    while (notes[i].time - notes[j].time > 1) j++;
    peak = Math.max(peak, i - j + 1);
  }
  return {
    notes,
    bound,
    difficulty: opts.difficulty,
    source: opts.source,
    duration: score.duration,
    stats: {
      notes: notes.length,
      holds: notes.filter((n) => n.end !== null).length,
      chords: onsets.length ? notes.length - onsets.length : 0,
      nps: span > 0 ? notes.length / span : notes.length,
      peakNps: peak,
    },
  };
}
