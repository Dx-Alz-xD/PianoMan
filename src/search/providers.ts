// Score search. Catalog providers search a bundled index (instant, offline);
// online providers query public websites through the desktop shell (no CORS).

import { bridge, fetchFirst } from '../platform/bridge';
import indexData from './data/score-index.json';

export type ResultFormat = 'musicxml' | 'mxl' | 'midi' | 'abc';

export interface SearchResult {
  id: string;
  title: string;
  composer?: string;
  detail?: string;
  format: ResultFormat;
  provider: string;
  /** Page on the source website, for attribution. */
  pageUrl?: string;
  /** Downloads the score. */
  download(): Promise<{ data: Uint8Array; fileName: string; url?: string }>;
}

export interface SearchPage {
  results: SearchResult[];
  hasMore: boolean;
  total?: number;
}

export interface Provider {
  id: string;
  name: string;
  description: string;
  formats: string;
  online: boolean;
  homepage: string;
  license: string;
  search(query: string, page: number): Promise<SearchPage>;
}

const PAGE = 30;

async function download(urls: string[], fileName: string) {
  const res = await fetchFirst<Uint8Array>(urls, { responseType: 'arraybuffer', cache: 'scores' });
  return { data: res.data, fileName, url: urls[res.mirror] };
}

const encodePath = (p: string) => p.split('/').map(encodeURIComponent).join('/');

