// Gameplay. Audio songs play their audio file (time-stretched when the speed
// changes and "keep pitch" is on); score songs play their accompaniment on
// the piano while every hit plays the notes that chart note stands for.

import type { ScoreNote } from '../../score/model';
import { h, icon } from '../../ui/dom';
import { JUDGEMENTS, LABELS, osuWindows, scaledWindows, type Judgement, type Windows } from '../../game/judge';
import { GameSession, type HitEvent, type NoteState, type PlayNote } from '../../game/session';
import { MusicPlayer } from '../audio/deck';
import { stretchAudio } from '../audio/workerClient';
import { beatAt, bindToScore } from '../mapgen';
import { addRecord, modsLabel, PALETTES, SNAP_COLORS, type BeatsSettings, type PlayRecord } from '../settings';
import type { MapData, SongMeta, TimingPoint } from '../types';
import type { BeatsApp, Screen } from './app';
import { btn, formatTime, keyName, progressBar, toast } from './widgets';

export interface PlayOptions {
  song: SongMeta;
  map: MapData;
  /** Start from this song time (practice / test play). */
  from?: number;
  /** Test play from the editor: not scored, returns to the editor. */
  test?: boolean;
  onExit?: (at: number) => void;
}

export interface PlayResult {
  song: SongMeta;
  map: MapData;
  counts: Record<Judgement, number>;
  score: number;
  accuracy: number;
  maxCombo: number;
  grade: string;
  fc: boolean;
  ur: number;
  mean: number;
  history: { delta: number; at: number; j: Judgement; timed: boolean }[];
  failed: boolean;
  auto: boolean;
  rate: number;
  mods: string;
  duration: number;
  windows: Windows;
  rank: number | null;
  early: number;
  late: number;
}

interface GNote extends PlayNote {
  sources: ScoreNote[];
  samples: string[];
  volume: number;
  color: string;
}

interface Clock {
  readonly rate: number;
  start(pos: number, when: number): void;
  stop(): number;
  /** Song time now, for drawing and judging. */
  now(): number;
  /** Song time at a context time (input timestamps). */
  at(ctxTime: number): number;
  /** Context time at which song time `t` is scheduled. */
  ctxFor(t: number): number;
  readonly playing: boolean;
  fail?(): void;
}

const ARROW_ROT = [-Math.PI / 2, Math.PI, 0, Math.PI / 2];
const JUDGE_COLORS: Record<Judgement, string> = { perfect: '#7cf8ff', excellent: '#8dff7a', good: '#ffe066', bad: '#ff9f43', miss: '#ff4d6d' };
const OFFSETS_KEY = 'pianobeats.offsets.v1';

function localOffsets(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(OFFSETS_KEY) || '{}');
  } catch {
    return {};
  }
}

export class PlayScreen implements Screen {
  readonly el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private bgImg: HTMLElement;
  private video: HTMLVideoElement;
  private dim: HTMLElement;
  private overlay: HTMLElement;
  private hud: Record<string, HTMLElement> = {};
  private judgeEl: HTMLElement;
  private judgeSub: HTMLElement;
  private comboEl: HTMLElement;
  private keyEls: HTMLElement[] = [];
  private keyCounts = [0, 0, 0, 0];
  private opts!: PlayOptions;
  private s: GameSession<GNote> | null = null;
  private clock: Clock | null = null;
  private notes: GNote[] = [];
  private samples = new Map<string, AudioBuffer>();
  private timing: TimingPoint[] = [];
  private pressed = [false, false, false, false];
  private autoUntil = [0, 0, 0, 0];
  private flash = [0, 0, 0, 0];
  private sounding = new Map<NoteState<GNote>, number[]>();
  private particles: { x: number; y: number; vx: number; vy: number; life: number; color: string; size: number }[] = [];
  private phase: 'loading' | 'playing' | 'paused' | 'failed' | 'done' = 'loading';
  private raf = 0;
  private startPos = 0;
  private firstNote = 0;
  private lastNote = 0;
  private endTime = 0;
  private offsetMs = 0;
  private localOffset = 0;
  private shake = 0;
  private frames: number[] = [];
  private retryDown = 0;
  private doneAt = 0;
  private token = 0;
  private windows: Windows = scaledWindows(1);
  private laneColors: string[] = PALETTES.fnf;
  private stretchCache: { key: string; buffer: AudioBuffer } | null = null;
  private w = 0;
  private hgt = 0;
  private dpr = 1;
  private lastCombo = 0;
  private npsTimes: number[] = [];

  constructor(private app: BeatsApp) {
    this.canvas = h('canvas', { class: 'pb-play-canvas' });
    this.g = this.canvas.getContext('2d')!;
    this.bgImg = h('div', { class: 'pb-play-bgimg' });
    this.video = h('video', { class: 'pb-play-video', muted: true, playsInline: true, preload: 'auto' }) as HTMLVideoElement;
    this.video.muted = true;
    this.dim = h('div', { class: 'pb-play-dim' });
    this.overlay = h('div', { class: 'pb-play-overlay' });
    this.judgeEl = h('div', { class: 'pb-judge' });
    this.judgeSub = h('div', { class: 'pb-judge-sub' });
    this.comboEl = h('div', { class: 'pb-combo' });
    const stat = (k: string, label: string) => h('div', { class: `pb-count c-${k}` }, h('span', null, label), (this.hud[k] = h('b', null, '0')));
    const keys = h('div', { class: 'pb-keyoverlay' });
    for (let i = 0; i < 4; i++) {
      const el = h('div', { class: 'pb-kov' }, h('span', { class: 'pb-kov-key' }), h('b', null, '0'));
      this.keyEls.push(el);
      keys.append(el);
    }
    this.hud.keys = keys;
    this.el = h(
      'div',
      { class: 'pb-screen pb-play' },
      h('div', { class: 'pb-play-bg' }, this.bgImg, this.video, this.dim),
      this.canvas,
      h(
        'div',
        { class: 'pb-hud' },
        (this.hud.progressWrap = h('div', { class: 'pb-hud-progress' }, (this.hud.progress = h('div', { class: 'pb-hud-progress-fill' })))),
        h('div', { class: 'pb-hud-top' }, (this.hud.title = h('div', { class: 'pb-hud-title' })), (this.hud.time = h('div', { class: 'pb-hud-time' }))),
        (this.hud.scoreBox = h('div', { class: 'pb-hud-score' }, (this.hud.score = h('b', null, '0')), (this.hud.acc = h('span', null, '100.00%')), (this.hud.grade = h('i', null, 'SS')))),
        (this.hud.counts = h('div', { class: 'pb-hud-counts' }, ...JUDGEMENTS.map((j) => stat(j, LABELS[j])))),
        (this.hud.side = h('div', { class: 'pb-hud-side' }, keys, (this.hud.nps = h('div', { class: 'pb-hud-nps' })), (this.hud.fps = h('div', { class: 'pb-hud-fps' })))),
        (this.hud.health = h('div', { class: 'pb-health' }, (this.hud.healthFill = h('div', { class: 'pb-health-fill' })))),
        this.judgeEl,
        this.judgeSub,
        this.comboEl,
        (this.hud.skip = h('div', { class: 'pb-skip', hidden: true }, h('kbd', null, 'Space'), ' Skip intro')),
        (this.hud.retry = h('div', { class: 'pb-retry-ring', hidden: true })),
        (this.hud.modsTag = h('div', { class: 'pb-hud-mods' })),
      ),
      this.overlay,
    );
    this.canvas.addEventListener('pointerdown', (e) => this.onPointer(e, true));
    this.canvas.addEventListener('pointerup', (e) => this.onPointer(e, false));
    this.canvas.addEventListener('pointercancel', (e) => this.onPointer(e, false));
    new ResizeObserver(() => this.resize()).observe(this.el);
  }

