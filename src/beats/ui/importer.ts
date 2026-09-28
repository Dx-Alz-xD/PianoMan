// Bringing songs into the 4K library: YouTube (search or any link yt-dlp
// understands), audio/video files, osu! beatmaps, and piano scores (the
// same catalogue and online search as the piano, plus the piano's library).

import { bridge } from '../../platform/bridge';
import { getProvider, PROVIDERS, type SearchResult } from '../../search/providers';
import { clear, formatBytes, h, icon } from '../../ui/dom';
import { PRESET_NAMES } from '../mapgen';
import { AUDIO_EXTS, extOf, SCORE_EXTS, VIDEO_EXTS, type PickedFile } from '../store';
import type { Preset, SongMeta } from '../types';
import { canDownload, cancelDownload, isUrl, onDownloadProgress, searchYoutube, youtubeId, ytDlpStatus, type DownloadProgress, type VideoResult } from '../web';
import type { BeatsApp } from './app';
import { btn, formatTime, modal, progressBar, row, segmented, select, sounding, toast, toggle, type ModalHandle } from './widgets';

type Tab = 'youtube' | 'file' | 'osu' | 'score';

export class ImportDialog {
  private tab: Tab;
  private body!: HTMLElement;
  private handle!: ModalHandle;
  private created: SongMeta[] = [];
  private busy = false;
  private bar = progressBar();
  private cancelBtn!: HTMLButtonElement;
  private job = '';
  private resolve: (songs: SongMeta[]) => void = () => {};
  private tabs!: ReturnType<typeof segmented<Tab>>;

  constructor(private app: BeatsApp, tab: Tab = 'youtube') {
    this.tab = tab;
  }

