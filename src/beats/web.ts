// Online lookups for the 4K area: YouTube search and downloads (through
// yt-dlp in the desktop app), and cover art (YouTube thumbnail, the first
// Google Images result, then iTunes and Deezer as fallbacks).

import { bridge, isDesktop } from '../platform/bridge';

export interface VideoResult {
  id: string;
  title: string;
  channel: string;
  duration: number;
  views: number;
  thumbnail: string;
  url: string;
}

export interface DownloadInfo {
  id: string;
  title: string;
  track: string | null;
  artist: string | null;
  album: string | null;
  uploader: string | null;
  duration: number | null;
  thumbnail: string | null;
  thumbnails: { url: string; width: number; height: number }[];
  webpage_url: string | null;
  extractor: string | null;
  description: string | null;
  hasVideo: boolean;
}

export interface DownloadProgress {
  job: string;
  stage: 'install' | 'info' | 'audio' | 'video';
  percent: number | null;
  speed?: number | null;
  eta?: number | null;
  warning?: string;
}

interface DesktopYt {
  status(): Promise<{ installed: boolean; version: string | null; path: string }>;
  install(): Promise<{ installed: boolean; version: string | null }>;
  search(query: string, limit?: number): Promise<VideoResult[]>;
  download(opts: { job: string; url: string; song: string; video: boolean; maxHeight?: number }): Promise<{ audio: string; video: string | null; info: DownloadInfo; size: number }>;
  cancel(job: string): Promise<boolean>;
  onProgress(cb: (p: DownloadProgress) => void): () => void;
}

const yt = (typeof window !== 'undefined' ? (window as unknown as { pianoman?: { yt?: DesktopYt } }).pianoman?.yt : undefined) as DesktopYt | undefined;

export const canDownload = !!yt;

// --------------------------------------------------------------- URLs ----

/** The YouTube video id in a URL (watch, youtu.be, shorts, embed, music), or null. */
export function youtubeId(input: string): string | null {
  const s = input.trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s.startsWith('http') ? s : `https://${s}`);
    const host = u.hostname.replace(/^www\.|^m\./, '');
    if (host === 'youtu.be') return /^[\w-]{11}/.exec(u.pathname.slice(1))?.[0] ?? null;
    if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
      const v = u.searchParams.get('v');
      if (v && /^[\w-]{11}$/.test(v)) return v;
      const m = /^\/(?:shorts|embed|live|v)\/([\w-]{11})/.exec(u.pathname);
      if (m) return m[1];
    }
  } catch {
    /* not a URL */
  }
  return null;
}

export function isUrl(s: string) {
  return /^https?:\/\/\S+$/i.test(s.trim());
}

export function youtubeThumbnails(id: string): string[] {
  return ['maxresdefault', 'sddefault', 'hqdefault', 'mqdefault'].map((q) => `https://i.ytimg.com/vi/${id}/${q}.jpg`);
}

// ------------------------------------------------------------- search ----

const parseDuration = (s: string | undefined) => {
  if (!s) return 0;
  const parts = s.trim().split(':').map((x) => parseInt(x, 10));
  if (parts.some((x) => Number.isNaN(x))) return 0;
  return parts.reduce((acc, x) => acc * 60 + x, 0);
};

const parseViews = (s: string | undefined) => {
  if (!s) return 0;
  const m = /([\d.,]+)\s*([KMB])?/i.exec(s.replace(/ /g, ' '));
  if (!m) return 0;
  const n = parseFloat(m[1].replace(/,/g, ''));
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] || '').toLowerCase() as 'k' | 'm' | 'b'] || 1;
  return Math.round(n * mult);
};

type Json = Record<string, unknown>;
const get = (o: unknown, ...path: (string | number)[]): unknown => path.reduce<unknown>((cur, k) => (cur && typeof cur === 'object' ? (cur as Json)[k as string] : undefined), o);
const text = (o: unknown): string => {
  if (!o || typeof o !== 'object') return typeof o === 'string' ? o : '';
  const j = o as Json;
  if (typeof j.simpleText === 'string') return j.simpleText;
  if (typeof j.content === 'string') return j.content;
  if (Array.isArray(j.runs)) return j.runs.map((r) => (r as Json).text || '').join('');
  return '';
};

