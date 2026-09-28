// Instrument catalog. Sampled instruments are streamed from public sample
// libraries on GitHub (with a mirror fallback) and cached on disk by the
// desktop shell; synth instruments are generated locally and need no network.

import sfzData from './data/sfz-instruments.json';
import { parseNoteName } from '../core/music';

export type Trigger = 'a' | 'r' | 'pd' | 'pu';

export interface Region {
  path: string;
  key: number;
  lo: number;
  hi: number;
  vl: number;
  vh: number;
  db: number;
  tune: number;
  offset: number;
  trigger: Trigger;
  pedal?: 'd' | 'u';
  rrPos?: number;
  rrLen?: number;
  undamped?: boolean;
  noKeytrack?: boolean;
  cutoff?: number;
  attack?: number;
}

export type Category = 'Grand pianos' | 'Upright pianos' | 'Electric pianos' | 'Keys & mallets' | 'Organs' | 'Offline (synthesized)';

interface BaseInstrument {
  id: string;
  name: string;
  category: Category;
  description: string;
  credit: string;
  license: string;
  homepage?: string;
  /** Behaves like an acoustic piano: dampers, string resonance, stretch tuning. */
  piano: boolean;
  /** Keys at and above this MIDI note have no dampers (real pianos: ~F6 up). */
  undampedFrom?: number;
  /** Organs: sound stops as soon as the key is released. */
  sustaining?: boolean;
}

export interface SampledInstrument extends BaseInstrument {
  kind: 'sampled';
  hosts: string[];
  ext: 'ogg' | 'mp3';
  sizeHint: string;
  /** Fraction of the dynamic-range setting applied as gain (layered sets already get softer). */
  veltrack: number;
  regions(): Region[];
}

export interface SynthInstrument extends BaseInstrument {
  kind: 'synth';
  engine: 'piano' | 'epiano' | 'organ';
}

export type Instrument = SampledInstrument | SynthInstrument;

// --------------------------------------------------------------- helpers ----

interface RawRegion {
  s: string; k: number; lo: number; hi: number; vl: number; vh: number;
  db?: number; t?: number; o?: number; fc?: number; tr?: Trigger; pc?: 'd' | 'u';
  u?: number; rl?: number; rp?: number; nk?: number; at?: number;
}

const SFZ = sfzData as unknown as Record<string, { repo: string; regions: RawRegion[] }>;

function sfzRegions(id: string): Region[] {
  return SFZ[id].regions.map((r) => ({
    path: r.s,
    key: r.k,
    lo: r.lo,
    hi: r.hi,
    vl: r.vl,
    vh: r.vh,
    db: Math.max(-30, Math.min(40, r.db || 0)),
    tune: r.t || 0,
    offset: r.o || 0,
    trigger: r.tr || 'a',
    pedal: r.pc,
    rrLen: r.rl,
    rrPos: r.rp,
    undamped: !!r.u,
    noKeytrack: !!r.nk,
    cutoff: r.fc,
    attack: r.at,
  }));
}

function githubHosts(repo: string, branch = 'main'): string[] {
  const [owner, name] = repo.split('/');
  return [`https://${owner.toLowerCase()}.github.io/${name}/`, `https://raw.githubusercontent.com/${repo}/${branch}/`];
}

/** Spreads single-velocity samples over the keyboard: each covers half-way to its neighbours. */
function spread(samples: { key: number; path: string }[], lo = 21, hi = 108): Region[] {
  const sorted = [...samples].sort((a, b) => a.key - b.key);
  return sorted.map((s, i) => {
    const prev = sorted[i - 1];
    const next = sorted[i + 1];
    return {
      path: s.path,
      key: s.key,
      lo: prev ? Math.floor((prev.key + s.key) / 2) + 1 : Math.min(lo, s.key),
      hi: next ? Math.floor((s.key + next.key) / 2) : Math.max(hi, s.key),
      vl: 0,
      vh: 127,
      db: 0,
      tune: 0,
      offset: 0,
      trigger: 'a' as Trigger,
    };
  });
}

const FLATS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
const TONE_SHARPS = ['C', 'Cs', 'D', 'Ds', 'E', 'F', 'Fs', 'G', 'Gs', 'A', 'As', 'B'];
const nameOf = (midi: number, names: string[]) => names[midi % 12] + (Math.floor(midi / 12) - 1);

