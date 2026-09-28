// Access to desktop features (network without CORS, disk cache, dialogs,
// library). In Electron these go through the preload API; when the UI is
// opened in a plain browser (e.g. `vite` for development) a best-effort
// fallback is used so the app still runs.

export type ResponseType = 'text' | 'json' | 'arraybuffer';
export type CacheBucket = false | 'samples' | 'scores' | 'api';

export interface FetchRequest {
  url: string;
  responseType?: ResponseType;
  cache?: CacheBucket;
  maxAge?: number;
  headers?: Record<string, string>;
  method?: 'GET' | 'POST';
  body?: string;
  /** Cache identity independent of the URL (e.g. the same sample on two mirrors). */
  cacheKey?: string;
}

export interface FetchResponse<T = unknown> {
  ok: boolean;
  status: number;
  fromCache: boolean;
  url: string;
  contentType?: string;
  data: T;
}

export interface OpenedFile {
  name: string;
  path?: string;
  data: Uint8Array;
}

export interface LibraryEntry {
  id: string;
  title: string;
  composer?: string;
  format: string;
  fileName: string;
  source?: string;
  sourceUrl?: string;
  addedAt?: string;
  lastOpenedAt?: string;
  favorite?: boolean;
  size?: number;
}

export interface CacheStats {
  samples: { bytes: number; files: number };
  scores: { bytes: number; files: number };
  api: { bytes: number; files: number };
  dir: string;
}

interface DesktopApi {
  isDesktop: true;
  fetch(req: FetchRequest): Promise<FetchResponse>;
  cacheStats(): Promise<CacheStats>;
  clearCache(bucket?: string): Promise<boolean>;
  openScores(): Promise<OpenedFile[]>;
  openFile(opts?: { title?: string; filters?: { name: string; extensions: string[] }[] }): Promise<OpenedFile | null>;
  saveFile(opts: { defaultName: string; filters?: { name: string; extensions: string[] }[]; data: Uint8Array | string }): Promise<string | null>;
  library: {
    list(): Promise<LibraryEntry[]>;
    save(meta: Partial<LibraryEntry>, data: Uint8Array): Promise<LibraryEntry>;
    update(id: string, patch: Partial<LibraryEntry>): Promise<LibraryEntry | null>;
    load(id: string): Promise<Uint8Array>;
    remove(id: string): Promise<boolean>;
  };
  appInfo(): Promise<Record<string, string>>;
  pendingFiles(): Promise<OpenedFile[]>;
  openExternal(url: string): Promise<unknown>;
  openCacheFolder(): Promise<unknown>;
  onMenu(cb: (action: string) => void): () => void;
  onOpenFile(cb: (file: OpenedFile) => void): () => void;
}

declare global {
  interface Window {
    pianoman?: DesktopApi;
  }
}

const desktop: DesktopApi | undefined = typeof window !== 'undefined' ? window.pianoman : undefined;

export const isDesktop = !!desktop;

// ------------------------------------------------------ browser fallback ----

const memoryCache = new Map<string, unknown>();

async function browserFetch(req: FetchRequest): Promise<FetchResponse> {
  const key = req.cacheKey || `${req.method || 'GET'} ${req.url} ${req.responseType}`;
  if (req.cache && memoryCache.has(key)) {
    return { ok: true, status: 200, fromCache: true, url: req.url, data: memoryCache.get(key) };
  }
  const res = await fetch(req.url, { method: req.method || 'GET', body: req.body, headers: req.headers });
  let data: unknown;
  if (req.responseType === 'arraybuffer') data = new Uint8Array(await res.arrayBuffer());
  else if (req.responseType === 'json') data = await res.json();
  else data = await res.text();
  if (res.ok && req.cache) memoryCache.set(key, data);
  return { ok: res.ok, status: res.status, fromCache: false, url: res.url, contentType: res.headers.get('content-type') || '', data };
}

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('pianoman-library', 1);
    open.onupgradeneeded = () => {
      open.result.createObjectStore('meta', { keyPath: 'id' });
      open.result.createObjectStore('data');
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
  });
}