/** Extracts video results from a YouTube results page (ytInitialData). */
export function parseYoutubeResults(html: string): VideoResult[] {
  const m = /(?:var ytInitialData|window\["ytInitialData"\])\s*=\s*(\{.+?\});\s*(?:<\/script>|var |window\[)/s.exec(html);
  if (!m) return [];
  let data: unknown;
  try {
    data = JSON.parse(m[1]);
  } catch {
    return [];
  }
  const out: VideoResult[] = [];
  const seen = new Set<string>();
  const walk = (o: unknown, depth: number) => {
    if (!o || typeof o !== 'object' || depth > 40) return;
    if (Array.isArray(o)) {
      for (const x of o) walk(x, depth + 1);
      return;
    }
    const j = o as Json;
    const vr = j.videoRenderer as Json | undefined;
    if (vr && typeof vr.videoId === 'string' && !seen.has(vr.videoId)) {
      seen.add(vr.videoId);
      const thumbs = (get(vr, 'thumbnail', 'thumbnails') as { url: string }[] | undefined) || [];
      out.push({
        id: vr.videoId,
        title: text(vr.title),
        channel: text(vr.ownerText) || text(vr.longBylineText),
        duration: parseDuration(text(vr.lengthText)),
        views: parseViews(text(vr.viewCountText)),
        thumbnail: thumbs.length ? thumbs[thumbs.length - 1].url : youtubeThumbnails(vr.videoId)[2],
        url: `https://www.youtube.com/watch?v=${vr.videoId}`,
      });
      return;
    }
    const lv = j.lockupViewModel as Json | undefined;
    if (lv && typeof lv.contentId === 'string' && (lv.contentType === 'LOCKUP_CONTENT_TYPE_VIDEO' || !lv.contentType) && !seen.has(lv.contentId)) {
      seen.add(lv.contentId);
      const meta = get(lv, 'metadata', 'lockupMetadataViewModel') as Json | undefined;
      const rows = (get(meta, 'metadata', 'contentMetadataViewModel', 'metadataRows') as Json[] | undefined) || [];
      const parts = rows.flatMap((r) => ((r.metadataParts as Json[] | undefined) || []).map((p) => text(p.text)));
      const badge = JSON.stringify(get(lv, 'contentImage') || {}).match(/"text":"(\d+:\d{2}(?::\d{2})?)"/);
      out.push({
        id: lv.contentId,
        title: text(get(meta, 'title')),
        channel: parts[0] || '',
        duration: parseDuration(badge?.[1]),
        views: parseViews(parts.find((p) => /view/i.test(p))),
        thumbnail: youtubeThumbnails(lv.contentId)[2],
        url: `https://www.youtube.com/watch?v=${lv.contentId}`,
      });
      return;
    }
    for (const k in j) walk(j[k], depth + 1);
  };
  walk(data, 0);
  return out.filter((r) => r.title);
}

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

/** Searches YouTube: the results page first, yt-dlp if that fails. */
export async function searchYoutube(query: string): Promise<VideoResult[]> {
  const q = query.trim();
  if (!q) return [];
  try {
    const res = await bridge.fetch<string>({
      url: `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&sp=EgIQAQ%253D%253D&hl=en`,
      headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'en-US,en;q=0.8', Cookie: 'SOCS=CAI; CONSENT=YES+1' },
      cache: 'api',
      maxAge: 1800,
    });
    const results = res.ok ? parseYoutubeResults(res.data) : [];
    if (results.length) return results;
  } catch {
    /* fall through */
  }
  if (!yt) throw new Error('YouTube search needs an internet connection.');
  await ensureYtDlp();
  return yt.search(q, 20);
}

// ------------------------------------------------------------- yt-dlp ----

let installing: Promise<void> | null = null;

export async function ytDlpStatus() {
  return yt ? yt.status() : { installed: false, version: null, path: '' };
}

/** Downloads yt-dlp on first use. */
export function ensureYtDlp(): Promise<void> {
  if (!yt) return Promise.reject(new Error('Downloading from YouTube needs the desktop app.'));
  if (!installing) {
    installing = (async () => {
      const s = await yt.status();
      if (!s.installed) {
        const r = await yt.install();
        if (!r.installed) throw new Error('yt-dlp could not be installed');
      }
    })().catch((e) => {
      installing = null;
      throw e;
    });
  }
  return installing;
}