function tokens(q: string) {
  return q
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function haystack(...parts: (string | undefined)[]) {
  return parts
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

// ---------------------------------------------------------------- catalogs ----

interface IndexItem {
  t: string;
  c: string;
  p: string;
  m?: string | null;
}

const INDEX = indexData as unknown as Record<string, { repo: string; branch: string; items: IndexItem[] }>;

function catalogProvider(key: string, meta: Omit<Provider, 'search' | 'online'>): Provider {
  const col = INDEX[key];
  const items = col.items.map((it) => ({ it, text: haystack(it.t, it.c, it.p.replace(/[_/.-]/g, ' ')) }));
  return {
    ...meta,
    online: false,
    async search(query, page) {
      const q = tokens(query);
      const hits = q.length ? items.filter(({ text }) => q.every((t) => text.includes(t))) : items;
      const slice = hits.slice(page * PAGE, (page + 1) * PAGE);
      return {
        total: hits.length,
        hasMore: (page + 1) * PAGE < hits.length,
        results: slice.map(({ it }) => {
          const format: ResultFormat = it.p.endsWith('.mxl') ? 'mxl' : 'musicxml';
          const fileName = `${it.c} - ${it.t}.${format === 'mxl' ? 'mxl' : 'musicxml'}`.replace(/[\\/:*?"<>|]/g, '');
          const urls = [
            `https://raw.githubusercontent.com/${col.repo}/${col.branch}/${encodePath(it.p)}`,
            `https://cdn.jsdelivr.net/gh/${col.repo}@${col.branch}/${encodePath(it.p)}`,
          ];
          return {
            id: `${key}:${it.p}`,
            title: it.t,
            composer: it.c,
            format,
            provider: meta.name,
            pageUrl: `https://github.com/${col.repo}/blob/${col.branch}/${encodePath(it.p)}`,
            download: () => download(urls, fileName),
          };
        }),
      };
    },
  };
}

// -------------------------------------------------------------- BitMidi ----

interface BitMidiItem {
  id?: number;
  name?: string;
  slug?: string;
  downloadUrl?: string;
  url?: string;
  plays?: number;
  views?: number;
}

function findItems(obj: unknown): BitMidiItem[] {
  if (Array.isArray(obj)) {
    if (obj.length && typeof obj[0] === 'object' && obj[0] && ('downloadUrl' in obj[0] || 'slug' in obj[0])) return obj as BitMidiItem[];
    for (const v of obj) {
      const r = findItems(v);
      if (r.length) return r;
    }
  } else if (obj && typeof obj === 'object') {
    for (const v of Object.values(obj)) {
      const r = findItems(v);
      if (r.length) return r;
    }
  }
  return [];
}

const bitmidi: Provider = {
  id: 'bitmidi',
  name: 'BitMidi',
  description: 'Over 100,000 MIDI files – pop, games, film and classical.',
  formats: 'MIDI',
  online: true,
  homepage: 'https://bitmidi.com',
  license: 'User uploads – check the original for rights',
  async search(query, page) {
    const url = `https://bitmidi.com/api/midi/search?q=${encodeURIComponent(query)}&page=${page}&pageSize=${PAGE}`;
    const res = await bridge.fetch<unknown>({ url, responseType: 'json', cache: 'api', maxAge: 3600, headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`BitMidi answered ${res.status}`);
    const data = res.data as { result?: { total?: number; pageTotal?: number } };
    const items = findItems(res.data);
    const pageTotal = data.result?.pageTotal;
    return {
      total: data.result?.total,
      hasMore: pageTotal !== undefined ? page + 1 < pageTotal : items.length >= PAGE,
      results: items
        .filter((it) => it.downloadUrl || it.slug)
        .map((it) => {
          const name = (it.name || it.slug || 'MIDI file').replace(/\.midi?$/i, '').replace(/[-_]+/g, ' ');
          const dl = it.downloadUrl ? new URL(it.downloadUrl, 'https://bitmidi.com').toString() : `https://bitmidi.com/uploads/${it.id}.mid`;
          return {
            id: `bitmidi:${it.id ?? it.slug}`,
            title: name,
            detail: it.plays ? `${it.plays.toLocaleString()} plays` : undefined,
            format: 'midi' as const,
            provider: 'BitMidi',
            pageUrl: it.url ? new URL(it.url, 'https://bitmidi.com').toString() : undefined,
            download: () => download([dl], `${name}.mid`),
          };
        }),
    };
  },
};

// ----------------------------------------------------- Mutopia Project ----

/** Parses a Mutopia make-table.cgi results page (one table.result-table per piece). */
export function parseMutopiaResults(html: string, pageUrl: string): { results: SearchResult[]; nextStart: number | null } {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const results: SearchResult[] = [];
  const text = (el: Element | null | undefined) => (el?.textContent || '').replace(/\s+/g, ' ').trim();
  for (const table of Array.from(doc.querySelectorAll('table.result-table'))) {
    const links = Array.from(table.querySelectorAll('a[href]'));
    const midi = links.find((a) => /\.mid\b/i.test(text(a)) || /\.(mid|midi)$/i.test(a.getAttribute('href') || ''));
    if (!midi) continue;
    const href = new URL(midi.getAttribute('href')!, pageUrl).toString();
    const rows = Array.from(table.querySelectorAll('tr')).filter((r) => !r.classList.contains('preview'));
    const first = rows[0] ? Array.from(rows[0].querySelectorAll('td')).map(text) : [];
    const second = rows[1] ? Array.from(rows[1].querySelectorAll('td')).map(text) : [];
    const title = first[0] || href.split('/').pop()!;
    const composer = (first[1] || '').replace(/^by\s+/i, '');
    const detail = [second[0], second[2], first[2]].filter((c) => c && c !== '\u00a0' && c.length < 60).join(' · ');
    const info = links.find((a) => /piece-info\.cgi/.test(a.getAttribute('href') || ''));
    const zipped = /\.zip$/i.test(href);
    results.push({
      id: `mutopia:${href}`,
      title,
      composer,
      detail: zipped ? `${detail}${detail ? ' · ' : ''}several movements` : detail,
      format: 'midi',
      provider: 'Mutopia Project',
      pageUrl: info ? new URL(info.getAttribute('href')!, pageUrl).toString() : 'https://www.mutopiaproject.org',
      download: () => download([href], `${title}.${zipped ? 'zip' : 'mid'}`),
    });
  }
  const next = Array.from(doc.querySelectorAll('a[href]')).find((a) => /^next/i.test(text(a)) && /startat=\d+/.test(a.getAttribute('href') || ''));
  const m = next ? /startat=(\d+)/.exec(next.getAttribute('href')!) : null;
  return { results, nextStart: m ? parseInt(m[1], 10) : null };
}

const mutopiaStarts = new Map<string, number[]>();

const mutopia: Provider = {
  id: 'mutopia',
  name: 'Mutopia Project',
  description: '2,000+ free classical scores typeset by volunteers (public domain / Creative Commons).',
  formats: 'MIDI',
  online: true,
  homepage: 'https://www.mutopiaproject.org',
  license: 'Public domain / CC',
  async search(query, page) {
    const starts = mutopiaStarts.get(query) || [0];
    const startAt = starts[page] ?? page * 10;
    const url = `https://www.mutopiaproject.org/cgibin/make-table.cgi?searchingfor=${encodeURIComponent(query)}${startAt ? `&startat=${startAt}` : ''}`;
    const res = await bridge.fetch<string>({ url, responseType: 'text', cache: 'api', maxAge: 6 * 3600 });
    if (!res.ok) throw new Error(`Mutopia answered ${res.status}`);
    const { results, nextStart } = parseMutopiaResults(res.data, url);
    if (nextStart !== null) {
      starts[page + 1] = nextStart;
      mutopiaStarts.set(query, starts);
    }
    return { results, hasMore: nextStart !== null };
  },
};

// ----------------------------------------------------------- The Session ----

const METER: Record<string, string> = {
  reel: '4/4', jig: '6/8', 'slip jig': '9/8', hornpipe: '4/4', polka: '2/4', waltz: '3/4', slide: '12/8', mazurka: '3/4',
  strathspey: '4/4', barndance: '4/4', 'three-two': '3/2', march: '2/4',
};

export function sessionKey(key: string): string {
  const m = /^([A-G][b#]?)(major|minor|dorian|mixolydian|lydian|phrygian|locrian|aeolian|ionian)$/i.exec(key.trim());
  if (!m) return key;
  const mode = m[2].toLowerCase();
  const suffix: Record<string, string> = { major: '', ionian: '', minor: 'm', aeolian: 'm', dorian: 'dor', mixolydian: 'mix', lydian: 'lyd', phrygian: 'phr', locrian: 'loc' };
  return m[1] + suffix[mode];
}

/** Builds a complete ABC tune from The Session's API data (the API only returns the body). */
export function buildSessionAbc(name: string, type: string, key: string, body: string): string {
  const t = type.toLowerCase();
  return ['X:1', `T:${name}`, `R:${t}`, `M:${METER[t] || '4/4'}`, 'L:1/8', `K:${sessionKey(key)}`, body.replace(/\r\n?/g, '\n').replace(/\\"/g, '"')].join('\n');
}

const thesession: Provider = {
  id: 'thesession',
  name: 'The Session',
  description: 'Thousands of Irish & folk tunes in ABC notation – great for clicker mode.',
  formats: 'ABC',
  online: true,
  homepage: 'https://thesession.org',
  license: 'Community transcriptions',
  async search(query, page) {
    const url = `https://thesession.org/tunes/search?q=${encodeURIComponent(query)}&format=json&perpage=${PAGE}&page=${page + 1}`;
    const res = await bridge.fetch<{ tunes?: { id: number; name: string; type?: string; url?: string }[]; pages?: number; total?: number }>({
      url, responseType: 'json', cache: 'api', maxAge: 3600,
    });
    if (!res.ok) throw new Error(`The Session answered ${res.status}`);
    const tunes = res.data.tunes || [];
    return {
      total: res.data.total,
      hasMore: res.data.pages !== undefined ? page + 1 < res.data.pages : tunes.length >= PAGE,
      results: tunes.map((t) => ({
        id: `thesession:${t.id}`,
        title: t.name,
        composer: 'Traditional',
        detail: t.type,
        format: 'abc' as const,
        provider: 'The Session',
        pageUrl: t.url || `https://thesession.org/tunes/${t.id}`,
        download: async () => {
          const r = await bridge.fetch<{ name: string; type?: string; settings?: { key: string; abc: string }[] }>({
            url: `https://thesession.org/tunes/${t.id}?format=json`, responseType: 'json', cache: 'scores',
          });
          if (!r.ok || !r.data.settings?.length) throw new Error('Tune not available');
          const setting = r.data.settings[0];
          const abc = buildSessionAbc(r.data.name, r.data.type || t.type || '', setting.key, setting.abc);
          return { data: new TextEncoder().encode(abc), fileName: `${r.data.name}.abc`, url: `https://thesession.org/tunes/${t.id}` };
        },
      })),
    };
  },
};

// ---------------------------------------------------------------- demos ----

const demos: Provider = {
  id: 'demos',
  name: 'PIANO-BEATS demos',
  description: 'Short public-domain pieces bundled with the app.',
  formats: 'MusicXML',
  online: false,
  homepage: '',
  license: 'Public domain',
  async search(query) {
    const list = (await fetch('demos/index.json').then((r) => r.json())) as { file: string; title: string; composer: string; level: string; description: string }[];
    const q = tokens(query);
    return {
      hasMore: false,
      results: list
        .filter((d) => !q.length || q.every((t) => haystack(d.title, d.composer, d.level).includes(t)))
        .map((d) => ({
          id: `demo:${d.file}`,
          title: d.title,
          composer: d.composer,
          detail: `${d.level} · ${d.description}`,
          format: 'musicxml' as const,
          provider: 'Demo',
          download: async () => ({ data: new Uint8Array(await (await fetch(`demos/${d.file}`)).arrayBuffer()), fileName: d.file }),
        })),
    };
  },
};

export const PROVIDERS: Provider[] = [
  catalogProvider('asap', {
    id: 'asap',
    name: 'Classical piano (ASAP)',
    description: '235 engraved piano works: Bach, Beethoven, Chopin, Liszt, Mozart, Schubert, Rachmaninoff, Ravel…',
    formats: 'MusicXML',
    homepage: 'https://github.com/fosfrancesco/asap-dataset',
    license: 'CC BY-NC-SA 4.0',
  }),
  bitmidi,
  mutopia,
  thesession,
  catalogProvider('music21', {
    id: 'music21',
    name: 'music21 corpus',
    description: '650 scores: Bach chorales, Joplin, Beethoven & Mozart quartets, Schumann, Monteverdi…',
    formats: 'MusicXML',
    homepage: 'https://github.com/cuthbertLab/music21',
    license: 'Public domain / BSD',
  }),
  demos,
];

export function getProvider(id: string) {
  return PROVIDERS.find((p) => p.id === id) || PROVIDERS[0];
}
