// Sound settings (what a preset stores) and app settings (everything else),
// with parameter metadata that drives the settings panel.

import { TEMPERAMENTS } from '../audio/tuning';

export type ReverbType = 'room' | 'studio' | 'chamber' | 'hall' | 'cathedral' | 'plate' | 'spring';
export type TouchCurve = 'linear' | 'light' | 'normal' | 'heavy' | 'fixed';
export type LidPosition = 'closed' | 'half' | 'open';

export interface SoundSettings {
  instrument: string;
  volume: number;
  // touch
  touch: TouchCurve;
  fixedVelocity: number;
  dynamicRange: number;
  // tone
  brightness: number;
  hardness: number;
  lid: LidPosition;
  eqLow: number;
  eqMid: number;
  eqMidFreq: number;
  eqHigh: number;
  // envelope
  attack: number;
  release: number;
  holdDecay: number;
  retrigger: 'cut' | 'overlap';
  // pedals & mechanics
  halfPedal: boolean;
  resonance: number;
  pedalNoise: number;
  releaseNoise: number;
  softAmount: number;
  // tuning
  a4: number;
  transpose: number;
  fineTune: number;
  temperament: string;
  temperamentRoot: number;
  stretch: number;
  unisonDetune: number;
  // space
  reverbType: ReverbType;
  reverbMix: number;
  reverbDecay: number;
  reverbPreDelay: number;
  reverbDamping: number;
  stereoWidth: number;
  keyPan: number;
  // effects
  tremoloDepth: number;
  tremoloRate: number;
  autoPan: boolean;
  chorusMix: number;
  chorusRate: number;
  chorusDepth: number;
  drive: number;
  // dynamics
  compressor: boolean;
  compThreshold: number;
  compRatio: number;
  limiter: boolean;
  polyphony: number;
}

export const DEFAULT_SOUND: SoundSettings = {
  instrument: 'splendid-grand',
  volume: -3,
  touch: 'normal',
  fixedVelocity: 100,
  dynamicRange: 40,
  brightness: 0,
  hardness: 0.35,
  lid: 'open',
  eqLow: 0,
  eqMid: 0,
  eqMidFreq: 1000,
  eqHigh: 0,
  attack: 0,
  release: 0.3,
  holdDecay: 0,
  retrigger: 'cut',
  halfPedal: true,
  resonance: 0.35,
  pedalNoise: 0.35,
  releaseNoise: 0.4,
  softAmount: 0.5,
  a4: 440,
  transpose: 0,
  fineTune: 0,
  temperament: 'equal',
  temperamentRoot: 0,
  stretch: 0.5,
  unisonDetune: 0,
  reverbType: 'hall',
  reverbMix: 0.22,
  reverbDecay: 2.4,
  reverbPreDelay: 18,
  reverbDamping: 0.45,
  stereoWidth: 1,
  keyPan: 0.45,
  tremoloDepth: 0,
  tremoloRate: 4.5,
  autoPan: false,
  chorusMix: 0,
  chorusRate: 0.7,
  chorusDepth: 0.4,
  drive: 0,
  compressor: true,
  compThreshold: -16,
  compRatio: 2.5,
  limiter: true,
  polyphony: 128,
};

export type SectionId = 'output' | 'touch' | 'tone' | 'envelope' | 'pedals' | 'tuning' | 'space' | 'effects' | 'dynamics';

export const SECTIONS: { id: SectionId; title: string; icon: string }[] = [
  { id: 'output', title: 'Output', icon: '🔊' },
  { id: 'touch', title: 'Touch & Velocity', icon: '✋' },
  { id: 'tone', title: 'Tone & EQ', icon: '🎚' },
  { id: 'envelope', title: 'Envelope & Dampers', icon: '📈' },
  { id: 'pedals', title: 'Pedals & Mechanics', icon: '🦶' },
  { id: 'tuning', title: 'Tuning & Temperament', icon: '🎼' },
  { id: 'space', title: 'Room & Stereo', icon: '🏛' },
  { id: 'effects', title: 'Effects', icon: '✨' },
  { id: 'dynamics', title: 'Dynamics & Engine', icon: '📊' },
];

type NumKeys = { [K in keyof SoundSettings]: SoundSettings[K] extends number ? K : never }[keyof SoundSettings];
type BoolKeys = { [K in keyof SoundSettings]: SoundSettings[K] extends boolean ? K : never }[keyof SoundSettings];
type StrKeys = Exclude<keyof SoundSettings, NumKeys | BoolKeys>;

