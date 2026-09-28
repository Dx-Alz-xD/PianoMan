// Settings of the 4K area, stored separately from the piano's.

import { readLegacyGameSettings } from '../core/settings';

export type Skin = 'arrows' | 'bars' | 'circles' | 'diamonds';
export type NoteColors = 'lanes' | 'snap' | 'single';
export type Palette = 'fnf' | 'neon' | 'osu' | 'pastel' | 'mono';
export type Judging = 'lenient' | 'normal' | 'strict' | 'map';
export type HealthMode = 'normal' | 'nofail' | 'suddendeath' | 'perfect';
export type Hitsound = 'none' | 'soft' | 'clap' | 'kick' | 'tick' | 'drum' | 'piano';
export type Accent = 'violet' | 'cyan' | 'sunset' | 'lime' | 'rose';

export interface Mods {
  rate: number;
  mirror: boolean;
  random: boolean;
  noHolds: boolean;
  hidden: boolean;
  fadeIn: boolean;
  auto: boolean;
}

export interface BeatsSettings {
  // gameplay
  scrollSpeed: number;
  scroll: 'down' | 'up';
  hitPosition: number;
  laneWidth: number;
  laneCover: number;
  skin: Skin;
  noteColors: NoteColors;
  palette: Palette;
  singleColor: string;
  judging: Judging;
  offset: number;
  healthMode: HealthMode;
  countdown: boolean;
  skipIntro: boolean;
  pauseOnBlur: boolean;
  keepPitch: boolean;
  // display
  bgDim: number;
  bgBlur: number;
  video: boolean;
  showJudgement: boolean;
  judgementPos: 'high' | 'center' | 'low';
  showCombo: boolean;
  showErrorBar: boolean;
  showKeyOverlay: boolean;
  showProgress: boolean;
  showNps: boolean;
  showScore: boolean;
  showHealth: boolean;
  showFps: boolean;
  hitLighting: boolean;
  barLines: boolean;
  laneOpacity: number;
  particles: boolean;
  shake: boolean;
  earlyLate: boolean;
  // audio
  masterVolume: number;
  musicVolume: number;
  hitsoundVolume: number;
  keysoundVolume: number;
  effectsVolume: number;
  hitsound: Hitsound;
  keysounds: boolean;
  missSound: boolean;
  menuMusic: boolean;
  previewMusic: boolean;
  crackle: number;
  // input
  keys: string[];
  altKeys: string[];
  retryKey: string;
  retryHold: number;
  offsetKeys: boolean;
  midi: 'white' | 'cdef' | 'off';
  touch: boolean;
  // mods
  mods: Mods;
  // ui
  accent: Accent;
  visualizer: boolean;
  reduceMotion: boolean;
  sort: 'added' | 'title' | 'artist' | 'level' | 'length' | 'played';
  filter: 'all' | 'youtube' | 'file' | 'osu' | 'score';
  lastSong: string;
  lastMap: string;
  creator: string;
  importVideo: boolean;
  videoHeight: number;
  autoMaps: string[];
  openEditorAfterImport: boolean;
  // editor
  editor: { snap: number; zoom: number; hitsounds: boolean; metronome: boolean; waveform: boolean; rate: number; keys: string[] };
}

export const DEFAULT_BEATS: BeatsSettings = {
  scrollSpeed: 22,
  scroll: 'down',
  hitPosition: 12,
  laneWidth: 96,
  laneCover: 0,
  skin: 'arrows',
  noteColors: 'lanes',
  palette: 'fnf',
  singleColor: '#8c6cff',
  judging: 'normal',
  offset: 0,
  healthMode: 'normal',
  countdown: true,
  skipIntro: true,
  pauseOnBlur: true,
  keepPitch: true,
  bgDim: 0.72,
  bgBlur: 6,
  video: true,
  showJudgement: true,
  judgementPos: 'center',
  showCombo: true,
  showErrorBar: true,
  showKeyOverlay: true,
  showProgress: true,
  showNps: true,
  showScore: true,
  showHealth: true,
  showFps: false,
  hitLighting: true,
  barLines: true,
  laneOpacity: 0.78,
  particles: true,
  shake: false,
  earlyLate: true,
  masterVolume: 0.9,
  musicVolume: 0.8,
  hitsoundVolume: 0.35,
  keysoundVolume: 0.9,
  effectsVolume: 0.6,
  hitsound: 'none',
  keysounds: true,
  missSound: true,
  menuMusic: true,
  previewMusic: true,
  crackle: 0.35,
  keys: ['KeyA', 'KeyS', 'KeyD', 'KeyF'],
  altKeys: ['ArrowLeft', 'ArrowDown', 'ArrowUp', 'ArrowRight'],
  retryKey: 'Backquote',
  retryHold: 400,
  offsetKeys: true,
  midi: 'white',
  touch: true,
  mods: { rate: 1, mirror: false, random: false, noHolds: false, hidden: false, fadeIn: false, auto: false },
  accent: 'violet',
  visualizer: true,
  reduceMotion: false,
  sort: 'added',
  filter: 'all',
  lastSong: '',
  lastMap: '',
  creator: '',
  importVideo: true,
  videoHeight: 720,
  autoMaps: ['easy', 'normal', 'hard'],
  openEditorAfterImport: false,
  editor: { snap: 4, zoom: 1, hitsounds: true, metronome: false, waveform: true, rate: 1, keys: ['KeyD', 'KeyF', 'KeyJ', 'KeyK'] },
};

