// High-level song and map operations for the 4K area: importing (files,
// downloads, osu! beatmaps, piano scores), cover art, analysis, map
// generation, loading for play, and export to osu!.

import type { PianoEngine } from '../audio/engine';
import { loadScore } from '../score/loader';
import type { Score } from '../score/model';
import { renderScore } from './audio/render';
import { analyzeAudio, encodeMp3 } from './audio/workerClient';
import type { BeatsAudio } from './audio/deck';
import { ANALYSIS_VERSION } from './audio/dsp';
import { eventsFromAnalysis, eventsFromScore, estimateLevel, generate, PRESET_NAMES, presetOptions, timingFromScore } from './mapgen';
import { buildOsz, mapFromImport, osuFileName, oszFileName, readBeatmapArchive, writeOsu } from './osu';
import { AUDIO_EXTS, extOf, IMAGE_EXTS, SCORE_EXTS, VIDEO_EXTS, type BeatsStore, type PickedFile } from './store';
import { imageExt, readTags } from './tags';
import type { Analysis, GeneratorOptions, MapData, Preset, SongMeta, TimingPoint } from './types';
import { now, uid } from './types';
import { coverFromUrl, downloadMedia, findCover, splitArtistTitle, youtubeId, type CoverResult, type DownloadInfo } from './web';

export type Progress = (label: string, fraction: number | null) => void;

const noop: Progress = () => {};

export class BeatsLibrary {
  private buffers = new Map<string, AudioBuffer>();
  private analyses = new Map<string, Analysis>();
  private scores = new Map<string, Score>();
  private previews = new Map<string, { buffer: AudioBuffer; start: number }>();
  private samples = new Map<string, AudioBuffer>();

  constructor(readonly store: BeatsStore, readonly audio: BeatsAudio, readonly engine: PianoEngine, private creator: () => string) {}

  // ------------------------------------------------------------ loading ----

  /** Decoded audio of an audio song (cached for the last two songs). */
  async audioBuffer(song: SongMeta): Promise<AudioBuffer> {
    const hit = this.buffers.get(song.id);
    if (hit) {
      this.buffers.delete(song.id);
      this.buffers.set(song.id, hit);
      return hit;
    }
    if (!song.audio) throw new Error('This song has no audio file');
    const buf = await this.audio.decode(await this.store.readFile(song.id, song.audio));
    this.buffers.set(song.id, buf);
    while (this.buffers.size > 2) this.buffers.delete(this.buffers.keys().next().value!);
    return buf;
  }

  async score(song: SongMeta): Promise<Score> {
    const hit = this.scores.get(song.id);
    if (hit) return hit;
    if (!song.score) throw new Error('This song has no score');
    const s = loadScore(await this.store.readFile(song.id, song.score), { fileName: song.score });
    this.scores.set(song.id, s);
    return s;
  }

  async analysis(song: SongMeta, progress: Progress = noop): Promise<Analysis> {
    const hit = this.analyses.get(song.id);
    if (hit) return hit;
    try {
      const cached = JSON.parse(new TextDecoder().decode(await this.store.readFile(song.id, 'analysis.json'))) as Analysis;
      if (cached.version === ANALYSIS_VERSION) {
        this.analyses.set(song.id, cached);
        return cached;
      }
    } catch {
      /* not analysed yet */
    }
    progress('Decoding audio…', null);
    const buf = await this.audioBuffer(song);
    progress('Listening for beats and notes…', 0);
    const a = await analyzeAudio(buf, (p) => progress('Listening for beats and notes…', p));
    await this.store.writeFile(song.id, 'analysis.json', JSON.stringify(a));
    this.analyses.set(song.id, a);
    return a;
  }

  /** Timing of a song: its maps' or score's tempo, else the analysed beat grid. */
  async timing(song: SongMeta, map?: MapData | null): Promise<TimingPoint[]> {
    if (map?.timing.length) return map.timing;
    if (song.source === 'score') return timingFromScore(await this.score(song));
    if (song.bpm) return [{ t: song.offset ?? 0, bpm: song.bpm, meter: 4 }];
    const a = await this.analysis(song);
    return [{ t: a.offset, bpm: a.bpm, meter: 4 }];
  }

