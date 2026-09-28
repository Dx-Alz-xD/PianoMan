// osu! beatmaps: reading .osu/.osz files into 4K maps and writing 4K maps
// back out as .osu files (osu!mania, 4 keys).
//
// osu!mania maps with 4 keys are used as they are. Other key counts are
// folded onto 4 lanes, and osu!standard / taiko / catch maps are converted
// (lane from the x position or drum colour, sliders and spinners become
// holds). Custom hitsound samples (keysounds) are kept, so keysounded maps
// sound as intended.

import { strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import type { MapData, MapNote, SongMeta, TimingPoint } from './types';
import { LANES, now, uid } from './types';

export interface OsuTimingPoint {
  time: number; // ms
  beatLength: number;
  meter: number;
  sampleSet: number;
  sampleIndex: number;
  volume: number;
  uninherited: boolean;
}

export interface OsuHitObject {
  x: number;
  y: number;
  time: number; // ms
  type: number;
  hitSound: number;
  endTime?: number; // ms (holds, spinners, sliders after conversion)
  slider?: { slides: number; length: number };
  sample: { normalSet: number; additionSet: number; index: number; volume: number; filename: string };
}

export interface OsuBeatmap {
  version: number;
  general: Record<string, string>;
  metadata: Record<string, string>;
  difficulty: Record<string, string>;
  background: string | null;
  video: { file: string; offset: number } | null;
  breaks: [number, number][];
  timingPoints: OsuTimingPoint[];
  hitObjects: OsuHitObject[];
  mode: number;
  keys: number;
}

const num = (s: string | undefined, d = 0) => {
  const v = parseFloat(s ?? '');
  return Number.isFinite(v) ? v : d;
};

const unquote = (s: string) => s.trim().replace(/^"(.*)"$/, '$1');

export function parseOsu(text: string): OsuBeatmap {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const vm = /osu file format v(\d+)/.exec(lines[0] || '');
  const map: OsuBeatmap = {
    version: vm ? parseInt(vm[1], 10) : 14,
    general: {},
    metadata: {},
    difficulty: {},
    background: null,
    video: null,
    breaks: [],
    timingPoints: [],
    hitObjects: [],
    mode: 0,
    keys: 4,
  };
  let section = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('//')) continue;
    const sec = /^\[(\w+)\]$/.exec(line);
    if (sec) {
      section = sec[1];
      continue;
    }
    if (section === 'General' || section === 'Metadata' || section === 'Difficulty' || section === 'Editor') {
      const i = line.indexOf(':');
      if (i < 0) continue;
      const key = line.slice(0, i).trim();
      const value = line.slice(i + 1).trim();
      if (section === 'General') map.general[key] = value;
      else if (section === 'Metadata') map.metadata[key] = value;
      else if (section === 'Difficulty') map.difficulty[key] = value;
    } else if (section === 'Events') {
      const p = line.split(',');
      const kind = p[0].trim();
      if (kind === '0' && p.length >= 3) map.background = unquote(p[2]);
      else if ((kind === 'Video' || kind === '1') && p.length >= 3) map.video = { file: unquote(p[2]), offset: num(p[1]) };
      else if ((kind === '2' || kind === 'Break') && p.length >= 3) map.breaks.push([num(p[1]), num(p[2])]);
    } else if (section === 'TimingPoints') {
      const p = line.split(',');
      if (p.length < 2) continue;
      map.timingPoints.push({
        time: num(p[0]),
        beatLength: num(p[1]),
        meter: p.length > 2 ? num(p[2], 4) || 4 : 4,
        sampleSet: p.length > 3 ? num(p[3]) : 0,
        sampleIndex: p.length > 4 ? num(p[4]) : 0,
        volume: p.length > 5 ? num(p[5], 100) : 100,
        uninherited: p.length > 6 ? p[6].trim() !== '0' : num(p[1]) > 0,
      });
    } else if (section === 'HitObjects') {
      const obj = parseHitObject(line);
      if (obj) map.hitObjects.push(obj);
    }
  }
  map.mode = Math.round(num(map.general.Mode, 0));
  map.keys = map.mode === 3 ? Math.max(1, Math.min(18, Math.round(num(map.difficulty.CircleSize, 4)))) : 4;
  map.timingPoints.sort((a, b) => a.time - b.time);
  map.hitObjects.sort((a, b) => a.time - b.time);
  return map;
}

function parseSample(s: string | undefined) {
  const p = (s || '').split(':');
  return { normalSet: num(p[0]), additionSet: num(p[1]), index: num(p[2]), volume: num(p[3]), filename: (p[4] || '').trim() };
}