function idbReq<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const browserLibrary: DesktopApi['library'] = {
  async list() {
    const db = await idb();
    const all = await idbReq(db.transaction('meta').objectStore('meta').getAll());
    return (all as LibraryEntry[]).sort((a, b) => (b.addedAt || '').localeCompare(a.addedAt || ''));
  },
  async save(meta, data) {
    const db = await idb();
    const entry = { ...meta, id: meta.id || crypto.randomUUID(), size: data.byteLength, addedAt: meta.addedAt || new Date().toISOString() } as LibraryEntry;
    const tx = db.transaction(['meta', 'data'], 'readwrite');
    tx.objectStore('meta').put(entry);
    tx.objectStore('data').put(data, entry.id);
    await new Promise((r) => (tx.oncomplete = r));
    return entry;
  },
  async update(id, patch) {
    const db = await idb();
    const cur = (await idbReq(db.transaction('meta').objectStore('meta').get(id))) as LibraryEntry | undefined;
    if (!cur) return null;
    const next = { ...cur, ...patch, id };
    await idbReq(db.transaction('meta', 'readwrite').objectStore('meta').put(next));
    return next;
  },
  async load(id) {
    const db = await idb();
    return (await idbReq(db.transaction('data').objectStore('data').get(id))) as Uint8Array;
  },
  async remove(id) {
    const db = await idb();
    const tx = db.transaction(['meta', 'data'], 'readwrite');
    tx.objectStore('meta').delete(id);
    tx.objectStore('data').delete(id);
    await new Promise((r) => (tx.oncomplete = r));
    return true;
  },
};

function pickFiles(accept: string, multiple: boolean): Promise<OpenedFile[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.onchange = async () => {
      const files = Array.from(input.files || []);
      resolve(await Promise.all(files.map(async (f) => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) }))));
    };
    input.click();
  });
}

function download(name: string, data: Uint8Array | string) {
  const blob = new Blob([data as BlobPart]);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// --------------------------------------------------------------- public ----

export const bridge = {
  fetch<T = unknown>(req: FetchRequest): Promise<FetchResponse<T>> {
    return (desktop ? desktop.fetch(req) : browserFetch(req)) as Promise<FetchResponse<T>>;
  },
  cacheStats(): Promise<CacheStats | null> {
    return desktop ? desktop.cacheStats() : Promise.resolve(null);
  },
  clearCache(bucket?: string): Promise<boolean> {
    if (desktop) return desktop.clearCache(bucket);
    memoryCache.clear();
    return Promise.resolve(true);
  },
  openScores(): Promise<OpenedFile[]> {
    return desktop ? desktop.openScores() : pickFiles('.musicxml,.xml,.mxl,.mid,.midi,.kar,.abc', true);
  },
  async openFile(opts: { title?: string; accept?: string; extensions?: string[] }): Promise<OpenedFile | null> {
    if (desktop) {
      return desktop.openFile({ title: opts.title, filters: [{ name: opts.title || 'Files', extensions: opts.extensions || ['*'] }] });
    }
    const files = await pickFiles(opts.accept || '*', false);
    return files[0] || null;
  },
  async saveFile(defaultName: string, data: Uint8Array | string, filters?: { name: string; extensions: string[] }[]): Promise<string | null> {
    if (desktop) return desktop.saveFile({ defaultName, data, filters });
    download(defaultName, data);
    return defaultName;
  },
  library: desktop ? desktop.library : browserLibrary,
  appInfo(): Promise<Record<string, string>> {
    return desktop ? desktop.appInfo() : Promise.resolve({ version: 'web', platform: navigator.platform });
  },
  pendingFiles(): Promise<OpenedFile[]> {
    return desktop ? desktop.pendingFiles() : Promise.resolve([]);
  },
  openExternal(url: string) {
    if (desktop) desktop.openExternal(url);
    else window.open(url, '_blank', 'noopener');
  },
  openCacheFolder() {
    if (desktop) desktop.openCacheFolder();
  },
  onMenu(cb: (action: string) => void) {
    return desktop ? desktop.onMenu(cb) : () => {};
  },
  onOpenFile(cb: (file: OpenedFile) => void) {
    return desktop ? desktop.onOpenFile(cb) : () => {};
  },
};

/** Fetches the first URL that works from a list of mirrors; `mirror` is the index used. */
export async function fetchFirst<T>(urls: string[], req: Omit<FetchRequest, 'url'>): Promise<FetchResponse<T> & { mirror: number }> {
  let last: unknown = null;
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    try {
      const res = await bridge.fetch<T>({ ...req, url });
      if (res.ok) return { ...res, mirror: i };
      last = new Error(`HTTP ${res.status} for ${url}`);
    } catch (err) {
      last = err;
    }
  }
  throw last instanceof Error ? last : new Error('All mirrors failed');
}
