// The 4K area: a rhythm game with its own screens, song library, settings
// and audio mix. It shares the piano's AudioContext and engine (score songs
// are played on the piano).

import type { Metronome } from '../../audio/metronome';
import type { PianoEngine } from '../../audio/engine';
import { AutoPlayer } from '../../player/autoplayer';
import { h } from '../../ui/dom';
import { BeatsAudio } from '../audio/deck';
import { BeatsLibrary } from '../library';
import { ACCENTS, loadBeatsSettings, saveBeatsSettings, type BeatsSettings } from '../settings';
import { BeatsStore, onOpenBeatmap, pendingBeatmaps } from '../store';
import type { MapData, SongMeta } from '../types';
import { EditorScreen } from './editor';
import { ImportDialog } from './importer';
import { MenuScreen } from './menu';
import { PlayScreen, type PlayOptions, type PlayResult } from './play';
import { ResultsScreen } from './results';
import { SelectScreen } from './select';
import { SettingsPanel } from './settingsPanel';
import { modalOpen, setSfx, toast } from './widgets';

export interface Screen {
  el: HTMLElement;
  enter(arg?: unknown): void | Promise<void>;
  leave(): void;
  keyDown?(e: KeyboardEvent): boolean | void;
  keyUp?(e: KeyboardEvent): boolean | void;
}

export interface BeatsDeps {
  engine: PianoEngine;
  metronome: Metronome;
  onHome: () => void;
}

export class BeatsApp {
  readonly root: HTMLElement;
  readonly settings: BeatsSettings;
  readonly store = new BeatsStore();
  readonly audio: BeatsAudio;
  readonly library: BeatsLibrary;
  /** Plays score songs' accompaniment during play (separate from the piano's own player). */
  readonly scorePlayer: AutoPlayer;
  readonly backdrop: Backdrop;
  private stage: HTMLElement;
  private screens = new Map<string, Screen>();
  private current: Screen | null = null;
  private currentName = '';
  private settingsPanel: SettingsPanel | null = null;
  active = false;
  private seeded = false;

  constructor(root: HTMLElement, readonly deps: BeatsDeps) {
    this.root = root;
    this.settings = loadBeatsSettings();
    this.audio = new BeatsAudio(deps.engine);
    this.audio.setVolumes(this.settings);
    this.library = new BeatsLibrary(this.store, this.audio, deps.engine, () => this.settings.creator);
    this.scorePlayer = new AutoPlayer(deps.engine, deps.metronome);
    setSfx((n) => this.audio.sfx(n));
    this.backdrop = new Backdrop(this.audio);
    this.stage = h('div', { class: 'pb-stage' });
    root.classList.add('beats');
    root.append(this.backdrop.el, this.stage);
    this.applyAccent();

    window.addEventListener('keydown', (e) => this.onKey(e, true), true);
    window.addEventListener('keyup', (e) => this.onKey(e, false), true);
    window.addEventListener('blur', () => this.active && this.current instanceof PlayScreen && this.settings.pauseOnBlur && this.current.pause());
    root.addEventListener('dragover', (e) => {
      if (!this.active) return;
      e.preventDefault();
      root.classList.add('dropping');
    });
    root.addEventListener('dragleave', (e) => {
      if (e.target === root || !root.contains(e.relatedTarget as Node)) root.classList.remove('dropping');
    });
    root.addEventListener('drop', (e) => {
      if (!this.active) return;
      e.preventDefault();
      root.classList.remove('dropping');
      const files = e.dataTransfer?.files;
      if (files?.length) void this.openImport({ files: this.store.fromDrop(files) });
    });
    onOpenBeatmap((p) => void this.importPath(p));
  }

  // ------------------------------------------------------------ area ----

  async enter() {
    this.active = true;
    this.root.hidden = false;
    this.root.classList.add('shown');
    void this.deps.engine.resume();
    this.audio.setVolumes(this.settings);
    await this.store.refresh();
    if (!this.seeded) {
      this.seeded = true;
      if (!this.store.songs.length) {
        toast('Setting up a few piano songs to play…');
        await this.library.seedDemos();
        await this.store.refresh();
      }
      for (const p of await pendingBeatmaps()) await this.importPath(p);
    }
    if (!this.current) await this.show('menu');
    else this.current.enter();
  }

