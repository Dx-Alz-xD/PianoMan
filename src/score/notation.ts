// Generates readable two-staff MusicXML from a performance-style note list
// (MIDI, ABC, recordings) so every score can be shown as sheet music.
//
// Each quarter-note beat is quantised to either a sixteenth grid or an eighth
// triplet grid (whichever fits the onsets better). Each staff is written as a
// single voice of chords; notes crossing barlines or beats are split and tied.

import type { Hand, ScoreNote, TimeSigPoint } from './model';

const DIV = 12; // divisions per quarter: 16ths = 3, triplet 8ths = 4

const SHARPS: [string, number][] = [['C', 0], ['C', 1], ['D', 0], ['D', 1], ['E', 0], ['F', 0], ['F', 1], ['G', 0], ['G', 1], ['A', 0], ['A', 1], ['B', 0]];
const FLATS: [string, number][] = [['C', 0], ['D', -1], ['D', 0], ['E', -1], ['E', 0], ['F', 0], ['G', -1], ['G', 0], ['A', -1], ['A', 0], ['B', -1], ['B', 0]];

const BINARY_TYPES: [number, string, number][] = [
  [48, 'whole', 0],
  [36, 'half', 1],
  [24, 'half', 0],
  [18, 'quarter', 1],
  [12, 'quarter', 0],
  [9, 'eighth', 1],
  [6, 'eighth', 0],
  [3, '16th', 0],
];

interface MeasureGrid {
  start: number;
  len: number;
  num: number;
  den: number;
  bpm?: number;
  implicit?: boolean;
}

interface Piece {
  start: number;
  len: number;
  pitches: number[] | null;
  tieStart: boolean;
  tieStop: boolean;
  triplet: boolean;
}