function parseHitObject(line: string): OsuHitObject | null {
  const p = line.split(',');
  if (p.length < 4) return null;
  const type = num(p[3]);
  const base = { x: num(p[0]), y: num(p[1]), time: num(p[2]), type, hitSound: num(p[4]) };
  if (type & 128) {
    // osu!mania hold: endTime:hitSample
    const rest = (p[5] || '').split(':');
    const endTime = num(rest[0], base.time);
    return { ...base, endTime, sample: parseSample(rest.slice(1).join(':')) };
  }
  if (type & 8) return { ...base, endTime: num(p[5], base.time), sample: parseSample(p[6]) };
  if (type & 2) return { ...base, slider: { slides: Math.max(1, num(p[6], 1)), length: num(p[7]) }, sample: parseSample(p[10]) };
  return { ...base, sample: parseSample(p[5]) };
}

// ------------------------------------------------------------ timing ----

/** Uninherited timing points as BPM changes (seconds). */
export function timingOf(map: OsuBeatmap): TimingPoint[] {
  const out: TimingPoint[] = [];
  for (const tp of map.timingPoints) {
    if (!tp.uninherited || tp.beatLength <= 0) continue;
    const bpm = 60000 / tp.beatLength;
    if (!Number.isFinite(bpm) || bpm <= 0) continue;
    out.push({ t: tp.time / 1000, bpm: Math.round(bpm * 1000) / 1000, meter: tp.meter || 4 });
  }
  return out;
}

function pointAt(points: OsuTimingPoint[], time: number, uninherited: boolean | null): OsuTimingPoint | null {
  let best: OsuTimingPoint | null = null;
  for (const tp of points) {
    if (tp.time > time + 1) break;
    if (uninherited === null || tp.uninherited === uninherited) best = tp;
  }
  return best;
}

/** Slider duration in ms from its pixel length and the slider velocity at its start. */
function sliderDuration(map: OsuBeatmap, obj: OsuHitObject): number {
  const beat = pointAt(map.timingPoints, obj.time, true)?.beatLength || 500;
  const inh = pointAt(map.timingPoints, obj.time, null);
  const sv = inh && !inh.uninherited && inh.beatLength < 0 ? Math.max(0.1, Math.min(10, -100 / inh.beatLength)) : 1;
  const mult = num(map.difficulty.SliderMultiplier, 1.4) || 1.4;
  return (obj.slider!.length / (mult * 100 * sv)) * beat * obj.slider!.slides;
}

// ----------------------------------------------------------- samples ----

const SET_NAMES: Record<number, string> = { 1: 'normal', 2: 'soft', 3: 'drum' };

/**
 * The sample files a hit object plays, if the beatmap ships them: its own
 * filename (keysound), or the beatmap's custom hitsounds for its sample set.
 */
function samplesFor(map: OsuBeatmap, obj: OsuHitObject, has: (name: string) => string | null): { files: string[]; volume: number } {
  const tp = pointAt(map.timingPoints, obj.time, null);
  const volume = (obj.sample.volume > 0 ? obj.sample.volume : tp?.volume ?? 100) / 100;
  if (obj.sample.filename) {
    const f = has(obj.sample.filename);
    return { files: f ? [f] : [], volume };
  }
  const index = obj.sample.index > 0 ? obj.sample.index : tp?.sampleIndex ?? 0;
  if (index === 0) return { files: [], volume }; // default skin hitsounds: nothing custom to play
  const normal = SET_NAMES[obj.sample.normalSet] || SET_NAMES[tp?.sampleSet ?? 0] || SET_NAMES[SET_NAME_DEFAULT(map)];
  const addition = SET_NAMES[obj.sample.additionSet] || normal;
  const suffix = index > 1 ? String(index) : '';
  const names = [`${normal}-hitnormal${suffix}`];
  if (obj.hitSound & 2) names.push(`${addition}-hitwhistle${suffix}`);
  if (obj.hitSound & 4) names.push(`${addition}-hitfinish${suffix}`);
  if (obj.hitSound & 8) names.push(`${addition}-hitclap${suffix}`);
  const files: string[] = [];
  for (const n of names) {
    const f = has(`${n}.wav`) || has(`${n}.ogg`) || has(`${n}.mp3`);
    if (f) files.push(f);
  }
  return { files, volume };
}

function SET_NAME_DEFAULT(map: OsuBeatmap): number {
  const s = (map.general.SampleSet || 'Normal').toLowerCase();
  return s === 'soft' ? 2 : s === 'drum' ? 3 : 1;
}

// -------------------------------------------------------- conversion ----

