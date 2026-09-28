import { describe, expect, it } from 'vitest';
import { parseAbc } from '../src/score/abc';
import { detectFormat, ensureNotation, loadScore } from '../src/score/loader';
import { finalizeScore, type ScoreNote } from '../src/score/model';
import { parseMusicXml } from '../src/score/musicxml';
import { estimateKey, generateMusicXml } from '../src/score/notation';
import { scoreToMidi } from '../src/audio/recorder';
import { zipSync, strToU8 } from 'fflate';
import { attrs, note, wrap } from './fixtures';

const n = (midi: number, beat: number, beats: number, hand: 'L' | 'R' = midi >= 60 ? 'R' : 'L'): ScoreNote => ({
  midi, beat, beats, time: 0, duration: 0, velocity: 0.7, hand, track: 0,
});

describe('format detection', () => {
  it('sniffs content rather than trusting extensions', () => {
    expect(detectFormat(new Uint8Array([0x4d, 0x54, 0x68, 0x64, 0, 0]), 'x.txt')).toBe('midi');
    expect(detectFormat(strToU8('<?xml version="1.0"?><score-partwise>'), 'x.bin')).toBe('musicxml');
    expect(detectFormat(strToU8('X:1\nT:Tune\nK:G\nGAB|'), 'tune.txt')).toBe('abc');
    expect(detectFormat(zipSync({ 'a.xml': strToU8('<score-partwise/>') }), 'x')).toBe('mxl');
  });
});

describe('MXL', () => {
  it('opens the rootfile named in the container', () => {
    const xml = wrap(`<measure number="1">${attrs(1)}${note('A', 4, 4)}</measure>`);
    const container = `<?xml version="1.0"?><container><rootfiles><rootfile full-path="score/main.musicxml"/></rootfiles></container>`;
    const zip = zipSync({ 'META-INF/container.xml': strToU8(container), 'score/main.musicxml': strToU8(xml) });
    const s = loadScore(zip, { fileName: 'test.mxl' });
    expect(s.format).toBe('mxl');
    expect(s.notes[0].midi).toBe(69);
  });
});

describe('MIDI', () => {
  it('round-trips through the MIDI writer with hands and pedal', () => {
    const src = finalizeScore({
      title: 'Round trip',
      format: 'recording',
      notes: [
        { midi: 72, time: 0, duration: 0.5, beat: 0, velocity: 0.8, hand: 'R', track: 0 },
        { midi: 48, time: 0.5, duration: 1, beat: 0, velocity: 0.5, hand: 'L', track: 0 },
      ],
      pedals: [{ time: 0.25, beat: 0, value: 1, kind: 'sustain' }],
      tempos: [{ beat: 0, bpm: 120 }],
      timing: 'seconds',
    });
    const bytes = scoreToMidi(src);
    const s = loadScore(bytes, { fileName: 'round.mid' });
    expect(s.format).toBe('midi');
    expect(s.notes.map((x) => [x.midi, x.hand])).toEqual([[72, 'R'], [48, 'L']]);
    expect(s.notes[1].time).toBeCloseTo(0.5, 2);
    expect(s.notes[0].velocity).toBeCloseTo(0.8, 1);
    expect(s.pedals.some((p) => p.kind === 'sustain' && p.value > 0.9)).toBe(true);
  });
});

describe('ABC', () => {
  const tune = `X:1\nT:Speed the Plough\nC:Trad.\nM:4/4\nL:1/8\nQ:1/4=120\nK:G\n|:GABc dedB|dedB dedB|c2ec B2dB|1 A2A2 A4:|2 A2A2 G4|]\n`;

  it('reads notes, tempo, meter and repeats', () => {
    const s = parseAbc(tune);
    expect(s.title).toBe('Speed the Plough');
    expect(s.composer).toBe('Trad.');
    expect(s.tempos[0].bpm).toBeCloseTo(120);
    expect(s.timeSignatures[0]).toMatchObject({ num: 4, den: 4 });
    expect(s.notes[0].midi).toBe(67);
    expect(s.notes[1].time).toBeCloseTo(0.25, 3);
    // 4 bars played twice with different endings = 32 eighths worth of beats.
    const last = s.notes[s.notes.length - 1];
    expect(last.beat + (last.beats || 0)).toBeCloseTo(32, 1);
    expect(s.keyFifths).toBe(1);
  });

  it('generates sheet music for ABC', () => {
    const s = parseAbc(tune);
    const xml = ensureNotation(s);
    const back = parseMusicXml(xml);
    expect(back.notes.length).toBe(s.notes.length);
    expect(s.notes.every((x) => x.src !== undefined)).toBe(true);
  });
});