  /** Audio for the record player: the song around its preview point. */
  async preview(song: SongMeta): Promise<{ buffer: AudioBuffer; start: number; length: number }> {
    const length = 32;
    if (song.source === 'score') {
      let p = this.previews.get(song.id);
      if (!p) {
        const score = await this.score(song);
        const start = Math.max(0, Math.min(song.previewTime >= 0 ? song.previewTime : 0, score.duration - 8));
        const buffer = await renderScore(this.engine, score, { from: start, to: start + length, fadeOut: 1.5 });
        p = { buffer, start };
        this.previews.set(song.id, p);
        while (this.previews.size > 4) this.previews.delete(this.previews.keys().next().value!);
      }
      return { buffer: p.buffer, start: 0, length: p.buffer.duration };
    }
    const buffer = await this.audioBuffer(song);
    const start = Math.max(0, Math.min(song.previewTime >= 0 ? song.previewTime : buffer.duration * 0.35, buffer.duration - 10));
    return { buffer, start, length: Math.min(length, buffer.duration - start) };
  }

  /** Decoded keysound samples used by a map. */
  async keysounds(song: SongMeta, map: MapData): Promise<Map<string, AudioBuffer>> {
    const names = new Set<string>();
    for (const n of map.notes) for (const s of (n.s || '').split('|')) if (s) names.add(s);
    const out = new Map<string, AudioBuffer>();
    await Promise.all(
      [...names].map(async (name) => {
        const key = `${song.id}/${name}`;
        let buf = this.samples.get(key);
        if (!buf) {
          try {
            buf = await this.audio.decode(await this.store.readFile(song.id, name));
            this.samples.set(key, buf);
          } catch {
            return;
          }
        }
        out.set(name, buf);
      }),
    );
    return out;
  }

  forget(songId: string) {
    this.buffers.delete(songId);
    this.analyses.delete(songId);
    this.scores.delete(songId);
    this.previews.delete(songId);
    for (const k of [...this.samples.keys()]) if (k.startsWith(`${songId}/`)) this.samples.delete(k);
  }

  // ------------------------------------------------------------ creating ----

  private async newSong(partial: Partial<SongMeta> & Pick<SongMeta, 'title' | 'source'>): Promise<SongMeta> {
    const song: SongMeta = { id: uid(), artist: '', previewTime: -1, duration: 0, createdAt: now(), maps: [], ...partial };
    return this.store.saveSong(song);
  }

  /** Sets the preview point to the loudest 20 s of the song (usually the chorus). */
  private previewFrom(a: Analysis): number {
    const e = a.energy;
    const win = 40;
    let best = 0;
    let bestAt = Math.floor(e.length * 0.35);
    let sum = 0;
    for (let i = 0; i < e.length; i++) {
      sum += e[i];
      if (i >= win) sum -= e[i - win];
      const start = i - win + 1;
      if (start >= e.length * 0.12 && start <= e.length * 0.75 && sum > best * 1.02) {
        best = sum;
        bestAt = start;
      }
    }
    return Math.round(bestAt * 0.5 * 10) / 10;
  }

  /** Analyses a fresh audio song and fills in duration, tempo and preview point. */
  async finishAudioSong(song: SongMeta, progress: Progress = noop): Promise<SongMeta> {
    const a = await this.analysis(song, progress);
    const next: SongMeta = {
      ...song,
      duration: a.duration,
      bpm: song.bpm ?? a.bpm,
      offset: song.offset ?? a.offset,
      previewTime: song.previewTime >= 0 ? song.previewTime : this.previewFrom(a),
    };
    return this.store.saveSong(next);
  }

  /** Imports an audio or video file from disk. */
  async createFromFile(picked: PickedFile, progress: Progress = noop): Promise<SongMeta> {
    const ext = extOf(picked.name);
    if (!AUDIO_EXTS.includes(ext) && !VIDEO_EXTS.includes(ext)) throw new Error(`${picked.name} is not an audio or video file`);
    const isVideo = VIDEO_EXTS.includes(ext);
    progress('Reading file…', null);
    const head = picked.size < 40e6 ? await this.store.readPicked(picked) : null;
    const tags = head ? readTags(head) : {};
    const guess = splitArtistTitle(picked.name);
    let song = await this.newSong({
      title: tags.title || guess.title || picked.name,
      artist: tags.artist || guess.artist || 'Unknown artist',
      source: 'file',
      tags: tags.album,
    });
    progress('Copying into your library…', null);
    const audioName = `audio.${ext}`;
    if (head) await this.store.writeFile(song.id, audioName, head);
    else await this.store.importFile(song.id, picked, audioName);
    song = { ...song, audio: audioName, video: isVideo ? audioName : undefined };
    if (tags.picture) {
      const name = `cover.${imageExt(tags.picture.mime)}`;
      await this.store.writeFile(song.id, name, tags.picture.data);
      song = { ...song, cover: name, coverSource: 'embedded' };
    }
    song = await this.store.saveSong(song);
    try {
      song = await this.finishAudioSong(song, progress);
    } catch (err) {
      await this.store.deleteSong(song.id);
      throw new Error(`Couldn't read the audio in ${picked.name}: ${err instanceof Error ? err.message : err}`);
    }
    if (!song.cover) song = await this.fetchCover(song, progress);
    return song;
  }

