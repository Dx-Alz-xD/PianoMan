// Song select: the record player with the selected song's cover (its
// preview plays and can be scratched), the song list with difficulties,
// scores, mods, and the way into playing, editing and exporting.

import { bridge, isDesktop } from '../../platform/bridge';
import { clear, h, icon } from '../../ui/dom';
import { bestRecord, loadRecords, modsLabel, playCount } from '../settings';
import type { MapSummary, SongMeta } from '../types';
import type { BeatsApp, Screen } from './app';
import { Turntable } from './turntable';
import { btn, confirmDialog, formatTime, levelColor, modal, progressBar, row, segmented, slider, sounding, stars, toast, toggle } from './widgets';

const SOURCE_LABEL: Record<SongMeta['source'], [string, string]> = {
  youtube: ['YouTube', 'youtube'],
  url: ['Web', 'link'],
  file: ['Audio file', 'fileAudio'],
  osu: ['osu!', 'osu'],
  score: ['Piano score', 'piano'],
};

export class SelectScreen implements Screen {
  readonly el: HTMLElement;
  private list: HTMLElement;
  private search: HTMLInputElement;
  private info: HTMLElement;
  private board: HTMLElement;
  private turntable: Turntable;
  private modsBtn: HTMLButtonElement;
  private empty: HTMLElement;
  private songs: SongMeta[] = [];
  private song: SongMeta | null = null;
  private mapId = '';
  private previewTimer = 0;
  private previewKey = '';
  private cards = new Map<string, HTMLElement>();
  private unsub: (() => void) | null = null;

  constructor(private app: BeatsApp) {
    const s = app.settings;
    this.turntable = new Turntable(app.audio.deck);
    this.turntable.onColor = (rgb) => app.backdrop.setTint(rgb);
    this.turntable.onPower = (on) => this.setMotor(on);
    this.turntable.onScratch = () => {
      if (!this.previewKey && this.song) void this.loadPreview(this.song, true);
    };
    this.search = h('input', { class: 'pb-search-input', type: 'search', placeholder: 'Search songs, artists, mappers…', oninput: () => this.render() }) as HTMLInputElement;
    this.list = h('div', { class: 'pb-song-list' });
    this.info = h('div', { class: 'pb-song-info' });
    this.board = h('div', { class: 'pb-board' });
    this.empty = h(
      'div',
      { class: 'pb-empty glass', hidden: true },
      h('h2', null, 'Your library is empty'),
      h('p', { class: 'pb-muted' }, 'Bring in a song and PIANO-BEATS makes the maps for you.'),
      h(
        'div',
        { class: 'pb-empty-actions' },
        btn('From YouTube', () => void app.openImport({ tab: 'youtube' }), { icon: 'youtube', cls: 'primary' }),
        btn('Audio file', () => void app.openImport({ tab: 'file' }), { icon: 'fileAudio' }),
        btn('osu! beatmap', () => void app.openImport({ tab: 'osu' }), { icon: 'osu' }),
        btn('Piano score', () => void app.openImport({ tab: 'score' }), { icon: 'piano' }),
      ),
    );
    const sort = segmented(
      s.sort,
      [
        { value: 'added', label: 'New', title: 'Recently added' },
        { value: 'title', label: 'A–Z', title: 'By title' },
        { value: 'artist', label: 'Artist', title: 'By artist' },
        { value: 'level', label: '★', title: 'By difficulty' },
        { value: 'length', label: 'Length', title: 'By length' },
        { value: 'played', label: 'Played', title: 'Most played' },
      ],
      (v) => {
        s.sort = v;
        app.save();
        this.render();
      },
      'small',
    );
    const filter = segmented(
      s.filter,
      [
        { value: 'all', label: 'All' },
        { value: 'youtube', label: 'YouTube', icon: 'youtube' },
        { value: 'file', label: 'Files', icon: 'fileAudio' },
        { value: 'osu', label: 'osu!', icon: 'osu' },
        { value: 'score', label: 'Piano', icon: 'piano' },
      ],
      (v) => {
        s.filter = v;
        app.save();
        this.render();
      },
      'small',
    );
    this.modsBtn = btn('Mods', () => this.openMods(), { icon: 'sparkle', title: 'Mods (F1)' }) as HTMLButtonElement;
    const bar = h(
      'div',
      { class: 'pb-select-bar glass' },
      btn('Back', () => this.back(), { icon: 'back', cls: 'ghost', title: 'Back (Esc)' }),
      this.modsBtn,
      btn('Random', () => this.random(), { icon: 'shuffle', title: 'Random song (F2)' }),
      btn('Options', () => app.openSettings(), { icon: 'gear', title: 'Settings (F3)' }),
      h('div', { class: 'pb-spacer' }),
      btn('Import', () => void app.openImport(), { icon: 'plus', title: 'Import a song' }),
      btn('Edit', () => this.edit(), { icon: 'edit', title: 'Map editor (Ctrl+E)' }),
      btn('Export', () => void this.export(), { icon: 'upload', title: 'Export to osu! (.osz)' }),
      btn('', () => void this.remove(), { icon: 'trash', cls: 'ghost danger-hover', title: 'Delete song (Del)' }),
      btn('Play', () => void this.play(), { icon: 'play', cls: 'primary big', title: 'Play (Enter)' }),
    );
    this.el = h(
      'div',
      { class: 'pb-screen pb-songselect' },
      h(
        'div',
        { class: 'pb-select-head' },
        h('h1', null, 'Song select'),
        h('div', { class: 'pb-search glass' }, icon('search', 18), this.search),
        sort,
        filter,
      ),
      h('div', { class: 'pb-select-body' }, h('div', { class: 'pb-select-left' }, this.turntable.el, this.info, this.board), h('div', { class: 'pb-select-right' }, this.list, this.empty)),
      bar,
    );
  }