  leave() {
    this.active = false;
    this.current?.leave();
    this.current = null;
    this.currentName = '';
    this.audio.deck.motor(false);
    this.audio.deck.gain(0);
    this.root.classList.remove('shown');
    this.root.hidden = true;
  }

  home() {
    this.audio.sfx('back');
    this.deps.onHome();
  }

  private screen(name: string): Screen {
    let s = this.screens.get(name);
    if (!s) {
      if (name === 'menu') s = new MenuScreen(this);
      else if (name === 'select') s = new SelectScreen(this);
      else if (name === 'play') s = new PlayScreen(this);
      else if (name === 'results') s = new ResultsScreen(this);
      else s = new EditorScreen(this);
      this.screens.set(name, s);
    }
    return s;
  }

  async show(name: 'menu' | 'select' | 'play' | 'results' | 'editor', arg?: unknown) {
    const next = this.screen(name);
    const prev = this.current;
    if (prev && prev !== next) {
      prev.leave();
      prev.el.classList.remove('in');
      prev.el.classList.add('out');
      const el = prev.el;
      setTimeout(() => {
        if (this.current !== prev) {
          el.classList.remove('out');
          el.remove();
        }
      }, 320);
    }
    this.current = next;
    this.currentName = name;
    this.root.dataset.screen = name;
    if (!next.el.isConnected) this.stage.append(next.el);
    next.el.classList.remove('out');
    requestAnimationFrame(() => next.el.classList.add('in'));
    await next.enter(arg);
  }

  get screenName() {
    return this.currentName;
  }

  // --------------------------------------------------------- actions ----

  play(song: SongMeta, map: MapData, opts: Partial<PlayOptions> = {}) {
    this.settings.lastSong = song.id;
    this.settings.lastMap = map.id;
    this.save();
    void this.show('play', { song, map, ...opts } satisfies PlayOptions);
  }

  results(r: PlayResult) {
    void this.show('results', r);
  }

  edit(song: SongMeta, mapId?: string | null) {
    void this.show('editor', { song, mapId: mapId ?? null });
  }

  async openImport(opts: { tab?: 'youtube' | 'file' | 'osu' | 'score'; files?: import('../store').PickedFile[]; edit?: boolean } = {}) {
    const dlg = new ImportDialog(this, opts.tab);
    const created = await dlg.open(opts.files);
    if (created.length) {
      await this.store.refresh();
      const song = this.store.song(created[created.length - 1].id) || created[created.length - 1];
      if (opts.edit || this.settings.openEditorAfterImport) this.edit(song, song.maps[0]?.id);
      else await this.show('select', { songId: song.id });
    }
  }

  private async importPath(p: string) {
    try {
      const picked = await this.store.pickedFromPath(p);
      if (!this.active) return;
      await this.openImport({ tab: 'osu', files: [picked] });
    } catch (err) {
      toast(`Couldn't open ${p}: ${err instanceof Error ? err.message : err}`, 'error');
    }
  }

  openSettings(focus?: string) {
    if (!this.settingsPanel) this.settingsPanel = new SettingsPanel(this);
    this.settingsPanel.open(focus);
  }

  save() {
    saveBeatsSettings(this.settings);
  }

  settingsChanged() {
    this.save();
    this.audio.setVolumes(this.settings);
    this.applyAccent();
    this.root.classList.toggle('reduce-motion', this.settings.reduceMotion);
    for (const s of this.screens.values()) (s as Screen & { settingsChanged?: () => void }).settingsChanged?.();
  }

  private applyAccent() {
    const [a, b, c] = ACCENTS[this.settings.accent] || ACCENTS.violet;
    this.root.style.setProperty('--pb-a', a);
    this.root.style.setProperty('--pb-b', b);
    this.root.style.setProperty('--pb-c', c);
    this.root.classList.toggle('reduce-motion', this.settings.reduceMotion);
  }

  // ------------------------------------------------------------- input ----