  /** Downloads a song (YouTube or any page yt-dlp understands). */
  async createFromUrl(url: string, opts: { video: boolean; maxHeight: number; job: string }, progress: Progress = noop): Promise<SongMeta> {
    const yid = youtubeId(url);
    const pageUrl = yid ? `https://www.youtube.com/watch?v=${yid}` : url;
    let song = await this.newSong({ title: 'Downloading…', source: yid ? 'youtube' : 'url', youtubeId: yid || undefined, url: pageUrl });
    let info: DownloadInfo;
    try {
      const r = await downloadMedia(opts.job, pageUrl, song.id, opts.video, opts.maxHeight);
      info = r.info;
      const named = info.track && info.artist ? { title: info.track, artist: info.artist } : splitArtistTitle(info.title || 'Untitled', info.uploader || '');
      song = await this.store.saveSong({
        ...song,
        title: named.title || info.title,
        artist: named.artist || info.uploader || 'Unknown artist',
        audio: r.audio,
        video: r.video || undefined,
        youtubeId: info.extractor?.toLowerCase().includes('youtube') ? info.id : song.youtubeId,
        description: info.description?.split('\n')[0]?.slice(0, 200) || undefined,
        tags: [info.album, info.uploader].filter(Boolean).join(' ') || undefined,
      });
    } catch (err) {
      await this.store.deleteSong(song.id);
      throw err;
    }
    song = await this.finishAudioSong(song, progress);
    // Cover: the video thumbnail; else the page's own thumbnail; else Google & co.
    song = await this.fetchCover(song, progress, info.thumbnail);
    return song;
  }

  async importBeatmap(name: string, bytes: Uint8Array, progress: Progress = noop): Promise<SongMeta[]> {
    progress('Reading beatmap…', null);
    const sets = readBeatmapArchive(name, bytes);
    const out: SongMeta[] = [];
    for (const set of sets) {
      let song = await this.newSong({ ...set.song, previewTime: set.song.previewTime });
      let i = 0;
      for (const [file, data] of set.files) {
        progress(`Copying ${file}…`, i++ / set.files.size);
        await this.store.writeFile(song.id, file, data);
      }
      for (const m of set.maps) await this.store.saveMap({ ...mapFromImport(song.id, m), creator: m.creator });
      song = this.store.song(song.id) || song;
      if (song.audio) {
        try {
          const buf = await this.audioBuffer(song);
          song = await this.store.saveSong({ ...song, duration: buf.duration, previewTime: song.previewTime >= 0 ? song.previewTime : buf.duration * 0.35 });
        } catch {
          /* unreadable audio: still keep the maps */
        }
      }
      if (!song.cover) song = await this.fetchCover(song, progress);
      out.push(song);
    }
    return out;
  }

  /** Creates a song from a piano score (a file, a search result or the piano library). */
  async createFromScore(bytes: Uint8Array, fileName: string, meta: { title?: string; composer?: string; source?: string } = {}): Promise<SongMeta> {
    const score = loadScore(bytes, { fileName });
    const ext = extOf(fileName) || 'musicxml';
    let song = await this.newSong({
      title: meta.title || score.title || fileName,
      artist: meta.composer || score.composer || 'Unknown composer',
      source: 'score',
      tags: meta.source,
      duration: score.duration,
      previewTime: Math.min(score.duration * 0.25, 20),
    });
    const scoreName = `score.${SCORE_EXTS.includes(ext) ? ext : 'musicxml'}`;
    await this.store.writeFile(song.id, scoreName, bytes);
    const timing = timingFromScore(score);
    song = await this.store.saveSong({ ...song, score: scoreName, bpm: timing[0]?.bpm, offset: timing[0]?.t ?? 0 });
    this.scores.set(song.id, score);
    return song;
  }