/**
 * Converts hit objects to notes on 4 lanes. `has` resolves a file name
 * inside the beatmap folder (case-insensitive) or returns null.
 */
export function convertNotes(map: OsuBeatmap, has: (name: string) => string | null = () => null): { notes: MapNote[]; converted: boolean } {
  const raw: MapNote[] = [];
  const keys = map.keys;
  let converted = !(map.mode === 3 && keys === LANES);
  let spin = 0;
  for (const obj of map.hitObjects) {
    let lane: number;
    let end: number | undefined;
    if (map.mode === 3) {
      const col = Math.max(0, Math.min(keys - 1, Math.floor((obj.x * keys) / 512)));
      lane = keys === LANES ? col : keys > LANES ? Math.floor((col * LANES) / keys) : keys === 1 ? 1 : Math.round((col * (LANES - 1)) / (keys - 1));
      if (obj.type & 128 && obj.endTime !== undefined && obj.endTime > obj.time) end = obj.endTime;
    } else if (map.mode === 1) {
      // Taiko: kat (whistle/clap) on the outer lanes, don on the inner ones.
      const kat = (obj.hitSound & 10) !== 0;
      lane = kat ? (spin++ % 2 ? 3 : 0) : spin++ % 2 ? 2 : 1;
      if (obj.type & 8 && obj.endTime) end = obj.endTime;
    } else {
      lane = Math.max(0, Math.min(LANES - 1, Math.floor((obj.x * LANES) / 512)));
      if (obj.type & 2 && obj.slider) {
        const d = sliderDuration(map, obj);
        if (d >= 120) end = obj.time + d;
      } else if (obj.type & 8 && obj.endTime) {
        lane = spin++ % LANES;
        end = obj.endTime;
      }
    }
    const { files, volume } = samplesFor(map, obj, has);
    const n: MapNote = { t: obj.time / 1000, l: lane };
    if (end !== undefined) n.e = end / 1000;
    if (files.length) {
      n.s = files.join('|');
      if (volume < 0.99) n.v = Math.round(volume * 100) / 100;
    }
    raw.push(n);
  }
  const fixed = resolveCollisions(raw);
  if (fixed.length !== raw.length) converted = true;
  return { notes: fixed, converted };
}

/** Moves notes that land on a busy lane (same time, or inside a hold) to the nearest free lane; drops them if none is free. */
export function resolveCollisions(notes: MapNote[]): MapNote[] {
  const sorted = [...notes].sort((a, b) => a.t - b.t || a.l - b.l);
  const busy = [-Infinity, -Infinity, -Infinity, -Infinity];
  const out: MapNote[] = [];
  const GAP = 0.03;
  for (const n of sorted) {
    const free = (l: number) => n.t > busy[l] + GAP;
    let lane = n.l;
    if (!free(lane)) {
      const order = [lane - 1, lane + 1, lane - 2, lane + 2, lane - 3, lane + 3].filter((l) => l >= 0 && l < LANES);
      const alt = order.find(free);
      if (alt === undefined) continue;
      lane = alt;
    }
    const note = { ...n, l: lane };
    out.push(note);
    busy[lane] = note.e ?? note.t;
  }
  return out;
}

/** Rough star rating from density, peaks and chords (1–10). */
export function estimateLevel(notes: MapNote[]): number {
  if (notes.length < 2) return 1;
  const span = Math.max(1, notes[notes.length - 1].t - notes[0].t);
  const nps = notes.length / span;
  let peak = 0;
  for (let i = 0, j = 0; i < notes.length; i++) {
    while (notes[i].t - notes[j].t > 2) j++;
    peak = Math.max(peak, (i - j + 1) / 2);
  }
  const times = new Set(notes.map((n) => Math.round(n.t * 100)));
  const chordRatio = 1 - times.size / notes.length;
  let jacks = 0;
  const last = [-9, -9, -9, -9];
  for (const n of notes) {
    if (n.t - last[n.l] < 0.2) jacks++;
    last[n.l] = n.t;
  }
  const level = 0.55 * nps + 0.35 * peak + 3 * chordRatio + (jacks / notes.length) * 3;
  return Math.max(0.5, Math.min(12, Math.round(level * 10) / 10));
}

// --------------------------------------------------------------- .osz ----

export interface ImportedSet {
  song: Omit<SongMeta, 'id' | 'createdAt' | 'maps'>;
  maps: Omit<MapData, 'id' | 'songId' | 'createdAt' | 'updatedAt'>[];
  /** Files to copy into the song folder: stored name → bytes. */
  files: Map<string, Uint8Array>;
}