export type ParamDef =
  | { type: 'range'; key: NumKeys; section: SectionId; label: string; min: number; max: number; step: number; unit?: string; help: string; format?: (v: number) => string; showIf?: (s: SoundSettings) => boolean }
  | { type: 'toggle'; key: BoolKeys; section: SectionId; label: string; help: string; showIf?: (s: SoundSettings) => boolean }
  | { type: 'select'; key: StrKeys | 'temperamentRoot'; section: SectionId; label: string; help: string; options: { value: string; label: string }[]; showIf?: (s: SoundSettings) => boolean };

const pct = (v: number) => `${Math.round(v * 100)}%`;
const db = (v: number) => `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`;
const secs = (v: number) => (v < 1 ? `${Math.round(v * 1000)} ms` : `${v.toFixed(2)} s`);
const signed = (v: number, unit = '') => `${v > 0 ? '+' : ''}${v}${unit}`;
const KEY_NAMES = ['C', 'C♯/D♭', 'D', 'D♯/E♭', 'E', 'F', 'F♯/G♭', 'G', 'G♯/A♭', 'A', 'A♯/B♭', 'B'];

export const PARAMS: ParamDef[] = [
  // output
  { type: 'range', key: 'volume', section: 'output', label: 'Master volume', min: -40, max: 6, step: 0.5, help: 'Overall output level.', format: db },

  // touch
  {
    type: 'select', key: 'touch', section: 'touch', label: 'Touch curve',
    help: 'How key velocity maps to loudness. Light = easier to play loud, heavy = needs more force.',
    options: [
      { value: 'light', label: 'Light' },
      { value: 'normal', label: 'Normal' },
      { value: 'linear', label: 'Linear' },
      { value: 'heavy', label: 'Heavy' },
      { value: 'fixed', label: 'Fixed velocity' },
    ],
  },
  { type: 'range', key: 'fixedVelocity', section: 'touch', label: 'Fixed velocity', min: 1, max: 127, step: 1, help: 'Velocity used for every note when the touch curve is Fixed.', showIf: (s) => s.touch === 'fixed' },
  { type: 'range', key: 'dynamicRange', section: 'touch', label: 'Dynamic range', min: 6, max: 60, step: 1, unit: 'dB', help: 'Loudness difference between the softest and the hardest note.', format: (v) => `${v} dB` },

  // tone
  { type: 'range', key: 'brightness', section: 'tone', label: 'Brightness', min: -1, max: 1, step: 0.01, help: 'Opens or closes the tone filter on every note.', format: (v) => signed(Math.round(v * 100), '%') },
  { type: 'range', key: 'hardness', section: 'tone', label: 'Hammer hardness', min: 0, max: 1, step: 0.01, help: 'How much brighter the tone gets when you play harder (voicing).', format: pct },
  {
    type: 'select', key: 'lid', section: 'tone', label: 'Lid position', help: 'A closed lid rounds off the treble; fully open projects the most.',
    options: [
      { value: 'open', label: 'Full stick' },
      { value: 'half', label: 'Half stick' },
      { value: 'closed', label: 'Closed' },
    ],
  },
  { type: 'range', key: 'eqLow', section: 'tone', label: 'EQ low (120 Hz)', min: -12, max: 12, step: 0.5, help: 'Low shelf.', format: db },
  { type: 'range', key: 'eqMid', section: 'tone', label: 'EQ mid', min: -12, max: 12, step: 0.5, help: 'Peaking band at the frequency below.', format: db },
  { type: 'range', key: 'eqMidFreq', section: 'tone', label: 'EQ mid frequency', min: 200, max: 5000, step: 10, help: 'Centre of the mid band.', format: (v) => (v >= 1000 ? `${(v / 1000).toFixed(2)} kHz` : `${v} Hz`) },
  { type: 'range', key: 'eqHigh', section: 'tone', label: 'EQ high (6 kHz)', min: -12, max: 12, step: 0.5, help: 'High shelf.', format: db },

  // envelope
  { type: 'range', key: 'attack', section: 'envelope', label: 'Attack', min: 0, max: 2, step: 0.005, help: 'Fade-in time. Keep at 0 for a natural piano; raise for pad-like swells.', format: secs },
  { type: 'range', key: 'release', section: 'envelope', label: 'Damper release', min: 0.05, max: 4, step: 0.01, help: 'How quickly the dampers stop a note after you let go.', format: secs },
  { type: 'range', key: 'holdDecay', section: 'envelope', label: 'Sustain decay', min: 0, max: 20, step: 0.1, help: 'Extra decay while a key is held. 0 = the natural decay of the instrument.', format: (v) => (v === 0 ? 'Natural' : `${v.toFixed(1)} s`) },
  {
    type: 'select', key: 'retrigger', section: 'envelope', label: 'Repeated notes', help: 'Cut: re-striking a key dampens the previous strike like a real string. Overlap: strikes pile up.',
    options: [
      { value: 'cut', label: 'Cut previous' },
      { value: 'overlap', label: 'Overlap' },
    ],
  },

  // pedals
  { type: 'toggle', key: 'halfPedal', section: 'pedals', label: 'Half-pedalling', help: 'Continuous sustain pedals (CC64) partially damp the strings in the middle range.' },
  { type: 'range', key: 'resonance', section: 'pedals', label: 'String resonance', min: 0, max: 1, step: 0.01, help: 'Sympathetic resonance of the open strings while the sustain pedal is down.', format: pct },
  { type: 'range', key: 'pedalNoise', section: 'pedals', label: 'Pedal noise', min: 0, max: 1, step: 0.01, help: 'Mechanical sound of the damper pedal going down and up.', format: pct },
  { type: 'range', key: 'releaseNoise', section: 'pedals', label: 'Key release noise', min: 0, max: 1, step: 0.01, help: 'Damper and key-off sounds when a note is released (sampled where available).', format: pct },
  { type: 'range', key: 'softAmount', section: 'pedals', label: 'Soft pedal (una corda)', min: 0, max: 1, step: 0.01, help: 'How much quieter and darker notes are while the soft pedal is held.', format: pct },

  // tuning
  { type: 'range', key: 'a4', section: 'tuning', label: 'Reference pitch A4', min: 415, max: 466, step: 0.1, help: '440 Hz is modern standard, 415 Hz Baroque, 432 Hz and 442 Hz are also common.', format: (v) => `${v.toFixed(1)} Hz` },
  { type: 'range', key: 'transpose', section: 'tuning', label: 'Transpose', min: -12, max: 12, step: 1, help: 'Shifts everything you play (and the autoplayer) by semitones.', format: (v) => signed(v, ' st') },
  { type: 'range', key: 'fineTune', section: 'tuning', label: 'Fine tune', min: -50, max: 50, step: 0.5, help: 'Global detune in cents.', format: (v) => signed(v, ' ¢') },
  {
    type: 'select', key: 'temperament', section: 'tuning', label: 'Temperament',
    help: 'Historical tuning systems. Try Werckmeister III with A = 415 Hz on the harpsichord.',
    options: TEMPERAMENTS.map((t) => ({ value: t.id, label: t.name })),
  },
  {
    type: 'select', key: 'temperamentRoot', section: 'tuning', label: 'Temperament key',
    help: 'The key the temperament is centred on.',
    options: KEY_NAMES.map((n, i) => ({ value: String(i), label: n })),
    showIf: (s) => s.temperament !== 'equal',
  },
  { type: 'range', key: 'stretch', section: 'tuning', label: 'Stretch tuning', min: 0, max: 1.5, step: 0.01, help: 'Tunes the treble slightly sharp and the bass flat, like a real piano tuner does.', format: pct },
  { type: 'range', key: 'unisonDetune', section: 'tuning', label: 'Unison detune (honky-tonk)', min: 0, max: 30, step: 0.5, help: 'Doubles every note with a detuned copy, like out-of-tune unison strings.', format: (v) => (v === 0 ? 'Off' : `${v} ¢`) },

  // space
  {
    type: 'select', key: 'reverbType', section: 'space', label: 'Room', help: 'Character of the reverb impulse.',
    options: [
      { value: 'room', label: 'Small room' },
      { value: 'studio', label: 'Studio' },
      { value: 'chamber', label: 'Chamber' },
      { value: 'hall', label: 'Concert hall' },
      { value: 'cathedral', label: 'Cathedral' },
      { value: 'plate', label: 'Plate' },
      { value: 'spring', label: 'Spring' },
    ],
  },
  { type: 'range', key: 'reverbMix', section: 'space', label: 'Reverb amount', min: 0, max: 1, step: 0.01, help: 'Wet level of the reverb.', format: pct },
  { type: 'range', key: 'reverbDecay', section: 'space', label: 'Reverb time', min: 0.2, max: 10, step: 0.05, help: 'RT60 – how long the room keeps ringing.', format: (v) => `${v.toFixed(2)} s` },
  { type: 'range', key: 'reverbPreDelay', section: 'space', label: 'Pre-delay', min: 0, max: 150, step: 1, help: 'Gap before the first reflections – bigger rooms have more.', format: (v) => `${v} ms` },
  { type: 'range', key: 'reverbDamping', section: 'space', label: 'Air damping', min: 0, max: 1, step: 0.01, help: 'How fast high frequencies die away in the reverb tail.', format: pct },
  { type: 'range', key: 'stereoWidth', section: 'space', label: 'Stereo width', min: 0, max: 2, step: 0.01, help: '0 = mono, 100% = natural, 200% = extra wide.', format: pct },
  { type: 'range', key: 'keyPan', section: 'space', label: 'Key panning', min: 0, max: 1, step: 0.01, help: 'Spreads bass to the left and treble to the right (player perspective).', format: pct },

  // effects
  { type: 'range', key: 'tremoloDepth', section: 'effects', label: 'Tremolo depth', min: 0, max: 1, step: 0.01, help: 'Volume wobble, the classic electric piano effect.', format: pct },
  { type: 'range', key: 'tremoloRate', section: 'effects', label: 'Tremolo rate', min: 0.5, max: 12, step: 0.1, help: 'Tremolo speed.', format: (v) => `${v.toFixed(1)} Hz` },
  { type: 'toggle', key: 'autoPan', section: 'effects', label: 'Stereo auto-pan', help: 'Tremolo alternates between the speakers (Rhodes suitcase style).' },
  { type: 'range', key: 'chorusMix', section: 'effects', label: 'Chorus', min: 0, max: 1, step: 0.01, help: 'Thickens the sound with modulated delays.', format: pct },
  { type: 'range', key: 'chorusRate', section: 'effects', label: 'Chorus rate', min: 0.05, max: 5, step: 0.05, help: 'Chorus modulation speed.', format: (v) => `${v.toFixed(2)} Hz` },
  { type: 'range', key: 'chorusDepth', section: 'effects', label: 'Chorus depth', min: 0, max: 1, step: 0.01, help: 'Chorus modulation depth.', format: pct },
  { type: 'range', key: 'drive', section: 'effects', label: 'Drive', min: 0, max: 1, step: 0.01, help: 'Warm saturation / amp overdrive.', format: pct },

  // dynamics
  { type: 'toggle', key: 'compressor', section: 'dynamics', label: 'Compressor', help: 'Evens out loud and soft passages.' },
  { type: 'range', key: 'compThreshold', section: 'dynamics', label: 'Threshold', min: -50, max: 0, step: 0.5, help: 'Level above which compression starts.', format: db, showIf: (s) => s.compressor },
  { type: 'range', key: 'compRatio', section: 'dynamics', label: 'Ratio', min: 1, max: 20, step: 0.1, help: 'Amount of compression above the threshold.', format: (v) => `${v.toFixed(1)}:1`, showIf: (s) => s.compressor },
  { type: 'toggle', key: 'limiter', section: 'dynamics', label: 'Output limiter', help: 'Prevents clipping on big chords.' },
  { type: 'range', key: 'polyphony', section: 'dynamics', label: 'Max polyphony', min: 16, max: 256, step: 8, help: 'Maximum simultaneous voices before the oldest are stolen.', format: (v) => `${v} voices` },
];