  // -------------------------------------------------------------- covers ----

  async fetchCover(song: SongMeta, progress: Progress = noop, pageThumbnail?: string | null, order?: CoverResult['source'][]): Promise<SongMeta> {
    progress('Looking for the cover art…', null);
    let r: CoverResult | null = null;
    try {
      r = await findCover({ youtubeId: song.youtubeId, artist: song.artist, title: song.title, order });
      if (!r && pageThumbnail) r = await coverFromUrl(pageThumbnail);
    } catch {
      r = null;
    }
    if (!r) return song;
    const name = `cover.${r.ext}`;
    if (song.cover && song.cover !== name && song.cover !== song.background) await this.store.removeFile(song.id, song.cover).catch(() => {});
    await this.store.writeFile(song.id, name, r.bytes);
    return this.store.saveSong({ ...song, cover: name, coverSource: r.source });
  }

  async setCoverFromFile(song: SongMeta, picked: PickedFile): Promise<SongMeta> {
    const ext = extOf(picked.name);
    if (!IMAGE_EXTS.includes(ext)) throw new Error('Choose a JPG, PNG, WebP or GIF image');
    const name = `cover-${Date.now().toString(36)}.${ext}`;
    await this.store.importFile(song.id, picked, name);
    return this.store.saveSong({ ...song, cover: name, coverSource: 'file' });
  }

  async setVideoFromFile(song: SongMeta, picked: PickedFile): Promise<SongMeta> {
    const ext = extOf(picked.name);
    if (!VIDEO_EXTS.includes(ext)) throw new Error('Choose an MP4, WebM or MOV video');
    const name = `video-${Date.now().toString(36)}.${ext}`;
    await this.store.importFile(song.id, picked, name);
    return this.store.saveSong({ ...song, video: name, videoOffset: song.videoOffset ?? 0 });
  }

  // ---------------------------------------------------------------- maps ----

  /** Builds a map (not saved) with the generator. */
  async generateMap(song: SongMeta, o: GeneratorOptions, progress: Progress = noop): Promise<Pick<MapData, 'notes' | 'timing' | 'level'>> {
    if (song.source === 'score') {
      const score = await this.score(song);
      const timing = timingFromScore(score);
      const notes = generate({ events: eventsFromScore(score, o.hands, timing), timing, duration: score.duration }, o);
      return { notes, timing, level: estimateLevel(notes) };
    }
    const a = await this.analysis(song, progress);
    const timing: TimingPoint[] = song.bpm ? [{ t: song.offset ?? a.offset, bpm: song.bpm, meter: 4 }] : [{ t: a.offset, bpm: a.bpm, meter: 4 }];
    const notes = generate({ events: eventsFromAnalysis(a, o.focus, timing), timing, duration: a.duration, energy: a.energy }, o);
    return { notes, timing, level: estimateLevel(notes) };
  }

  newMap(song: SongMeta, name: string, o?: GeneratorOptions): MapData {
    const t = now();
    return {
      id: uid(),
      songId: song.id,
      name,
      description: '',
      creator: this.creator() || 'You',
      level: 1,
      notes: [],
      timing: [],
      od: 8,
      hp: 7,
      hands: o?.hands ?? 'both',
      generator: o,
      origin: 'generated',
      createdAt: t,
      updatedAt: t,
    };
  }

  /** Generates and saves maps for the given presets. */
  async generateDefaultMaps(song: SongMeta, presets: Preset[], progress: Progress = noop): Promise<SongMeta> {
    let latest = song;
    for (let i = 0; i < presets.length; i++) {
      const p = presets[i];
      progress(`Mapping ${PRESET_NAMES[p]}…`, i / presets.length);
      const o = presetOptions(p, { seed: 1 + i });
      const g = await this.generateMap(song, o);
      if (!g.notes.length) continue;
      const map = { ...this.newMap(song, PRESET_NAMES[p], o), ...g, od: [6, 7, 8, 8.5, 9][['easy', 'normal', 'hard', 'insane', 'expert'].indexOf(p)] ?? 8 };
      map.description = `Made by the PIANO-BEATS map generator (${PRESET_NAMES[p]} preset).`;
      latest = await this.store.saveMap(map);
    }
    return latest;
  }

  saveMap(map: MapData) {
    return this.store.saveMap({ ...map, updatedAt: now() });
  }

  loadMap(song: SongMeta, id: string) {
    return this.store.loadMap(song.id, id);
  }