  private get set(): BeatsSettings {
    return this.app.settings;
  }

  // ------------------------------------------------------------ setup ----

  async enter(arg?: unknown) {
    this.opts = arg as PlayOptions;
    this.app.backdrop.intensity = 0;
    await this.load();
  }

  private async load() {
    const token = ++this.token;
    const { song, map } = this.opts;
    const set = this.set;
    const mods = set.mods;
    this.stopAll();
    this.phase = 'loading';
    this.el.classList.remove('failed', 'paused');
    this.sounding.clear();
    this.particles = [];
    this.keyCounts = [0, 0, 0, 0];
    this.lastCombo = 0;
    this.npsTimes = [];
    this.pressed = [false, false, false, false];
    const bar = progressBar();
    this.showOverlay(h('div', { class: 'pb-play-loading glass' }, h('h2', null, song.title), h('p', null, `${song.artist} · ${map.name}`), bar));
    bar.set('Loading…', null);
    this.hud.title.textContent = `${song.title} · ${map.name}`;
    const rate = Math.max(0.5, Math.min(2, mods.rate));
    this.laneColors = set.palette === 'mono' ? PALETTES.mono : PALETTES[set.palette] || PALETTES.fnf;
    this.windows = set.judging === 'map' ? osuWindows(map.od) : scaledWindows(set.judging === 'lenient' ? 1.35 : set.judging === 'strict' ? 0.7 : 1);
    this.localOffset = localOffsets()[map.id] || 0;
    this.offsetMs = set.offset + this.localOffset;
    this.hud.modsTag.textContent = [this.opts.test ? 'TEST PLAY' : '', modsLabel(mods, set.healthMode)].filter(Boolean).join(' · ');
    try {
      this.timing = map.timing.length ? map.timing : await this.app.library.timing(song, map);
      // Lanes after mods.
      let perm = [0, 1, 2, 3];
      if (mods.random) {
        const seed = Math.floor(Math.random() * 1e9);
        let a = seed;
        const rnd = () => ((a = (a * 16807) % 2147483647) / 2147483647);
        for (let i = 3; i > 0; i--) {
          const j = Math.floor(rnd() * (i + 1));
          [perm[i], perm[j]] = [perm[j], perm[i]];
        }
        if (perm.every((v, i) => v === i)) perm = [1, 0, 3, 2];
      }
      const lanesOf = (l: number) => (mods.mirror ? 3 - perm[l] : perm[l]);
      const mapped = map.notes.map((n) => ({ ...n, l: lanesOf(n.l) }));
      let bound: Set<ScoreNote> = new Set();
      let score = null;
      if (song.source === 'score') {
        bar.set('Loading the score…', null);
        score = await this.app.library.score(song);
        const b = bindToScore(mapped, score, map.hands || 'both');
        bound = b.bound;
        this.notes = b.notes.map((n) => ({ ...n, color: '' }));
      } else {
        this.notes = mapped.map((n, i) => ({ id: i, time: n.t, lane: n.l, end: n.e ?? null, sources: [], samples: n.s ? n.s.split('|') : [], volume: n.v ?? 1, color: '' }));
      }
      for (const n of this.notes) n.color = this.noteColor(n);
      this.notes.sort((a, b) => a.time - b.time || a.lane - b.lane);
      if (set.keysounds && this.notes.some((n) => n.samples.length)) {
        bar.set('Loading keysounds…', null);
        this.samples = await this.app.library.keysounds(song, map);
      } else this.samples = new Map();

      // Clock.
      if (song.source === 'score') {
        const p = this.app.scorePlayer;
        p.load(score);
        p.hands = { L: true, R: true };
        p.waitMode = false;
        p.loop = null;
        p.loopWhole = false;
        p.metronomeOn = false;
        p.setGate(null);
        p.noteFilter = (n) => !bound.has(n);
        p.speed = rate;
        p.rebuild();
        // Keep our own clock: the player stops (and resets) when the accompaniment ends,
        // but the chart can go on a little longer.
        const ctx = this.app.audio.ctx;
        let startPos = 0;
        let startCtx = 0;
        let pausedAt = 0;
        let running = false;
        const now = (ct = ctx.currentTime) => (running ? startPos + (ct - startCtx) * rate : pausedAt);
        this.clock = {
          rate,
          start: (pos, when) => {
            startPos = pos;
            startCtx = when;
            running = true;
            p.startFrom(pos, when);
          },
          stop: () => {
            pausedAt = now();
            running = false;
            p.pause();
            return pausedAt;
          },
          now: () => now(),
          at: (ct) => now(ct),
          ctxFor: (t) => startCtx + (t - startPos) / rate,
          get playing() {
            return running;
          },
        };
      } else {
        bar.set('Decoding audio…', null);
        const buffer = await this.app.library.audioBuffer(song);
        if (token !== this.token) return;
        let playBuf = buffer;
        let stretched = false;
        if (Math.abs(rate - 1) > 1e-3 && set.keepPitch) {
          const key = `${song.id}@${rate}`;
          if (this.stretchCache?.key === key) playBuf = this.stretchCache.buffer;
          else {
            bar.set(`Preparing ${rate.toFixed(2)}× (keeping the pitch)…`, 0);
            const ch = await stretchAudio(buffer, rate, (f) => bar.set(`Preparing ${rate.toFixed(2)}× (keeping the pitch)…`, f));
            if (token !== this.token) return;
            playBuf = new AudioBuffer({ numberOfChannels: ch.length, length: ch[0].length, sampleRate: buffer.sampleRate });
            ch.forEach((c, i) => playBuf.copyToChannel(c as Float32Array<ArrayBuffer>, i));
            this.stretchCache = { key, buffer: playBuf };
          }
          stretched = true;
        }
        const mp = new MusicPlayer(this.app.audio.ctx, this.app.audio.music);
        mp.set(playBuf, rate, stretched);
        const ctx = this.app.audio.ctx;
        this.clock = {
          rate,
          start: (pos, when) => mp.start(pos, when),
          stop: () => mp.stop(),
          now: () => mp.time(ctx.currentTime, true),
          at: (ct) => mp.time(ct, true),
          ctxFor: (t) => mp.ctxTimeFor(t),
          get playing() {
            return mp.playing;
          },
          fail: () => {
            // Vinyl stop: the music winds down.
            const src = (mp as unknown as { src: AudioBufferSourceNode | null }).src;
            if (src) {
              const t = ctx.currentTime;
              src.playbackRate.cancelScheduledValues(t);
              src.playbackRate.setValueAtTime(src.playbackRate.value, t);
              src.playbackRate.exponentialRampToValueAtTime(0.05, t + 1.4);
              setTimeout(() => mp.stop(), 1450);
            }
          },
        };
      }

      // Background.
      const cover = song.background || song.cover;
      const url = cover ? await this.app.store.url(song.id, cover) : null;
      this.bgImg.style.backgroundImage = url ? `url("${url}")` : '';
      this.bgImg.style.filter = `blur(${set.bgBlur}px) saturate(1.1)`;
      this.dim.style.opacity = String(set.bgDim);
      this.video.hidden = true;
      if (set.video && song.video) {
        this.video.src = await this.app.store.url(song.id, song.video);
        this.video.hidden = false;
        this.video.pause();
      } else this.video.removeAttribute('src');

      this.s = new GameSession(this.notes, { speed: rate, windows: this.windows, noHolds: mods.noHolds });
      this.firstNote = this.notes.length ? this.notes[0].time : 0;
      this.lastNote = this.notes.reduce((m, n) => Math.max(m, n.end ?? n.time), 0);
      this.endTime = this.lastNote + 1.2 * rate;
      const from = this.opts.from ?? 0;
      if (from > 0) this.s.skipBefore(from);
      const lead = (set.countdown ? 2.6 : 1.6) * rate;
      const firstPlayable = this.notes.find((n) => n.time >= from - 1e-3)?.time ?? from;
      this.startPos = Math.min(from, firstPlayable - lead);
      if (token !== this.token) return;
      this.applyHudVisibility();
      this.updateHud();
      this.clearOverlay();
      this.phase = 'playing';
      this.doneAt = 0;
      void this.app.deps.engine.resume();
      const when = this.app.audio.ctx.currentTime + 0.35;
      this.clock.start(this.startPos, when);
      this.syncVideo(true);
      this.countdown(when);
      this.app.audio.sfx('whoosh');
      this.loop();
    } catch (err) {
      console.error(err);
      if (token !== this.token) return;
      this.showOverlay(
        h(
          'div',
          { class: 'pb-play-card glass' },
          h('h2', null, 'Couldn’t start this map'),
          h('p', { class: 'pb-muted' }, err instanceof Error ? err.message : String(err)),
          h('div', { class: 'pb-play-actions' }, btn('Back', () => this.quit(), { icon: 'back', cls: 'primary' })),
        ),
      );
    }
  }

