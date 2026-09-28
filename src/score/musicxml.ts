// MusicXML → Score. Handles multi-part / multi-staff scores, chords, voices
// (backup/forward), ties, grace notes, tempo and dynamics markings (including
// hairpins), articulations, arpeggios, pedal markings, transposing parts and
// full repeat structure (repeat barlines, voltas, D.C./D.S./Fine/Coda).

import { finalizeScore, type Hand, type PedalEvent, type Score, type ScoreNote, type TimeSigPoint } from './model';

const STEP_PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

const DYNAMICS: Record<string, number> = {
  pppppp: 0.06, ppppp: 0.09, pppp: 0.13, ppp: 0.2, pp: 0.3, p: 0.42, mp: 0.53, mf: 0.63,
  f: 0.75, ff: 0.86, fff: 0.94, ffff: 0.98, fffff: 1, ffffff: 1,
};
const ACCENTS: Record<string, number> = { sf: 0.18, sfz: 0.2, sffz: 0.25, fz: 0.18, sfp: 0.18, rf: 0.12, rfz: 0.15, sfzp: 0.2 };

interface RawNote {
  part: number;
  m: number;
  pos: number;
  dur: number;
  midi: number;
  staff: number;
  hand: Hand;
  tieStart: boolean;
  tieStop: boolean;
  velocity: number | null;
  accent: number;
  lengthFactor: number;
  grace: boolean;
  arpeggio: boolean;
}

export interface MeasureInfo {
  length: number;
  num: number;
  den: number;
  repeatForward: boolean;
  repeatBackward: boolean;
  times: number;
  endings: number[] | null;
  endingGroupMax: number;
  segno: string | null;
  coda: string | null;
  tocoda: string | null;
  dacapo: boolean;
  dalsegno: string | null;
  fine: boolean;
}

interface MarkEvent {
  m: number;
  pos: number;
}

const kids = (el: Element, name?: string) => Array.from(el.children).filter((c) => !name || c.tagName === name);
const kid = (el: Element | null | undefined, name: string) => (el ? Array.from(el.children).find((c) => c.tagName === name) || null : null);
const text = (el: Element | null | undefined, name: string) => kid(el, name)?.textContent?.trim() ?? null;
const num = (v: string | null | undefined, d = 0) => {
  const n = v === null || v === undefined ? NaN : parseFloat(v);
  return isFinite(n) ? n : d;
};

export function parseXml(xml: string): Document {
  const doc = new DOMParser().parseFromString(xml.replace(/^﻿/, ''), 'application/xml');
  const err = doc.getElementsByTagName('parsererror')[0];
  if (err) throw new Error(`Not valid XML: ${err.textContent?.slice(0, 200)}`);
  return doc;
}

/** score-timewise → score-partwise (the sheet renderer only reads partwise). */
export function timewiseToPartwise(doc: Document): Document {
  const root = doc.documentElement;
  if (root.tagName !== 'score-timewise') return doc;
  const out = document.implementation.createDocument(null, 'score-partwise', null);
  const newRoot = out.documentElement;
  newRoot.setAttribute('version', root.getAttribute('version') || '3.1');
  const parts = new Map<string, Element>();
  for (const child of kids(root)) {
    if (child.tagName !== 'measure') {
      newRoot.appendChild(out.importNode(child, true));
      continue;
    }
    for (const p of kids(child, 'part')) {
      const id = p.getAttribute('id') || 'P1';
      let partEl = parts.get(id);
      if (!partEl) {
        partEl = out.createElement('part');
        partEl.setAttribute('id', id);
        parts.set(id, partEl);
        newRoot.appendChild(partEl);
      }
      const m = out.createElement('measure');
      for (const a of Array.from(child.attributes)) m.setAttribute(a.name, a.value);
      for (const c of Array.from(p.childNodes)) m.appendChild(out.importNode(c, true));
      partEl.appendChild(m);
    }
  }
  return out;
}

function metronomeToQpm(met: Element): number | null {
  const perMinute = num(text(met, 'per-minute'), NaN);
  if (!isFinite(perMinute)) return null;
  const unit = text(met, 'beat-unit') || 'quarter';
  const dots = kids(met, 'beat-unit-dot').length;
  const base: Record<string, number> = { whole: 4, half: 2, quarter: 1, eighth: 0.5, '16th': 0.25, '32nd': 0.125, breve: 8 };
  let q = base[unit] ?? 1;
  let add = q / 2;
  for (let i = 0; i < dots; i++) {
    q += add;
    add /= 2;
  }
  return perMinute * q;
}