describe('notation generator', () => {
  it('round-trips straight rhythms, rests and ties across barlines', () => {
    const notes = [n(60, 0, 1), n(64, 1, 0.5), n(67, 1.5, 0.5), n(72, 3, 2), n(48, 0, 4), n(55, 4, 2)];
    const { xml } = generateMusicXml({ title: 'T', notes, timeSignatures: [{ beat: 0, num: 4, den: 4 }], tempos: [{ beat: 0, bpm: 100 }] });
    const back = parseMusicXml(xml);
    const key = (x: ScoreNote) => `${x.midi}@${x.beat}+${x.beats}`;
    expect(back.notes.map(key).sort()).toEqual(notes.map(key).sort());
    expect(back.tempos[0].bpm).toBe(100);
  });

  it('keeps held notes in a second voice instead of cutting them short', () => {
    // Bach C-major-prelude pattern in the left hand: C held for 2 beats, E enters a 16th later.
    const notes = [n(48, 0, 2, 'L'), n(52, 0.25, 1.75, 'L'), n(55, 0.5, 0.25, 'R'), n(60, 0.75, 0.25, 'R'), n(48, 2, 2, 'L'), n(52, 2.25, 1.75, 'L')];
    const { xml } = generateMusicXml({ title: 'T', notes, timeSignatures: [{ beat: 0, num: 4, den: 4 }], tempos: [] });
    expect(xml).toContain('<voice>6</voice>');
    const back = parseMusicXml(xml);
    const key = (x: ScoreNote) => `${x.midi}@${x.beat}+${x.beats}`;
    expect(back.notes.map(key).sort()).toEqual(notes.map(key).sort());
  });

  it('treats slight legato overlaps as one voice', () => {
    const notes = [n(60, 0, 1.1), n(62, 1, 1.1), n(64, 2, 2)];
    const { xml } = generateMusicXml({ title: 'T', notes, timeSignatures: [{ beat: 0, num: 4, den: 4 }], tempos: [] });
    expect(xml).not.toContain('<voice>2</voice>');
  });

  it('detects triplets', () => {
    const notes = [n(60, 0, 1 / 3), n(62, 1 / 3, 1 / 3), n(64, 2 / 3, 1 / 3), n(65, 1, 1), n(67, 2, 2)];
    const { xml } = generateMusicXml({ title: 'T', notes, timeSignatures: [{ beat: 0, num: 4, den: 4 }], tempos: [] });
    expect(xml).toContain('<actual-notes>3</actual-notes>');
    const back = parseMusicXml(xml);
    expect(back.notes.map((x) => +x.beat.toFixed(3))).toEqual([0, 0.333, 0.667, 1, 2]);
  });

  it('writes 6/8 with a full measure per bar', () => {
    const notes = [n(60, 0, 1.5), n(62, 1.5, 1.5), n(64, 3, 3)];
    const { xml } = generateMusicXml({ title: 'T', notes, timeSignatures: [{ beat: 0, num: 6, den: 8 }], tempos: [] });
    const back = parseMusicXml(xml);
    expect(back.measures.length).toBe(2);
    expect(back.notes.map((x) => [x.midi, x.beat, x.beats])).toEqual([[60, 0, 1.5], [62, 1.5, 1.5], [64, 3, 3]]);
  });

  it('estimates key signatures', () => {
    const scale = (root: number, pcs: number[]) => pcs.map((p, i) => n(root + p, i, 1));
    expect(estimateKey(scale(62, [0, 2, 4, 5, 7, 9, 11]))).toBe(2); // D major
    expect(estimateKey(scale(65, [0, 2, 4, 5, 7, 9, 11]))).toBe(-1); // F major
  });
});