  private noteColor(n: GNote): string {
    const set = this.set;
    if (set.noteColors === 'single') return set.singleColor;
    if (set.noteColors === 'snap' && this.timing.length) {
      const b = beatAt(this.timing, n.time);
      for (const [div, col] of SNAP_COLORS) if (Math.abs(b * div - Math.round(b * div)) < 0.04 * div) return col;
      return '#b0b0c0';
    }
    return this.laneColors[n.lane];
  }

  /** 3 · 2 · 1 · GO, timed so GO lands on the first note. */
  private countdown(startCtx: number) {
    if (!this.set.countdown || !this.clock) return;
    const ctx = this.app.audio.ctx;
    const firstAt = startCtx + (this.firstNote - this.startPos) / this.clock.rate;
    const spacing = Math.min(0.55, (firstAt - startCtx - 0.2) / 4);
    if (spacing < 0.25) return;
    const token = this.token;
    ['3', '2', '1', 'GO!'].forEach((label, i) => {
      const at = firstAt - spacing * (3 - i);
      setTimeout(() => {
        if (token !== this.token || this.phase !== 'playing') return;
        this.popJudge(label, i === 3 ? '#7cf8ff' : '#ffffff', '');
        this.app.audio.sfx(i === 3 ? 'go' : 'count');
      }, Math.max(0, (at - ctx.currentTime) * 1000));
    });
  }

  leave() {
    this.token++;
    this.stopAll();
    cancelAnimationFrame(this.raf);
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
  }

  private stopAll() {
    this.clock?.stop();
    this.clock = null;
    const p = this.app.scorePlayer;
    p.stop();
    p.noteFilter = null;
    this.app.deps.engine.allNotesOff();
  }

  settingsChanged() {
    const set = this.set;
    this.dim.style.opacity = String(set.bgDim);
    this.bgImg.style.filter = `blur(${set.bgBlur}px) saturate(1.1)`;
    this.offsetMs = set.offset + this.localOffset;
    this.applyHudVisibility();
    for (const n of this.notes) n.color = this.noteColor(n);
    this.resize();
  }

  private applyHudVisibility() {
    const s = this.set;
    this.hud.scoreBox.hidden = !s.showScore;
    this.hud.counts.hidden = !s.showScore;
    this.hud.keys.hidden = !s.showKeyOverlay;
    this.hud.nps.hidden = !s.showNps;
    this.hud.fps.hidden = !s.showFps;
    this.hud.health.hidden = !s.showHealth || s.healthMode === 'nofail';
    this.hud.progressWrap.hidden = !s.showProgress;
    this.el.dataset.judgePos = s.judgementPos;
    this.el.dataset.scroll = s.scroll;
    this.keyEls.forEach((el, i) => {
      el.querySelector('.pb-kov-key')!.textContent = keyName(s.keys[i]);
      el.style.setProperty('--c', this.laneColors[i]);
    });
  }

  // ---------------------------------------------------------- overlays ----

  private showOverlay(content: HTMLElement) {
    this.overlay.replaceChildren(content);
    this.overlay.classList.add('show');
  }

  private clearOverlay() {
    this.overlay.classList.remove('show');
    this.overlay.replaceChildren();
  }

  pause() {
    if (this.phase !== 'playing' || !this.clock) return;
    const at = this.clock.stop();
    this.releaseSounding();
    this.video.pause();
    this.phase = 'paused';
    this.el.classList.add('paused');
    (this as unknown as { pausedAt: number }).pausedAt = at;
    const offsetLine = h('div', { class: 'pb-muted small' }, `Offset ${this.offsetMs >= 0 ? '+' : ''}${this.offsetMs} ms (this map ${this.localOffset >= 0 ? '+' : ''}${this.localOffset} ms · −/= to nudge)`);
    this.showOverlay(
      h(
        'div',
        { class: 'pb-play-card glass pause' },
        h('h2', null, 'Paused'),
        h('p', { class: 'pb-muted' }, `${this.opts.song.title} · ${this.opts.map.name} · ${formatTime(Math.max(0, at))}`),
        h(
          'div',
          { class: 'pb-play-actions col' },
          btn('Continue', () => this.resume(), { icon: 'play', cls: 'primary big', title: 'Esc' }),
          btn('Retry', () => void this.retry(), { icon: 'refresh', title: 'R' }),
          btn('Settings', () => this.app.openSettings('gameplay'), { icon: 'gear' }),
          btn(this.opts.test ? 'Back to the editor' : 'Quit', () => this.quit(), { icon: 'exit', cls: 'ghost', title: 'Q' }),
        ),
        offsetLine,
      ),
    );
  }