// ------------------------------------------------------------ app state ----

export type ViewMode = 'notes' | 'sheet' | 'split';
export type AppMode = 'play' | 'autoplay' | 'clicker' | 'game';

export interface GameSettings {
  difficulty: 'easy' | 'normal' | 'hard' | 'expert';
  source: 'melody' | 'both';
  skin: 'arrows' | 'bars';
  scroll: 'up' | 'down';
  scrollSpeed: number;
  speed: number;
  keys: string[];
  offset: number;
  holds: boolean;
  missSound: boolean;
  fail: boolean;
}

export interface AppSettings {
  presetId: string;
  sampleQuality: 'full' | 'balanced' | 'light';
  latency: 'interactive' | 'balanced' | 'playback';
  mode: AppMode;
  view: ViewMode;
  theme: 'dark' | 'light';
  keyboard: {
    keyCount: 88 | 76 | 61 | 49 | 37;
    labels: 'none' | 'c' | 'all' | 'keys';
    octave: number;
    velocity: number;
    layout: 'tracker' | 'single';
  };
  midi: { input: string; channel: number };
  notes: { lookahead: number; showNames: boolean; colorR: string; colorL: string; guides: boolean; particles: boolean };
  metronome: { enabled: boolean; bpm: number; beats: number; volume: number; accent: boolean; sound: 'click' | 'wood' | 'beep' };
  player: {
    speed: number;
    countIn: boolean;
    handL: boolean;
    handR: boolean;
    followScore: boolean;
    velocityScale: number;
    applyPedal: boolean;
    waitMode: boolean;
    loop: boolean;
    humanize: number;
  };
  clicker: {
    style: 'tap' | 'flow';
    target: 'both' | 'R' | 'L';
    duration: 'natural' | 'hold' | 'next';
    velocity: 'score' | 'input' | 'fixed';
    fixedVelocity: number;
    allowRepeat: boolean;
    accompany: boolean;
  };
  panels: { settings: boolean; library: boolean; libraryTab: 'library' | 'search' | 'info'; keyboard: boolean; drawer: boolean; focus: boolean };
  game: GameSettings;
  settingsSections: Partial<Record<SectionId, boolean>>;
}