/** Reads an .osz (zip) or a single .osu file. One set per distinct audio file. */
export function readBeatmapArchive(name: string, bytes: Uint8Array, siblings?: Map<string, Uint8Array>): ImportedSet[] {
  let files: Map<string, Uint8Array>;
  if (/\.osu$/i.test(name)) {
    files = new Map(siblings || []);
    files.set(name.split(/[\\/]/).pop()!, bytes);
  } else {
    const entries = unzipSync(bytes);
    files = new Map(Object.entries(entries).filter(([k, v]) => !k.endsWith('/') && v.byteLength > 0));
  }
  const lower = new Map<string, string>();
  for (const k of files.keys()) lower.set(k.replace(/\\/g, '/').toLowerCase(), k);
  const has = (n: string) => lower.get(n.replace(/\\/g, '/').toLowerCase()) ?? null;

  const osuFiles = [...files.keys()].filter((k) => /\.osu$/i.test(k));
  if (!osuFiles.length) throw new Error('No .osu difficulty files in this beatmap');
  const byAudio = new Map<string, ImportedSet>();
  const dec = new TextDecoder();
  for (const f of osuFiles) {
    const bm = parseOsu(dec.decode(files.get(f)!));
    const audioName = has(bm.general.AudioFilename || '');
    const key = audioName || '(none)';
    let set = byAudio.get(key);
    const md = bm.metadata;
    if (!set) {
      const keep = new Map<string, Uint8Array>();
      if (audioName) keep.set(audioName, files.get(audioName)!);
      const bg = bm.background ? has(bm.background) : null;
      if (bg) keep.set(bg, files.get(bg)!);
      const video = bm.video ? has(bm.video.file) : null;
      const videoOk = video && /\.(mp4|m4v|webm|mov)$/i.test(video);
      if (videoOk) keep.set(video!, files.get(video!)!);
      set = {
        song: {
          title: md.Title || md.TitleUnicode || f.replace(/\.osu$/i, ''),
          artist: md.Artist || md.ArtistUnicode || 'Unknown artist',
          source: 'osu',
          audio: audioName || undefined,
          background: bg || undefined,
          cover: bg || undefined,
          coverSource: bg ? 'osu' : undefined,
          video: videoOk ? video! : undefined,
          videoOffset: videoOk ? bm.video!.offset / 1000 : undefined,
          previewTime: num(bm.general.PreviewTime, -1) >= 0 ? num(bm.general.PreviewTime) / 1000 : -1,
          duration: 0,
          tags: [md.Source, md.Tags].filter(Boolean).join(' '),
          description: md.TitleUnicode && md.TitleUnicode !== md.Title ? `${md.ArtistUnicode || ''} – ${md.TitleUnicode}` : undefined,
        },
        maps: [],
        files: keep,
      };
      byAudio.set(key, set);
    }
    const { notes, converted } = convertNotes(bm, has);
    for (const n of notes) for (const s of (n.s || '').split('|').filter(Boolean)) set.files.set(s, files.get(s)!);
    const timing = timingOf(bm);
    if (timing.length && !set.song.bpm) {
      set.song.bpm = timing[0].bpm;
      set.song.offset = timing[0].t;
    }
    const modeName = ['osu!', 'taiko', 'catch', 'mania'][bm.mode] || 'osu!';
    set.maps.push({
      name: md.Version || 'Normal',
      description: converted ? `Converted from ${bm.mode === 3 ? `${bm.keys}K osu!mania` : modeName}.` : '',
      creator: md.Creator || '',
      level: estimateLevel(notes),
      notes,
      timing,
      od: num(bm.difficulty.OverallDifficulty, 8),
      hp: num(bm.difficulty.HPDrainRate, 8),
      origin: 'osu',
      osu: { beatmapId: num(md.BeatmapID) || undefined, setId: num(md.BeatmapSetID) || undefined, version: md.Version, converted, keys: bm.keys },
    });
  }
  const sets = [...byAudio.values()].filter((s) => s.maps.some((m) => m.notes.length));
  if (!sets.length) throw new Error('This beatmap has no playable notes');
  return sets;
}

// ------------------------------------------------------------ writing ----

const osuName = (s: string) => s.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '').trim() || 'untitled';

export interface OsuExportInput {
  song: SongMeta;
  map: MapData;
  audioFile: string;
  background?: string | null;
  video?: string | null;
}