export interface MusicXmlOptions {
  fileName?: string;
  expandRepeats?: boolean;
}

export function parseMusicXml(xml: string, opts: MusicXmlOptions = {}): Score {
  let doc = parseXml(xml);
  let displayXml = xml;
  if (doc.documentElement.tagName === 'score-timewise') {
    doc = timewiseToPartwise(doc);
    displayXml = new XMLSerializer().serializeToString(doc);
  }
  const root = doc.documentElement;
  if (root.tagName !== 'score-partwise') throw new Error('This file is not a MusicXML score.');

  const warnings: string[] = [];
  const work = kid(root, 'work');
  const credits = kids(root, 'credit');
  const creditText = (type: string) =>
    credits.find((c) => text(c, 'credit-type') === type)?.getElementsByTagName('credit-words')[0]?.textContent?.trim() || null;
  const title =
    text(work, 'work-title') || text(root, 'movement-title') || creditText('title') || (opts.fileName ? opts.fileName.replace(/\.[^.]+$/, '') : 'Untitled');
  const ident = kid(root, 'identification');
  const composer =
    kids(ident || root, 'creator').find((c) => c.getAttribute('type') === 'composer')?.textContent?.trim() || creditText('composer') || undefined;

  const partNames = new Map<string, string>();
  const partList = kid(root, 'part-list');
  for (const sp of partList ? kids(partList, 'score-part') : []) partNames.set(sp.getAttribute('id') || '', text(sp, 'part-name') || '');

  const partEls = kids(root, 'part');
  if (!partEls.length) throw new Error('The score has no parts.');
  const measureCount = Math.max(...partEls.map((p) => kids(p, 'measure').length));

  const measures: MeasureInfo[] = Array.from({ length: measureCount }, () => ({
    length: 0, num: 4, den: 4, repeatForward: false, repeatBackward: false, times: 2, endings: null, endingGroupMax: 0,
    segno: null, coda: null, tocoda: null, dacapo: false, dalsegno: null, fine: false,
  }));
  const raw: RawNote[] = [];
  const tempos: (MarkEvent & { bpm: number })[] = [];
  const dynamicsByPart: (MarkEvent & { v: number })[][] = [];
  const accentsByPart: (MarkEvent & { v: number })[][] = [];
  const wedgesByPart: { start: MarkEvent; stop: MarkEvent | null; type: 'crescendo' | 'diminuendo' }[][] = [];
  const pedals: (MarkEvent & { value: number })[] = [];
  const partInfo: { name: string; notes: number }[] = [];
  let keyFifths: number | undefined;

  partEls.forEach((partEl, pi) => {
    const pid = partEl.getAttribute('id') || '';
    let divisions = 1;
    let transpose = 0;
    let staves = 1;
    const clefs = new Map<number, string>();
    const dyn: (MarkEvent & { v: number })[] = [];
    const accents: (MarkEvent & { v: number })[] = [];
    accentsByPart.push(accents);
    const wedges: { start: MarkEvent; stop: MarkEvent | null; type: 'crescendo' | 'diminuendo' }[] = [];
    dynamicsByPart.push(dyn);
    wedgesByPart.push(wedges);
    let noteCount = 0;
    let openEnding: number[] | null = null;
    let pendingGrace: RawNote[] = [];

    kids(partEl, 'measure').forEach((mEl, mi) => {
      const info = measures[mi];
      let pos = 0;
      let maxPos = 0;
      let lastStart = 0;
      const q = (d: number) => d / divisions;
      const handFor = (staff: number): Hand => {
        if (staves >= 2) return staff >= 2 ? 'L' : 'R';
        const clef = clefs.get(staff) || clefs.get(1);
        return clef === 'F' ? 'L' : 'R';
      };
      if (openEnding) info.endings = openEnding;

      for (const el of kids(mEl)) {
        switch (el.tagName) {
          case 'attributes': {
            const div = num(text(el, 'divisions'), 0);
            if (div > 0) divisions = div;
            const st = num(text(el, 'staves'), 0);
            if (st > 0) staves = st;
            for (const c of kids(el, 'clef')) clefs.set(num(c.getAttribute('number'), 1), text(c, 'sign') || 'G');
            const tr = kid(el, 'transpose');
            if (tr) transpose = num(text(tr, 'chromatic')) + 12 * num(text(tr, 'octave-change'));
            const time = kid(el, 'time');
            if (time && pi === 0) {
              const beats = text(time, 'beats');
              const bt = num(text(time, 'beat-type'), 4);
              if (beats) {
                const n = beats.split('+').reduce((s, x) => s + num(x), 0);
                if (n > 0) {
                  for (let k = mi; k < measureCount; k++) {
                    measures[k].num = n;
                    measures[k].den = bt;
                  }
                }
              }
            }
            const key = kid(el, 'key');
            if (key && keyFifths === undefined) keyFifths = num(text(key, 'fifths'));
            break;
          }
          case 'direction': {
            const offset = q(num(text(el, 'offset')));
            const at = { m: mi, pos: q(pos) + offset };
            for (const dt of kids(el, 'direction-type')) {
              const met = kid(dt, 'metronome');
              if (met && !kid(el, 'sound')?.getAttribute('tempo')) {
                const qpm = metronomeToQpm(met);
                if (qpm && pi === 0) tempos.push({ ...at, bpm: qpm });
              }
              const dynEl = kid(dt, 'dynamics');
              if (dynEl) {
                for (const d of kids(dynEl)) {
                  const name = d.tagName === 'other-dynamics' ? (d.textContent || '').trim() : d.tagName;
                  if (DYNAMICS[name] !== undefined) dyn.push({ ...at, v: DYNAMICS[name] });
                  else if (ACCENTS[name] !== undefined) accents.push({ ...at, v: ACCENTS[name] });
                  else if (name === 'fp') {
                    dyn.push({ ...at, v: DYNAMICS.f });
                    dyn.push({ m: at.m, pos: at.pos + 0.01, v: DYNAMICS.p });
                  }
                }
              }
              const wedge = kid(dt, 'wedge');
              if (wedge) {
                const type = wedge.getAttribute('type');
                if (type === 'crescendo' || type === 'diminuendo') wedges.push({ start: at, stop: null, type });
                else if (type === 'stop') {
                  const open = [...wedges].reverse().find((w) => !w.stop);
                  if (open) open.stop = at;
                }
              }
              const pedal = kid(dt, 'pedal');
              if (pedal && pi === 0) {
                const type = pedal.getAttribute('type');
                if (type === 'start' || type === 'resume') pedals.push({ ...at, value: 1 });
                else if (type === 'stop' || type === 'discontinue') pedals.push({ ...at, value: 0 });
                else if (type === 'change') {
                  pedals.push({ m: at.m, pos: at.pos - 0.02, value: 0 });
                  pedals.push({ ...at, value: 1 });
                }
              }
            }
            const sound = kid(el, 'sound');
            if (sound) handleSound(sound, at, pi, info);
            break;
          }
          case 'sound':
            handleSound(el, { m: mi, pos: q(pos) }, pi, info);
            break;
          case 'backup':
            pos -= num(text(el, 'duration'));
            if (pos < 0) pos = 0;
            break;
          case 'forward':
            pos += num(text(el, 'duration'));
            maxPos = Math.max(maxPos, pos);
            break;
          case 'barline': {
            const rep = kid(el, 'repeat');
            if (rep && pi === 0) {
              if (rep.getAttribute('direction') === 'forward') info.repeatForward = true;
              else {
                info.repeatBackward = true;
                info.times = Math.max(2, num(rep.getAttribute('times'), 2));
              }
            }
            const ending = kid(el, 'ending');
            if (ending && pi === 0) {
              const type = ending.getAttribute('type');
              const nums = (ending.getAttribute('number') || '1')
                .split(/[,\s]+/)
                .map((x) => parseInt(x, 10))
                .filter((x) => x > 0);
              if (type === 'start') {
                openEnding = nums;
                info.endings = nums;
              } else if (type === 'stop' || type === 'discontinue') {
                info.endings = info.endings || nums;
                openEnding = null;
              }
            }
            break;
          }
          case 'note': {
            if (kid(el, 'cue')) break;
            const isChord = !!kid(el, 'chord');
            const isGrace = !!kid(el, 'grace');
            const dur = isGrace ? 0 : num(text(el, 'duration'));
            const start = isChord ? lastStart : pos;
            const pitch = kid(el, 'pitch');
            const staff = num(text(el, 'staff'), 1);
            if (pitch) {
              const step = text(pitch, 'step') || 'C';
              const midi = (num(text(pitch, 'octave'), 4) + 1) * 12 + (STEP_PC[step] ?? 0) + Math.round(num(text(pitch, 'alter'))) + transpose;
              const ties = kids(el, 'tie').map((t) => t.getAttribute('type'));
              const notations = kid(el, 'notations');
              for (const t of notations ? kids(notations, 'tied') : []) ties.push(t.getAttribute('type'));
              const artic = notations ? kid(notations, 'articulations') : null;
              let lengthFactor = 1;
              let accent = 0;
              if (artic) {
                if (kid(artic, 'staccatissimo') || kid(artic, 'spiccato')) lengthFactor = 0.3;
                else if (kid(artic, 'staccato')) lengthFactor = kid(artic, 'tenuto') ? 0.75 : 0.5;
                if (kid(artic, 'accent')) accent += 0.12;
                if (kid(artic, 'strong-accent')) accent += 0.18;
              }
              if (notations && kid(notations, 'fermata')) lengthFactor *= 1.6;
              const dynAttr = el.getAttribute('dynamics');
              const n: RawNote = {
                part: pi,
                m: mi,
                pos: q(start),
                dur: q(dur),
                midi,
                staff,
                hand: handFor(staff),
                tieStart: ties.includes('start'),
                tieStop: ties.includes('stop'),
                velocity: dynAttr ? Math.min(1, (num(dynAttr) * 0.9) / 127) : null,
                accent,
                lengthFactor,
                grace: isGrace,
                arpeggio: !!(notations && kid(notations, 'arpeggiate')),
              };
              if (isGrace) {
                pendingGrace.push(n);
              } else {
                if (pendingGrace.length) {
                  // Grace notes are played just before the main note.
                  const g = Math.min(0.125, n.dur / 4 || 0.125);
                  pendingGrace.forEach((gn, i) => {
                    gn.pos = Math.max(0, n.pos - g * (pendingGrace.length - i));
                    gn.dur = g;
                    gn.m = mi;
                    raw.push(gn);
                  });
                  pendingGrace = [];
                }
                raw.push(n);
                noteCount++;
              }
            }
            if (!isChord) {
              lastStart = pos;
              pos += dur;
            }
            maxPos = Math.max(maxPos, pos);
            break;
          }
        }
      }
      info.length = Math.max(info.length, q(maxPos));
    });
    partInfo.push({ name: partNames.get(pid) || `Part ${pi + 1}`, notes: noteCount });
  });

  function handleSound(sound: Element, at: MarkEvent, pi: number, info: MeasureInfo) {
    const tempo = sound.getAttribute('tempo');
    if (tempo && pi === 0 && num(tempo) > 0) tempos.push({ ...at, bpm: num(tempo) });
    const dynamics = sound.getAttribute('dynamics');
    if (dynamics) dynamicsByPart[pi].push({ ...at, v: Math.min(1, (num(dynamics) * 0.9) / 127) });
    const damper = sound.getAttribute('damper-pedal');
    if (damper && pi === 0) pedals.push({ ...at, value: damper === 'yes' ? 1 : damper === 'no' ? 0 : Math.min(1, num(damper) / 100) });
    if (pi !== 0) return;
    if (sound.getAttribute('segno')) info.segno = sound.getAttribute('segno');
    if (sound.getAttribute('coda')) info.coda = sound.getAttribute('coda');
    if (sound.getAttribute('tocoda')) info.tocoda = sound.getAttribute('tocoda');
    if (sound.getAttribute('dacapo') === 'yes') info.dacapo = true;
    if (sound.getAttribute('dalsegno')) info.dalsegno = sound.getAttribute('dalsegno');
    if (sound.getAttribute('fine')) info.fine = true;
  }

  // Measures with no content at all still take their written length.
  for (const m of measures) if (m.length <= 0) m.length = (m.num * 4) / m.den;

  // Volta groups: consecutive measures with endings.
  for (let i = 0; i < measureCount; ) {
    if (!measures[i].endings) {
      i++;
      continue;
    }
    let j = i;
    let max = 0;
    while (j < measureCount && measures[j].endings) max = Math.max(max, ...measures[j++].endings!);
    for (let k = i; k < j; k++) measures[k].endingGroupMax = max;
    i = j;
  }

  const order = opts.expandRepeats === false ? measures.map((_, i) => i) : playOrder(measures);
  if (order.length > measureCount * 8) warnings.push('Repeat structure looked unusual; playback was capped.');

  // Measure start beats on the expanded timeline.
  const starts: number[] = [];
  const occurrences: number[][] = Array.from({ length: measureCount }, () => []);
  let beat = 0;
  order.forEach((m, k) => {
    starts.push(beat);
    occurrences[m].push(k);
    beat += measures[m].length;
  });

  // Dynamics per part, in source order.
  const byPos = (a: MarkEvent, b: MarkEvent) => a.m - b.m || a.pos - b.pos;
  dynamicsByPart.forEach((d) => d.sort(byPos));
  const dynamicAt = (part: number, m: number, pos: number) => {
    const list = dynamicsByPart[part];
    let v = DYNAMICS.mf;
    for (const d of list) {
      if (d.m < m || (d.m === m && d.pos <= pos + 1e-6)) v = d.v;
      else break;
    }
    return v;
  };
  const nextDynamic = (part: number, ev: MarkEvent) =>
    dynamicsByPart[part].find((d) => d.m > ev.m || (d.m === ev.m && d.pos >= ev.pos - 1e-6));
  // Position on the unexpanded timeline, for hairpin interpolation.
  const srcStart: number[] = [];
  measures.reduce((acc, m, i) => ((srcStart[i] = acc), acc + m.length), 0);
  const srcBeat = (ev: MarkEvent) => (srcStart[Math.min(Math.max(ev.m, 0), measureCount - 1)] ?? 0) + ev.pos;
  const hairpins = wedgesByPart.map((list) =>
    list
      .filter((w) => w.stop)
      .map((w) => {
        const part = wedgesByPart.indexOf(list);
        const a = srcBeat(w.start);
        const b = srcBeat(w.stop!);
        const base = dynamicAt(part, w.start.m, w.start.pos);
        const nd = nextDynamic(part, w.stop!);
        let target = nd && srcBeat(nd) - b < 8 ? nd.v : base + (w.type === 'crescendo' ? 0.15 : -0.15);
        target = w.type === 'crescendo' ? Math.max(target, base) : Math.min(target, base);
        return { a, b, base, target };
      })
      .filter((h) => h.b > h.a),
  );

  const notes: ScoreNote[] = [];
  const tieKey = (n: RawNote) => `${n.part}:${n.midi}`;
  const expanded: (RawNote & { beat: number })[] = [];
  for (const n of raw) {
    for (const k of occurrences[n.m]) expanded.push({ ...n, beat: starts[k] + n.pos });
  }
  expanded.sort((a, b) => a.beat - b.beat || a.midi - b.midi);

  // Arpeggiated chords: roll from the bottom up.
  const arpGroups = new Map<string, (RawNote & { beat: number })[]>();
  for (const n of expanded) {
    if (!n.arpeggio) continue;
    const k = `${n.part}:${n.staff}:${n.beat.toFixed(4)}`;
    if (!arpGroups.has(k)) arpGroups.set(k, []);
    arpGroups.get(k)!.push(n);
  }
  for (const g of arpGroups.values()) {
    g.sort((a, b) => a.midi - b.midi).forEach((n, i) => {
      const shift = Math.min(0.06 * i, n.dur * 0.5);
      n.beat += shift;
      n.dur -= shift;
    });
  }

  const openTies = new Map<string, ScoreNote>();
  for (const n of expanded) {
    const key = tieKey(n);
    if (n.tieStop) {
      const carrier = openTies.get(key);
      if (carrier && Math.abs(carrier.beat + (carrier.beats || 0) - n.beat) < 0.02) {
        carrier.beats = (carrier.beats || 0) + n.dur;
        if (!n.tieStart) openTies.delete(key);
        continue;
      }
    }
    let v = n.velocity ?? dynamicAt(n.part, n.m, n.pos);
    // sf / sfz / fz: a one-off accent on the notes at that spot.
    let sf = 0;
    for (const a of accentsByPart[n.part]) if (a.m === n.m && Math.abs(a.pos - n.pos) < 0.02) sf += a.v;
    // Hairpins.
    const sb = srcBeat(n);
    for (const h of hairpins[n.part]) {
      if (sb >= h.a && sb <= h.b) v = h.base + (h.target - h.base) * ((sb - h.a) / (h.b - h.a));
    }
    // Staccato etc. shorten the sounding length, which also shortens a tie chain's head only.
    const note: ScoreNote = {
      midi: n.midi,
      beat: n.beat,
      beats: n.dur,
      time: 0,
      duration: 0,
      velocity: Math.min(1, v + n.accent + sf),
      hand: n.hand,
      track: n.part,
      staff: n.staff,
      src: { m: n.m, o: n.pos },
      grace: n.grace || undefined,
    };
    (note as ScoreNote & { _lf?: number })._lf = n.lengthFactor;
    notes.push(note);
    if (n.tieStart) openTies.set(key, note);
  }
  for (const n of notes) {
    const lf = (n as ScoreNote & { _lf?: number })._lf ?? 1;
    delete (n as ScoreNote & { _lf?: number })._lf;
    if (lf !== 1) n.beats = Math.max(0.05, (n.beats || 0) * lf);
    if ((n.beats || 0) <= 0) n.beats = 0.1;
  }

  // Tempo and pedal marks on the expanded timeline.
  const expandMarks = <T extends MarkEvent>(list: T[]) => {
    const out: (T & { beat: number })[] = [];
    for (const e of list) {
      const m = Math.min(Math.max(0, e.m), measureCount - 1);
      for (const k of occurrences[m]) out.push({ ...e, beat: starts[k] + e.pos });
    }
    return out.sort((a, b) => a.beat - b.beat);
  };
  const tempoPoints = expandMarks(tempos).map((t) => ({ beat: t.beat, bpm: t.bpm }));
  if (!tempoPoints.length || tempoPoints[0].beat > 0.001) tempoPoints.unshift({ beat: 0, bpm: tempoPoints[0]?.bpm || 120 });
  // A pedal mark usually comes with an equivalent <sound damper-pedal>; keep one of each.
  const seenPedal = new Set<string>();
  const uniquePedals = pedals.filter((p) => {
    const k = `${p.m}:${p.pos.toFixed(3)}:${p.value}`;
    if (seenPedal.has(k)) return false;
    seenPedal.add(k);
    return true;
  });
  const pedalEvents: PedalEvent[] = expandMarks(uniquePedals).map((p) => ({ beat: p.beat, time: 0, value: p.value, kind: 'sustain' }));

  const measureList = order.map((m, k) => ({ src: m, beat: starts[k], num: measures[m].num, den: measures[m].den, length: measures[m].length }));
  const sigs: TimeSigPoint[] = [];
  for (const m of measureList) {
    const last = sigs[sigs.length - 1];
    if (!last || last.num !== m.num || last.den !== m.den) sigs.push({ beat: m.beat, num: m.num, den: m.den });
  }

  if (!notes.length) warnings.push('No playable (pitched) notes were found in this score.');

  return finalizeScore({
    title,
    composer,
    format: 'musicxml',
    fileName: opts.fileName,
    notes,
    pedals: pedalEvents,
    tempos: tempoPoints,
    timeSignatures: sigs,
    measures: measureList,
    timing: 'beats',
    musicXml: displayXml,
    keyFifths,
    parts: partInfo,
    warnings,
  });
}