const KEY = 'pianobeats.beats.v1';

function merge<T>(base: T, patch: unknown): T {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return base;
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (!(k in out)) continue;
    const cur = out[k];
    if (Array.isArray(cur)) {
      if (Array.isArray(v) && v.length === cur.length && v.every((x) => typeof x === typeof cur[0])) out[k] = v;
      else if (Array.isArray(v) && k === 'autoMaps') out[k] = v.filter((x) => typeof x === 'string');
    } else if (cur && typeof cur === 'object') out[k] = merge(cur, v);
    else if (v !== undefined && typeof v === typeof cur) out[k] = v;
  }
  return out as T;
}

export function loadBeatsSettings(): BeatsSettings {
  let raw: unknown = null;
  try {
    raw = JSON.parse(localStorage.getItem(KEY) || 'null');
  } catch {
    raw = null;
  }
  const s = merge(structuredClone(DEFAULT_BEATS), raw);
  if (!raw) {
    // First visit: carry over what the old in-piano 4K mode had.
    const legacy = readLegacyGameSettings();
    if (legacy) {
      if (Array.isArray(legacy.keys) && legacy.keys.length === 4) s.keys = legacy.keys as string[];
      if (legacy.skin === 'bars') s.skin = 'bars';
      if (legacy.scroll === 'up' || legacy.scroll === 'down') s.scroll = legacy.scroll;
      if (typeof legacy.offset === 'number') s.offset = legacy.offset;
      if (legacy.fail === true) s.healthMode = 'normal';
    }
  }
  return s;
}

let saveTimer = 0;
export function saveBeatsSettings(s: BeatsSettings) {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(s));
    } catch {
      /* storage unavailable */
    }
  }, 150);
}

// --------------------------------------------------------- best scores ----

export interface PlayRecord {
  score: number;
  accuracy: number;
  grade: string;
  maxCombo: number;
  fc: boolean;
  counts: Record<string, number>;
  mods: string;
  rate: number;
  date: string;
  ur: number;
}

const SCORES_KEY = 'pianobeats.scores.v1';

export function loadRecords(): Record<string, PlayRecord[]> {
  try {
    const v = JSON.parse(localStorage.getItem(SCORES_KEY) || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

export function bestRecord(mapId: string): PlayRecord | null {
  const list = loadRecords()[mapId];
  return list && list.length ? list[0] : null;
}

/** Stores a play; returns its rank among the map's plays (0 = new best). */
export function addRecord(mapId: string, rec: PlayRecord): number {
  const all = loadRecords();
  const list = [...(all[mapId] || []), rec].sort((a, b) => b.score - a.score).slice(0, 20);
  all[mapId] = list;
  try {
    localStorage.setItem(SCORES_KEY, JSON.stringify(all));
  } catch {
    /* ignore */
  }
  return list.indexOf(rec);
}

export function playCount(mapId: string): number {
  return (loadRecords()[mapId] || []).length;
}

export function modsLabel(m: Mods, healthMode: HealthMode): string {
  const parts: string[] = [];
  if (m.rate !== 1) parts.push(`${m.rate.toFixed(2).replace(/0$/, '')}×`);
  if (m.mirror) parts.push('MR');
  if (m.random) parts.push('RD');
  if (m.noHolds) parts.push('NH');
  if (m.hidden) parts.push('HD');
  if (m.fadeIn) parts.push('FI');
  if (m.auto) parts.push('AUTO');
  if (healthMode === 'nofail') parts.push('NF');
  if (healthMode === 'suddendeath') parts.push('SD');
  if (healthMode === 'perfect') parts.push('PF');
  return parts.join(' ');
}

// ------------------------------------------------------------ palettes ----

export const PALETTES: Record<Palette, string[]> = {
  fnf: ['#c24b99', '#00c3ff', '#12fa05', '#f9393f'],
  neon: ['#ff3cac', '#7b61ff', '#2bd2ff', '#2bff88'],
  osu: ['#ffffff', '#4fb5ff', '#4fb5ff', '#ffffff'],
  pastel: ['#ffadad', '#a0c4ff', '#caffbf', '#ffd6a5'],
  mono: ['#e8e8f0', '#e8e8f0', '#e8e8f0', '#e8e8f0'],
};

/** Beat-division colours (StepMania style) for "colour by snap". */
export const SNAP_COLORS: [number, string][] = [
  [1, '#ff4d6d'],
  [2, '#4d9dff'],
  [3, '#b44dff'],
  [4, '#ffd24d'],
  [6, '#ff7ad9'],
  [8, '#ff9f43'],
  [12, '#7dffcf'],
  [16, '#4dffa1'],
];

export const ACCENTS: Record<Accent, [string, string, string]> = {
  violet: ['#ff3cac', '#8c6cff', '#2b86c5'],
  cyan: ['#00f5d4', '#00bbf9', '#4361ee'],
  sunset: ['#ff9e00', '#ff5400', '#e0115f'],
  lime: ['#d9ff00', '#38e54d', '#00a878'],
  rose: ['#ffafcc', '#ff4d8d', '#9d4edd'],
};