/** A MIDI.js soundfont instrument (gleitz/midi-js-soundfonts): one mp3 per key A0..C8. */
function soundfont(font: 'FluidR3_GM' | 'MusyngKite' | 'FatBoy', inst: string, lo = 21, hi = 108): Pick<SampledInstrument, 'hosts' | 'ext' | 'regions'> {
  return {
    hosts: [
      `https://gleitz.github.io/midi-js-soundfonts/${font}/${inst}-mp3/`,
      `https://raw.githubusercontent.com/gleitz/midi-js-soundfonts/gh-pages/${font}/${inst}-mp3/`,
    ],
    ext: 'mp3',
    regions: () => {
      const samples = [];
      for (let m = lo; m <= hi; m++) samples.push({ key: m, path: nameOf(m, FLATS) });
      return spread(samples, 0, 127);
    },
  };
}

const PAGES_SPLENDID = githubHosts('smpldsnds/sfzinstruments-splendid-grand-piano');
const PAGES_VCSL = githubHosts('smpldsnds/sgossner-vcsl');
const PAGES_GS = githubHosts('smpldsnds/sfzinstruments-greg-sullivan-e-pianos');

const VCSL_CREDIT = 'Versilian Community Sample Library by Sam Gossner, hosted by smpldsnds';
const VCSL_HOME = 'https://github.com/sgossner/VCSL';
const MIDIJS_HOME = 'https://github.com/gleitz/midi-js-soundfonts';

// ---------------------------------------------------------------- catalog ----