export interface NotationInput {
  title: string;
  composer?: string;
  notes: ScoreNote[];
  timeSignatures: TimeSigPoint[];
  tempos: { beat: number; bpm: number }[];
  keyFifths?: number;
  /** Length of an anacrusis (pickup bar) in quarters. */
  pickupBeats?: number;
  /** Sustain pedal changes, written as pedal marks under the bass staff. */
  pedals?: { beat: number; value: number }[];
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Picks the major/minor key signature that best fits the pitch content. */
export function estimateKey(notes: ScoreNote[]): number {
  const weight = new Array(12).fill(0);
  for (const n of notes) weight[n.midi % 12] += Math.max(0.1, n.beats || n.duration || 0.25);
  let best = 0;
  let bestScore = -Infinity;
  for (let f = -6; f <= 6; f++) {
    const tonic = (((f * 7) % 12) + 12) % 12;
    let score = 0;
    for (const step of [0, 2, 4, 5, 7, 9, 11]) score += weight[(tonic + step) % 12];
    score -= Math.abs(f) * 1e-6;
    if (score > bestScore) {
      bestScore = score;
      best = f;
    }
  }
  return best;
}

function buildMeasures(sigs: TimeSigPoint[], tempos: { beat: number; bpm: number }[], endDiv: number, pickup = 0): MeasureGrid[] {
  const sorted = [...(sigs.length ? sigs : [{ beat: 0, num: 4, den: 4 }])].sort((a, b) => a.beat - b.beat);
  const out: MeasureGrid[] = [];
  let pos = 0;
  let si = 0;
  let lastBpm = -1;
  const tempoSorted = [...tempos].sort((a, b) => a.beat - b.beat);
  while (pos < endDiv || out.length === 0) {
    while (si + 1 < sorted.length && Math.round(sorted[si + 1].beat * DIV) <= pos) si++;
    const { num, den } = sorted[si];
    const full = Math.max(3, Math.round((num * 4 * DIV) / den));
    const pick = out.length === 0 && pickup > 0 ? Math.round(pickup * DIV) : 0;
    const len = pick > 0 && pick < full ? pick : full;
    let bpm: number | undefined;
    for (const t of tempoSorted) if (t.beat * DIV <= pos + 1e-6) bpm = t.bpm;
    const m: MeasureGrid = { start: pos, len, num, den, implicit: len !== full || undefined };
    if (bpm !== undefined && Math.abs(bpm - lastBpm) > 0.5) {
      m.bpm = bpm;
      lastBpm = bpm;
    }
    out.push(m);
    pos += len;
    if (out.length > 20000) break;
  }
  return out;
}

/** 6/8, 9/8, 12/8 …: beats are dotted quarters. */
const isCompound = (m: MeasureGrid) => m.den === 8 && m.num % 3 === 0;

function measureIndexAt(measures: MeasureGrid[], pos: number): number {
  let lo = 0;
  let hi = measures.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measures[mid].start <= pos + 1e-6) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export interface NotationResult {
  xml: string;
  /** For each input note (same order): written measure and offset in quarters. */
  positions: { m: number; o: number }[];
  keyFifths: number;
}

export function generateMusicXml(input: NotationInput): NotationResult {
  const keyFifths = input.keyFifths ?? estimateKey(input.notes);
  const spell = keyFifths < 0 ? FLATS : SHARPS;
  const endDiv = Math.ceil(input.notes.reduce((m, n) => Math.max(m, (n.beat + (n.beats || 0.25)) * DIV), 0));
  const measures = buildMeasures(input.timeSignatures, input.tempos, Math.max(endDiv, 1), input.pickupBeats);

  // Pedal marks (binarised) per measure.
  const pedalMarks: string[][] = measures.map(() => []);
  let down = false;
  for (const p of [...(input.pedals || [])].sort((a, b) => a.beat - b.beat)) {
    const isDown = p.value >= 0.5;
    if (isDown === down) continue;
    down = isDown;
    const pos = Math.round(p.beat * DIV);
    const mi = measureIndexAt(measures, pos);
    const offset = pos - measures[mi].start;
    pedalMarks[mi].push(
      `<direction placement="below"><direction-type><pedal type="${isDown ? 'start' : 'stop'}" line="yes"/></direction-type>` +
        `${offset ? `<offset>${offset}</offset>` : ''}<staff>2</staff><sound damper-pedal="${isDown ? 'yes' : 'no'}"/></direction>`,
    );
  }
  const positions: { m: number; o: number }[] = input.notes.map(() => ({ m: 0, o: 0 }));

  // Grid choice per (measure, beat).
  const ternary = new Set<string>();
  const errs = new Map<string, { b: number; t: number; n: number }>();
  const beatKey = (pos: number) => {
    const mi = measureIndexAt(measures, pos);
    const rel = pos - measures[mi].start;
    return { mi, q: Math.floor(rel / DIV), rel };
  };
  for (const n of input.notes) {
    const pos = n.beat * DIV;
    const { mi, q, rel } = beatKey(pos);
    const x = rel - q * DIV;
    const k = `${mi}:${q}`;
    const e = errs.get(k) || { b: 0, t: 0, n: 0 };
    e.b += Math.abs(x - Math.round(x / 3) * 3);
    e.t += Math.abs(x - Math.round(x / 4) * 4);
    e.n++;
    errs.set(k, e);
  }
  for (const [k, e] of errs) {
    const [mi, q] = k.split(':').map(Number);
    const m = measures[mi];
    if ((q + 1) * DIV > m.len || isCompound(m)) continue; // odd-meter tails and compound meters stay binary
    if (e.t + 0.3 * e.n < e.b) ternary.add(k);
  }
  const snap = (pos: number) => {
    const mi = measureIndexAt(measures, pos);
    const m = measures[mi];
    const rel = pos - m.start;
    const q = Math.floor(rel / DIV);
    const step = ternary.has(`${mi}:${q}`) ? 4 : 3;
    const base = q * DIV;
    let s = base + Math.round((rel - base) / step) * step;
    s = Math.min(s, m.len);
    return m.start + s;
  };

  const total = measures[measures.length - 1].start + measures[measures.length - 1].len;

  /** Splits a voice's chords/rests into notatable pieces covering the whole piece. */
  const renderVoice = (events: Map<number, { pitches: Set<number>; end: number }>): Piece[] => {
    const onsets = [...events.keys()].sort((a, b) => a - b);
    const segs: { start: number; end: number; pitches: number[] | null }[] = [];
    let cursor = 0;
    onsets.forEach((on, k) => {
      const ev = events.get(on)!;
      const next = k + 1 < onsets.length ? onsets[k + 1] : Infinity;
      const end = Math.min(ev.end, next);
      if (on > cursor) segs.push({ start: cursor, end: on, pitches: null });
      segs.push({ start: on, end, pitches: [...ev.pitches].sort((a, b) => a - b) });
      cursor = end;
    });
    if (cursor < total) segs.push({ start: cursor, end: total, pitches: null });
    const pieces: Piece[] = [];
    for (const seg of segs) {
      const parts: Piece[] = [];
      let pos = seg.start;
      while (pos < seg.end) {
        const mi = measureIndexAt(measures, pos);
        const m = measures[mi];
        const rel = pos - m.start;
        const q = Math.floor(rel / DIV);
        const inTriplet = ternary.has(`${mi}:${q}`);
        const bl = isCompound(m) ? 18 : DIV;
        const measureEnd = m.start + m.len;
        let limit = Math.min(seg.end, measureEnd);
        const nextTriplet = ternary.has(`${mi}:${q + 1}`);
        if (inTriplet || nextTriplet) limit = Math.min(limit, m.start + (q + 1) * DIV);
        else if (rel % bl !== 0) limit = Math.min(limit, m.start + (Math.floor(rel / bl) + 1) * bl);
        let len = limit - pos;
        let triplet = false;
        if (inTriplet) {
          if (!(rel % DIV === 0 && len === DIV)) {
            triplet = true;
            len = len >= 8 ? 8 : 4;
          }
        } else {
          const fit = BINARY_TYPES.find(([d]) => d <= len && (rel % bl === 0 || d <= bl));
          len = fit ? fit[0] : Math.max(1, len);
        }
        parts.push({ start: pos, len, pitches: seg.pitches, tieStart: false, tieStop: false, triplet });
        pos += len;
      }
      if (seg.pitches && parts.length > 1) {
        parts.forEach((p, k) => {
          p.tieStart = k < parts.length - 1;
          p.tieStop = k > 0;
        });
      }
      pieces.push(...parts);
    }
    return pieces;
  };

  // Each staff is written as up to two voices: notes still sounding when the
  // next chord starts (held bass notes, sustained melody) go to a second voice
  // instead of being cut short.
  const staffXml: string[][] = measures.map(() => []);
  const hands: Hand[] = ['R', 'L'];
  hands.forEach((hand, si) => {
    const staff = si + 1;
    const snapped = input.notes
      .map((n, i) => ({ n, i }))
      .filter(({ n }) => n.hand === hand)
      .map(({ n, i }) => {
        const on = snap(n.beat * DIV);
        let off = snap((n.beat + (n.beats || 0.25)) * DIV);
        if (off <= on) off = on + (ternary.has(`${beatKey(on).mi}:${beatKey(on).q}`) ? 4 : 3);
        const mi = measureIndexAt(measures, on);
        positions[i] = { m: mi, o: (on - measures[mi].start) / DIV };
        return { midi: n.midi, on, off };
      })
      .sort((a, b) => a.on - b.on || a.midi - b.midi);
    const groups: { on: number; notes: { midi: number; off: number }[] }[] = [];
    for (const x of snapped) {
      const g = groups[groups.length - 1];
      if (g && g.on === x.on) g.notes.push(x);
      else groups.push({ on: x.on, notes: [x] });
    }
    const voices = [new Map<number, { pitches: Set<number>; end: number }>(), new Map<number, { pitches: Set<number>; end: number }>()];
    const busy = [0, 0];
    const lastLen = [0, 0];
    const place = (v: number, on: number, notes: { midi: number; off: number }[]) => {
      const ev = voices[v].get(on) || { pitches: new Set<number>(), end: on };
      for (const n of notes) {
        ev.pitches.add(n.midi);
        ev.end = Math.max(ev.end, n.off);
      }
      voices[v].set(on, ev);
      busy[v] = ev.end;
      lastLen[v] = ev.end - on;
    };
    // Slight legato overlaps (common in performed MIDI) don't count as busy.
    const free = (v: number, on: number) => busy[v] <= on || busy[v] - on <= Math.max(3, lastLen[v] * 0.25);
    for (const g of groups) {
      const durs = g.notes.map((n) => n.off - g.on);
      const shortest = Math.min(...durs);
      const long = g.notes.filter((n) => n.off - g.on > shortest * 1.5 + 2);
      if (long.length && long.length < g.notes.length && free(0, g.on) && free(1, g.on)) {
        place(1, g.on, long);
        place(0, g.on, g.notes.filter((n) => !long.includes(n)));
      } else if (free(0, g.on)) place(0, g.on, g.notes);
      else if (free(1, g.on)) place(1, g.on, g.notes);
      else place(busy[0] <= busy[1] ? 0 : 1, g.on, g.notes);
    }
    // The higher-sounding voice is voice 1 (stems up).
    const avg = voices.map((v) => {
      let sum = 0;
      let w = 0;
      for (const [on, ev] of v) for (const p of ev.pitches) {
        sum += p * (ev.end - on);
        w += ev.end - on;
      }
      return w ? sum / w : -Infinity;
    });
    if (voices[1].size && avg[1] > avg[0]) voices.reverse();

    const rendered = voices.map((v) => (v.size ? renderVoice(v) : null));
    const cursors = [0, 0];
    measures.forEach((m, mi) => {
      const perVoice: Piece[][] = rendered.map((pieces, vi) => {
        const out: Piece[] = [];
        if (!pieces) return out;
        while (cursors[vi] < pieces.length && pieces[cursors[vi]].start < m.start + m.len) out.push(pieces[cursors[vi]++]);
        return out;
      });
      const hasNotes = perVoice.map((ps) => ps.some((p) => p.pitches));
      const twoVoices = hasNotes[0] && hasNotes[1];
      const chunks: string[] = [];
      perVoice.forEach((ps, vi) => {
        const voice = (staff === 1 ? 1 : 5) + vi;
        if (vi === 1 && !hasNotes[1]) return;
        if (!hasNotes[vi] && vi === 0 && !hasNotes[1]) {
          if (!m.implicit) {
            chunks.push(`<note><rest measure="yes"/><duration>${m.len}</duration><voice>${voice}</voice><staff>${staff}</staff></note>`);
            return;
          }
        }
        const out: string[] = [];
        ps.forEach((p, k) => {
          const rel = p.start - m.start;
          const q = Math.floor(rel / DIV);
          const prev = ps[k - 1];
          const next = ps[k + 1];
          const tupletStart = p.triplet && (!prev || !prev.triplet || Math.floor((prev.start - m.start) / DIV) !== q);
          const tupletStop = p.triplet && (!next || !next.triplet || Math.floor((next.start - m.start) / DIV) !== q);
          out.push(noteXml(p, staff, voice, spell, tupletStart, tupletStop, twoVoices ? (vi === 0 ? 'up' : 'down') : null, vi === 1));
        });
        chunks.push(out.join(''));
      });
      staffXml[mi].push(...chunks);
    });
  });

  const body = measures
    .map((m, mi) => {
      const attrs: string[] = [];
      const prev = measures[mi - 1];
      if (mi === 0) {
        attrs.push(
          `<attributes><divisions>${DIV}</divisions><key><fifths>${keyFifths}</fifths></key>` +
            `<time><beats>${m.num}</beats><beat-type>${m.den}</beat-type></time><staves>2</staves>` +
            `<clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>`,
        );
      } else if (prev && (prev.num !== m.num || prev.den !== m.den)) {
        attrs.push(`<attributes><time><beats>${m.num}</beats><beat-type>${m.den}</beat-type></time></attributes>`);
      }
      if (m.bpm) {
        const bpm = Math.round(m.bpm);
        attrs.push(
          `<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${bpm}</per-minute></metronome></direction-type><staff>1</staff><sound tempo="${bpm}"/></direction>`,
        );
      }
      attrs.push(...pedalMarks[mi]);
      const number = measures[0].implicit ? mi : mi + 1;
      const voices = staffXml[mi].join(`<backup><duration>${m.len}</duration></backup>`);
      return `<measure number="${number}"${m.implicit ? ' implicit="yes"' : ''}>${attrs.join('')}${voices}</measure>`;
    })
    .join('\n');

  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">\n` +
    `<score-partwise version="3.1"><work><work-title>${esc(input.title)}</work-title></work>` +
    `<identification>${input.composer ? `<creator type="composer">${esc(input.composer)}</creator>` : ''}<encoding><software>PIANO-BEATS</software></encoding></identification>` +
    `<part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>` +
    `<part id="P1">\n${body}\n</part></score-partwise>`;
  return { xml, positions, keyFifths };
}

function noteXml(p: Piece, staff: number, voice: number, spell: [string, number][], tupletStart: boolean, tupletStop: boolean, stem: 'up' | 'down' | null, hideRests: boolean): string {
  const stemXml = stem ? `<stem>${stem}</stem>` : '';
  let type: string;
  let dots = 0;
  if (p.triplet) type = p.len === 8 ? 'quarter' : 'eighth';
  else {
    const t = BINARY_TYPES.find(([d]) => d === p.len);
    type = t ? t[1] : '16th';
    dots = t ? t[2] : 0;
  }
  const tm = p.triplet ? '<time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>' : '';
  const tupletNot = (tupletStart ? '<tuplet type="start" bracket="yes"/>' : '') + (tupletStop ? '<tuplet type="stop"/>' : '');
  const dotXml = '<dot/>'.repeat(dots);
  if (!p.pitches) {
    const notations = tupletNot ? `<notations>${tupletNot}</notations>` : '';
    return `<note${hideRests ? ' print-object="no"' : ''}><rest/><duration>${p.len}</duration><voice>${voice}</voice><type>${type}</type>${dotXml}${tm}<staff>${staff}</staff>${notations}</note>`;
  }
  return p.pitches
    .map((midi, i) => {
      const [step, alter] = spell[midi % 12];
      const octave = Math.floor(midi / 12) - 1;
      const ties = (p.tieStop ? '<tie type="stop"/>' : '') + (p.tieStart ? '<tie type="start"/>' : '');
      const tied = (p.tieStop ? '<tied type="stop"/>' : '') + (p.tieStart ? '<tied type="start"/>' : '');
      const notations = tied || (i === 0 && tupletNot) ? `<notations>${tied}${i === 0 ? tupletNot : ''}</notations>` : '';
      return (
        `<note>${i > 0 ? '<chord/>' : ''}<pitch><step>${step}</step>${alter ? `<alter>${alter}</alter>` : ''}<octave>${octave}</octave></pitch>` +
        `<duration>${p.len}</duration>${ties}<voice>${voice}</voice><type>${type}</type>${dotXml}${tm}${stemXml}<staff>${staff}</staff>${notations}</note>`
      );
    })
    .join('');
}
