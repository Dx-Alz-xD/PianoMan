// Standard MIDI File → Score.

import { Midi } from '@tonejs/midi';
import { finalizeScore, type Hand, type PedalEvent, type Score, type ScoreNote } from './model';

const MAJOR_FIFTHS: Record<string, number> = {
  C: 0, G: 1, D: 2, A: 3, E: 4, B: 5, 'F#': 6, 'C#': 7, F: -1, Bb: -2, Eb: -3, Ab: -4, Db: -5, Gb: -6, Cb: -7,
  'A#': -2, 'D#': -3, 'G#': -4,
};

function keyToFifths(key: string, scale: string): number | undefined {
  const f = MAJOR_FIFTHS[key];
  if (f === undefined) return undefined;
  return scale === 'minor' ? ((f - 3 + 7 + 14) % 14) - 7 : f;
}

const HAND_NAMES: [RegExp, Hand][] = [
  [/\b(right|rh|r\.h\.|treble|melody|upper)\b/i, 'R'],
  [/\b(left|lh|l\.h\.|bass|lower)\b/i, 'L'],
];

export function parseMidi(data: Uint8Array, fileName?: string): Score {
  const midi = new Midi(data);
  const ppq = midi.header.ppq || 480;
  const tracks = midi.tracks.filter((t) => t.notes.length && t.channel !== 9 && !t.instrument.percussion);
  if (!tracks.length) throw new Error('This MIDI file has no melodic notes.');

  // Decide how notes are split between the hands.
  const named = tracks.map((t) => HAND_NAMES.find(([re]) => re.test(t.name))?.[1]);
  const avg = tracks.map((t) => t.notes.reduce((s, n) => s + n.midi, 0) / t.notes.length);
  let handOf: (trackIdx: number, midiNote: number) => Hand;
  if (named.every((h) => h) && new Set(named).size === 2) {
    handOf = (ti) => named[ti]!;
  } else if (tracks.length === 2) {
    const right = avg[0] >= avg[1] ? 0 : 1;
    handOf = (ti) => (ti === right ? 'R' : 'L');
  } else {
    handOf = (_ti, m) => (m >= 60 ? 'R' : 'L');
  }

  const notes: ScoreNote[] = [];
  const pedals: PedalEvent[] = [];
  tracks.forEach((t, ti) => {
    for (const n of t.notes) {
      notes.push({
        midi: n.midi,
        beat: n.ticks / ppq,
        beats: n.durationTicks / ppq,
        time: n.time,
        duration: n.duration,
        velocity: n.velocity,
        hand: handOf(ti, n.midi),
        track: ti,
      });
    }
    const ccs = t.controlChanges as Record<number, { ticks: number; time: number; value: number }[]>;
    for (const [num, kind] of [[64, 'sustain'], [66, 'sostenuto'], [67, 'soft']] as const) {
      for (const cc of ccs[num] || []) pedals.push({ beat: cc.ticks / ppq, time: cc.time, value: cc.value, kind });
    }
  });

  // Several tracks often carry the same pedal; drop exact duplicates.
  const seen = new Set<string>();
  const uniquePedals = pedals
    .sort((a, b) => a.beat - b.beat)
    .filter((p) => {
      const k = `${p.kind}:${p.beat.toFixed(4)}:${p.value.toFixed(3)}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

  const ks = midi.header.keySignatures[0];
  const trackName = midi.tracks.find((t) => t.name)?.name;
  const title = midi.header.name?.trim() || (fileName ? fileName.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ') : trackName || 'MIDI file');
  return finalizeScore({
    title,
    format: 'midi',
    fileName,
    notes,
    pedals: uniquePedals,
    tempos: midi.header.tempos.map((t) => ({ beat: t.ticks / ppq, bpm: t.bpm })),
    timeSignatures: midi.header.timeSignatures.map((t) => ({ beat: t.ticks / ppq, num: t.timeSignature[0], den: t.timeSignature[1] })),
    timing: 'beats',
    keyFifths: ks ? keyToFifths(ks.key, ks.scale) : undefined,
    parts: tracks.map((t, i) => ({ name: t.name || t.instrument.name || `Track ${i + 1}`, notes: t.notes.length })),
  });
}