export async function updateYtDlp() {
  if (!yt) return null;
  installing = null;
  const r = await yt.install();
  return r.version;
}

export function onDownloadProgress(cb: (p: DownloadProgress) => void) {
  return yt ? yt.onProgress(cb) : () => {};
}

export async function downloadMedia(job: string, url: string, song: string, video: boolean, maxHeight = 720) {
  if (!yt) throw new Error('Downloading needs the desktop app.');
  await ensureYtDlp();
  return yt.download({ job, url, song, video, maxHeight });
}

export function cancelDownload(job: string) {
  return yt ? yt.cancel(job) : Promise.resolve(false);
}

// ------------------------------------------------------------ titles ----

const NOISE = /\s*[([](?:official(?:\s+(?:music|lyric|audio|hd|4k))?\s*(?:video|audio|visualizer|visualiser|mv)?|lyrics?(?:\s+video)?|audio|hd|hq|4k|mv|m\/v|visuali[sz]er|video(?:\s+oficial)?|full\s+version|explicit|clean|remastered(?:\s+\d{4})?|\d{4}\s+remaster(?:ed)?)[)\]]\s*/gi;

/** Splits "Artist - Title (Official Video)" style names. */
export function splitArtistTitle(raw: string, fallbackArtist = ''): { artist: string; title: string } {
  let s = raw.replace(/\.[a-z0-9]{2,5}$/i, '').replace(/_/g, ' ').replace(NOISE, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/\s*\|\s*.*$/, '').trim();
  const m = /^(.+?)\s+[-–—~]\s+(.+)$/.exec(s);
  if (m) return { artist: m[1].trim(), title: m[2].replace(/^["“](.+)["”]$/, '$1').trim() };
  return { artist: fallbackArtist.replace(/\s*-\s*Topic$/i, '').trim(), title: s };
}

// ------------------------------------------------------------- covers ----

export interface CoverResult {
  bytes: Uint8Array;
  source: 'youtube' | 'google' | 'itunes' | 'deezer';
  url: string;
  ext: string;
}

function decodeJsString(s: string) {
  return s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\\//g, '/');
}

