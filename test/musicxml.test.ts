import { describe, expect, it } from 'vitest';
import { parseMusicXml, playOrder, type MeasureInfo } from '../src/score/musicxml';
import { attrs, note, wrap } from './fixtures';

describe('MusicXML parser', () => {
  it('reads title, composer, pitches, durations and tempo', () => {
    const xml = wrap(
      `<measure number="1">${attrs(2)}<direction><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>90</per-minute></metronome></direction-type><sound tempo="90"/></direction>
       ${note('C', 4, 2)}${note('D', 4, 2)}${note('E', 4, 4)}</measure>`,
    );
    const s = parseMusicXml(xml);
    expect(s.title).toBe('Test Piece');
    expect(s.composer).toBe('Tester');
    expect(s.notes.map((n) => n.midi)).toEqual([60, 62, 64]);
    expect(s.notes.map((n) => n.beat)).toEqual([0, 1, 2]);
    expect(s.tempos[0].bpm).toBe(90);
    expect(s.notes[1].time).toBeCloseTo(60 / 90, 5);
    expect(s.notes[2].duration).toBeCloseTo((2 * 60) / 90, 5);
  });

  it('handles chords, backup to a second staff and hand assignment', () => {
    const xml = wrap(
      `<measure number="1">${attrs(1, 4, 4, 2)}
        ${note('C', 5, 4, '<staff>1</staff>')}${note('E', 5, 4, '<chord/><staff>1</staff>')}
        <backup><duration>4</duration></backup>
        ${note('C', 3, 2, '<staff>2</staff>')}${note('G', 2, 2, '<staff>2</staff>')}</measure>`,
    );
    const s = parseMusicXml(xml);
    const right = s.notes.filter((n) => n.hand === 'R').map((n) => [n.midi, n.beat]);
    const left = s.notes.filter((n) => n.hand === 'L').map((n) => [n.midi, n.beat]);
    expect(right).toEqual([[72, 0], [76, 0]]);
    expect(left).toEqual([[48, 0], [43, 2]]);
  });

  it('merges tied notes across a barline', () => {
    const xml = wrap(
      `<measure number="1">${attrs(1)}${note('C', 4, 2)}${note('G', 4, 2, '<tie type="start"/>')}</measure>
       <measure number="2">${note('G', 4, 2, '<tie type="stop"/>')}${note('A', 4, 2)}</measure>`,
    );
    const s = parseMusicXml(xml);
    expect(s.notes.map((n) => n.midi)).toEqual([60, 67, 69]);
    expect(s.notes[1].beats).toBe(4);
  });

  it('applies dynamics, staccato and accents', () => {
    const xml = wrap(
      `<measure number="1">${attrs(1)}
       <direction><direction-type><dynamics><p/></dynamics></direction-type></direction>${note('C', 4, 1)}
       <direction><direction-type><dynamics><ff/></dynamics></direction-type></direction>${note('D', 4, 1, '<notations><articulations><staccato/></articulations></notations>')}
       ${note('E', 4, 1, '<notations><articulations><accent/></articulations></notations>')}${note('F', 4, 1)}</measure>`,
    );
    const s = parseMusicXml(xml);
    expect(s.notes[0].velocity).toBeLessThan(s.notes[1].velocity);
    expect(s.notes[1].beats).toBeCloseTo(0.5);
    expect(s.notes[2].velocity).toBeGreaterThan(s.notes[3].velocity);
  });

  it('interpolates a crescendo hairpin towards the next dynamic', () => {
    const xml = wrap(
      `<measure number="1">${attrs(1)}
       <direction><direction-type><dynamics><p/></dynamics></direction-type></direction>
       <direction><direction-type><wedge type="crescendo"/></direction-type></direction>
       ${note('C', 4, 1)}${note('D', 4, 1)}${note('E', 4, 1)}
       <direction><direction-type><wedge type="stop"/></direction-type></direction>
       <direction><direction-type><dynamics><f/></dynamics></direction-type></direction>${note('F', 4, 1)}</measure>`,
    );
    const v = parseMusicXml(xml).notes.map((n) => n.velocity);
    expect(v[0]).toBeLessThan(v[1]);
    expect(v[1]).toBeLessThan(v[2]);
    expect(v[2]).toBeLessThanOrEqual(v[3]);
  });

  it('expands repeats with first and second endings', () => {
    const xml = wrap(
      `<measure number="1">${attrs(1)}<barline location="left"><repeat direction="forward"/></barline>${note('C', 4, 4)}</measure>
       <measure number="2"><barline location="left"><ending number="1" type="start"/></barline>${note('D', 4, 4)}<barline location="right"><ending number="1" type="stop"/><repeat direction="backward"/></barline></measure>
       <measure number="3"><barline location="left"><ending number="2" type="start"/></barline>${note('E', 4, 4)}<barline location="right"><ending number="2" type="stop"/></barline></measure>
       <measure number="4">${note('F', 4, 4)}</measure>`,
    );
    const s = parseMusicXml(xml);
    expect(s.notes.map((n) => n.midi)).toEqual([60, 62, 60, 64, 65]);
    expect(s.measures.map((m) => m.src)).toEqual([0, 1, 0, 2, 3]);
    expect(s.notes.map((n) => n.src?.m)).toEqual([0, 1, 0, 2, 3]);
  });

  it('plays repeats without a forward barline from the start', () => {
    const xml = wrap(
      `<measure number="1">${attrs(1)}${note('C', 4, 4)}</measure>
       <measure number="2">${note('D', 4, 4)}<barline location="right"><repeat direction="backward"/></barline></measure>
       <measure number="3">${note('E', 4, 4)}</measure>`,
    );
    expect(parseMusicXml(xml).notes.map((n) => n.midi)).toEqual([60, 62, 60, 62, 64]);
  });

  it('follows D.C. al Fine', () => {
    const xml = wrap(
      `<measure number="1">${attrs(1)}${note('C', 4, 4)}</measure>
       <measure number="2">${note('D', 4, 4)}<sound fine="yes"/></measure>
       <measure number="3">${note('E', 4, 4)}<sound dacapo="yes"/></measure>`,
    );
    expect(parseMusicXml(xml).notes.map((n) => n.midi)).toEqual([60, 62, 64, 60, 62]);
  });

  it('places grace notes just before the main note', () => {
    const xml = wrap(`<measure number="1">${attrs(2)}${note('C', 4, 2)}<note><grace/><pitch><step>E</step><octave>4</octave></pitch></note>${note('D', 4, 2)}${note('C', 4, 4)}</measure>`);
    const s = parseMusicXml(xml);
    const grace = s.notes.find((n) => n.midi === 64)!;
    const main = s.notes.find((n) => n.midi === 62)!;
    expect(grace.grace).toBe(true);
    expect(grace.beat).toBeLessThan(main.beat);
    expect(main.beat).toBe(1);
  });

  it('reads pedal markings', () => {
    const xml = wrap(
      `<measure number="1">${attrs(1)}<direction><direction-type><pedal type="start"/></direction-type></direction>${note('C', 4, 2)}
       <direction><direction-type><pedal type="stop"/></direction-type></direction>${note('D', 4, 2)}</measure>`,
    );
    const s = parseMusicXml(xml);
    expect(s.pedals.map((p) => [p.beat, p.value])).toEqual([[0, 1], [2, 0]]);
  });

  it('applies transposing instruments', () => {
    const xml = wrap(`<measure number="1"><attributes><divisions>1</divisions><transpose><diatonic>-1</diatonic><chromatic>-2</chromatic></transpose></attributes>${note('D', 4, 4)}</measure>`);
    expect(parseMusicXml(xml).notes[0].midi).toBe(60);
  });

  it('rejects files that are not scores', () => {
    expect(() => parseMusicXml('<html><body/></html>')).toThrow();
    expect(() => parseMusicXml('not xml')).toThrow();
  });
});

describe('playOrder', () => {
  const m = (p: Partial<MeasureInfo> = {}): MeasureInfo => ({
    length: 4, num: 4, den: 4, repeatForward: false, repeatBackward: false, times: 2, endings: null, endingGroupMax: 0,
    segno: null, coda: null, tocoda: null, dacapo: false, dalsegno: null, fine: false, ...p,
  });

  it('honours repeat counts', () => {
    expect(playOrder([m({ repeatForward: true }), m({ repeatBackward: true, times: 3 }), m()])).toEqual([0, 1, 0, 1, 0, 1, 2]);
  });

  it('handles D.S. al Coda', () => {
    const order = playOrder([m(), m({ segno: 's' }), m({ tocoda: 'c' }), m({ dalsegno: 's' }), m({ coda: 'c' })]);
    expect(order).toEqual([0, 1, 2, 3, 1, 2, 4]);
  });
});