  open(files?: PickedFile[]): Promise<SongMeta[]> {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.tabs = segmented<Tab>(
        this.tab,
        [
          { value: 'youtube', label: 'YouTube & links', icon: 'youtube' },
          { value: 'file', label: 'Audio / video file', icon: 'fileAudio' },
          { value: 'osu', label: 'osu! beatmap', icon: 'osu' },
          { value: 'score', label: 'Piano score', icon: 'piano' },
        ],
        (t) => this.show(t),
        'pb-import-tabs',
      );
      this.body = h('div', { class: 'pb-import-body' });
      this.cancelBtn = btn('Cancel download', () => void cancelDownload(this.job), { cls: 'ghost small', icon: 'x' }) as HTMLButtonElement;
      this.cancelBtn.hidden = true;
      this.bar.hidden = true;
      const status = h('div', { class: 'pb-import-status' }, this.bar, this.cancelBtn);
      this.handle = modal('Add songs', [this.tabs, this.body, status], {
        wide: true,
        cls: 'pb-import',
        onClose: () => {
          unsub();
          this.resolve(this.created);
        },
      });
      const unsub = onDownloadProgress((p) => this.onProgress(p));
      this.handle.el.addEventListener('dragover', (e) => e.preventDefault());
      this.handle.el.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer?.files.length) void this.importFiles(this.app.store.fromDrop(e.dataTransfer.files));
      });
      this.show(this.tab);
      if (files?.length) void this.importFiles(files);
    });
  }

  private show(t: Tab) {
    this.tab = t;
    this.tabs.set(t);
    clear(this.body);
    if (t === 'youtube') this.youtubeTab();
    else if (t === 'file') this.fileTab();
    else if (t === 'osu') this.osuTab();
    else this.scoreTab();
  }

  // ---------------------------------------------------------- common ----

  private mapChoices(): HTMLElement {
    const s = this.app.settings;
    const presets: Preset[] = ['easy', 'normal', 'hard', 'insane', 'expert'];
    const wrap = h('div', { class: 'pb-preset-picks' });
    for (const p of presets) {
      wrap.append(
        toggle(s.autoMaps.includes(p), (v) => {
          s.autoMaps = v ? [...new Set([...s.autoMaps, p])] : s.autoMaps.filter((x) => x !== p);
          this.app.save();
        }, PRESET_NAMES[p]),
      );
    }
    return row('Make maps', wrap, 'Generated automatically – edit them later');
  }

  private presets(): Preset[] {
    const order: Preset[] = ['easy', 'normal', 'hard', 'insane', 'expert'];
    return order.filter((p) => this.app.settings.autoMaps.includes(p));
  }

  private async run(label: string, fn: (progress: (label: string, f: number | null) => void) => Promise<SongMeta[]>) {
    if (this.busy) {
      toast('Wait for the current import to finish.');
      return;
    }
    this.busy = true;
    this.bar.hidden = false;
    this.bar.set(label, null);
    this.handle.el.classList.add('busy');
    try {
      const songs = await fn((l, f) => this.bar.set(l, f));
      for (const song of songs) {
        let s = song;
        if (!s.maps.length && this.presets().length) s = await this.app.library.generateDefaultMaps(s, this.presets(), (l, f) => this.bar.set(l, f));
        this.created.push(s);
      }
      this.bar.set(`Added ${songs.map((s) => `"${s.title}"`).join(', ')}`, 1);
      this.app.audio.sfx('clear');
      toast(songs.length === 1 ? `"${songs[0].title}" is ready to play.` : `${songs.length} songs added.`, 'ok');
      setTimeout(() => this.handle.close(), 700);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.bar.set(msg === 'Cancelled' ? 'Cancelled.' : `Failed: ${msg}`, 0);
      this.app.audio.sfx('error');
      if (msg !== 'Cancelled') toast(msg, 'error', 7000);
    } finally {
      this.busy = false;
      this.cancelBtn.hidden = true;
      this.handle.el.classList.remove('busy');
    }
  }

  /** Routes files by type (audio/video, osu!, score). */
  async importFiles(files: PickedFile[]) {
    for (const f of files) {
      const ext = extOf(f.name);
      if (ext === 'osz' || ext === 'osu') {
        this.show('osu');
        await this.run(`Importing ${f.name}…`, async (p) => this.app.library.importBeatmap(f.name, await this.app.store.readPicked(f), p));
      } else if (AUDIO_EXTS.includes(ext) || VIDEO_EXTS.includes(ext)) {
        this.show('file');
        await this.run(`Importing ${f.name}…`, async (p) => [await this.app.library.createFromFile(f, p)]);
      } else if (SCORE_EXTS.includes(ext)) {
        this.show('score');
        await this.run(`Importing ${f.name}…`, async (p) => [await this.withCover(await this.app.library.createFromScore(await this.app.store.readPicked(f), f.name), p)]);
      } else toast(`${f.name}: unsupported file type`, 'error');
    }
  }

  private dropZone(kind: 'audio' | 'osu' | 'score', title: string, hint: string, ic: string) {
    return sounding(
      h(
        'button',
        {
          class: 'pb-drop',
          onclick: async () => {
            const files = await this.app.store.pickFiles(kind, true, title);
            if (files.length) await this.importFiles(files);
          },
        },
        h('span', { class: 'pb-drop-ic' }, icon(ic, 34)),
        h('b', null, title),
        h('span', null, hint),
      ),
    );
  }

  // --------------------------------------------------------- youtube ----

  private youtubeTab() {
    const s = this.app.settings;
    const results = h('div', { class: 'pb-yt-results' });
    const input = h('input', {
      class: 'pb-input big',
      type: 'search',
      placeholder: 'Search YouTube, or paste a YouTube / SoundCloud / Bandcamp / direct link…',
      onkeydown: (e: KeyboardEvent) => e.key === 'Enter' && void go(),
    }) as HTMLInputElement;
    const status = h('div', { class: 'pb-muted small' });
    const go = async () => {
      const q = input.value.trim();
      if (!q) return;
      clear(results);
      if (isUrl(q) || youtubeId(q)) {
        const id = youtubeId(q);
        results.append(
          this.resultCard(
            { id: id || q, title: id ? 'YouTube video' : q, channel: id ? q : 'Link', duration: 0, views: 0, thumbnail: id ? `https://i.ytimg.com/vi/${id}/hqdefault.jpg` : '', url: q },
            true,
          ),
        );
        return;
      }
      results.append(h('div', { class: 'pb-muted pb-spin-row' }, h('span', { class: 'pb-spinner' }), 'Searching YouTube…'));
      try {
        const list = await searchYoutube(q);
        clear(results);
        if (!list.length) results.append(h('div', { class: 'pb-muted' }, 'No results.'));
        for (const r of list.slice(0, 24)) results.append(this.resultCard(r, false));
      } catch (err) {
        clear(results);
        results.append(h('div', { class: 'pb-error' }, `Search failed: ${err instanceof Error ? err.message : err}`));
      }
    };
    const quality = select(String(s.videoHeight), ['360', '480', '720', '1080'].map((v) => ({ value: v, label: `${v}p` })), (v) => {
      s.videoHeight = parseInt(v, 10);
      this.app.save();
    });
    this.body.append(
      h('div', { class: 'pb-yt-search' }, input, btn('Search', () => void go(), { cls: 'primary', icon: 'search' })),
      h(
        'div',
        { class: 'pb-import-opts' },
        row('Background video', h('div', { class: 'pb-inline' }, toggle(s.importVideo, (v) => ((s.importVideo = v), this.app.save())), quality), 'Plays behind the notes (optional in settings)'),
        this.mapChoices(),
      ),
      status,
      results,
    );
    if (!canDownload) status.textContent = 'Downloading from YouTube needs the desktop app. You can still search here.';
    else
      void ytDlpStatus().then((st) => {
        status.textContent = st.installed ? `Downloads use yt-dlp ${st.version}.` : 'Downloads use yt-dlp, which is fetched automatically (about 40 MB) the first time.';
      });
    setTimeout(() => input.focus(), 50);
  }

  private resultCard(r: VideoResult, isLink: boolean) {
    const add = btn(isLink ? 'Import' : 'Add', () => void this.download(r.url, r.title), { cls: 'primary small', icon: 'download' });
    return h(
      'div',
      { class: 'pb-yt-card' },
      h('div', { class: 'pb-yt-thumb' }, r.thumbnail ? h('img', { src: r.thumbnail, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : icon('link', 28), r.duration ? h('span', { class: 'pb-yt-dur' }, formatTime(r.duration)) : null),
      h('div', { class: 'pb-yt-text' }, h('b', { title: r.title }, r.title), h('span', null, r.channel), r.views ? h('small', null, `${r.views.toLocaleString()} views`) : null),
      add,
    );
  }

  private async download(url: string, title: string) {
    if (!canDownload) {
      toast('Downloading needs the desktop app.', 'error');
      return;
    }
    this.job = `dl-${Date.now()}`;
    this.cancelBtn.hidden = false;
    await this.run(`Getting "${title}"…`, async (p) => [
      await this.app.library.createFromUrl(url, { video: this.app.settings.importVideo, maxHeight: this.app.settings.videoHeight, job: this.job }, p),
    ]);
  }

  private onProgress(p: DownloadProgress) {
    if (p.job !== this.job && p.job !== 'install') return;
    const pct = p.percent === null ? null : p.percent / 100;
    const speed = p.speed ? ` · ${formatBytes(p.speed)}/s` : '';
    const eta = p.eta ? ` · ${Math.round(p.eta)} s left` : '';
    const label = p.stage === 'install' ? 'Installing yt-dlp…' : p.stage === 'info' ? 'Reading the page…' : p.stage === 'audio' ? `Downloading audio${speed}${eta}` : `Downloading video${speed}${eta}`;
    this.bar.set(p.warning || label, pct);
  }

  // ------------------------------------------------------------ file ----

  private fileTab() {
    this.body.append(
      this.dropZone('audio', 'Choose audio or video files', 'MP3, OGG, Opus, WAV, FLAC, M4A · MP4 / WebM videos play in the background · or drop them here', 'fileAudio'),
      h('div', { class: 'pb-import-opts' }, this.mapChoices()),
      h('p', { class: 'pb-muted small' }, 'Title, artist and cover art are read from the file’s tags; missing cover art is looked up online (Google Images, then iTunes and Deezer).'),
    );
  }

  // ------------------------------------------------------------- osu ----

  private osuTab() {
    this.body.append(
      this.dropZone('osu', 'Choose .osz or .osu files', 'Every difficulty is imported. 4K osu!mania maps play as they are; other key counts and osu!standard, taiko and catch maps are converted to 4 lanes.', 'osu'),
      h(
        'ul',
        { class: 'pb-bullets' },
        h('li', null, 'Keysounds and custom hitsounds in the beatmap are played when you hit the notes.'),
        h('li', null, 'The background image becomes the record’s cover; a background video plays behind the notes.'),
        h('li', null, 'Download beatmaps from osu.ppy.sh, then drop the .osz here (or open it with PIANO-BEATS).'),
      ),
    );
  }

  // ----------------------------------------------------------- score ----

  private scoreTab() {
    let provider = PROVIDERS[0].id;
    const results = h('div', { class: 'pb-score-results' });
    const input = h('input', { class: 'pb-input big', type: 'search', placeholder: 'Search piano scores: Chopin, Clair de Lune, Für Elise…', onkeydown: (e: KeyboardEvent) => e.key === 'Enter' && void go() }) as HTMLInputElement;
    const provSel = select(provider, PROVIDERS.map((p) => ({ value: p.id, label: p.name })), (v) => {
      provider = v;
      void go();
    });
    const go = async () => {
      clear(results);
      results.append(h('div', { class: 'pb-muted pb-spin-row' }, h('span', { class: 'pb-spinner' }), 'Searching…'));
      try {
        const page = await getProvider(provider).search(input.value.trim(), 0);
        clear(results);
        if (!page.results.length) results.append(h('div', { class: 'pb-muted' }, 'No scores found.'));
        for (const r of page.results.slice(0, 40)) results.append(this.scoreRow(r));
      } catch (err) {
        clear(results);
        results.append(h('div', { class: 'pb-error' }, `Search failed: ${err instanceof Error ? err.message : err}`));
      }
    };
    const pianoLib = h('div', { class: 'pb-score-results small' });
    void bridge.library.list().then((items) => {
      if (!items.length) return;
      pianoLib.append(h('h4', null, 'From your piano library'));
      for (const it of items.slice(0, 30)) {
        pianoLib.append(
          h(
            'div',
            { class: 'pb-score-row' },
            h('div', null, h('b', null, it.title), h('span', null, it.composer || it.format)),
            btn('Add', () => void this.run(`Adding "${it.title}"…`, async (p) => [await this.withCover(await this.app.library.createFromScore(await bridge.library.load(it.id), it.fileName, { title: it.title, composer: it.composer, source: it.source }), p)]), { cls: 'small', icon: 'plus' }),
          ),
        );
      }
    });
    this.body.append(
      h('p', { class: 'pb-muted small' }, 'Score songs are played on the piano: every note you hit plays the melody it stands for, and the accompaniment plays along.'),
      h('div', { class: 'pb-yt-search' }, input, provSel, btn('Search', () => void go(), { cls: 'primary', icon: 'search' })),
      h('div', { class: 'pb-import-opts' }, this.mapChoices()),
      results,
      this.dropZone('score', 'Or open a score file', 'MusicXML, MXL, MIDI, ABC', 'file'),
      pianoLib,
    );
    void go();
  }

  /** Cover art for a score song: the first Google Images result for "title composer", then iTunes/Deezer. */
  private async withCover(song: SongMeta, p: (label: string, f: number | null) => void) {
    try {
      return await this.app.library.fetchCover(song, p, null, ['google', 'itunes', 'deezer']);
    } catch {
      return song;
    }
  }

  private scoreRow(r: SearchResult) {
    return h(
      'div',
      { class: 'pb-score-row' },
      h('div', null, h('b', null, r.title), h('span', null, [r.composer, r.detail, r.format.toUpperCase()].filter(Boolean).join(' · '))),
      btn('Add', () => void this.run(`Downloading "${r.title}"…`, async (p) => {
        const d = await r.download();
        return [await this.withCover(await this.app.library.createFromScore(d.data, d.fileName, { title: r.title, composer: r.composer, source: r.provider }), p)];
      }), { cls: 'small', icon: 'plus' }),
    );
  }
}
