// Data model of the 4K area: songs (audio + metadata) and the maps (charts)
// made for them.

export type SongSource = 'youtube' | 'url' | 'file' | 'osu' | 'score';

export interface MapSummary {
  id: string;
  name: string;
  creator: string;
  level: number;
  notes: number;
  holds: number;
  nps: number;
  origin: MapOrigin;
  updatedAt: string;
}

export interface SongMeta {
  id: string;
  title: string;
  artist: string;
  source: SongSource;
  /** Files inside the song folder. */
  audio?: string;
  video?: string;
  cover?: string;
  /** osu! background image (can differ from the cover art). */
  background?: string;
  /** Piano score file for score-based songs. */
  score?: string;
  /** Seconds the background video starts after the song (osu! convention; may be negative). */
  videoOffset?: number;
  youtubeId?: string;
  url?: string;
  /** Where the cover art came from, for the song info panel. */
  coverSource?: 'embedded' | 'youtube' | 'google' | 'itunes' | 'deezer' | 'osu' | 'file';
  previewTime: number;
  duration: number;
  bpm?: number;
  /** Time of the first downbeat, seconds. */
  offset?: number;
  tags?: string;
  description?: string;
  createdAt: string;
  updatedAt?: string;
  maps: MapSummary[];
}

export type MapOrigin = 'generated' | 'edited' | 'osu';

/** One chart note. `e` = hold end, `s` = keysound file, `v` = keysound volume (0–1). */
export interface MapNote {
  t: number;
  l: number;
  e?: number;
  s?: string;
  v?: number;
}

export interface TimingPoint {
  t: number;
  bpm: number;
  meter: number;
}

export interface MapData {
  id: string;
  songId: string;
  name: string;
  description: string;
  creator: string;
  /** Difficulty rating, roughly 1–10 (stars). */
  level: number;
  /** Whether `level` was set by hand rather than estimated. */
  levelManual?: boolean;
  notes: MapNote[];
  timing: TimingPoint[];
  /** osu!-style overall difficulty (judgement strictness) and HP drain. */
  od: number;
  hp: number;
  /** Score songs: which hands the chart notes play. */
  hands?: 'both' | 'melody';
  generator?: GeneratorOptions;
  origin: MapOrigin;
  /** osu! source identifiers, kept for export. */
  osu?: { beatmapId?: number; setId?: number; version?: string; converted?: boolean; keys?: number };
  createdAt: string;
  updatedAt: string;
}

export type Preset = 'easy' | 'normal' | 'hard' | 'insane' | 'expert';
export type Pattern = 'flow' | 'stairs' | 'trills' | 'jumps' | 'random';
export type Focus = 'all' | 'drums' | 'melody' | 'bass';

export interface GeneratorOptions {
  preset: Preset;
  /** Target average notes per second. */
  density: number;
  /** Finest beat division notes may snap to (4 = sixteenths in 4/4); 0 = do not quantize. */
  snap: number;
  /** 0–1: how often strong beats with several voices become chords. */
  chords: number;
  maxChord: number;
  /** 0–1: how often long notes become holds; 0 = no holds. */
  holds: number;
  holdMin: number;
  /** Minimum time between two notes in the same lane, seconds. */
  jackGap: number;
  pattern: Pattern;
  /** 0–1: how closely lanes follow the melody's pitch. */
  followPitch: number;
  /** 0–1: onset sensitivity for audio (higher = more candidate notes). */
  sensitivity: number;
  focus: Focus;
  /** Score songs: both hands or melody only. */
  hands: 'both' | 'melody';
  /** Make quiet parts sparser and loud parts denser. */
  dynamics: boolean;
  mirror: boolean;
  seed: number;
  /** Only generate between these times (seconds). */
  from?: number;
  to?: number;
}

/** Result of analysing a song's audio (computed in a worker, cached per song). */
export interface Analysis {
  version: number;
  duration: number;
  sampleRate: number;
  bpm: number;
  bpmConfidence: number;
  offset: number;
  /** Onset candidates. */
  onsets: Onset[];
  /** Waveform overview: min/max pairs and three band energies per bin. */
  peaks: { rate: number; min: number[]; max: number[]; low: number[]; mid: number[]; high: number[] };
  /** Loudness (0–1) per half second. */
  energy: number[];
}

export interface Onset {
  t: number;
  /** 0–1 */
  strength: number;
  /** Relative strength in the low / mid / high bands. */
  low: number;
  mid: number;
  high: number;
  /** 0–1 brightness (spectral centroid, log scale) – a stand-in for pitch. */
  pitch: number;
  /** How long the sound sustains, seconds. */
  dur: number;
}

export const LANES = 4;

export function uid(): string {
  return (crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`).toLowerCase();
}

export function now(): string {
  return new Date().toISOString();
}

export function summarize(map: MapData): MapSummary {
  const notes = map.notes.length;
  const span = notes > 1 ? map.notes[notes - 1].t - map.notes[0].t : 1;
  return {
    id: map.id,
    name: map.name,
    creator: map.creator,
    level: map.level,
    notes,
    holds: map.notes.filter((n) => n.e !== undefined).length,
    nps: span > 0 ? notes / span : notes,
    origin: map.origin,
    updatedAt: map.updatedAt,
  };
}