export const DEFAULT_APP: AppSettings = {
  presetId: 'concert-grand',
  sampleQuality: 'balanced',
  latency: 'interactive',
  mode: 'play',
  view: 'notes',
  theme: 'dark',
  keyboard: { keyCount: 88, labels: 'c', octave: 4, velocity: 96, layout: 'tracker' },
  midi: { input: 'all', channel: 0 },
  notes: { lookahead: 3, showNames: true, colorR: '#4fc3f7', colorL: '#ffb74d', guides: true, particles: true },
  metronome: { enabled: false, bpm: 100, beats: 4, volume: 0.6, accent: true, sound: 'click' },
  player: { speed: 1, countIn: false, handL: true, handR: true, followScore: true, velocityScale: 1, applyPedal: true, waitMode: false, loop: false, humanize: 0 },
  clicker: { style: 'flow', target: 'both', duration: 'natural', velocity: 'score', fixedVelocity: 90, allowRepeat: false, accompany: true },
  panels: { settings: false, library: false, libraryTab: 'library', keyboard: true, drawer: false, focus: false },
  game: {
    difficulty: 'normal',
    source: 'both',
    skin: 'arrows',
    scroll: 'up',
    scrollSpeed: 2,
    speed: 1,
    keys: ['KeyA', 'KeyS', 'KeyD', 'KeyF'],
    offset: 0,
    holds: true,
    missSound: true,
    fail: false,
  },
  settingsSections: { output: true, touch: true },
};

