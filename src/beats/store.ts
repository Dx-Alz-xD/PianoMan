// The 4K song library. In the desktop app songs live on disk (see
// electron/beats.cjs) and media is streamed over media://; in a plain browser
// everything is kept in IndexedDB and served as blob: URLs.

import type { MapData, SongMeta } from './types';
import { summarize } from './types';

export interface PickedFile {
  name: string;
  size: number;
  /** Absolute path (desktop). */
  path?: string;
  /** Browser file (drag and drop or <input type=file>). */
  file?: File;
}

export type PickKind = 'audio' | 'video' | 'image' | 'osu' | 'score' | 'any';

interface DesktopBeats {
  list(): Promise<SongMeta[]>;
  dir(): Promise<string>;
  saveSong(meta: SongMeta): Promise<SongMeta>;
  deleteSong(id: string): Promise<boolean>;
  writeFile(song: string, name: string, data: Uint8Array | string): Promise<{ name: string; size: number }>;
  readFile(song: string, name: string): Promise<Uint8Array>;
  hasFile(song: string, name: string): Promise<boolean>;
  removeFile(song: string, name: string): Promise<boolean>;
  copyIn(song: string, src: string, name: string): Promise<{ name: string; size: number }>;
  saveMap(song: string, map: MapData, summary: unknown): Promise<SongMeta>;
  loadMap(song: string, map: string): Promise<MapData>;
  deleteMap(song: string, map: string): Promise<SongMeta>;
  pickFiles(opts: { kind: PickKind; multiple?: boolean; title?: string }): Promise<{ path: string; name: string; size: number }[]>;
  readPath(p: string): Promise<Uint8Array>;
  statPath(p: string): Promise<{ path: string; name: string; size: number }>;
  openPath(p: string): Promise<string>;
  showItem(p: string): Promise<boolean>;
  openSongFolder(id?: string): Promise<string>;
}

interface DesktopExtras {
  beats: DesktopBeats;
  pathForFile(file: File): string | null;
  onOpenBeatmap(cb: (path: string) => void): () => void;
  pendingBeatmaps(): Promise<string[]>;
}

const desktop = (typeof window !== 'undefined' ? (window as unknown as { pianoman?: DesktopExtras }).pianoman : undefined) as DesktopExtras | undefined;
const api = desktop?.beats;

export const hasDiskLibrary = !!api;

export function pathForFile(file: File): string | null {
  return desktop?.pathForFile ? desktop.pathForFile(file) : null;
}

export function onOpenBeatmap(cb: (path: string) => void): () => void {
  return desktop?.onOpenBeatmap ? desktop.onOpenBeatmap(cb) : () => {};
}

export function pendingBeatmaps(): Promise<string[]> {
  return desktop?.pendingBeatmaps ? desktop.pendingBeatmaps() : Promise.resolve([]);
}

// ------------------------------------------------------ browser storage ----

let dbPromise: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const open = indexedDB.open('piano-beats', 1);
      open.onupgradeneeded = () => {
        open.result.createObjectStore('songs', { keyPath: 'id' });
        open.result.createObjectStore('files');
        open.result.createObjectStore('maps');
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
  }
  return dbPromise;
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function idbGet<T>(store: string, key: string): Promise<T | undefined> {
  return (await req((await db()).transaction(store).objectStore(store).get(key))) as T | undefined;
}

async function idbPut(store: string, value: unknown, key?: string) {
  const d = await db();
  await req(d.transaction(store, 'readwrite').objectStore(store).put(value, key));
}

async function idbDelete(store: string, key: string | IDBKeyRange) {
  const d = await db();
  await req(d.transaction(store, 'readwrite').objectStore(store).delete(key));
}

const prefixRange = (song: string) => IDBKeyRange.bound(`${song}/`, `${song}/￿`);

// ---------------------------------------------------------------- store ----

export class BeatsStore {
  songs: SongMeta[] = [];
  private blobUrls = new Map<string, string>();
  private listeners = new Set<() => void>();