/** Unrolls repeats, voltas and D.C./D.S. jumps into a list of measure indices. */
export function playOrder(measures: MeasureInfo[]): number[] {
  const n = measures.length;
  const order: number[] = [];
  const taken = new Map<number, number>();
  let i = 0;
  let pass = 1;
  let repeatStart = 0;
  let jumpedBack = false;
  let afterJump = false;
  let jumps = 0;
  const limit = n * 8 + 16;
  while (i < n && order.length < limit) {
    const m = measures[i];
    if (m.repeatForward && !jumpedBack && !afterJump) {
      repeatStart = i;
      pass = 1;
    }
    jumpedBack = false;
    if (m.endings) {
      const want = afterJump ? m.endingGroupMax : pass;
      if (!m.endings.includes(want)) {
        i++;
        continue;
      }
    }
    order.push(i);
    if (afterJump && m.fine) break;
    if (afterJump && m.tocoda) {
      const target = measures.findIndex((x, k) => k > i && x.coda === m.tocoda);
      const fallback = measures.findIndex((x, k) => k > i && x.coda);
      const t = target >= 0 ? target : fallback;
      if (t >= 0) {
        i = t;
        continue;
      }
    }
    if (m.repeatBackward && !afterJump) {
      const t = taken.get(i) || 0;
      if (t < m.times - 1) {
        taken.set(i, t + 1);
        pass++;
        i = repeatStart;
        jumpedBack = true;
        continue;
      }
      taken.set(i, 0);
      repeatStart = i + 1;
      pass = 1;
    }
    if (!afterJump && jumps === 0 && (m.dacapo || m.dalsegno)) {
      jumps++;
      afterJump = true;
      if (m.dacapo) i = 0;
      else {
        const s = measures.findIndex((x) => x.segno === m.dalsegno);
        i = s >= 0 ? s : measures.findIndex((x) => x.segno) >= 0 ? measures.findIndex((x) => x.segno) : 0;
      }
      continue;
    }
    i++;
  }
  return order;
}