  resume() {
    if (this.phase !== 'paused' || !this.clock) return;
    const at = (this as unknown as { pausedAt: number }).pausedAt;
    const back = Math.max(this.startPos, at - 1.2 * this.clock.rate);
    this.clearOverlay();
    this.el.classList.remove('paused');
    this.phase = 'playing';
    this.clock.start(back, this.app.audio.ctx.currentTime + 0.25);
    this.syncVideo(true);
    this.popJudge('READY', '#ffffff', '');
    this.loop();
  }

  async retry() {
    this.app.audio.sfx('whoosh');
    await this.load();
  }

  quit() {
    const at = this.clock ? Math.max(0, this.clock.now()) : 0;
    this.leave();
    if (this.opts.test) {
      this.opts.onExit?.(at);
      return;
    }
    void this.app.show('select', { songId: this.opts.song.id });
  }

  private fail() {
    if (this.phase !== 'playing') return;
    this.phase = 'failed';
    this.el.classList.add('failed');
    this.clock?.fail?.();
    if (this.opts.song.source === 'score') this.clock?.stop();
    this.releaseSounding();
    this.video.pause();
    this.app.audio.sfx('fail');
    setTimeout(() => {
      if (this.phase !== 'failed') return;
      this.clock?.stop();
      this.showOverlay(
        h(
          'div',
          { class: 'pb-play-card glass fail' },
          h('div', { class: 'pb-fail-title' }, 'FAILED'),
          h('p', { class: 'pb-muted' }, `${this.s ? Math.round(this.s.progress * 100) : 0}% of the map · ${this.s?.keeper.score.toLocaleString() ?? 0} points`),
          h(
            'div',
            { class: 'pb-play-actions' },
            btn('Retry', () => void this.retry(), { icon: 'refresh', cls: 'primary big' }),
            btn('Results', () => this.finish(true), { icon: 'trophy' }),
            btn('Quit', () => this.quit(), { icon: 'exit', cls: 'ghost' }),
          ),
        ),
      );
    }, 1300);
  }

  private finish(failed = false) {
    const s = this.s;
    if (!s) return;
    const k = s.keeper;
    const set = this.set;
    this.phase = 'done';
    const auto = set.mods.auto;
    const early = k.history.filter((x) => x.timed && x.delta < -this.windows.perfect).length;
    const late = k.history.filter((x) => x.timed && x.delta > this.windows.perfect).length;
    const mods = modsLabel(set.mods, set.healthMode);
    let rank: number | null = null;
    if (!auto && !this.opts.test && !failed && (this.opts.from ?? 0) <= 0 && k.total > 0) {
      const rec: PlayRecord = { score: k.score, accuracy: k.accuracy, grade: k.grade, maxCombo: k.maxCombo, fc: k.fullCombo, counts: { ...k.counts }, mods, rate: set.mods.rate, date: new Date().toISOString(), ur: k.unstableRate };
      rank = addRecord(this.opts.map.id, rec);
    }
    if (this.opts.test) {
      toast(`Test play: ${(k.accuracy * 100).toFixed(2)}% · ${k.counts.miss} misses`);
      this.quit();
      return;
    }
    const result: PlayResult = {
      song: this.opts.song,
      map: this.opts.map,
      counts: { ...k.counts },
      score: k.score,
      accuracy: k.accuracy,
      maxCombo: k.maxCombo,
      grade: failed ? 'F' : k.grade,
      fc: k.fullCombo && !failed,
      ur: k.unstableRate,
      mean: k.meanError,
      history: [...k.history],
      failed,
      auto,
      rate: set.mods.rate,
      mods,
      duration: this.lastNote,
      windows: this.windows,
      rank,
      early,
      late,
    };
    this.leave();
    this.app.results(result);
  }

  // ------------------------------------------------------------- input ----

  private laneFor(e: KeyboardEvent): number {
    const s = this.set;
    let i = s.keys.indexOf(e.code);
    if (i < 0) i = s.altKeys.indexOf(e.code);
    return i;
  }

  keyDown(e: KeyboardEvent) {
    const lane = this.laneFor(e);
    if (this.phase === 'playing') {
      if (lane >= 0) {
        if (!e.repeat) this.press(lane, e.timeStamp);
        return true;
      }
      if (e.code === 'Escape') this.pause();
      else if (e.code === this.set.retryKey && !e.repeat) this.startRetryHold();
      else if (e.code === 'Space' && !this.hud.skip.hidden) this.skipIntro();
      else if (this.set.offsetKeys && (e.code === 'Minus' || e.code === 'Equal' || e.code === 'NumpadSubtract' || e.code === 'NumpadAdd')) this.nudgeOffset(e.code === 'Minus' || e.code === 'NumpadSubtract' ? -5 : 5);
      return true;
    }
    if (this.phase === 'paused') {
      if (e.code === 'Escape') this.resume();
      else if (e.code === 'KeyR') void this.retry();
      else if (e.code === 'KeyQ') this.quit();
      else if (e.code === 'Minus' || e.code === 'Equal') this.nudgeOffset(e.code === 'Minus' ? -5 : 5);
      return true;
    }
    if (this.phase === 'failed') {
      if (e.code === 'KeyR' || e.code === 'Enter') void this.retry();
      else if (e.code === 'Escape' || e.code === 'KeyQ') this.quit();
      return true;
    }
    if (this.phase === 'loading' && e.code === 'Escape') {
      this.quit();
      return true;
    }
    return false;
  }

  keyUp(e: KeyboardEvent) {
    const lane = this.laneFor(e);
    if (lane >= 0) {
      this.release(lane, e.timeStamp);
      return true;
    }
    if (e.code === this.set.retryKey) this.cancelRetryHold();
    return false;
  }

  midi(midi: number, _velocity: number, down: boolean) {
    const map = this.set.midi;
    if (map === 'off') return;
    let lane = -1;
    const pc = midi % 12;
    if (map === 'cdef') lane = [0, 2, 4, 5].indexOf(pc);
    else {
      const WHITE = [0, 2, 4, 5, 7, 9, 11];
      const wi = WHITE.indexOf(pc);
      if (wi >= 0) lane = (Math.floor(midi / 12) * 7 + wi) % 4;
    }
    if (lane < 0) return;
    if (down) this.press(lane, performance.now());
    else this.release(lane, performance.now());
  }