  private isTyping(e: KeyboardEvent) {
    const t = e.target as HTMLElement | null;
    if (!t) return false;
    if (t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return true;
    return t.tagName === 'INPUT' && !['range', 'checkbox', 'button', 'color', 'radio'].includes((t as HTMLInputElement).type);
  }

  private onKey(e: KeyboardEvent, down: boolean) {
    if (!this.active) return;
    if (this.settingsPanel?.isOpen) {
      if (down) this.settingsPanel.keyDown(e);
      return;
    }
    if (modalOpen()) return;
    const typing = this.isTyping(e);
    const cur = this.current;
    if (!cur) return;
    if (down) {
      if (typing && !(cur instanceof SelectScreen)) return;
      if (cur.keyDown?.(e)) {
        e.preventDefault();
        e.stopPropagation();
      }
    } else if (cur.keyUp?.(e)) {
      e.preventDefault();
      e.stopPropagation();
    }
  }

  midi(midi: number, velocity: number, down: boolean) {
    if (!this.active) return;
    const cur = this.current as Screen & { midi?: (m: number, v: number, d: boolean) => void };
    cur?.midi?.(midi, velocity, down);
  }
}

// ------------------------------------------------------------ backdrop ----

/** The animated background: gradient orbs, the current cover blurred, and drifting sparks that react to the music. */
export class Backdrop {
  readonly el: HTMLElement;
  private covers: HTMLElement;
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private sparks: { x: number; y: number; r: number; v: number; a: number; hue: number }[] = [];
  private freq = new Uint8Array(1024);
  private level = 0;
  private coverUrl = '';
  intensity = 1;

  constructor(private audio: BeatsAudio) {
    this.covers = h('div', { class: 'pb-bg-covers' });
    this.canvas = h('canvas', { class: 'pb-bg-sparks' });
    this.g = this.canvas.getContext('2d')!;
    this.el = h('div', { class: 'pb-bg' }, h('div', { class: 'pb-bg-orb o1' }), h('div', { class: 'pb-bg-orb o2' }), h('div', { class: 'pb-bg-orb o3' }), this.covers, this.canvas, h('div', { class: 'pb-bg-vignette' }));
    for (let i = 0; i < 70; i++) this.sparks.push(this.spark(true));
    const loop = () => {
      requestAnimationFrame(loop);
      this.frame();
    };
    loop();
  }

  private spark(anywhere: boolean) {
    return { x: Math.random(), y: anywhere ? Math.random() : 1.05, r: 0.6 + Math.random() * 2.2, v: 0.02 + Math.random() * 0.06, a: 0.2 + Math.random() * 0.6, hue: Math.random() };
  }

  setCover(url: string | null) {
    if ((url || '') === this.coverUrl) return;
    this.coverUrl = url || '';
    const layer = h('div', { class: 'pb-bg-cover' });
    if (url) layer.style.backgroundImage = `url("${url}")`;
    this.covers.append(layer);
    requestAnimationFrame(() => layer.classList.add('in'));
    const old = [...this.covers.children].slice(0, -1);
    setTimeout(() => old.forEach((o) => o.remove()), 1200);
  }

  setTint(rgb: [number, number, number]) {
    this.el.style.setProperty('--pb-tint', `${rgb[0]}, ${rgb[1]}, ${rgb[2]}`);
  }

  /** Current bass level (0–1) for beat-reactive visuals. */
  get bass() {
    return this.level;
  }

  get frequencies() {
    return this.freq;
  }

  private frame() {
    // Nothing to do while hidden (during play the backdrop is not rendered at all).
    if (!this.el.isConnected || document.hidden || this.el.offsetParent === null) return;
    const a = this.audio.analyser;
    if (this.freq.length !== a.frequencyBinCount) this.freq = new Uint8Array(a.frequencyBinCount);
    a.getByteFrequencyData(this.freq);
    let bass = 0;
    for (let i = 1; i < 12; i++) bass += this.freq[i];
    bass /= 11 * 255;
    this.level += (bass - this.level) * 0.25;

    const c = this.canvas;
    const dpr = Math.min(1.5, window.devicePixelRatio || 1);
    const w = c.clientWidth;
    const hgt = c.clientHeight;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(hgt * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(hgt * dpr);
    }
    const g = this.g;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, hgt);
    if (this.intensity <= 0) return;
    const boost = 1 + this.level * 4;
    for (const s of this.sparks) {
      s.y -= (s.v * boost) / 60;
      s.x += Math.sin(s.y * 6 + s.hue * 10) * 0.0004;
      if (s.y < -0.05) Object.assign(s, this.spark(false));
      g.globalAlpha = s.a * this.intensity * (0.5 + this.level);
      g.fillStyle = s.hue < 0.33 ? 'rgba(255,120,220,1)' : s.hue < 0.66 ? 'rgba(150,120,255,1)' : 'rgba(90,200,255,1)';
      g.beginPath();
      g.arc(s.x * w, s.y * hgt, s.r * (1 + this.level), 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;
  }
}