  onChange(cb: () => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private changed() {
    for (const cb of this.listeners) cb();
  }

  async refresh(): Promise<SongMeta[]> {
    if (api) this.songs = await api.list();
    else {
      const all = (await req((await db()).transaction('songs').objectStore('songs').getAll())) as SongMeta[];
      this.songs = all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }
    this.changed();
    return this.songs;
  }

  song(id: string): SongMeta | undefined {
    return this.songs.find((s) => s.id === id);
  }

  async saveSong(meta: SongMeta): Promise<SongMeta> {
    const saved = api ? await api.saveSong(meta) : (await idbPut('songs', meta), meta);
    const i = this.songs.findIndex((s) => s.id === saved.id);
    if (i >= 0) this.songs[i] = saved;
    else this.songs.unshift(saved);
    this.changed();
    return saved;
  }

  async deleteSong(id: string) {
    if (api) await api.deleteSong(id);
    else {
      await idbDelete('songs', id);
      await idbDelete('files', prefixRange(id));
      await idbDelete('maps', prefixRange(id));
    }
    for (const [k, url] of this.blobUrls) {
      if (k.startsWith(`${id}/`)) {
        URL.revokeObjectURL(url);
        this.blobUrls.delete(k);
      }
    }
    this.songs = this.songs.filter((s) => s.id !== id);
    this.changed();
  }

  async writeFile(song: string, name: string, data: Uint8Array | string) {
    const key = `${song}/${name}`;
    const old = this.blobUrls.get(key);
    if (old) {
      URL.revokeObjectURL(old);
      this.blobUrls.delete(key);
    }
    if (api) return api.writeFile(song, name, data);
    await idbPut('files', new Blob([data as BlobPart], { type: mimeFor(name) }), key);
    return { name, size: typeof data === 'string' ? data.length : data.byteLength };
  }

  async readFile(song: string, name: string): Promise<Uint8Array> {
    if (api) return api.readFile(song, name);
    const blob = await idbGet<Blob>('files', `${song}/${name}`);
    if (!blob) throw new Error(`Missing file ${name}`);
    return new Uint8Array(await blob.arrayBuffer());
  }

  async hasFile(song: string, name: string): Promise<boolean> {
    if (api) return api.hasFile(song, name);
    return !!(await idbGet<Blob>('files', `${song}/${name}`));
  }

  async removeFile(song: string, name: string) {
    if (api) await api.removeFile(song, name);
    else await idbDelete('files', `${song}/${name}`);
  }

  /** Copies a picked or dropped file into the song folder. */
  async importFile(song: string, picked: PickedFile, name: string) {
    if (api && picked.path) return api.copyIn(song, picked.path, name);
    return this.writeFile(song, name, await this.readPicked(picked));
  }

  async readPicked(picked: PickedFile): Promise<Uint8Array> {
    if (picked.file) return new Uint8Array(await picked.file.arrayBuffer());
    if (api && picked.path) return api.readPath(picked.path);
    throw new Error('File is not readable');
  }

  /** URL the page can load a song file from (audio, video, images). */
  async url(song: string, name: string): Promise<string> {
    if (api) return `media://song/${encodeURIComponent(song)}/${name.split('/').map(encodeURIComponent).join('/')}`;
    const key = `${song}/${name}`;
    let url = this.blobUrls.get(key);
    if (!url) {
      const blob = await idbGet<Blob>('files', key);
      if (!blob) throw new Error(`Missing file ${name}`);
      url = URL.createObjectURL(blob);
      this.blobUrls.set(key, url);
    }
    return url;
  }

  /** Synchronous variant for the desktop app (returns null in the browser). */
  urlSync(song: string, name: string): string | null {
    if (api) return `media://song/${encodeURIComponent(song)}/${name.split('/').map(encodeURIComponent).join('/')}`;
    return this.blobUrls.get(`${song}/${name}`) ?? null;
  }

  async saveMap(map: MapData): Promise<SongMeta> {
    const summary = summarize(map);
    let song: SongMeta;
    if (api) song = await api.saveMap(map.songId, map, summary);
    else {
      await idbPut('maps', map, `${map.songId}/${map.id}`);
      const cur = this.song(map.songId) || (await idbGet<SongMeta>('songs', map.songId));
      if (!cur) throw new Error('Song not found');
      song = { ...cur, maps: [...cur.maps.filter((m) => m.id !== map.id), summary].sort((a, b) => a.level - b.level), updatedAt: new Date().toISOString() };
      await idbPut('songs', song);
    }
    const i = this.songs.findIndex((s) => s.id === song.id);
    if (i >= 0) this.songs[i] = song;
    this.changed();
    return song;
  }

  async loadMap(song: string, id: string): Promise<MapData> {
    if (api) return api.loadMap(song, id);
    const m = await idbGet<MapData>('maps', `${song}/${id}`);
    if (!m) throw new Error('Map not found');
    return m;
  }

  async deleteMap(songId: string, id: string): Promise<SongMeta> {
    let song: SongMeta;
    if (api) song = await api.deleteMap(songId, id);
    else {
      await idbDelete('maps', `${songId}/${id}`);
      const cur = this.song(songId)!;
      song = { ...cur, maps: cur.maps.filter((m) => m.id !== id) };
      await idbPut('songs', song);
    }
    const i = this.songs.findIndex((s) => s.id === song.id);
    if (i >= 0) this.songs[i] = song;
    this.changed();
    return song;
  }

  async pickFiles(kind: PickKind, multiple = false, title?: string): Promise<PickedFile[]> {
    if (api) return api.pickFiles({ kind, multiple, title });
    const accept: Record<PickKind, string> = {
      audio: 'audio/*,video/mp4,video/webm,.mp3,.ogg,.opus,.wav,.flac,.m4a',
      video: 'video/*',
      image: 'image/*',
      osu: '.osz,.osu',
      score: '.musicxml,.xml,.mxl,.mid,.midi,.kar,.abc',
      any: '*',
    };
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = accept[kind];
      input.multiple = multiple;
      input.onchange = () => resolve(Array.from(input.files || []).map((f) => ({ name: f.name, size: f.size, file: f })));
      input.click();
    });
  }

  /** Turns dropped files into picked files (keeping their paths in the desktop app). */
  fromDrop(files: FileList | File[]): PickedFile[] {
    return Array.from(files).map((f) => ({ name: f.name, size: f.size, file: f, path: pathForFile(f) ?? undefined }));
  }

  async pickedFromPath(p: string): Promise<PickedFile> {
    if (!api) throw new Error('Paths need the desktop app');
    return api.statPath(p);
  }

  openPath(p: string) {
    return api ? api.openPath(p) : Promise.resolve('');
  }

  showItem(p: string) {
    return api ? api.showItem(p) : Promise.resolve(false);
  }

  openSongFolder(id?: string) {
    return api ? api.openSongFolder(id) : Promise.resolve('');
  }
}

export function mimeFor(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() || '';
  const types: Record<string, string> = {
    mp3: 'audio/mpeg',
    ogg: 'audio/ogg',
    opus: 'audio/ogg',
    wav: 'audio/wav',
    flac: 'audio/flac',
    m4a: 'audio/mp4',
    aac: 'audio/aac',
    mp4: 'video/mp4',
    m4v: 'video/mp4',
    webm: 'video/webm',
    mov: 'video/quicktime',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
  };
  return types[ext] || 'application/octet-stream';
}

export function extOf(name: string): string {
  const m = /\.([a-z0-9]{1,5})$/i.exec(name);
  return m ? m[1].toLowerCase() : '';
}

export const AUDIO_EXTS = ['mp3', 'ogg', 'oga', 'opus', 'wav', 'flac', 'm4a', 'aac', 'weba'];
export const VIDEO_EXTS = ['mp4', 'm4v', 'webm', 'mov'];
export const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'gif'];
export const SCORE_EXTS = ['musicxml', 'xml', 'mxl', 'mid', 'midi', 'kar', 'abc'];