  private onPointer(e: PointerEvent, down: boolean) {
    if (!this.set.touch || this.phase !== 'playing') return;
    const { x0, laneW } = this.geom();
    const r = this.canvas.getBoundingClientRect();
    const lane = Math.floor((e.clientX - r.left - x0) / laneW);
    if (lane < 0 || lane > 3) return;
    e.preventDefault();
    if (down) this.press(lane, e.timeStamp);
    else this.release(lane, e.timeStamp);
  }

  private songTimeAt(stamp: number): number {
    const ctx = this.app.audio.ctx;
    const ago = Math.max(0, (performance.now() - stamp) / 1000);
    return this.clock!.at(ctx.currentTime - ago) - (this.offsetMs / 1000) * this.clock!.rate;
  }

  private press(lane: number, stamp: number) {
    this.pressed[lane] = true;
    this.keyCounts[lane]++;
    const kc = this.keyEls[lane];
    kc.classList.add('down');
    kc.querySelector('b')!.textContent = String(this.keyCounts[lane]);
    if (!this.s || !this.clock || this.set.mods.auto) return;
    const hit = this.s.press(lane, this.songTimeAt(stamp));
    if (hit) this.onHit(hit);
    else if (this.set.hitsound !== 'none') this.app.audio.hitsound(this.set.hitsound, lane, undefined, 0.5);
  }

  private release(lane: number, stamp: number) {
    this.pressed[lane] = false;
    this.keyEls[lane].classList.remove('down');
    if (!this.s || !this.clock || this.set.mods.auto || this.phase !== 'playing') return;
    const hit = this.s.release(lane, this.songTimeAt(stamp));
    if (hit) this.onHit(hit);
  }

  private startRetryHold() {
    this.retryDown = performance.now();
    this.hud.retry.hidden = false;
  }

  private cancelRetryHold() {
    this.retryDown = 0;
    this.hud.retry.hidden = true;
  }

  private skipIntro() {
    if (!this.clock) return;
    const to = this.firstNote - 2 * this.clock.rate;
    if (to <= this.clock.now()) return;
    this.clock.stop();
    this.clock.start(to, this.app.audio.ctx.currentTime + 0.05);
    this.syncVideo(true);
    this.hud.skip.hidden = true;
    this.app.audio.sfx('whoosh');
  }

  private nudgeOffset(d: number) {
    this.localOffset += d;
    this.offsetMs = this.set.offset + this.localOffset;
    const all = localOffsets();
    all[this.opts.map.id] = this.localOffset;
    try {
      localStorage.setItem(OFFSETS_KEY, JSON.stringify(all));
    } catch {
      /* ignore */
    }
    toast(`Map offset ${this.localOffset >= 0 ? '+' : ''}${this.localOffset} ms`, 'info', 1200);
  }

  // -------------------------------------------------------------- hits ----

  private onHit(e: HitEvent<GNote>) {
    const set = this.set;
    const audio = this.app.audio;
    const ctx = audio.ctx;
    const note = e.state.note;
    if (e.kind === 'head') {
      this.flash[e.lane] = performance.now();
      const when = Math.max(ctx.currentTime, this.clock!.ctxFor(note.time));
      const midis: number[] = [];
      const rate = this.clock!.rate;
      for (const n of note.sources) {
        this.app.deps.engine.noteOn(n.midi, Math.max(1, Math.round(n.velocity * 127)), when);
        midis.push(n.midi);
        if (note.end === null) this.app.deps.engine.noteOff(n.midi, when + Math.max(0.08, n.duration / rate));
      }
      if (note.end !== null && midis.length) this.sounding.set(e.state, midis);
      for (const name of note.samples) {
        const buf = this.samples.get(name);
        if (buf) audio.playBuffer(buf, when, note.volume, audio.keys);
      }
      if (set.hitsound !== 'none') audio.hitsound(set.hitsound, e.lane, ctx.currentTime, 1);
      if (e.judgement === 'perfect' || e.judgement === 'excellent') this.burst(e.lane, note.color, e.judgement === 'perfect' ? 12 : 7);
      this.npsTimes.push(performance.now());
    } else if (e.kind === 'tail') {
      const midis = this.sounding.get(e.state);
      if (midis) {
        for (const m of midis) this.app.deps.engine.noteOff(m, ctx.currentTime);
        this.sounding.delete(e.state);
      }
      if (e.judgement === 'perfect') this.burst(e.lane, note.color, 5);
    }
    if (e.judgement === 'miss') {
      if (set.missSound) audio.sfx(this.lastCombo >= 20 ? 'combobreak' : 'miss');
      if (set.shake) this.shake = 1;
    }
    if (e.kind !== 'tail' || e.judgement === 'miss') {
      const early = e.kind === 'head' && e.judgement !== 'perfect' && set.earlyLate ? (e.delta < 0 ? 'EARLY' : 'LATE') : '';
      if (set.showJudgement) this.popJudge(LABELS[e.judgement], JUDGE_COLORS[e.judgement], early);
    }
    this.lastCombo = this.s!.keeper.combo;
    this.updateHud();
    const k = this.s!.keeper;
    const hm = set.healthMode;
    if (!set.mods.auto && !this.opts.test) {
      if ((hm === 'normal' && k.health <= 0) || (hm === 'suddendeath' && e.judgement === 'miss') || (hm === 'perfect' && e.judgement !== 'perfect')) this.fail();
    }
  }

  private releaseSounding() {
    const now = this.app.audio.ctx.currentTime;
    for (const midis of this.sounding.values()) for (const m of midis) this.app.deps.engine.noteOff(m, now);
    this.sounding.clear();
  }

  private popJudge(text: string, color: string, sub: string) {
    const el = this.judgeEl;
    el.textContent = text;
    el.style.color = color;
    el.classList.remove('pop');
    void el.offsetWidth;
    el.classList.add('pop');
    this.judgeSub.textContent = sub;
    this.judgeSub.className = `pb-judge-sub ${sub ? (sub === 'EARLY' ? 'early' : 'late') : ''}`;
  }

  private updateHud() {
    const s = this.s;
    if (!s) return;
    const k = s.keeper;
    this.hud.score.textContent = k.score.toLocaleString();
    this.hud.acc.textContent = `${(k.accuracy * 100).toFixed(2)}%`;
    this.hud.grade.textContent = k.total ? k.grade : 'SS';
    this.hud.grade.className = `g-${k.total ? k.grade : 'SS'}`;
    for (const j of JUDGEMENTS) this.hud[j].textContent = String(k.counts[j]);
    const c = this.comboEl;
    if (this.set.showCombo && k.combo >= 3) {
      if (c.textContent !== `${k.combo}`) {
        c.textContent = `${k.combo}`;
        c.classList.remove('pop');
        void c.offsetWidth;
        c.classList.add('pop');
      }
      c.hidden = false;
    } else c.hidden = true;
    this.hud.healthFill.style.height = `${k.health * 100}%`;
    this.hud.healthFill.classList.toggle('low', k.health < 0.25);
  }

