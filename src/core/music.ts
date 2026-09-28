export const SHARP_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
export const PLAIN_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

const BLACK = new Set([1, 3, 6, 8, 10]);

export const isBlack = (midi: number) => BLACK.has(((midi % 12) + 12) % 12);
export const octaveOf = (midi: number) => Math.floor(midi / 12) - 1;
export const pitchClass = (midi: number) => ((midi % 12) + 12) % 12;

/** Scientific pitch name, e.g. 60 -> "C4". */
export function noteName(midi: number, pretty = true): string {
  return (pretty ? SHARP_NAMES : PLAIN_NAMES)[pitchClass(midi)] + octaveOf(midi);
}

/** Parses "C4", "F#3", "Bb-1", "Ds1" (Tone.js style) into a MIDI number. */
export function parseNoteName(name: string): number {
  const m = /^([A-Ga-g])(#|s|b|♯|♭)?(-?\d+)$/.exec(name.trim());
  if (!m) throw new Error(`Bad note name: ${name}`);
  const base = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[m[1].toLowerCase() as 'c'];
  const acc = m[2] === '#' || m[2] === 's' || m[2] === '♯' ? 1 : m[2] === 'b' || m[2] === '♭' ? -1 : 0;
  return (parseInt(m[3], 10) + 1) * 12 + base + acc;
}

export const midiToFreq = (midi: number, a4 = 440) => a4 * Math.pow(2, (midi - 69) / 12);
export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const dbToGain = (db: number) => Math.pow(10, db / 20);
export const gainToDb = (g: number) => (g <= 0 ? -Infinity : 20 * Math.log10(g));

export function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function uid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
