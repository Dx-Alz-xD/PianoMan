// Detects a score's format and converts it into the common model.

import { parseAbc } from './abc';
import { parseMidi } from './midi';
import type { Score } from './model';
import { parseMusicXml } from './musicxml';
import { decodeText, extractMxl, isZip, zipContents } from './mxl';
import { generateMusicXml } from './notation';

export const SCORE_EXTENSIONS = ['musicxml', 'xml', 'mxl', 'mid', 'midi', 'kar', 'abc'];

export type DetectedFormat = 'musicxml' | 'mxl' | 'midi' | 'abc' | 'unknown';

export function detectFormat(data: Uint8Array, fileName = ''): DetectedFormat {
  if (data.length >= 4 && data[0] === 0x4d && data[1] === 0x54 && data[2] === 0x68 && data[3] === 0x64) return 'midi'; // MThd
  if (data.length >= 12 && String.fromCharCode(...data.slice(0, 4)) === 'RIFF' && String.fromCharCode(...data.slice(8, 12)) === 'RMID') return 'midi';
  if (isZip(data)) return 'mxl';
  const head = decodeText(data.slice(0, 4096));
  if (/<score-(partwise|timewise)/.test(head) || (/^\s*<\?xml/.test(head) && /\.(musicxml|xml)$/i.test(fileName))) return 'musicxml';
  if (/^\s*(X:\s*\d*|T:|%abc|K:)/m.test(head) && /^K:/m.test(decodeText(data.slice(0, 65536)))) return 'abc';
  const ext = fileName.split('.').pop()?.toLowerCase() || '';
  if (ext === 'abc') return 'abc';
  if (ext === 'mid' || ext === 'midi' || ext === 'kar') return 'midi';
  if (ext === 'mxl') return 'mxl';
  if (ext === 'musicxml' || ext === 'xml') return 'musicxml';
  return 'unknown';
}

export interface LoadOptions {
  fileName?: string;
  source?: string;
  sourceUrl?: string;
  tuneIndex?: number;
}

export function loadScore(data: Uint8Array, opts: LoadOptions = {}): Score {
  const format = detectFormat(data, opts.fileName);
  let score: Score;
  switch (format) {
    case 'midi':
      score = parseMidi(data, opts.fileName);
      break;
    case 'mxl': {
      const contents = zipContents(data);
      if (contents.kind === 'midi') {
        // e.g. Mutopia's multi-movement downloads: open the first movement.
        const first = contents.midi![0];
        score = parseMidi(first.data, first.name);
        if (contents.midi!.length > 1) score.warnings.push(`This archive has ${contents.midi!.length} MIDI files; opened "${first.name}".`);
        break;
      }
      const { xml } = extractMxl(data);
      score = parseMusicXml(xml, { fileName: opts.fileName });
      score.format = 'mxl';
      break;
    }
    case 'musicxml':
      score = parseMusicXml(decodeText(data), { fileName: opts.fileName });
      break;
    case 'abc':
      score = parseAbc(decodeText(data), { fileName: opts.fileName, tuneIndex: opts.tuneIndex });
      break;
    default:
      throw new Error('Unrecognised file. PianoMan reads MusicXML (.musicxml, .xml, .mxl), MIDI (.mid, .midi, .kar) and ABC (.abc).');
  }
  score.source = opts.source;
  score.sourceUrl = opts.sourceUrl;
  if (!score.notes.length) throw new Error('This score contains no playable notes.');
  return score;
}

/**
 * Makes sure the score has MusicXML for the sheet view. MIDI, ABC and
 * recordings get notation generated (and their notes linked to it) on demand.
 */
export function ensureNotation(score: Score): string {
  if (score.musicXml) return score.musicXml;
  const res = generateMusicXml({
    title: score.title,
    composer: score.composer,
    notes: score.notes,
    timeSignatures: score.timeSignatures,
    tempos: score.tempos,
    keyFifths: score.keyFifths,
    pickupBeats: (score as Score & { pickupBeats?: number }).pickupBeats,
    pedals: score.pedals.filter((p) => p.kind === 'sustain'),
  });
  score.notes.forEach((n, i) => (n.src = res.positions[i]));
  score.keyFifths = res.keyFifths;
  score.musicXml = res.xml;
  score.generatedNotation = true;
  return res.xml;
}