export function writeOsu({ song, map, audioFile, background, video }: OsuExportInput): string {
  const ms = (t: number) => Math.round(t * 1000);
  const ascii = (s: string) => s.replace(/[^\x20-\x7e]/g, '').trim();
  const lines: string[] = [];
  const kv = (k: string, v: string | number) => lines.push(`${k}: ${v}`);
  const kvTight = (k: string, v: string | number) => lines.push(`${k}:${v}`);
  lines.push('osu file format v14', '', '[General]');
  kv('AudioFilename', audioFile);
  kv('AudioLeadIn', 0);
  kv('PreviewTime', song.previewTime >= 0 ? ms(song.previewTime) : -1);
  kv('Countdown', 0);
  kv('SampleSet', 'Soft');
  kv('StackLeniency', 0.7);
  kv('Mode', 3);
  kv('LetterboxInBreaks', 0);
  kv('SpecialStyle', 0);
  kv('WidescreenStoryboard', 1);
  lines.push('', '[Editor]');
  kv('DistanceSpacing', 1);
  kv('BeatDivisor', map.generator?.snap && map.generator.snap > 0 ? map.generator.snap : 4);
  kv('GridSize', 32);
  kv('TimelineZoom', 1);
  lines.push('', '[Metadata]');
  kvTight('Title', ascii(song.title) || 'Untitled');
  kvTight('TitleUnicode', song.title);
  kvTight('Artist', ascii(song.artist) || 'Unknown');
  kvTight('ArtistUnicode', song.artist);
  kvTight('Creator', map.creator || 'PIANO-BEATS');
  kvTight('Version', map.name);
  kvTight('Source', song.source === 'youtube' ? 'YouTube' : '');
  kvTight('Tags', [song.tags, 'piano-beats', map.description].filter(Boolean).join(' ').replace(/\s+/g, ' ').slice(0, 400));
  kvTight('BeatmapID', map.osu?.beatmapId ?? 0);
  kvTight('BeatmapSetID', map.osu?.setId ?? -1);
  lines.push('', '[Difficulty]');
  kvTight('HPDrainRate', map.hp);
  kvTight('CircleSize', LANES);
  kvTight('OverallDifficulty', map.od);
  kvTight('ApproachRate', 5);
  kvTight('SliderMultiplier', 1.4);
  kvTight('SliderTickRate', 1);
  lines.push('', '[Events]', '//Background and Video events');
  if (background) lines.push(`0,0,"${background}",0,0`);
  if (video) lines.push(`Video,${ms(song.videoOffset || 0)},"${video}"`);
  lines.push('//Break Periods', '//Storyboard Layer 0 (Background)', '//Storyboard Layer 1 (Fail)', '//Storyboard Layer 2 (Pass)', '//Storyboard Layer 3 (Foreground)', '//Storyboard Sound Samples');
  lines.push('', '[TimingPoints]');
  const timing = map.timing.length ? map.timing : [{ t: song.offset ?? 0, bpm: song.bpm || 120, meter: 4 }];
  for (const tp of [...timing].sort((a, b) => a.t - b.t)) lines.push(`${ms(tp.t)},${(60000 / tp.bpm).toFixed(12).replace(/0+$/, '').replace(/\.$/, '')},${tp.meter || 4},2,0,60,1,0`);
  lines.push('', '[HitObjects]');
  for (const n of [...map.notes].sort((a, b) => a.t - b.t || a.l - b.l)) {
    const x = Math.floor((512 * (n.l + 0.5)) / LANES);
    const sample = n.s ? `0:0:0:${Math.round((n.v ?? 1) * 100)}:${n.s.split('|')[0]}` : '0:0:0:0:';
    if (n.e !== undefined && n.e > n.t) lines.push(`${x},192,${ms(n.t)},128,0,${ms(n.e)}:${sample}`);
    else lines.push(`${x},192,${ms(n.t)},1,0,${sample}`);
  }
  return lines.join('\r\n') + '\r\n';
}

export function osuFileName(song: SongMeta, map: MapData): string {
  return osuName(`${song.artist} - ${song.title} (${map.creator || 'PIANO-BEATS'}) [${map.name}]`) + '.osu';
}

export function oszFileName(song: SongMeta): string {
  return osuName(`${song.artist} - ${song.title}`) + '.osz';
}

/** Packs difficulties and media into an .osz archive. */
export function buildOsz(osuFiles: { name: string; text: string }[], media: Map<string, Uint8Array>): Uint8Array {
  const zip: Zippable = {};
  for (const f of osuFiles) zip[f.name] = [strToU8(f.text), { level: 6 }];
  for (const [name, data] of media) zip[name] = [data, { level: 0 }];
  return zipSync(zip);
}

/** Builds a MapData from an imported difficulty. */
export function mapFromImport(songId: string, m: ImportedSet['maps'][number]): MapData {
  const t = now();
  return { ...m, id: uid(), songId, createdAt: t, updatedAt: t };
}