  async deleteSong(song: SongMeta) {
    this.forget(song.id);
    await this.store.deleteSong(song.id);
  }

  // -------------------------------------------------------------- export ----

  /** Builds an .osz with the given maps (osu!mania 4K). */
  async exportOsz(song: SongMeta, maps: MapData[], opts: { video: boolean }, progress: Progress = noop): Promise<{ name: string; bytes: Uint8Array }> {
    const media = new Map<string, Uint8Array>();
    let audioFile = 'audio.mp3';
    if (song.source === 'score') {
      const score = await this.score(song);
      progress('Rendering the piano…', 0);
      const buf = await renderScore(this.engine, score, { onProgress: (p) => progress('Rendering the piano…', p) });
      progress('Encoding MP3…', 0);
      media.set(audioFile, await encodeMp3(buf, 192, (p) => progress('Encoding MP3…', p)));
    } else if (song.audio && extOf(song.audio) === 'mp3') {
      audioFile = 'audio.mp3';
      media.set(audioFile, await this.store.readFile(song.id, song.audio));
    } else {
      progress('Encoding MP3…', 0);
      const buf = await this.audioBuffer(song);
      media.set(audioFile, await encodeMp3(buf, 192, (p) => progress('Encoding MP3…', p)));
    }
    let background: string | null = null;
    const img = song.background || song.cover;
    if (img) {
      progress('Adding the background…', null);
      const bytes = await this.store.readFile(song.id, img);
      const ext = extOf(img);
      if (ext === 'jpg' || ext === 'jpeg' || ext === 'png') {
        background = `bg.${ext}`;
        media.set(background, bytes);
      } else {
        const jpg = await toJpeg(bytes);
        if (jpg) {
          background = 'bg.jpg';
          media.set(background, jpg);
        }
      }
    }
    let video: string | null = null;
    if (opts.video && song.video && song.video !== song.audio) {
      progress('Adding the video…', null);
      video = `video.${extOf(song.video)}`;
      media.set(video, await this.store.readFile(song.id, song.video));
    }
    for (const m of maps) for (const n of m.notes) for (const s of (n.s || '').split('|')) if (s && !media.has(s)) {
      try {
        media.set(s, await this.store.readFile(song.id, s));
      } catch {
        /* missing sample */
      }
    }
    const osuFiles = maps.map((map) => ({ name: osuFileName(song, map), text: writeOsu({ song, map, audioFile, background, video }) }));
    progress('Packing…', null);
    return { name: oszFileName(song), bytes: buildOsz(osuFiles, media) };
  }

  // --------------------------------------------------------------- demos ----

  /** Adds the bundled piano demos (with generated maps) the first time the 4K area opens. */
  async seedDemos(progress: Progress = noop) {
    const KEY = 'pianobeats.seeded.v1';
    try {
      if (localStorage.getItem(KEY)) return;
    } catch {
      return;
    }
    const demos = [
      { file: 'fur-elise.musicxml', title: 'Für Elise (opening)', composer: 'Ludwig van Beethoven' },
      { file: 'minuet-in-g.musicxml', title: 'Minuet in G major', composer: 'Christian Petzold' },
      { file: 'prelude-in-c.musicxml', title: 'Prelude in C major, BWV 846', composer: 'Johann Sebastian Bach' },
      { file: 'ode-to-joy.musicxml', title: 'Ode to Joy', composer: 'Ludwig van Beethoven' },
    ];
    for (const d of demos) {
      try {
        progress(`Adding ${d.title}…`, null);
        const res = await fetch(`./demos/${d.file}`);
        if (!res.ok) continue;
        const song = await this.createFromScore(new Uint8Array(await res.arrayBuffer()), d.file, { title: d.title, composer: d.composer, source: 'demo' });
        await this.generateDefaultMaps(song, ['easy', 'normal', 'hard']);
      } catch (err) {
        console.warn('demo seed failed', d.file, err);
      }
    }
    try {
      localStorage.setItem(KEY, '1');
    } catch {
      /* ignore */
    }
  }
}

async function toJpeg(bytes: Uint8Array): Promise<Uint8Array | null> {
  try {
    const bmp = await createImageBitmap(new Blob([bytes as BlobPart]));
    const c = document.createElement('canvas');
    c.width = bmp.width;
    c.height = bmp.height;
    c.getContext('2d')!.drawImage(bmp, 0, 0);
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', 0.9));
    return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
  } catch {
    return null;
  }
}