  private burst(lane: number, color: string, n: number) {
    if (!this.set.particles || !this.set.hitLighting) return;
    const { x0, laneW, recY } = this.geom();
    const cx = x0 + (lane + 0.5) * laneW;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = 80 + Math.random() * 260;
      this.particles.push({ x: cx, y: recY, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 60, life: 1, color, size: 1.5 + Math.random() * 3 });
    }
    if (this.particles.length > 400) this.particles.splice(0, this.particles.length - 400);
  }

  // -------------------------------------------------------------- loop ----

  private resize() {
    const r = this.el.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = r.width;
    this.hgt = r.height;
    this.canvas.width = Math.round(r.width * this.dpr);
    this.canvas.height = Math.round(r.height * this.dpr);
    const { x0, laneW } = this.geom();
    this.el.style.setProperty('--field-l', `${x0}px`);
    this.el.style.setProperty('--field-r', `${x0 + laneW * 4}px`);
    this.el.style.setProperty('--field-w', `${laneW * 4}px`);
  }

  private geom() {
    const s = this.set;
    const scale = Math.max(0.6, this.hgt / 900);
    const laneW = Math.max(36, Math.min(this.w / 5, s.laneWidth * scale));
    const x0 = (this.w - laneW * 4) / 2;
    const hp = (Math.max(0, Math.min(45, s.hitPosition)) / 100) * this.hgt;
    const recY = s.scroll === 'down' ? this.hgt - hp - laneW * 0.45 : hp + laneW * 0.45;
    const pps = (this.hgt * Math.max(3, s.scrollSpeed)) / 18;
    return { laneW, x0, recY, pps, dir: s.scroll === 'down' ? -1 : 1 };
  }

  private loop = () => {
    cancelAnimationFrame(this.raf);
    if (this.phase !== 'playing' && this.phase !== 'failed' && this.phase !== 'done') return;
    this.raf = requestAnimationFrame(this.loop);
    this.tick();
    this.draw();
  };

  private tick() {
    const s = this.s;
    const clock = this.clock;
    if (!s || !clock) return;
    const now = performance.now();
    this.frames.push(now);
    while (this.frames.length && now - this.frames[0] > 1000) this.frames.shift();
    if (this.set.showFps) this.hud.fps.textContent = `${this.frames.length} fps`;
    if (this.phase !== 'playing') return;
    const t = clock.now() - (this.offsetMs / 1000) * clock.rate;
    // Auto-play.
    if (this.set.mods.auto) {
      for (let l = 0; l < 4; l++) {
        let st = s.nextIn(l);
        while (st && t >= st.note.time) {
          const hit = s.press(l, st.note.time);
          if (!hit) break;
          this.autoUntil[l] = (st.note.end ?? st.note.time + 0.06 * clock.rate) as number;
          this.keyCounts[l]++;
          this.keyEls[l].querySelector('b')!.textContent = String(this.keyCounts[l]);
          this.onHit(hit);
          st = s.nextIn(l);
        }
        const down = t < this.autoUntil[l];
        this.pressed[l] = down;
        this.keyEls[l].classList.toggle('down', down);
      }
    }
    for (const e of s.update(t)) this.onHit(e);
    // Progress, time, NPS.
    const dur = Math.max(1, this.lastNote);
    this.hud.progress.style.width = `${Math.max(0, Math.min(100, (t / dur) * 100))}%`;
    this.hud.time.textContent = `${formatTime(Math.max(0, t))} / ${formatTime(this.lastNote)}`;
    while (this.npsTimes.length && now - this.npsTimes[0] > 1000) this.npsTimes.shift();
    if (this.set.showNps) this.hud.nps.textContent = `${this.npsTimes.length} NPS`;
    // Skip intro.
    const canSkip = this.set.skipIntro && this.firstNote - t > 4 * clock.rate && (this.opts.from ?? 0) <= 0;
    this.hud.skip.hidden = !canSkip;
    // Quick retry.
    if (this.retryDown) {
      const f = (now - this.retryDown) / Math.max(50, this.set.retryHold);
      this.hud.retry.style.setProperty('--p', String(Math.min(1, f)));
      if (f >= 1) {
        this.cancelRetryHold();
        void this.retry();
        return;
      }
    }
    this.syncVideo(false);
    if (s.finished && t > this.endTime) {
      if (!this.doneAt) this.doneAt = now;
      else if (now - this.doneAt > 600) this.finish(false);
    }
  }

  private syncVideo(force: boolean) {
    const v = this.video;
    if (v.hidden || !v.src || !this.clock) return;
    const rate = this.clock.rate;
    const expected = this.clock.now() - (this.opts.song.videoOffset || 0);
    if (!this.clock.playing || this.phase !== 'playing') {
      v.pause();
      return;
    }
    if (expected < 0) {
      if (!v.paused) v.pause();
      if (v.currentTime !== 0) v.currentTime = 0;
      return;
    }
    if (Number.isFinite(v.duration) && expected > v.duration) return;
    const drift = v.currentTime - expected;
    if (force || Math.abs(drift) > 0.2) {
      v.currentTime = Math.max(0, expected);
      v.playbackRate = rate;
    } else v.playbackRate = Math.max(0.25, Math.min(4, rate * (1 - drift * 0.6)));
    if (v.paused) void v.play().catch(() => {});
  }

  // -------------------------------------------------------------- draw ----

  private draw() {
    const c = this.g;
    const W = this.w;
    const H = this.hgt;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, W, H);
    const s = this.s;
    const clock = this.clock;
    if (!s || !clock) return;
    const set = this.set;
    const { laneW, x0, recY, pps, dir } = this.geom();
    const rate = clock.rate;
    const t = clock.now() - (this.offsetMs / 1000) * rate;
    const y = (time: number) => recY + dir * ((time - t) / rate) * pps;
    const skin = set.skin;
    const now = performance.now();
    if (this.shake > 0.01) {
      c.translate((Math.random() - 0.5) * 10 * this.shake, (Math.random() - 0.5) * 10 * this.shake);
      this.shake *= 0.86;
    }

    // Lanes.
    c.fillStyle = `rgba(6, 6, 12, ${set.laneOpacity})`;
    c.fillRect(x0, 0, laneW * 4, H);
    for (let i = 0; i <= 4; i++) {
      c.fillStyle = i === 0 || i === 4 ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.05)';
      c.fillRect(x0 + i * laneW - (i === 0 || i === 4 ? 1 : 0.5), 0, i === 0 || i === 4 ? 2 : 1, H);
    }
    for (let i = 0; i < 4; i++) {
      const lit = this.pressed[i] ? 1 : Math.max(0, 1 - (now - this.flash[i]) / 220) * 0.7;
      if (lit <= 0.01 || !set.hitLighting) continue;
      const grad = c.createLinearGradient(0, recY, 0, recY + dir * H * 0.55);
      grad.addColorStop(0, hexA(this.laneColors[i], 0.3 * lit));
      grad.addColorStop(1, hexA(this.laneColors[i], 0));
      c.fillStyle = grad;
      c.fillRect(x0 + i * laneW, dir < 0 ? 0 : recY, laneW, dir < 0 ? recY : H - recY);
    }

    // Bar lines.
    if (set.barLines && this.timing.length) {
      const tp = this.timing[0];
      const spb = 60 / tp.bpm;
      const bar = spb * (tp.meter || 4);
      const visible = (H / pps) * rate;
      let k = Math.ceil((t - 0.2 - tp.t) / bar);
      for (let bt = tp.t + k * bar; bt < t + visible; bt += bar, k++) {
        const yy = y(bt);
        if (yy < -2 || yy > H + 2) continue;
        c.fillStyle = 'rgba(255,255,255,0.13)';
        c.fillRect(x0, yy - 0.5, laneW * 4, 1);
      }
    }

    // Notes.
    const lookAhead = (H / pps) * rate + 0.3;
    const visFrom = this.set.laneCover;
    for (const st of s.states) {
      const n = st.note;
      if (n.time > t + lookAhead) break;
      const end = n.end ?? n.time;
      if (end < t - 0.5 * rate) continue;
      const skipped = (st as NoteState<GNote> & { skipped?: boolean }).skipped;
      if (skipped) continue;
      const doneHead = st.judged !== null && st.judged !== 'miss';
      if (doneHead && !st.holding && (n.end === null || st.tail !== null)) continue;
      const missed = st.judged === 'miss' || st.tail === 'miss';
      const lx = x0 + n.lane * laneW;
      const cx = lx + laneW / 2;
      const headY = st.holding ? recY : y(n.time);
      // Visibility mods: fraction of the way from spawn (0) to the receptor (1).
      const dist = Math.abs(headY - recY) / Math.max(1, dir < 0 ? recY : H - recY);
      let alpha = missed ? 0.28 : 1;
      if (set.mods.hidden && !st.holding) alpha *= Math.max(0, Math.min(1, (dist - 0.18) / 0.22));
      if (set.mods.fadeIn && !st.holding) alpha *= Math.max(0, Math.min(1, (0.62 - dist) / 0.15));
      if (alpha <= 0.01) continue;
      c.globalAlpha = alpha;
      const col = missed ? '#6b6f80' : n.color;
      if (n.end !== null) {
        const tailY = y(n.end);
        const bw = skin === 'bars' ? laneW - 12 : laneW * 0.46;
        const top = Math.min(headY, tailY);
        const hh = Math.abs(tailY - headY);
        const body = c.createLinearGradient(0, headY, 0, tailY);
        body.addColorStop(0, hexA(col, st.holding ? 0.85 : 0.6));
        body.addColorStop(1, hexA(col, st.holding ? 0.5 : 0.3));
        c.fillStyle = body;
        roundRect(c, cx - bw / 2, top, bw, hh, Math.min(10, bw / 2));
        c.fill();
        if (st.holding && set.hitLighting) {
          c.shadowColor = col;
          c.shadowBlur = 18;
          c.fillStyle = hexA('#ffffff', 0.25);
          roundRect(c, cx - bw / 4, top, bw / 2, hh, 4);
          c.fill();
          c.shadowBlur = 0;
        }
        // tail cap
        c.fillStyle = hexA(col, 0.9);
        roundRect(c, cx - bw / 2, tailY - (dir < 0 ? 0 : 6), bw, 6, 3);
        c.fill();
      }
      if (!st.holding) this.drawNote(cx, headY, laneW, n.lane, col, skin);
      c.globalAlpha = 1;
    }
    c.globalAlpha = 1;

    // Receptors.
    for (let i = 0; i < 4; i++) {
      const cx = x0 + (i + 0.5) * laneW;
      const fl = Math.max(0, 1 - (now - this.flash[i]) / 200);
      this.drawReceptor(cx, recY, laneW, i, this.pressed[i], fl, dir);
    }

    // Lane cover (sudden).
    if (visFrom > 0.001) {
      const coverEnd = dir < 0 ? recY * visFrom : recY + (H - recY) * (1 - visFrom);
      const grad = dir < 0 ? c.createLinearGradient(0, 0, 0, coverEnd) : c.createLinearGradient(0, H, 0, coverEnd);
      grad.addColorStop(0, 'rgba(8,8,14,1)');
      grad.addColorStop(0.85, 'rgba(8,8,14,0.96)');
      grad.addColorStop(1, 'rgba(8,8,14,0)');
      c.fillStyle = grad;
      if (dir < 0) c.fillRect(x0, 0, laneW * 4, coverEnd);
      else c.fillRect(x0, coverEnd, laneW * 4, H - coverEnd);
    }

    // Particles.
    const dt = 1 / 60;
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 420 * dt;
      p.life -= dt * 1.8;
      if (p.life <= 0) {
        this.particles.splice(i, 1);
        continue;
      }
      c.globalAlpha = p.life;
      c.fillStyle = p.color;
      c.beginPath();
      c.arc(p.x, p.y, p.size * p.life + 0.5, 0, Math.PI * 2);
      c.fill();
    }
    c.globalAlpha = 1;

    // Hit error bar.
    if (set.showErrorBar) {
      const k = s.keeper;
      const mw = Math.min(280, laneW * 3.2);
      const my = dir < 0 ? Math.min(H - 14, recY + laneW * 0.8) : Math.max(14, recY - laneW * 0.8);
      const mx = x0 + laneW * 2;
      const scale = mw / 2 / this.windows.bad;
      const zones: [number, string][] = [[this.windows.bad, JUDGE_COLORS.bad], [this.windows.good, JUDGE_COLORS.good], [this.windows.excellent, JUDGE_COLORS.excellent], [this.windows.perfect, JUDGE_COLORS.perfect]];
      for (const [wdw, col] of zones) {
        c.fillStyle = hexA(col, 0.32);
        c.fillRect(mx - wdw * scale, my - 3, wdw * scale * 2, 6);
      }
      c.fillStyle = '#fff';
      c.fillRect(mx - 1, my - 8, 2, 16);
      for (const e of k.recentErrors) {
        const age = t - e.at;
        if (age > 3 * rate) continue;
        c.globalAlpha = Math.max(0.12, 1 - age / (3 * rate));
        c.fillStyle = '#ffffff';
        c.fillRect(mx + Math.max(-1, Math.min(1, e.delta / this.windows.bad)) * (mw / 2) - 1, my - 7, 2, 14);
      }
      c.globalAlpha = 1;
    }
  }

  private drawNote(cx: number, cy: number, laneW: number, lane: number, col: string, skin: BeatsSettings['skin']) {
    const c = this.g;
    if (skin === 'arrows') drawArrow(c, cx, cy, laneW * 0.4, ARROW_ROT[lane], col, 'rgba(255,255,255,0.92)', 2.5, true);
    else if (skin === 'bars') {
      const hh = Math.max(10, laneW * 0.26);
      const grad = c.createLinearGradient(0, cy - hh / 2, 0, cy + hh / 2);
      grad.addColorStop(0, mixHex(col, '#ffffff', 0.35));
      grad.addColorStop(1, col);
      c.fillStyle = grad;
      roundRect(c, cx - laneW / 2 + 4, cy - hh / 2, laneW - 8, hh, 6);
      c.fill();
      c.fillStyle = 'rgba(255,255,255,0.45)';
      roundRect(c, cx - laneW / 2 + 8, cy - hh / 2 + 2, laneW - 16, 3, 2);
      c.fill();
    } else if (skin === 'circles') {
      const r = laneW * 0.36;
      const grad = c.createRadialGradient(cx - r * 0.3, cy - r * 0.3, r * 0.1, cx, cy, r);
      grad.addColorStop(0, mixHex(col, '#ffffff', 0.55));
      grad.addColorStop(1, col);
      c.fillStyle = grad;
      c.beginPath();
      c.arc(cx, cy, r, 0, Math.PI * 2);
      c.fill();
      c.lineWidth = 3;
      c.strokeStyle = 'rgba(255,255,255,0.85)';
      c.stroke();
    } else {
      const r = laneW * 0.34;
      c.save();
      c.translate(cx, cy);
      c.rotate(Math.PI / 4);
      const grad = c.createLinearGradient(-r, -r, r, r);
      grad.addColorStop(0, mixHex(col, '#ffffff', 0.45));
      grad.addColorStop(1, col);
      c.fillStyle = grad;
      roundRect(c, -r * 0.72, -r * 0.72, r * 1.44, r * 1.44, 5);
      c.fill();
      c.lineWidth = 2.5;
      c.strokeStyle = 'rgba(255,255,255,0.85)';
      c.stroke();
      c.restore();
    }
  }

  private drawReceptor(cx: number, cy: number, laneW: number, lane: number, down: boolean, flash: number, dir: number) {
    const c = this.g;
    const col = this.laneColors[lane];
    const skin = this.set.skin;
    if (flash > 0 && this.set.hitLighting) {
      c.shadowColor = col;
      c.shadowBlur = 28 * flash;
    }
    if (skin === 'arrows') {
      const size = laneW * 0.4 * (down ? 0.9 : 1);
      drawArrow(c, cx, cy, size, ARROW_ROT[lane], flash > 0 ? mixHex('#3a3e4d', col, Math.min(1, flash + 0.2)) : down ? mixHex('#2b2f3b', col, 0.45) : '#262a36', down ? mixHex('#aab0c4', col, 0.5) : '#9aa0b4', 3, false);
    } else if (skin === 'bars') {
      const bh = laneW * 0.62;
      const top = dir < 0 ? cy + laneW * 0.14 : cy - laneW * 0.14 - bh;
      c.fillStyle = down ? hexA(col, 0.85) : 'rgba(255,255,255,0.07)';
      roundRect(c, cx - laneW / 2 + 4, top, laneW - 8, bh, 8);
      c.fill();
      c.fillStyle = down ? '#0b0d12' : 'rgba(230,232,245,0.8)';
      c.font = `700 ${Math.round(laneW * 0.24)}px 'Outfit Variable', system-ui, sans-serif`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(keyName(this.set.keys[lane]), cx, top + bh / 2);
      c.textBaseline = 'alphabetic';
      if (lane === 0) {
        c.fillStyle = 'rgba(255,255,255,0.9)';
        c.fillRect(cx - laneW / 2, cy - 2, laneW * 4, 4);
      }
    } else if (skin === 'circles') {
      c.lineWidth = down ? 5 : 3;
      c.strokeStyle = down || flash > 0 ? col : 'rgba(220,224,240,0.55)';
      c.beginPath();
      c.arc(cx, cy, laneW * 0.36, 0, Math.PI * 2);
      c.stroke();
      if (down) {
        c.fillStyle = hexA(col, 0.25);
        c.fill();
      }
    } else {
      c.save();
      c.translate(cx, cy);
      c.rotate(Math.PI / 4);
      const r = laneW * 0.34;
      c.lineWidth = down ? 4.5 : 2.5;
      c.strokeStyle = down || flash > 0 ? col : 'rgba(220,224,240,0.55)';
      roundRect(c, -r * 0.72, -r * 0.72, r * 1.44, r * 1.44, 5);
      c.stroke();
      if (down) {
        c.fillStyle = hexA(col, 0.25);
        c.fill();
      }
      c.restore();
    }
    c.shadowBlur = 0;
  }
}

