// Tuning systems. Everything is expressed as a cents offset from 12-tone
// equal temperament at A4 = 440 Hz, which the voices apply as `detune`.

import { pitchClass } from '../core/music';

export interface Temperament {
  id: string;
  name: string;
  description: string;
  /** Cents of each pitch class above the root (index 0 = root). */
  cents: number[];
}

const ratioCents = (r: number) => 1200 * Math.log2(r);
const fromRatios = (ratios: number[]) => ratios.map(ratioCents);

export const TEMPERAMENTS: Temperament[] = [
  {
    id: 'equal',
    name: 'Equal temperament',
    description: 'Modern standard: all semitones are exactly 100 cents.',
    cents: [0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100],
  },
  {
    id: 'just',
    name: 'Just intonation (5-limit)',
    description: 'Pure thirds and fifths in the root key; other keys sound increasingly out of tune.',
    cents: fromRatios([1, 16 / 15, 9 / 8, 6 / 5, 5 / 4, 4 / 3, 45 / 32, 3 / 2, 8 / 5, 5 / 3, 9 / 5, 15 / 8]),
  },
  {
    id: 'pythagorean',
    name: 'Pythagorean',
    description: 'Built from pure 3:2 fifths. Bright, wide thirds and one "wolf" fifth.',
    cents: fromRatios([1, 256 / 243, 9 / 8, 32 / 27, 81 / 64, 4 / 3, 729 / 512, 3 / 2, 128 / 81, 27 / 16, 16 / 9, 243 / 128]),
  },
  {
    id: 'meantone',
    name: 'Quarter-comma meantone',
    description: 'Renaissance/early Baroque: pure major thirds, very sweet in simple keys.',
    cents: [0, 76.05, 193.16, 310.26, 386.31, 503.42, 579.47, 696.58, 772.63, 889.74, 1006.84, 1082.89],
  },
  {
    id: 'werckmeister3',
    name: 'Werckmeister III',
    description: 'Baroque well temperament (1691): every key playable, each with its own colour.',
    cents: [0, 90.22, 192.18, 294.13, 390.22, 498.04, 588.27, 696.09, 792.18, 888.27, 996.09, 1092.18],
  },
  {
    id: 'kirnberger3',
    name: 'Kirnberger III',
    description: 'Well temperament favoured in the late 18th century; pure C–E third.',
    cents: [0, 90.22, 193.16, 294.13, 386.31, 498.04, 590.22, 696.58, 792.18, 889.74, 996.09, 1088.27],
  },
  {
    id: 'vallotti',
    name: 'Vallotti',
    description: 'Gentle 18th-century well temperament, close to equal but with key colour.',
    cents: [0, 94.13, 196.09, 298.04, 392.18, 501.96, 592.18, 698.04, 796.09, 894.13, 1000, 1090.22],
  },
  {
    id: 'young',
    name: 'Young II',
    description: 'Thomas Young (1800): circulating temperament with smooth key changes.',
    cents: [0, 90.22, 196.09, 294.13, 392.18, 498.04, 588.27, 698.04, 792.18, 894.13, 996.09, 1090.22],
  },
];

export function getTemperament(id: string): Temperament {
  return TEMPERAMENTS.find((t) => t.id === id) || TEMPERAMENTS[0];
}

export interface TuningParams {
  a4: number;
  fineTune: number;
  temperament: string;
  temperamentRoot: number;
  stretch: number;
}

/**
 * Offset (in cents from equal temperament) of each pitch class for a
 * temperament rooted on `root`, normalised so that A stays at the reference.
 */
export function temperamentOffsets(id: string, root: number): number[] {
  const t = getTemperament(id);
  const offsets = new Array<number>(12);
  for (let pc = 0; pc < 12; pc++) {
    const degree = (pc - root + 12) % 12;
    offsets[pc] = t.cents[degree] - degree * 100;
  }
  const a = offsets[9];
  return offsets.map((o) => o - a);
}

/**
 * Railsback-style stretch: real pianos are tuned progressively sharp in the
 * treble and flat in the bass because of string inharmonicity. amount = 1 is a
 * typical concert-grand curve (~ -25 cents at A0, ~ +30 cents at C8).
 */
export function stretchCents(midi: number, amount: number): number {
  if (!amount) return 0;
  const d = midi - 69;
  if (d >= 0) return amount * 30 * Math.pow(d / 39, 2.2);
  return -amount * 25 * Math.pow(-d / 48, 2.2);
}

/** Total detune (cents) for a sounding MIDI note. */
export function noteDetune(midi: number, p: TuningParams, offsets = temperamentOffsets(p.temperament, p.temperamentRoot)): number {
  return 1200 * Math.log2(p.a4 / 440) + p.fineTune + offsets[pitchClass(midi)] + stretchCents(midi, p.stretch);
}