export const INSTRUMENTS: Instrument[] = [
  // Grand pianos
  {
    kind: 'sampled', id: 'splendid-grand', name: 'Splendid Grand (Steinway D)', category: 'Grand pianos', piano: true,
    description: 'Steinway concert grand with four velocity layers. The richest acoustic piano in PIANO-BEATS.',
    credit: 'AKAI sample set, SFZ mapping by kinwie, hosted by smpldsnds', license: 'Public domain',
    homepage: 'https://github.com/sfzinstruments/SplendidGrandPiano',
    hosts: PAGES_SPLENDID, ext: 'ogg', sizeHint: '≈ 30 MB', veltrack: 0.55, regions: () => sfzRegions('splendid-grand'),
  },
  {
    kind: 'sampled', id: 'salamander', name: 'Salamander Grand (Yamaha C5)', category: 'Grand pianos', piano: true, undampedFrom: 89,
    description: 'Warm, well-balanced Yamaha C5 grand. Quick to download.',
    credit: 'Alexander Holm, via Tone.js', license: 'CC BY 3.0', homepage: 'https://archive.org/details/SalamanderGrandPianoV3',
    hosts: ['https://tonejs.github.io/audio/salamander/', 'https://raw.githubusercontent.com/Tonejs/audio/master/salamander/'],
    ext: 'mp3', sizeHint: '≈ 2.5 MB', veltrack: 1,
    regions: () => {
      const samples = [];
      for (let m = 21; m <= 108; m += 3) samples.push({ key: m, path: nameOf(m, TONE_SHARPS) });
      return spread(samples, 0, 127);
    },
  },
  {
    kind: 'sampled', id: 'vcsl-steinway-b', name: 'Steinway B (close, pedal-aware)', category: 'Grand pianos', piano: true,
    description: 'Close-miked Steinway B with separate samples recorded with the sustain pedal up and down, plus release samples.',
    credit: VCSL_CREDIT, license: 'CC0', homepage: VCSL_HOME,
    hosts: PAGES_VCSL, ext: 'ogg', sizeHint: '≈ 45 MB', veltrack: 0.6, regions: () => sfzRegions('vcsl-steinway-b'),
  },
  {
    kind: 'sampled', id: 'vcsl-kawai-grand', name: 'Kawai Grand', category: 'Grand pianos', piano: true,
    description: 'Mellow Kawai grand piano with release samples.',
    credit: VCSL_CREDIT, license: 'CC0', homepage: VCSL_HOME,
    hosts: PAGES_VCSL, ext: 'ogg', sizeHint: '≈ 25 MB', veltrack: 0.6, regions: () => sfzRegions('vcsl-kawai-grand'),
  },
  {
    kind: 'sampled', id: 'mk-grand', name: 'Soundfont Grand (MusyngKite)', category: 'Grand pianos', piano: true, undampedFrom: 89,
    description: 'Lightweight General-MIDI grand, one sample per key.',
    credit: 'MusyngKite soundfont, via midi-js-soundfonts', license: 'CC BY-SA 3.0', homepage: MIDIJS_HOME,
    sizeHint: '≈ 2 MB', veltrack: 1, ...soundfont('MusyngKite', 'acoustic_grand_piano'),
  },
  {
    kind: 'sampled', id: 'fluid-bright', name: 'Bright Grand (FluidR3)', category: 'Grand pianos', piano: true, undampedFrom: 89,
    description: 'Bright, cutting pop/rock grand.',
    credit: 'FluidR3 GM soundfont by Frank Wen, via midi-js-soundfonts', license: 'CC BY 3.0', homepage: MIDIJS_HOME,
    sizeHint: '≈ 2 MB', veltrack: 1, ...soundfont('FluidR3_GM', 'bright_acoustic_piano'),
  },

  // Upright pianos
  {
    kind: 'sampled', id: 'vcsl-upright-yamaha', name: 'Yamaha Upright', category: 'Upright pianos', piano: true, undampedFrom: 89,
    description: 'Intimate upright with round-robin samples and release noises. Great for felt/lo-fi sounds.',
    credit: VCSL_CREDIT, license: 'CC0', homepage: VCSL_HOME,
    hosts: PAGES_VCSL, ext: 'ogg', sizeHint: '≈ 20 MB', veltrack: 0.6, regions: () => sfzRegions('vcsl-upright-yamaha'),
  },
  {
    kind: 'sampled', id: 'vcsl-upright-knight', name: 'Knight Upright (with mechanics)', category: 'Upright pianos', piano: true,
    description: 'Vintage upright including sampled pedal and key-release mechanics.',
    credit: VCSL_CREDIT, license: 'CC0', homepage: VCSL_HOME,
    hosts: PAGES_VCSL, ext: 'ogg', sizeHint: '≈ 18 MB', veltrack: 0.6, regions: () => sfzRegions('vcsl-upright-knight'),
  },
  {
    kind: 'sampled', id: 'mk-honkytonk', name: 'Honky-tonk Upright', category: 'Upright pianos', piano: true, undampedFrom: 89,
    description: 'Detuned saloon piano.',
    credit: 'MusyngKite soundfont, via midi-js-soundfonts', license: 'CC BY-SA 3.0', homepage: MIDIJS_HOME,
    sizeHint: '≈ 2 MB', veltrack: 1, ...soundfont('MusyngKite', 'honkytonk_piano'),
  },

  // Electric pianos
  {
    kind: 'sampled', id: 'gs-wurlitzer', name: 'Wurlitzer EP200', category: 'Electric pianos', piano: false,
    description: 'Reedy, barky Wurlitzer with four dynamic layers.',
    credit: 'Greg Sullivan, SFZ by kinwie, hosted by smpldsnds', license: 'CC BY 3.0',
    homepage: 'https://github.com/sfzinstruments/GregSullivan.E-Pianos',
    hosts: PAGES_GS, ext: 'ogg', sizeHint: '≈ 6 MB', veltrack: 0.5, regions: () => sfzRegions('gs-wurlitzer'),
  },
  {
    kind: 'sampled', id: 'gs-cp80', name: 'Yamaha CP-80 Electric Grand', category: 'Electric pianos', piano: false,
    description: 'The 80s electric grand: string piano with pickups.',
    credit: 'Greg Sullivan, SFZ by kinwie, hosted by smpldsnds', license: 'CC BY 3.0',
    homepage: 'https://github.com/sfzinstruments/GregSullivan.E-Pianos',
    hosts: PAGES_GS, ext: 'ogg', sizeHint: '≈ 12 MB', veltrack: 0.5, regions: () => sfzRegions('gs-cp80'),
  },
  {
    kind: 'sampled', id: 'gs-pianet', name: 'Hohner Pianet T', category: 'Electric pianos', piano: false,
    description: 'Soft, woody 60s electric piano.',
    credit: 'Greg Sullivan, SFZ by kinwie, hosted by smpldsnds', license: 'CC BY 3.0',
    homepage: 'https://github.com/sfzinstruments/GregSullivan.E-Pianos',
    hosts: PAGES_GS, ext: 'ogg', sizeHint: '≈ 5 MB', veltrack: 0.6, regions: () => sfzRegions('gs-pianet'),
  },
  {
    kind: 'sampled', id: 'fluid-ep1', name: 'Tine Electric Piano', category: 'Electric pianos', piano: false,
    description: 'Rhodes-style tine piano. Add tremolo and chorus for the classic sound.',
    credit: 'FluidR3 GM soundfont by Frank Wen, via midi-js-soundfonts', license: 'CC BY 3.0', homepage: MIDIJS_HOME,
    sizeHint: '≈ 2 MB', veltrack: 1, ...soundfont('FluidR3_GM', 'electric_piano_1'),
  },
  {
    kind: 'sampled', id: 'fluid-ep2', name: 'FM Electric Piano', category: 'Electric pianos', piano: false,
    description: 'Glassy DX7-style FM electric piano.',
    credit: 'FluidR3 GM soundfont by Frank Wen, via midi-js-soundfonts', license: 'CC BY 3.0', homepage: MIDIJS_HOME,
    sizeHint: '≈ 2 MB', veltrack: 1, ...soundfont('FluidR3_GM', 'electric_piano_2'),
  },
  {
    kind: 'sampled', id: 'vcsl-tx81z', name: 'TX81Z FM Piano', category: 'Electric pianos', piano: false,
    description: 'Yamaha TX81Z FM piano patch, three velocity layers.',
    credit: VCSL_CREDIT, license: 'CC0', homepage: VCSL_HOME,
    hosts: PAGES_VCSL, ext: 'ogg', sizeHint: '≈ 8 MB', veltrack: 0.6, regions: () => sfzRegions('vcsl-tx81z-piano'),
  },

  // Keys & mallets
  {
    kind: 'sampled', id: 'vcsl-harpsichord', name: 'Flemish Harpsichord', category: 'Keys & mallets', piano: false,
    description: 'Two-manual Flemish harpsichord (8′ + 4′) with jack release samples.',
    credit: VCSL_CREDIT, license: 'CC0', homepage: VCSL_HOME,
    hosts: PAGES_VCSL, ext: 'ogg', sizeHint: '≈ 12 MB', veltrack: 0.2, regions: () => sfzRegions('vcsl-harpsichord'),
  },
  {
    kind: 'sampled', id: 'fluid-clavinet', name: 'Clavinet', category: 'Keys & mallets', piano: false,
    description: 'Funky Hohner clavinet.',
    credit: 'FluidR3 GM soundfont by Frank Wen, via midi-js-soundfonts', license: 'CC BY 3.0', homepage: MIDIJS_HOME,
    sizeHint: '≈ 2 MB', veltrack: 1, ...soundfont('FluidR3_GM', 'clavinet'),
  },
  {
    kind: 'sampled', id: 'mk-celesta', name: 'Celesta', category: 'Keys & mallets', piano: false, undampedFrom: 0,
    description: 'Sugar-plum celesta.',
    credit: 'MusyngKite soundfont, via midi-js-soundfonts', license: 'CC BY-SA 3.0', homepage: MIDIJS_HOME,
    sizeHint: '≈ 2 MB', veltrack: 1, ...soundfont('MusyngKite', 'celesta'),
  },
  {
    kind: 'sampled', id: 'mk-musicbox', name: 'Music Box', category: 'Keys & mallets', piano: false, undampedFrom: 0,
    description: 'Wind-up music box comb.',
    credit: 'MusyngKite soundfont, via midi-js-soundfonts', license: 'CC BY-SA 3.0', homepage: MIDIJS_HOME,
    sizeHint: '≈ 2 MB', veltrack: 1, ...soundfont('MusyngKite', 'music_box'),
  },
  {
    kind: 'sampled', id: 'vcsl-vibraphone', name: 'Vibraphone (soft mallets)', category: 'Keys & mallets', piano: false,
    description: 'Warm vibraphone. The sustain pedal works like the vibes damper bar.',
    credit: VCSL_CREDIT, license: 'CC0', homepage: VCSL_HOME,
    hosts: PAGES_VCSL, ext: 'ogg', sizeHint: '≈ 4 MB', veltrack: 0.7, regions: () => sfzRegions('vcsl-vibraphone'),
  },
  {
    kind: 'sampled', id: 'vcsl-marimba', name: 'Marimba', category: 'Keys & mallets', piano: false, undampedFrom: 0,
    description: 'Rosewood marimba.',
    credit: VCSL_CREDIT, license: 'CC0', homepage: VCSL_HOME,
    hosts: PAGES_VCSL, ext: 'ogg', sizeHint: '≈ 3 MB', veltrack: 0.8, regions: () => sfzRegions('vcsl-marimba'),
  },
  {
    kind: 'sampled', id: 'vcsl-glockenspiel', name: 'Glockenspiel', category: 'Keys & mallets', piano: false, undampedFrom: 0,
    description: 'Bright orchestral bells.',
    credit: VCSL_CREDIT, license: 'CC0', homepage: VCSL_HOME,
    hosts: PAGES_VCSL, ext: 'ogg', sizeHint: '≈ 2 MB', veltrack: 0.8, regions: () => sfzRegions('vcsl-glockenspiel'),
  },
  {
    kind: 'sampled', id: 'casio', name: 'Toy Keyboard (Casio)', category: 'Keys & mallets', piano: false,
    description: 'Lo-fi 80s home keyboard, stretched across the whole range.',
    credit: 'Tone.js audio samples', license: 'CC BY 3.0', homepage: 'https://github.com/Tonejs/audio',
    hosts: ['https://tonejs.github.io/audio/casio/', 'https://raw.githubusercontent.com/Tonejs/audio/master/casio/'],
    ext: 'mp3', sizeHint: '< 1 MB', veltrack: 1,
    regions: () => {
      const names = ['A1', 'As1', 'B1', 'C2', 'Cs2', 'D2', 'Ds2', 'E2', 'F2', 'Fs2', 'G2', 'Gs1', 'A2'];
      return spread(names.map((n) => ({ key: parseNoteName(n), path: n })), 0, 127);
    },
  },

  // Organs
  {
    kind: 'sampled', id: 'vcsl-pipe-organ', name: 'Pipe Organ', category: 'Organs', piano: false, sustaining: true,
    description: 'Church pipe organ, quiet registration.',
    credit: VCSL_CREDIT, license: 'CC0', homepage: VCSL_HOME,
    hosts: PAGES_VCSL, ext: 'ogg', sizeHint: '≈ 10 MB', veltrack: 0, regions: () => sfzRegions('vcsl-pipe-organ'),
  },
  {
    kind: 'sampled', id: 'fluid-church-organ', name: 'Church Organ (full)', category: 'Organs', piano: false, sustaining: true,
    description: 'Full-registration church organ.',
    credit: 'FluidR3 GM soundfont by Frank Wen, via midi-js-soundfonts', license: 'CC BY 3.0', homepage: MIDIJS_HOME,
    sizeHint: '≈ 2 MB', veltrack: 0, ...soundfont('FluidR3_GM', 'church_organ'),
  },

  // Offline
  {
    kind: 'synth', id: 'synth-piano', name: 'Synth Piano', category: 'Offline (synthesized)', piano: true, engine: 'piano',
    description: 'Generated on the fly – works without an internet connection.', credit: 'PIANO-BEATS', license: 'MIT',
  },
  {
    kind: 'synth', id: 'synth-epiano', name: 'FM Tine Piano', category: 'Offline (synthesized)', piano: false, engine: 'epiano',
    description: 'Two-operator FM electric piano, generated on the fly.', credit: 'PIANO-BEATS', license: 'MIT',
  },
  {
    kind: 'synth', id: 'synth-organ', name: 'Drawbar Organ', category: 'Offline (synthesized)', piano: false, engine: 'organ', sustaining: true,
    description: 'Tonewheel-style drawbar organ, generated on the fly.', credit: 'PIANO-BEATS', license: 'MIT',
  },
];

export const FALLBACK_INSTRUMENT = 'synth-piano';

export function getInstrument(id: string): Instrument {
  return INSTRUMENTS.find((i) => i.id === id) || INSTRUMENTS.find((i) => i.id === FALLBACK_INSTRUMENT)!;
}

export function sampleUrls(inst: SampledInstrument, path: string): string[] {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  return inst.hosts.map((h) => `${h}${encoded}.${inst.ext}`);
}
