// ABC notation → Score, using abcjs to interpret the tune (repeats, chords,
// tuplets, decorations) into timed note events.

import * as abcjsNs from 'abcjs';
import { finalizeScore, type Hand, type Score, type ScoreNote } from './model';

type AbcjsModule = typeof abcjsNs;
const abcjs: AbcjsModule = ((abcjsNs as unknown as { default?: AbcjsModule }).default ?? abcjsNs) as AbcjsModule;

interface AudioEvent {
  cmd: string;
  pitch?: number;
  volume?: number;
  start?: number;
  duration?: number;
}

export function listAbcTunes(text: string): string[] {
  return abcjs.parseOnly(text).map((t, i) => t.metaText?.title || `Tune ${i + 1}`);
}

export function parseAbc(text: string, opts: { fileName?: string; tuneIndex?: number; chords?: boolean } = {}): Score {
  const tunes = abcjs.parseOnly(text);
  if (!tunes.length) throw new Error('No ABC tune found in this file.');
  const tuneIndex = Math.min(Math.max(0, opts.tuneIndex || 0), tunes.length - 1);
  const tune = tunes[tuneIndex];
  const audio = tune.setUpAudio({ chordsOff: opts.chords === false }) as unknown as { tempo: number; tracks: AudioEvent[][] };
  const beatLength = tune.getBeatLength() || 0.25;
  const qpm = (audio.tempo || 120) * beatLength * 4;

  const tracks = audio.tracks.map((tr) => tr.filter((e) => e.cmd === 'note' && typeof e.pitch === 'number'));
  const avg = tracks.map((tr) => (tr.length ? tr.reduce((s, e) => s + (e.pitch || 0), 0) / tr.length : 0));
  const melody = avg.indexOf(Math.max(...avg));
  const notes: ScoreNote[] = [];
  tracks.forEach((tr, ti) => {
    for (const e of tr) {
      const hand: Hand = tracks.length === 1 ? ((e.pitch || 0) >= 55 ? 'R' : 'L') : ti === melody ? 'R' : (e.pitch || 0) >= 60 ? 'R' : 'L';
      notes.push({
        midi: e.pitch!,
        beat: (e.start || 0) * 4,
        beats: Math.max(0.05, (e.duration || 0.125) * 4),
        time: 0,
        duration: 0,
        velocity: Math.min(1, (e.volume ?? 90) / 127),
        hand,
        track: ti,
      });
    }
  });
  if (!notes.length) throw new Error('This ABC tune has no notes.');

  const meter = tune.getMeterFraction?.() || { num: 4, den: 4 };
  const key = tune.getKeySignature?.() as { accidentals?: { acc: string }[] } | undefined;
  const fifths = key?.accidentals ? key.accidentals.reduce((s, a) => s + (a.acc === 'sharp' ? 1 : a.acc === 'flat' ? -1 : 0), 0) : undefined;

  const score = finalizeScore({
    title: tune.metaText?.title || (opts.fileName ? opts.fileName.replace(/\.[^.]+$/, '') : 'ABC tune'),
    composer: (tune.metaText as { composer?: string })?.composer,
    format: 'abc',
    fileName: opts.fileName,
    notes,
    tempos: [{ beat: 0, bpm: qpm }],
    timeSignatures: [{ beat: 0, num: meter.num || 4, den: meter.den || 4 }],
    timing: 'beats',
    keyFifths: fifths,
    parts: tracks.map((tr, i) => ({ name: i === melody ? 'Melody' : `Voice ${i + 1}`, notes: tr.length })),
  });
  // Pickup (anacrusis): notation starts with a partial bar.
  const pickup = (tune.getPickupLength?.() || 0) * 4;
  if (pickup > 0) (score as Score & { pickupBeats?: number }).pickupBeats = pickup;
  score.tunes = tunes.map((t, i) => t.metaText?.title || `Tune ${i + 1}`);
  score.tuneIndex = tuneIndex;
  score.abcText = text;
  return score;
}