// ------------------------------------------------------------ drawing ----

export function drawArrow(c: CanvasRenderingContext2D, cx: number, cy: number, size: number, rot: number, fill: string, stroke: string, lw: number, shine: boolean) {
  c.save();
  c.translate(cx, cy);
  c.rotate(rot);
  c.beginPath();
  const pts: [number, number][] = [[0, -1], [0.95, -0.02], [0.42, -0.02], [0.42, 0.92], [-0.42, 0.92], [-0.42, -0.02], [-0.95, -0.02]];
  pts.forEach(([px, py], i) => (i ? c.lineTo(px * size, py * size) : c.moveTo(px * size, py * size)));
  c.closePath();
  c.lineJoin = 'round';
  if (shine) {
    const g = c.createLinearGradient(0, -size, 0, size);
    g.addColorStop(0, mixHex(fill, '#ffffff', 0.35));
    g.addColorStop(1, fill);
    c.fillStyle = g;
  } else c.fillStyle = fill;
  c.fill();
  c.lineWidth = lw;
  c.strokeStyle = stroke;
  c.stroke();
  c.restore();
}

export function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  c.beginPath();
  c.moveTo(x + rr, y);
  c.arcTo(x + w, y, x + w, y + h, rr);
  c.arcTo(x + w, y + h, x, y + h, rr);
  c.arcTo(x, y + h, x, y, rr);
  c.arcTo(x, y, x + w, y, rr);
  c.closePath();
}

function parseHex(c: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(c.trim());
  if (!m) return [200, 200, 210];
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

export function hexA(c: string, a: number): string {
  const [r, g, b] = parseHex(c);
  return `rgba(${r},${g},${b},${a})`;
}

export function mixHex(a: string, b: string, t: number): string {
  const pa = parseHex(a);
  const pb = parseHex(b);
  const ch = (i: number) => Math.round(pa[i] * (1 - t) + pb[i] * t);
  return `#${[ch(0), ch(1), ch(2)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

export { icon };