/** Image URLs in a Google Images results page, in result order (full-size first, thumbnails last). */
export function parseGoogleImages(html: string): string[] {
  const full: string[] = [];
  const re = /\["(https?:\/\/[^"]+?)",(\d{2,5}),(\d{2,5})\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const url = decodeJsString(m[1]);
    if (/gstatic\.com|google\.com|googleusercontent\.com\/(?!.*=w)/.test(url)) continue;
    if (!/\.(jpe?g|png|webp)(\?|$)|\/image|img|photo|cover|art/i.test(url)) continue;
    if (Math.min(+m[2], +m[3]) < 120) continue;
    if (!full.includes(url)) full.push(url);
  }
  const imgres: string[] = [];
  const re2 = /imgurl=(https?[^&"]+)/g;
  while ((m = re2.exec(html))) {
    try {
      const url = decodeURIComponent(m[1]);
      if (!imgres.includes(url)) imgres.push(url);
    } catch {
      /* bad escape */
    }
  }
  const thumbs: string[] = [];
  const re3 = /(https:\/\/encrypted-tbn\d\.gstatic\.com\/images\?q=[^"'\s&]+(?:&amp;[^"'\s]+)?)/g;
  while ((m = re3.exec(html))) {
    const url = m[1].replace(/&amp;/g, '&');
    if (!thumbs.includes(url)) thumbs.push(url);
  }
  return [...full, ...imgres.filter((u) => !full.includes(u)), ...thumbs];
}

export function parseItunes(json: unknown): string[] {
  const results = (get(json, 'results') as Json[] | undefined) || [];
  return results.map((r) => String(r.artworkUrl100 || '')).filter(Boolean).map((u) => u.replace(/\/\d+x\d+bb\./, '/600x600bb.'));
}

export function parseDeezer(json: unknown): string[] {
  const data = (get(json, 'data') as Json[] | undefined) || [];
  return data.map((d) => String(get(d, 'album', 'cover_xl') || get(d, 'album', 'cover_big') || '')).filter(Boolean);
}

function sniffImage(b: Uint8Array): string | null {
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) return 'webp';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'gif';
  return null;
}

async function fetchImage(url: string, minBytes = 1500): Promise<{ bytes: Uint8Array; ext: string } | null> {
  try {
    const res = await bridge.fetch<Uint8Array>({ url, responseType: 'arraybuffer', headers: { 'User-Agent': BROWSER_UA }, cache: 'api', maxAge: 86400 * 30 });
    if (!res.ok || res.data.byteLength < minBytes) return null;
    const ext = sniffImage(res.data);
    return ext ? { bytes: res.data, ext } : null;
  } catch {
    return null;
  }
}

async function firstImage(urls: string[], source: CoverResult['source'], limit = 4): Promise<CoverResult | null> {
  for (const url of urls.slice(0, limit)) {
    const img = await fetchImage(url, source === 'google' && url.includes('encrypted-tbn') ? 800 : 1500);
    if (img) return { ...img, source, url };
  }
  return null;
}

/** A cover from a known image URL (e.g. the thumbnail yt-dlp reported for a non-YouTube page). */
export async function coverFromUrl(url: string): Promise<CoverResult | null> {
  const img = await fetchImage(url, 2000);
  return img ? { ...img, source: 'youtube', url } : null;
}

export async function youtubeCover(id: string): Promise<CoverResult | null> {
  // maxresdefault is missing for many videos; YouTube serves a 120×90 grey placeholder (~1 KB) then.
  for (const url of youtubeThumbnails(id)) {
    const img = await fetchImage(url, 4000);
    if (img) return { ...img, source: 'youtube', url };
  }
  return null;
}

export async function googleCover(query: string): Promise<CoverResult | null> {
  try {
    const res = await bridge.fetch<string>({
      url: `https://www.google.com/search?tbm=isch&hl=en&safe=active&q=${encodeURIComponent(query)}`,
      headers: { 'User-Agent': BROWSER_UA, 'Accept-Language': 'en-US,en;q=0.8', Cookie: 'CONSENT=YES+1; SOCS=CAI' },
      cache: 'api',
      maxAge: 86400 * 7,
    });
    if (!res.ok) return null;
    return firstImage(parseGoogleImages(res.data), 'google');
  } catch {
    return null;
  }
}

export async function itunesCover(query: string): Promise<CoverResult | null> {
  try {
    const res = await bridge.fetch<unknown>({ url: `https://itunes.apple.com/search?media=music&entity=song&limit=5&term=${encodeURIComponent(query)}`, responseType: 'json', cache: 'api', maxAge: 86400 * 7 });
    return res.ok ? firstImage(parseItunes(res.data), 'itunes', 2) : null;
  } catch {
    return null;
  }
}

export async function deezerCover(query: string): Promise<CoverResult | null> {
  try {
    const res = await bridge.fetch<unknown>({ url: `https://api.deezer.com/search?limit=5&q=${encodeURIComponent(query)}`, responseType: 'json', cache: 'api', maxAge: 86400 * 7 });
    return res.ok ? firstImage(parseDeezer(res.data), 'deezer', 2) : null;
  } catch {
    return null;
  }
}

/**
 * Cover art for a song: its YouTube thumbnail if it came from YouTube,
 * otherwise the first Google Images result for "artist title", then iTunes
 * and Deezer album art.
 */
export async function findCover(opts: { youtubeId?: string; artist?: string; title: string; order?: CoverResult['source'][] }): Promise<CoverResult | null> {
  const query = [opts.artist, opts.title].filter(Boolean).join(' ').trim();
  const order = opts.order || ['youtube', 'google', 'itunes', 'deezer'];
  for (const src of order) {
    let r: CoverResult | null = null;
    if (src === 'youtube' && opts.youtubeId) r = await youtubeCover(opts.youtubeId);
    else if (src === 'google' && query) r = await googleCover(`${query} album cover`);
    else if (src === 'itunes' && query) r = await itunesCover(query);
    else if (src === 'deezer' && query) r = await deezerCover(query);
    if (r) return r;
  }
  return null;
}

export const webAvailable = isDesktop || typeof fetch !== 'undefined';