  async enter(arg?: unknown) {
    const want = (arg as { songId?: string } | undefined)?.songId;
    this.app.backdrop.intensity = 0.6;
    this.turntable.setVisible(true);
    this.unsub = this.app.store.onChange(() => this.render());
    this.render();
    const target = (want && this.app.store.song(want)) || this.app.store.song(this.app.settings.lastSong) || this.songs[0];
    if (target) this.select(target, this.app.settings.lastMap, true);
    this.updateMods();
  }

  leave() {
    clearTimeout(this.previewTimer);
    this.turntable.setVisible(false);
    this.unsub?.();
    this.unsub = null;
  }

  settingsChanged() {
    this.updateMods();
  }

  // ------------------------------------------------------------ list ----

  private filtered(): SongMeta[] {
    const s = this.app.settings;
    const words = this.search.value.toLowerCase().split(/\s+/).filter(Boolean);
    let songs = this.app.store.songs.filter((x) => s.filter === 'all' || x.source === s.filter || (s.filter === 'youtube' && x.source === 'url'));
    if (words.length) {
      songs = songs.filter((x) => {
        const hay = `${x.title} ${x.artist} ${x.tags || ''} ${x.maps.map((m) => `${m.name} ${m.creator}`).join(' ')}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      });
    }
    const maxLevel = (x: SongMeta) => Math.max(0, ...x.maps.map((m) => m.level));
    const plays = (x: SongMeta) => x.maps.reduce((n, m) => n + playCount(m.id), 0);
    const by: Record<string, (a: SongMeta, b: SongMeta) => number> = {
      added: (a, b) => b.createdAt.localeCompare(a.createdAt),
      title: (a, b) => a.title.localeCompare(b.title),
      artist: (a, b) => a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title),
      level: (a, b) => maxLevel(a) - maxLevel(b),
      length: (a, b) => a.duration - b.duration,
      played: (a, b) => plays(b) - plays(a),
    };
    return songs.sort(by[s.sort] || by.added);
  }

  private render() {
    this.songs = this.filtered();
    clear(this.list);
    this.cards.clear();
    this.empty.hidden = this.app.store.songs.length > 0;
    this.list.hidden = !this.app.store.songs.length;
    if (!this.songs.length && this.app.store.songs.length) {
      this.list.append(h('div', { class: 'pb-muted pb-list-empty' }, 'No songs match.'));
    }
    for (const song of this.songs) {
      const url = song.cover ? this.app.store.urlSync(song.id, song.cover) : null;
      const [srcLabel, srcIcon] = SOURCE_LABEL[song.source];
      const top = Math.max(0, ...song.maps.map((m) => m.level));
      const card = sounding(
        h(
          'div',
          { class: 'pb-song', onclick: () => this.select(song, this.song?.id === song.id ? this.mapId : undefined), ondblclick: () => void this.play() },
          url ? h('img', { class: 'pb-song-cover', src: url, alt: '', loading: 'lazy' }) : h('div', { class: 'pb-song-cover placeholder' }, song.title.slice(0, 1).toUpperCase()),
          h(
            'div',
            { class: 'pb-song-text' },
            h('b', null, song.title),
            h('span', null, song.artist),
            h('small', null, icon(srcIcon, 12), srcLabel, ' · ', formatTime(song.duration), song.bpm ? ` · ${Math.round(song.bpm)} BPM` : '', ` · ${song.maps.length} map${song.maps.length === 1 ? '' : 's'}`),
          ),
          h('div', { class: 'pb-song-level', style: { color: levelColor(top) } }, song.maps.length ? stars(top) : '—'),
          h('div', { class: 'pb-song-maps' }),
        ),
        'select',
      );
      this.cards.set(song.id, card);
      this.list.append(card);
    }
    if (this.song) {
      const still = this.app.store.song(this.song.id);
      if (still) {
        this.song = still;
        this.markSelected();
      } else {
        this.song = null;
        if (this.songs[0]) this.select(this.songs[0]);
        else this.showInfo();
      }
    }
  }

  private markSelected() {
    for (const [id, card] of this.cards) {
      const on = id === this.song?.id;
      card.classList.toggle('sel', on);
      const maps = card.querySelector('.pb-song-maps')!;
      clear(maps);
      if (on && this.song) {
        for (const m of this.song.maps) {
          const best = bestRecord(m.id);
          maps.append(
            sounding(
              h(
                'button',
                {
                  class: `pb-diff ${m.id === this.mapId ? 'on' : ''}`,
                  style: { '--lv': levelColor(m.level) } as unknown as Partial<CSSStyleDeclaration>,
                  onclick: (e: MouseEvent) => {
                    e.stopPropagation();
                    this.setMap(m.id);
                  },
                  ondblclick: (e: MouseEvent) => {
                    e.stopPropagation();
                    void this.play();
                  },
                },
                h('span', { class: 'pb-diff-star' }, stars(m.level)),
                h('b', null, m.name),
                best ? h('span', { class: `pb-grade-chip g-${best.grade}` }, best.grade) : null,
              ),
              'toggle',
            ),
          );
        }
        if (!this.song.maps.length) maps.append(btn('Make a map', () => this.edit(), { icon: 'wand', cls: 'small' }));
      }
    }
  }

  private select(song: SongMeta, mapId?: string, instant = false) {
    const changed = this.song?.id !== song.id;
    this.song = song;
    const maps = song.maps;
    this.mapId = maps.find((m) => m.id === mapId)?.id || (changed ? maps[Math.min(1, maps.length - 1)]?.id : this.mapId) || maps[0]?.id || '';
    this.markSelected();
    const card = this.cards.get(song.id);
    card?.scrollIntoView({ block: 'nearest', behavior: instant || this.app.settings.reduceMotion ? 'auto' : 'smooth' });
    this.showInfo();
    const url = song.cover ? this.app.store.urlSync(song.id, song.cover) : null;
    this.turntable.setCover(url, song.title);
    this.app.backdrop.setCover(url);
    this.app.settings.lastSong = song.id;
    this.app.settings.lastMap = this.mapId;
    this.app.save();
    if (changed) {
      clearTimeout(this.previewTimer);
      this.app.audio.deck.gain(0);
      this.previewTimer = window.setTimeout(() => void this.loadPreview(song, false), instant ? 50 : 260);
    }
  }

  private setMap(id: string) {
    this.mapId = id;
    this.app.settings.lastMap = id;
    this.app.save();
    this.markSelected();
    this.showInfo();
  }

  private get map(): MapSummary | undefined {
    return this.song?.maps.find((m) => m.id === this.mapId);
  }

  private async loadPreview(song: SongMeta, force: boolean) {
    const key = `sel:${song.id}`;
    if (this.previewKey === key && this.app.audio.deck.loadedKey === key) {
      if (this.app.settings.previewMusic || force) this.setMotor(true);
      return;
    }
    this.turntable.setLoading(true);
    try {
      const p = await this.app.library.preview(song);
      if (this.song?.id !== song.id) return;
      await this.app.audio.deck.load(key, p.buffer, p.start, p.length);
      this.previewKey = key;
      this.setMotor(this.app.settings.previewMusic || force);
    } catch (err) {
      console.warn('preview failed', err);
      this.previewKey = '';
      this.setMotor(false);
    } finally {
      this.turntable.setLoading(false);
    }
  }

  private setMotor(on: boolean) {
    const deck = this.app.audio.deck;
    if (on && this.song && !this.previewKey) {
      void this.loadPreview(this.song, true);
      return;
    }
    deck.motor(on);
    deck.gain(on ? 1 : 0.9);
    this.turntable.setPlaying(on);
  }

  // ------------------------------------------------------------ info ----

  private showInfo() {
    const song = this.song;
    clear(this.info);
    clear(this.board);
    if (!song) return;
    const map = this.map;
    const [srcLabel, srcIcon] = SOURCE_LABEL[song.source];
    const chip = (ic: string, text: string, title?: string) => h('span', { class: 'pb-chip', title }, icon(ic, 13), text);
    this.info.append(
      h('div', { class: 'pb-info-title' }, h('h2', null, song.title), h('p', null, song.artist)),
      h(
        'div',
        { class: 'pb-chips' },
        chip(srcIcon, srcLabel),
        chip('clock', formatTime(song.duration)),
        song.bpm ? chip('metronome', `${Math.round(song.bpm * 10) / 10} BPM`) : null,
        map ? chip('lanes', `${map.notes} notes · ${map.holds} holds`) : null,
        map ? chip('bolt', `${map.nps.toFixed(1)} NPS`) : null,
        map ? h('span', { class: 'pb-chip level', style: { color: levelColor(map.level) } }, icon('star', 13), `${map.level.toFixed(1)}`) : null,
        song.video ? chip('video', 'Video') : null,
      ),
      map ? h('p', { class: 'pb-info-mapper' }, `${map.name} · mapped by `, h('b', null, map.creator || 'PIANO-BEATS'), map.origin === 'osu' ? ' (osu!)' : map.origin === 'generated' ? ' (generated)' : '') : h('p', { class: 'pb-muted' }, 'No maps yet – press Edit to make one.'),
    );
    if (!map) return;
    const records = loadRecords()[map.id] || [];
    this.board.append(h('h3', null, icon('trophy', 15), 'Your best'));
    if (!records.length) this.board.append(h('p', { class: 'pb-muted small' }, 'Not played yet.'));
    records.slice(0, 5).forEach((r, i) => {
      this.board.append(
        h(
          'div',
          { class: `pb-board-row ${i === 0 ? 'top' : ''}` },
          h('span', { class: `pb-grade-chip g-${r.grade}` }, r.grade),
          h('b', null, r.score.toLocaleString()),
          h('span', null, `${(r.accuracy * 100).toFixed(2)}%`),
          h('span', null, `${r.maxCombo}×${r.fc ? ' FC' : ''}`),
          h('small', null, r.mods || new Date(r.date).toLocaleDateString()),
        ),
      );
    });
  }

  // ---------------------------------------------------------- actions ----

  private back() {
    void this.app.show('menu');
  }

  private random() {
    if (!this.songs.length) return;
    const pick = this.songs[Math.floor(Math.random() * this.songs.length)];
    this.select(pick);
  }

  private edit() {
    if (!this.song) {
      void this.app.openImport();
      return;
    }
    this.app.edit(this.song, this.mapId || null);
  }

  private async play() {
    const song = this.song;
    const summary = this.map;
    if (!song) return;
    if (!summary) {
      this.edit();
      return;
    }
    try {
      const map = await this.app.library.loadMap(song, summary.id);
      this.app.audio.deck.gain(0);
      this.app.audio.deck.motor(false);
      this.turntable.setPlaying(false);
      this.app.play(song, map);
    } catch (err) {
      toast(`Couldn't load the map: ${err instanceof Error ? err.message : err}`, 'error');
    }
  }

  private async remove() {
    const song = this.song;
    if (!song) return;
    if (!(await confirmDialog('Delete song?', `"${song.title}" and its ${song.maps.length} map(s) will be removed from your library.`, 'Delete', true))) return;
    const idx = this.songs.indexOf(song);
    await this.app.library.deleteSong(song);
    this.app.audio.deck.unload();
    this.previewKey = '';
    this.song = null;
    this.render();
    const next = this.songs[Math.min(idx, this.songs.length - 1)];
    if (next) this.select(next);
    else this.showInfo();
    toast('Song deleted.', 'ok');
  }

  private async export() {
    const song = this.song;
    if (!song || !song.maps.length) {
      toast('This song has no maps to export yet.', 'error');
      return;
    }
    const chosen = new Set(song.maps.map((m) => m.id));
    let withVideo = !!song.video && song.video !== song.audio;
    let openAfter = false;
    const listEl = h(
      'div',
      { class: 'pb-export-list' },
      ...song.maps.map((m) => h('div', { class: 'pb-export-item' }, toggle(true, (v) => (v ? chosen.add(m.id) : chosen.delete(m.id)), `${m.name} (${m.level.toFixed(1)}★, ${m.notes} notes)`))),
    );
    const bar = progressBar();
    bar.hidden = true;
    const go = btn('Export .osz', async () => {
      if (!chosen.size) return toast('Choose at least one difficulty.', 'error');
      go.disabled = true;
      bar.hidden = false;
      try {
        const maps = await Promise.all([...chosen].map((id) => this.app.library.loadMap(song, id)));
        const { name, bytes } = await this.app.library.exportOsz(song, maps, { video: withVideo }, (label, f) => bar.set(label, f));
        bar.set('Saving…', null);
        const path = await bridge.saveFile(name, bytes, [{ name: 'osu! beatmap', extensions: ['osz'] }]);
        m.close();
        if (path) {
          toast(`Exported ${name}`, 'ok');
          if (openAfter && isDesktop) {
            const err = await this.app.store.openPath(path);
            if (err) toast(`osu! didn't open it: ${err}`, 'error');
          }
        }
      } catch (err) {
        bar.hidden = true;
        go.disabled = false;
        toast(`Export failed: ${err instanceof Error ? err.message : err}`, 'error', 6000);
      }
    }, { cls: 'primary', icon: 'upload' }) as HTMLButtonElement;
    const m = modal('Export to osu!', [
      h('p', { class: 'pb-muted' }, 'Creates an osu!mania 4K beatmap (.osz) with the audio, the cover as background, and the difficulties you pick. ', song.source === 'score' ? 'The piano is rendered to MP3 first.' : ''),
      listEl,
      song.video && song.video !== song.audio ? row('Background video', toggle(withVideo, (v) => (withVideo = v))) : null,
      row('Open it with osu! afterwards', toggle(openAfter, (v) => (openAfter = v)), 'Imports it into osu! if installed'),
      bar,
    ].filter(Boolean) as Node[], { actions: [btn('Cancel', () => m.close(), { cls: 'ghost' }), go] });
  }

  // ------------------------------------------------------------- mods ----

  private updateMods() {
    const label = modsLabel(this.app.settings.mods, this.app.settings.healthMode);
    this.modsBtn.querySelector('span')!.textContent = label ? `Mods: ${label}` : 'Mods';
    this.modsBtn.classList.toggle('on', !!label);
  }

  private openMods() {
    const s = this.app.settings;
    const m = s.mods;
    const changed = () => {
      this.app.settingsChanged();
      this.updateMods();
    };
    const mod = (key: keyof typeof m, label: string, desc: string, ic: string) =>
      h('div', { class: 'pb-mod' }, h('span', { class: 'pb-mod-ic' }, icon(ic, 18)), h('div', null, h('b', null, label), h('small', null, desc)), toggle(m[key] as boolean, (v) => (((m as unknown as Record<string, unknown>)[key] = v), changed())));
    modal(
      'Mods',
      [
        row('Song speed', slider({ value: m.rate, min: 0.5, max: 2, step: 0.05, reset: 1, format: (v) => `${v.toFixed(2)}×`, onInput: (v) => ((m.rate = v), changed()) }), 'Double-click to reset'),
        row('Keep pitch', toggle(s.keepPitch, (v) => ((s.keepPitch = v), changed())), 'Off = nightcore/daycore style'),
        h(
          'div',
          { class: 'pb-mods-grid' },
          mod('mirror', 'Mirror', 'Flip the lanes left to right', 'mirror'),
          mod('random', 'Random', 'Shuffle which lane is which', 'shuffle'),
          mod('noHolds', 'No holds', 'Hold notes become taps', 'hold'),
          mod('hidden', 'Hidden', 'Notes fade out before the line', 'eye'),
          mod('fadeIn', 'Fade in', 'Notes appear late', 'sparkle'),
          mod('auto', 'Auto', 'Watch it play itself (not scored)', 'bolt'),
        ),
        row(
          'Health',
          segmented(s.healthMode, [
            { value: 'normal', label: 'Normal' },
            { value: 'nofail', label: 'No fail' },
            { value: 'suddendeath', label: 'Sudden death' },
            { value: 'perfect', label: 'Perfect only' },
          ], (v) => ((s.healthMode = v), changed())),
        ),
      ],
      { cls: 'pb-mods-modal', actions: [btn('Reset mods', () => {
        Object.assign(m, { rate: 1, mirror: false, random: false, noHolds: false, hidden: false, fadeIn: false, auto: false });
        s.healthMode = 'normal';
        changed();
        toast('Mods cleared.');
      }, { cls: 'ghost' })] },
    );
  }

  // ------------------------------------------------------------- keys ----

  keyDown(e: KeyboardEvent) {
    const typing = document.activeElement === this.search;
    if (e.code === 'Escape') {
      if (typing && this.search.value) {
        this.search.value = '';
        this.render();
      } else if (typing) this.search.blur();
      else this.back();
      return true;
    }
    if (e.code === 'F1') this.openMods();
    else if (e.code === 'F2') this.random();
    else if (e.code === 'F3') this.app.openSettings();
    else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyE') this.edit();
    else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyF') this.search.focus();
    else if (e.code === 'Enter') void this.play();
    else if (e.code === 'ArrowDown' || e.code === 'ArrowUp') {
      if (!this.songs.length) return true;
      const i = this.song ? this.songs.findIndex((x) => x.id === this.song!.id) : -1;
      const next = this.songs[Math.max(0, Math.min(this.songs.length - 1, i + (e.code === 'ArrowDown' ? 1 : -1)))];
      if (next) this.select(next);
    } else if ((e.code === 'ArrowLeft' || e.code === 'ArrowRight') && !typing) {
      const maps = this.song?.maps || [];
      const i = maps.findIndex((m) => m.id === this.mapId);
      const next = maps[Math.max(0, Math.min(maps.length - 1, i + (e.code === 'ArrowRight' ? 1 : -1)))];
      if (next) {
        this.app.audio.sfx('toggle');
        this.setMap(next.id);
      }
    } else if (e.code === 'Delete' && !typing) void this.remove();
    else if (!typing && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && /\S/.test(e.key)) {
      // Typing anywhere searches.
      this.search.focus();
      return false;
    } else return typing ? false : e.code === 'Space';
    return true;
  }
}
