import { describe, expect, it } from 'vitest';
import { buildSessionAbc, parseMutopiaResults, PROVIDERS, sessionKey } from '../src/search/providers';
import { parseAbc } from '../src/score/abc';
import { loadScore } from '../src/score/loader';
import { scoreToMidi } from '../src/audio/recorder';
import { zipSync } from 'fflate';

// Markup as produced by Mutopia's cgibin/make-table.cgi (github.com/MutopiaProject/MutopiaWeb).
const mutopiaPage = `<html><body><table class="outer-table">
<tr><td>
<table class="table-bordered result-table">
<tr><td>Sonata No. 14 "Moonlight"</td>
<td>by L. v. Beethoven (1770–1827)</td>
<td>Op. 27, No. 2</td>
<td>&nbsp;</td>
</tr><tr>
<td>for Piano</td>
<td>1801</td>
<td>Classical</td>
<td>&nbsp;</td>
</tr><tr>
<td>Urtext</td>
<td><a href="../legal.html#publicdomain">Public Domain</a></td>
<td><a href="piece-info.cgi?id=1234">More Information</a></td>
<td>2020/01/02</td>
</tr><tr>
<td>Download: <a href="https://www.mutopiaproject.org/ftp/BeethovenLv/O27/moonlight/moonlight.ly">.ly file</a></td>
<td><a href="https://www.mutopiaproject.org/ftp/BeethovenLv/O27/moonlight/moonlight.mid">.mid file</a></td>
<td><a href="https://www.mutopiaproject.org/ftp/BeethovenLv/O27/moonlight/moonlight-preview.png">Preview image</a></td>
<td><a href="https://www.mutopiaproject.org/ftp/BeethovenLv/O27/moonlight/">Appropriate FTP area</a></td>
</tr><tr>
<td><a href="https://www.mutopiaproject.org/ftp/BeethovenLv/O27/moonlight/moonlight-a4.pdf">A4 .pdf file</a></td>
</tr>
</table>
</tr></td>
<tr><td>
<table class="table-bordered result-table">
<tr><td>Piano Sonata</td>
<td>by W. A. Mozart</td>
<td>K. 331</td>
<td>&nbsp;</td>
</tr><tr>
<td>for Piano</td><td>1783</td><td>Classical</td><td>&nbsp;</td>
</tr><tr>
<td>&nbsp;</td><td><a href="../legal.html#ccasa">CC BY-SA</a></td><td><a href="piece-info.cgi?id=99">More Information</a></td><td>2019/05/05</td>
</tr><tr>
<td class="zipped">Download: <a href="https://www.mutopiaproject.org/ftp/MozartWA/KV331/K331/K331-lys.zip">.ly files (zipped)</a></td>
<td class="zipped"><a href="https://www.mutopiaproject.org/ftp/MozartWA/KV331/K331/K331-mids.zip">.mid files (zipped)</a></td>
</tr>
</table>
</tr></td>
</table>
<a href="make-table.cgi?startat=10&searchingfor=moonlight&Composer=&Instrument=">Next 10</a>
</body></html>`;

describe('Mutopia results', () => {
  it('reads each result table (not the outer table)', () => {
    const { results, nextStart } = parseMutopiaResults(mutopiaPage, 'https://www.mutopiaproject.org/cgibin/make-table.cgi?searchingfor=moonlight');
    expect(results.map((r) => r.title)).toEqual(['Sonata No. 14 "Moonlight"', 'Piano Sonata']);
    expect(results[0].composer).toBe('L. v. Beethoven (1770–1827)');
    expect(results[0].detail).toContain('for Piano');
    expect(results[0].pageUrl).toBe('https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=1234');
    expect(results[1].detail).toContain('several movements');
    expect(nextStart).toBe(10);
  });

  it('opens zipped multi-movement MIDI downloads', () => {
    const one = scoreToMidi(loadScore(new TextEncoder().encode('X:1\nT:a\nK:C\nCDEF|'), { fileName: 'a.abc' }));
    const zip = zipSync({ 'K331-1.mid': one, 'K331-2.mid': one });
    const s = loadScore(zip, { fileName: 'K331-mids.zip' });
    expect(s.format).toBe('midi');
    expect(s.notes.map((n) => n.midi)).toEqual([60, 62, 64, 65]);
    expect(s.warnings[0]).toMatch(/2 MIDI files/);
  });
});

describe('The Session', () => {
  it('maps keys and modes to ABC K: fields', () => {
    expect(sessionKey('Gmajor')).toBe('G');
    expect(sessionKey('Edorian')).toBe('Edor');
    expect(sessionKey('Aminor')).toBe('Am');
    expect(sessionKey('Dmixolydian')).toBe('Dmix');
    expect(sessionKey('Bbmajor')).toBe('Bb');
  });

  it('builds playable ABC from real tune data', () => {
    // Bodies copied from The Session's public data dump (github.com/adactio/TheSession-data).
    const hornpipe = buildSessionAbc("'Ma' McNulty's Favourite", 'hornpipe', 'Edorian',
      'B2 E>F G>A B2|A2 D>E F>G A2| B2 E>F G>AB>c| d>BA>F E2 d>c|\r\nB2 E>F G>A B2|A2 D>E F>G A2| B2 E>F G>AB>c| d>BA>F E2E2||');
    const strathspey = buildSessionAbc("'S Ann An Ìle", 'strathspey', 'Gmajor',
      'uD2|:{F}v[G,2G2]uB>ud c>A B>G|{D}E2 uA>uG F<D D>F|{F}[G,2G2]uB>ud c>A B>G|1 E>A F<D {F}G2 uG>uD:|2 E>A F<D {F}G2 (G>E)|');
    const a = parseAbc(hornpipe);
    expect(a.title).toBe("'Ma' McNulty's Favourite");
    expect(a.timeSignatures[0]).toMatchObject({ num: 4, den: 4 });
    expect(a.notes.length).toBeGreaterThan(40);
    const b = parseAbc(strathspey);
    expect(b.notes.length).toBeGreaterThan(20);
    expect(buildSessionAbc('Jig', 'jig', 'Dmajor', 'ABC')).toContain('M:6/8');
  });
});

describe('catalog providers', () => {
  it('search the bundled ASAP index', async () => {
    const asap = PROVIDERS.find((p) => p.id === 'asap')!;
    const page = await asap.search('moonlight', 0);
    expect(page.results.length).toBeGreaterThan(0);
    expect(page.results[0].title).toMatch(/Moonlight/);
    const chopin = await asap.search('chopin etude', 0);
    expect(chopin.results.every((r) => r.composer === 'Chopin')).toBe(true);
    const all = await asap.search('', 0);
    expect(all.total).toBeGreaterThan(200);
    expect(all.hasMore).toBe(true);
  });

  it('search the music21 corpus index', async () => {
    const m21 = PROVIDERS.find((p) => p.id === 'music21')!;
    const page = await m21.search('joplin', 0);
    expect(page.results[0].format).toBe('mxl');
  });
});