const APP_KEY = 'pianoman.app.v1';
const SOUND_KEY = 'pianoman.sound.v1';
const PRESETS_KEY = 'pianoman.userPresets.v1';

function deepMerge<T>(base: T, patch: unknown): T {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (!(k in out)) continue;
    const cur = out[k];
    if (cur && typeof cur === 'object' && !Array.isArray(cur)) out[k] = deepMerge(cur, v);
    else if (v !== undefined && typeof v === typeof cur) out[k] = v;
  }
  return out as T;
}

function read(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or unavailable */
  }
}

export function loadAppSettings(): AppSettings {
  return deepMerge(structuredClone(DEFAULT_APP), read(APP_KEY));
}
export function saveAppSettings(s: AppSettings) {
  write(APP_KEY, s);
}
export function loadSoundSettings(): SoundSettings | null {
  const raw = read(SOUND_KEY);
  return raw ? deepMerge({ ...DEFAULT_SOUND }, raw) : null;
}
export function saveSoundSettings(s: SoundSettings) {
  write(SOUND_KEY, s);
}
export function normalizeSound(raw: unknown): SoundSettings {
  return deepMerge({ ...DEFAULT_SOUND }, raw);
}

export interface UserPreset {
  id: string;
  name: string;
  sound: SoundSettings;
  createdAt: string;
}
export function loadUserPresets(): UserPreset[] {
  const raw = read(PRESETS_KEY);
  return Array.isArray(raw) ? (raw as UserPreset[]).map((p) => ({ ...p, sound: normalizeSound(p.sound) })) : [];
}
export function saveUserPresets(p: UserPreset[]) {
  write(PRESETS_KEY, p);
}
