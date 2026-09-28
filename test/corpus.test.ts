// Optional: parses every score in $PIANOMAN_CORPUS (a folder of real-world
// files) and checks it converts cleanly. Skipped when the variable is unset.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ensureNotation, loadScore } from '../src/score/loader';
import { parseMusicXml } from '../src/score/musicxml';

const dir = process.env.PIANOMAN_CORPUS;
const files = dir ? readdirSync(dir).filter((f) => /\.(musicxml|xml|mxl|mid|midi|abc)$/i.test(f)) : [];

describe.skipIf(!dir)('real-world corpus', () => {
  for (const f of files) {
    it(f, { timeout: 60000 }, () => {
      const t0 = performance.now();
      const s = loadScore(new Uint8Array(readFileSync(join(dir!, f))), { fileName: f });
      const t1 = performance.now();
      expect(s.notes.length).toBeGreaterThan(0);
      expect(s.duration).toBeGreaterThan(0);
      let extra = '';
      if (s.format === 'midi' || s.format === 'abc') {
        const xml = ensureNotation(s);
        const back = parseMusicXml(xml);
        extra = ` notation: ${back.notes.length} notes`;
      }
      for (const n of s.notes) {
        expect(Number.isFinite(n.time) && Number.isFinite(n.duration) && n.duration > 0).toBe(true);
        expect(n.src).toBeDefined();
      }
      const hands = { L: s.notes.filter((n) => n.hand === 'L').length, R: s.notes.filter((n) => n.hand === 'R').length };
      console.log(
        `${f}: "${s.title}" ${s.format} notes=${s.notes.length} L/R=${hands.L}/${hands.R} measures=${s.measures.length} ` +
          `dur=${s.duration.toFixed(1)}s tempo=${s.tempos[0].bpm.toFixed(0)} pedals=${s.pedals.length} parse=${(t1 - t0).toFixed(0)}ms${extra} ${s.warnings.join(' ')}`,
      );
    });
  }
});
