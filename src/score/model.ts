// The common score model every format is converted into. Times are in
// seconds at the written tempo; `beat` is the position in quarter notes on the
// fully expanded (repeats unrolled) timeline.

import { uid } from '../core/music';

export type Hand = 'L' | 'R';
export type ScoreFormat = 'musicxml' | 'mxl' | 'midi' | 'abc' | 'recording';

export interface ScoreNote {
  midi: number;
  time: number;
  duration: number;
  beat: number;
  beats?: number;
  velocity: number;
  hand: Hand;
  track: number;
  staff?: number;
  /** Where the note is written: source measure index and offset in quarters (for the sheet cursor). */
  src?: { m: number; o: number };
  grace?: boolean;
}

export interface PedalEvent {
  time: number;
  beat: number;
  value: number;
  kind: 'sustain' | 'soft' | 'sostenuto';
}

export interface TempoPoint {
  beat: number;
  time: number;
  bpm: number;
}

export interface TimeSigPoint {
  beat: number;
  num: number;
  den: number;
}

export interface Measure {
  /** Source (written) measure index. */
  src: number;
  beat: number;
  time: number;
  num: number;
  den: number;
  length: number;
}

export interface Score {
  id: string;
  title: string;
  composer?: string;
  source?: string;
  sourceUrl?: string;
  fileName?: string;
  format: ScoreFormat;
  notes: ScoreNote[];
  pedals: PedalEvent[];
  tempos: TempoPoint[];
  timeSignatures: TimeSigPoint[];
  measures: Measure[];
  duration: number;
  /** MusicXML used by the sheet-music view (original, or generated from MIDI/ABC). */
  musicXml?: string;
  generatedNotation?: boolean;
  keyFifths?: number;
  parts: { name: string; notes: number }[];
  /** For files containing several tunes (ABC). */
  tunes?: string[];
  tuneIndex?: number;
  /** Original ABC text, so another tune from the same file can be selected. */
  abcText?: string;
  warnings: string[];
}

export class TempoMap {
  readonly points: TempoPoint[];

  constructor(points: { beat: number; bpm: number }[]) {
    const sorted = [...points].filter((p) => p.bpm > 0 && isFinite(p.bpm)).sort((a, b) => a.beat - b.beat);
    if (!sorted.length || sorted[0].beat > 0) sorted.unshift({ beat: 0, bpm: sorted[0]?.bpm || 120 });
    const out: TempoPoint[] = [];
    for (const p of sorted) {
      const prev = out[out.length - 1];
      if (prev && Math.abs(prev.beat - p.beat) < 1e-9) {
        prev.bpm = p.bpm;
        continue;
      }
      const time = prev ? prev.time + ((p.beat - prev.beat) * 60) / prev.bpm : 0;
      out.push({ beat: p.beat, bpm: p.bpm, time });
    }
    this.points = out;
  }

  private at(beat: number): TempoPoint {
    const pts = this.points;
    let lo = 0;
    let hi = pts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (pts[mid].beat <= beat) lo = mid;
      else hi = mid - 1;
    }
    return pts[lo];
  }

  beatToTime(beat: number): number {
    const p = this.at(beat);
    return p.time + ((beat - p.beat) * 60) / p.bpm;
  }

  timeToBeat(time: number): number {
    const pts = this.points;
    let lo = 0;
    let hi = pts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (pts[mid].time <= time) lo = mid;
      else hi = mid - 1;
    }
    const p = pts[lo];
    return p.beat + ((time - p.time) * p.bpm) / 60;
  }

  bpmAt(beat: number) {
    return this.at(beat).bpm;
  }
}

export interface ScoreDraft {
  title: string;
  composer?: string;
  format: ScoreFormat;
  notes: ScoreNote[];
  pedals?: PedalEvent[];
  tempos: { beat: number; bpm: number }[];
  timeSignatures?: TimeSigPoint[];
  measures?: Omit<Measure, 'time'>[];
  /** 'beats': times are derived from beats; 'seconds': beats derived from times. */
  timing?: 'beats' | 'seconds';
  musicXml?: string;
  generatedNotation?: boolean;
  keyFifths?: number;
  parts?: { name: string; notes: number }[];
  warnings?: string[];
  fileName?: string;
}

/** Sorts, fills in derived timing and computes measures/duration. */
export function finalizeScore(d: ScoreDraft): Score {
  const map = new TempoMap(d.tempos);
  const timing = d.timing || 'seconds';
  const notes = d.notes.filter((n) => n.midi >= 0 && n.midi <= 127);
  for (const n of notes) {
    if (timing === 'beats') {
      const beats = n.beats ?? 0;
      n.time = map.beatToTime(n.beat);
      n.duration = Math.max(0.02, map.beatToTime(n.beat + beats) - n.time);
    } else {
      n.beat = map.timeToBeat(n.time);
      n.beats = map.timeToBeat(n.time + n.duration) - n.beat;
    }
    n.velocity = Math.max(0.02, Math.min(1, n.velocity));
  }
  notes.sort((a, b) => a.time - b.time || a.midi - b.midi);
  const pedals = (d.pedals || []).map((p) => (timing === 'beats' ? { ...p, time: map.beatToTime(p.beat) } : { ...p, beat: map.timeToBeat(p.time) }));
  pedals.sort((a, b) => a.time - b.time);

  const lastBeat = notes.reduce((m, n) => Math.max(m, n.beat + (n.beats || 0)), 0);
  const sigs = (d.timeSignatures && d.timeSignatures.length ? d.timeSignatures : [{ beat: 0, num: 4, den: 4 }]).slice().sort((a, b) => a.beat - b.beat);
  let measures: Measure[];
  if (d.measures && d.measures.length) {
    measures = d.measures.map((m) => ({ ...m, time: map.beatToTime(m.beat) }));
  } else {
    measures = [];
    let beat = 0;
    let si = 0;
    let idx = 0;
    while (beat < lastBeat - 1e-6 || idx === 0) {
      while (si + 1 < sigs.length && sigs[si + 1].beat <= beat + 1e-6) si++;
      const { num, den } = sigs[si];
      const length = (num * 4) / den;
      measures.push({ src: idx, beat, time: map.beatToTime(beat), num, den, length });
      beat += length;
      idx++;
      if (idx > 100000) break;
    }
  }
  const end = notes.reduce((m, n) => Math.max(m, n.time + n.duration), 0);
  const parts = d.parts || [];
  return {
    id: uid(),
    title: d.title || 'Untitled',
    composer: d.composer,
    format: d.format,
    fileName: d.fileName,
    notes,
    pedals,
    tempos: map.points,
    timeSignatures: sigs,
    measures,
    duration: end,
    musicXml: d.musicXml,
    generatedNotation: d.generatedNotation,
    keyFifths: d.keyFifths,
    parts,
    warnings: d.warnings || [],
  };
}

export function tempoMapOf(score: Score): TempoMap {
  return new TempoMap(score.tempos);
}
