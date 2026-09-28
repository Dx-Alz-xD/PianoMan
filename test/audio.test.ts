import { describe, expect, it } from 'vitest';
import { noteDetune, stretchCents, temperamentOffsets, TEMPERAMENTS } from '../src/audio/tuning';
import { INSTRUMENTS, sampleUrls, type SampledInstrument } from '../src/audio/instruments';
import { selectRegions } from '../src/audio/samples';
import { FACTORY_PRESETS } from '../src/audio/presets';
import { PARAMS, DEFAULT_SOUND } from '../src/core/settings';

describe('tuning', () => {
  it('keeps A at the reference pitch in every temperament', () => {
    for (const t of TEMPERAMENTS) for (let root = 0; root < 12; root++) expect(temperamentOffsets(t.id, root)[9]).toBeCloseTo(0, 6);
  });

  it('equal temperament has no offsets', () => {
    expect(temperamentOffsets('equal', 3).every((o) => Math.abs(o) < 1e-9)).toBe(true);
  });

  it('just intonation has a pure major third', () => {
    const o = temperamentOffsets('just', 0);
    expect(o[4] - o[0]).toBeCloseTo(-13.686, 2); // 386.31 - 400
  });

  it('shifts pitch with A4 and stretches the extremes', () => {
    const p = { a4: 415, fineTune: 0, temperament: 'equal', temperamentRoot: 0, stretch: 0 };
    expect(noteDetune(69, p)).toBeCloseTo(1200 * Math.log2(415 / 440), 6);
    expect(stretchCents(108, 1)).toBeGreaterThan(20);
    expect(stretchCents(21, 1)).toBeLessThan(-20);
    expect(stretchCents(69, 1)).toBe(0);
  });
});

describe('instruments', () => {
  it('have unique ids and full keyboard coverage', () => {
    const ids = new Set(INSTRUMENTS.map((i) => i.id));
    expect(ids.size).toBe(INSTRUMENTS.length);
    for (const inst of INSTRUMENTS) {
      if (inst.kind !== 'sampled') continue;
      const regions = inst.regions();
      expect(regions.length, inst.id).toBeGreaterThan(0);
      for (const r of regions) expect(r.path, inst.id).toBeTruthy();
    }
  });

  it('encodes sample paths into mirror URLs', () => {
    const splendid = INSTRUMENTS.find((i) => i.id === 'splendid-grand') as SampledInstrument;
    const urls = sampleUrls(splendid, 'samples/PP C#1');
    expect(urls[0]).toBe('https://smpldsnds.github.io/sfzinstruments-splendid-grand-piano/samples/PP%20C%231.ogg');
    expect(urls[1]).toContain('raw.githubusercontent.com/smpldsnds/sfzinstruments-splendid-grand-piano/main/');
  });

  it('reduces velocity layers for lighter quality levels', () => {
    const splendid = INSTRUMENTS.find((i) => i.id === 'splendid-grand') as SampledInstrument;
    const all = splendid.regions();
    const light = selectRegions(all, 'light');
    const balanced = selectRegions(all, 'balanced');
    expect(light.length).toBeLessThan(balanced.length);
    expect(balanced.length).toBeLessThan(all.length);
    // Every key still has a sample in light mode.
    for (let k = 21; k <= 108; k++) expect(light.some((r) => r.lo <= k && k <= r.hi), `key ${k}`).toBe(true);
  });

  it('presets reference existing instruments and valid settings', () => {
    const ids = new Set(INSTRUMENTS.map((i) => i.id));
    for (const p of FACTORY_PRESETS) {
      expect(ids.has(p.sound.instrument!), p.id).toBe(true);
      for (const k of Object.keys(p.sound)) expect(k in DEFAULT_SOUND, `${p.id}.${k}`).toBe(true);
    }
  });

  it('every parameter has a default', () => {
    for (const p of PARAMS) expect(p.key in DEFAULT_SOUND, p.key).toBe(true);
  });
});
