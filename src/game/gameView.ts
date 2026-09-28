// 4K rhythm game: song select, countdown, the playfield (FNF-style arrows or
// osu!mania-style bars), HUD, pause menu and results. The accompaniment is
// played by the autoplayer; the piano notes behind each chart note only sound
// when you hit it.

import type { PianoEngine } from '../audio/engine';
import type { GameSettings } from '../core/settings';
import { keyChar } from '../input/computerKeyboard';
import type { AutoPlayer } from '../player/autoplayer';
import type { Score } from '../score/model';
import { clear, h, icon } from '../ui/dom';
import { generateChart, type Chart, type Difficulty } from './chart';
import { JUDGEMENTS, LABELS, WINDOWS, type Judgement } from './judge';
import { GameSession, type HitEvent, type NoteState } from './session';

type Phase = 'select' | 'countdown' | 'playing' | 'paused' | 'results';

const LANE_COLORS = ['#c24b99', '#00c3ff', '#12fa05', '#f9393f'];
const BAR_COLORS = ['#eef1f8', '#4fc3f7', '#4fc3f7', '#eef1f8'];
const ARROW_ROTATION = [-Math.PI / 2, Math.PI, 0, Math.PI / 2]; // ← ↓ ↑ →
const JUDGE_COLORS: Record<Judgement, string> = { perfect: '#7cf8ff', excellent: '#8dff7a', good: '#ffe066', bad: '#ff9f43', miss: '#ff4d6d' };
const DIFFICULTIES: { id: Difficulty; label: string }[] = [
  { id: 'easy', label: 'Easy' },
  { id: 'normal', label: 'Normal' },
  { id: 'hard', label: 'Hard' },
  { id: 'expert', label: 'Expert' },
];
const KEY_PRESETS: { label: string; keys: string[] }[] = [
  { label: 'A S D F', keys: ['KeyA', 'KeyS', 'KeyD', 'KeyF'] },
  { label: 'D F J K', keys: ['KeyD', 'KeyF', 'KeyJ', 'KeyK'] },
  { label: '← ↓ ↑ →', keys: ['ArrowLeft', 'ArrowDown', 'ArrowUp', 'ArrowRight'] },
  { label: 'Z X , .', keys: ['KeyZ', 'KeyX', 'Comma', 'Period'] },
];
const LEAD_IN = 3; // seconds of countdown before the song starts
const BEST_KEY = 'pianoman.best.v1';

const keyLabel = (code: string) =>
  ({ ArrowLeft: '←', ArrowDown: '↓', ArrowUp: '↑', ArrowRight: '→', Space: '␣' } as Record<string, string>)[code] || keyChar(code);

interface Best {
  score: number;
  accuracy: number;
  grade: string;
  fc: boolean;
}

export interface GameViewHandlers {
  optionsChanged(o: GameSettings): void;
  openLibrary(): void;
  openSearch(): void;
}

export class GameView {
  readonly el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private overlay: HTMLElement;
  private hud: HTMLElement;
  private hudEls: Record<string, HTMLElement> = {};
  private judgeEl: HTMLElement;
  private comboEl: HTMLElement;
  private score: Score | null = null;
  private charts = new Map<string, Chart>();
  private chart: Chart | null = null;
  private session: GameSession | null = null;
  private phase: Phase = 'select';
  private pressed = [false, false, false, false];
  private flash = [0, 0, 0, 0];
  private sounding = new Map<NoteState, number[]>();
  private rebinding = -1;
  private raf = 0;
  private visible = false;
  private w = 0;
  private hgt = 0;
  private dpr = 1;
  private lastCount = -1;
  private failed = false;

  constructor(
    private engine: PianoEngine,
    private player: AutoPlayer,
    public opts: GameSettings,
    private handlers: GameViewHandlers,
  ) {
    if (!Array.isArray(opts.keys) || opts.keys.length !== 4 || !opts.keys.every((k) => typeof k === 'string')) opts.keys = [...KEY_PRESETS[0].keys];
    this.canvas = h('canvas', { class: 'game-canvas' });
    this.g = this.canvas.getContext('2d')!;
    this.judgeEl = h('div', { class: 'game-judgement' });
    this.comboEl = h('div', { class: 'game-combo' });
    const stat = (key: string, label: string) => {
      const v = h('b', null, '0');
      this.hudEls[key] = v;
      return h('div', { class: `hud-stat hud-${key}` }, h('span', null, label), v);
    };
    this.hud = h('div', { class: 'game-hud' },
      h('div', { class: 'hud-top' }, (this.hudEls.title = h('span', { class: 'hud-title' })), h('div', { class: 'hud-progress' }, (this.hudEls.progress = h('div', { class: 'hud-progress-fill' })))),
      h('div', { class: 'hud-left' }, ...JUDGEMENTS.map((j) => stat(j, LABELS[j]))),
      h('div', { class: 'hud-right' }, stat('score', 'Score'), stat('accuracy', 'Accuracy'), stat('combo', 'Combo'), stat('misses', 'Misses')),
      h('div', { class: 'hud-health' }, (this.hudEls.health = h('div', { class: 'hud-health-fill' }))),
      this.judgeEl,
      this.comboEl,
    );
    this.overlay = h('div', { class: 'game-overlay' });
    this.el = h('div', { class: 'game' }, this.canvas, this.hud, this.overlay);
    this.el.classList.toggle('scroll-down', opts.scroll === 'down');
    this.el.addEventListener('pointerdown', (e) => this.onPointer(e, true));
    this.el.addEventListener('pointerup', (e) => this.onPointer(e, false));
    this.el.addEventListener('pointercancel', (e) => this.onPointer(e, false));
    new ResizeObserver(() => this.resize()).observe(this.el);
    this.player.on('end', () => {
      if (this.phase === 'playing') this.finish();
    });
    this.renderSelect();
  }

  // ---------------------------------------------------------- lifecycle ----

  setVisible(v: boolean) {
    this.visible = v;
    if (v) {
      if (!this.raf) this.raf = requestAnimationFrame(() => this.loop());
    } else {
      if (this.phase === 'playing' || this.phase === 'countdown') this.quit();
    }
  }

  load(score: Score | null) {
    if (this.phase === 'playing' || this.phase === 'countdown' || this.phase === 'paused') this.stopPlayback();
    this.score = score;
    this.charts.clear();
    this.chart = null;
    this.session = null;
    this.phase = 'select';
    this.renderSelect();
  }

  private chartFor(d: Difficulty): Chart | null {
    if (!this.score) return null;
    const key = `${d}|${this.opts.source}|${this.opts.holds}`;
    let c = this.charts.get(key);
    if (!c) {
      c = generateChart(this.score, { difficulty: d, source: this.opts.source, holds: this.opts.holds });
      this.charts.set(key, c);
    }
    return c;
  }

  private setOpt<K extends keyof GameSettings>(key: K, value: GameSettings[K]) {
    this.opts[key] = value;
    this.el.classList.toggle('scroll-down', this.opts.scroll === 'down');
    this.handlers.optionsChanged(this.opts);
  }

  start() {
    const chart = this.chartFor(this.opts.difficulty);
    if (!chart || !chart.notes.length || !this.score) return;
    this.chart = chart;
    this.session = new GameSession(chart, this.opts.speed);
    this.failed = false;
    this.sounding.clear();
    this.lastCount = -1;
    const p = this.player;
    p.stop();
    p.setGate(null);
    p.waitMode = false;
    p.loop = null;
    p.loopWhole = false;
    p.metronomeOn = false;
    p.hands = { L: true, R: true };
    p.noteFilter = (n) => !chart.bound.has(n);
    p.speed = this.opts.speed;
    p.rebuild();
    const t0 = this.engine.ctx.currentTime + LEAD_IN;
    for (let i = 0; i < 3; i++) this.beep(t0 - 3 + i + 0.02, i === 2 ? 1320 : 880);
    p.startFrom(0, t0);
    this.phase = 'countdown';
    this.hudEls.title.textContent = `${this.score.title} · ${DIFFICULTIES.find((d) => d.id === this.opts.difficulty)!.label}`;
    this.judgeEl.textContent = '';
    this.comboEl.textContent = '';
    clear(this.overlay);
    this.overlay.hidden = true;
    this.el.classList.add('in-play');
    this.updateHud();
  }

  private stopPlayback() {
    this.player.stop();
    this.releaseSounding();
    this.player.noteFilter = null;
    this.player.rebuild();
    this.el.classList.remove('in-play');
  }

  pause() {
    if (this.phase !== 'playing' && this.phase !== 'countdown') return;
    this.player.pause();
    this.releaseSounding();
    this.phase = 'paused';
    this.showOverlay(
      h('div', { class: 'game-card small' },
        h('h2', null, 'Paused'),
        h('div', { class: 'game-actions' },
          h('button', { class: 'btn primary', onclick: () => this.resume() }, icon('play', 16), 'Resume (Esc)'),
          h('button', { class: 'btn', onclick: () => this.start() }, icon('refresh', 16), 'Restart (R)'),
          h('button', { class: 'btn', onclick: () => this.quit() }, icon('x', 16), 'Quit (Q)'),
        ),
      ),
    );
  }

  resume() {
    if (this.phase !== 'paused') return;
    // Rewind a little and count back in so you can find the beat again.
    const at = this.clock();
    const back = Math.max(0, at - 1.5 * this.opts.speed);
    this.player.startFrom(back, this.engine.ctx.currentTime + 1);
    this.beep(this.engine.ctx.currentTime + 0.02, 880);
    this.phase = 'countdown';
    this.overlay.hidden = true;
  }

  quit() {
    this.stopPlayback();
    this.phase = 'select';
    this.renderSelect();
  }

  private finish() {
    const s = this.session;
    if (!s || this.phase === 'results') return;
    s.update(Number.MAX_SAFE_INTEGER); // anything left unplayed counts as missed
    this.stopPlayback();
    this.phase = 'results';
    const k = s.keeper;
    const key = this.bestKey();
    const bests = this.readBests();
    const prev = bests[key];
    const isBest = !this.failed && (!prev || k.score > prev.score);
    if (isBest) {
      bests[key] = { score: k.score, accuracy: k.accuracy, grade: k.grade, fc: k.fullCombo };
      try {
        localStorage.setItem(BEST_KEY, JSON.stringify(bests));
      } catch {
        /* ignore */
      }
    }
    this.showOverlay(
      h('div', { class: 'game-card results' },
        h('div', { class: `grade grade-${this.failed ? 'F' : k.grade}` }, this.failed ? 'F' : k.grade),
        h('h2', null, this.failed ? 'Failed' : k.fullCombo ? 'Full combo!' : 'Song complete'),
        isBest ? h('p', { class: 'new-best' }, '★ New best') : prev ? h('p', { class: 'muted' }, `Best: ${prev.score.toLocaleString()} · ${(prev.accuracy * 100).toFixed(2)}%`) : '',
        h('div', { class: 'result-stats' },
          h('div', null, h('span', null, 'Score'), h('b', null, k.score.toLocaleString())),
          h('div', null, h('span', null, 'Accuracy'), h('b', null, `${(k.accuracy * 100).toFixed(2)}%`)),
          h('div', null, h('span', null, 'Max combo'), h('b', null, String(k.maxCombo))),
        ),
        h('div', { class: 'result-counts' }, ...JUDGEMENTS.map((j) => h('div', { style: { color: JUDGE_COLORS[j] } }, h('span', null, LABELS[j]), h('b', null, String(k.counts[j]))))),
        h('div', { class: 'game-actions' },
          h('button', { class: 'btn primary', onclick: () => this.start() }, icon('refresh', 16), 'Retry (Enter)'),
          h('button', { class: 'btn', onclick: () => this.quit() }, icon('back', 16), 'Song select (Esc)'),
        ),
      ),
    );
  }

  private bestKey() {
    return `${this.score?.title}|${this.score?.notes.length}|${this.opts.difficulty}|${this.opts.source}`;
  }

  private readBests(): Record<string, Best> {
    try {
      return JSON.parse(localStorage.getItem(BEST_KEY) || '{}');
    } catch {
      return {};
    }
  }

  // ------------------------------------------------------------- select ----

  private showOverlay(content: HTMLElement) {
    clear(this.overlay).append(content);
    this.overlay.hidden = false;
  }

  private renderSelect() {
    const o = this.opts;
    if (!this.score) {
      this.showOverlay(
        h('div', { class: 'game-card' },
          h('div', { class: 'game-logo' }, '4K'),
          h('h2', null, 'Rhythm mode'),
          h('p', { class: 'muted' }, 'Pick any song – PianoMan turns it into a 4-key map. Hit the notes to play the piano part; the accompaniment plays along.'),
          h('div', { class: 'game-actions' },
            h('button', { class: 'btn primary', onclick: () => this.handlers.openLibrary() }, icon('library', 16), 'Choose from library'),
            h('button', { class: 'btn', onclick: () => this.handlers.openSearch() }, icon('search', 16), 'Search songs'),
          ),
        ),
      );
      return;
    }
    const bests = this.readBests();
    const diffButtons = DIFFICULTIES.map((d) => {
      const c = this.chartFor(d.id)!;
      const best = bests[`${this.score!.title}|${this.score!.notes.length}|${d.id}|${o.source}`];
      return h('button', {
        class: `diff-btn diff-${d.id} ${o.difficulty === d.id ? 'active' : ''}`,
        onclick: () => {
          this.setOpt('difficulty', d.id);
          this.renderSelect();
        },
      },
        h('b', null, d.label),
        h('span', null, `${c.stats.notes} notes · ${c.stats.nps.toFixed(1)}/s`),
        best ? h('span', { class: 'best' }, `${best.grade} · ${(best.accuracy * 100).toFixed(1)}%`) : h('span', { class: 'best muted' }, 'not played'),
      );
    });
    const seg = <K extends keyof GameSettings>(key: K, options: { value: GameSettings[K]; label: string }[], after?: () => void) =>
      h('div', { class: 'segmented small' },
        ...options.map((opt) =>
          h('button', {
            class: `seg ${o[key] === opt.value ? 'active' : ''}`,
            onclick: () => {
              this.setOpt(key, opt.value);
              after?.();
              this.renderSelect();
            },
          }, opt.label),
        ),
      );
    const range = (key: 'scrollSpeed' | 'offset', min: number, max: number, step: number, fmt: (v: number) => string) => {
      const out = h('output', null, fmt(o[key]));
      const input = h('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(o[key]) }) as HTMLInputElement;
      input.addEventListener('input', () => {
        this.setOpt(key, parseFloat(input.value));
        out.textContent = fmt(o[key]);
      });
      return h('label', { class: 'game-range' }, input, out);
    };
    const keyButtons = o.keys.map((code, i) =>
      h('button', {
        class: `key-bind ${this.rebinding === i ? 'listening' : ''}`,
        style: { borderColor: LANE_COLORS[i] },
        title: 'Click, then press a key',
        onclick: () => {
          this.rebinding = i;
          this.renderSelect();
        },
      }, this.rebinding === i ? '…' : keyLabel(code)),
    );
    const c = this.chartFor(o.difficulty)!;
    const row = (label: string, ...content: (Node | string)[]) => h('div', { class: 'game-row' }, h('span', { class: 'game-label' }, label), ...content);
    this.showOverlay(
      h('div', { class: 'game-card select' },
        h('div', { class: 'select-head' },
          h('div', { class: 'game-logo' }, '4K'),
          h('div', null, h('h2', null, this.score.title), h('p', { class: 'muted' }, `${this.score.composer || 'Unknown composer'} · ${Math.floor(this.score.duration / 60)}:${String(Math.floor(this.score.duration % 60)).padStart(2, '0')}`)),
        ),
        h('div', { class: 'diff-row' }, ...diffButtons),
        row('Map from', seg('source', [{ value: 'both', label: 'Both hands' }, { value: 'melody', label: 'Melody (right hand)' }])),
        row('Notes', seg('skin', [{ value: 'arrows', label: 'Arrows (FNF)' }, { value: 'bars', label: 'Bars (osu!mania)' }], () => this.setOpt('scroll', this.opts.skin === 'arrows' ? 'up' : 'down'))),
        row('Scroll', seg('scroll', [{ value: 'up', label: 'Upscroll' }, { value: 'down', label: 'Downscroll' }]), range('scrollSpeed', 0.8, 4, 0.1, (v) => `${v.toFixed(1)}×`)),
        row('Song speed', seg('speed', [0.5, 0.75, 1, 1.25, 1.5].map((v) => ({ value: v, label: `${v}×` })))),
        row('Keys', ...keyButtons, h('select', {
          class: 'key-presets',
          onchange: (e: Event) => {
            const p = KEY_PRESETS[parseInt((e.target as HTMLSelectElement).value, 10)];
            if (p) this.setOpt('keys', [...p.keys]);
            this.renderSelect();
          },
        }, h('option', { value: '' }, 'Presets…'), ...KEY_PRESETS.map((p, i) => h('option', { value: String(i) }, p.label)))),
        row('Offset', range('offset', -150, 150, 1, (v) => `${v > 0 ? '+' : ''}${v} ms`), h('span', { class: 'muted small' }, 'raise if you tend to hit late')),
        row('Options',
          this.check('Hold notes', o.holds, (v) => {
            this.setOpt('holds', v);
            this.charts.clear();
            this.renderSelect();
          }),
          this.check('Miss sound', o.missSound, (v) => this.setOpt('missSound', v)),
          this.check('Fail at zero health', o.fail, (v) => this.setOpt('fail', v)),
        ),
        h('div', { class: 'chart-info muted' }, `${c.stats.notes} notes · ${c.stats.holds} holds · ${c.stats.chords} chord notes · peak ${c.stats.peakNps}/s`),
        h('div', { class: 'game-actions' },
          h('button', { class: 'btn primary big', disabled: !c.notes.length, onclick: () => this.start() }, icon('play', 18), 'Play (Enter)'),
        ),
      ),
    );
  }

  private check(label: string, value: boolean, onChange: (v: boolean) => void) {
    const input = h('input', { type: 'checkbox', checked: value }) as HTMLInputElement;
    input.addEventListener('change', () => onChange(input.checked));
    return h('label', { class: 'game-check' }, input, label);
  }

  // -------------------------------------------------------------- input ----

  /** Keyboard input while this mode is active. Returns true if handled. */
  keyDown(e: KeyboardEvent): boolean {
    if (this.rebinding >= 0) {
      e.preventDefault();
      if (e.code !== 'Escape') {
        const keys = [...this.opts.keys];
        const dup = keys.indexOf(e.code);
        if (dup >= 0) keys[dup] = keys[this.rebinding];
        keys[this.rebinding] = e.code;
        this.setOpt('keys', keys);
      }
      this.rebinding = -1;
      this.renderSelect();
      return true;
    }
    const lane = this.opts.keys.indexOf(e.code);
    if (this.phase === 'playing' || this.phase === 'countdown') {
      if (e.code === 'Escape') {
        this.pause();
        return true;
      }
      if (lane >= 0) {
        e.preventDefault();
        if (!e.repeat) this.press(lane, e.timeStamp);
        return true;
      }
      return true; // swallow other keys while playing
    }
    if (this.phase === 'paused') {
      if (e.code === 'Escape') this.resume();
      else if (e.code === 'KeyR') this.start();
      else if (e.code === 'KeyQ') this.quit();
      return true;
    }
    if (this.phase === 'results') {
      if (e.code === 'Enter' || e.code === 'Space') this.start();
      else if (e.code === 'Escape') this.quit();
      return true;
    }
    if (this.phase === 'select' && (e.code === 'Enter' || e.code === 'Space') && this.score) {
      e.preventDefault();
      this.start();
      return true;
    }
    return false;
  }

  keyUp(e: KeyboardEvent): boolean {
    const lane = this.opts.keys.indexOf(e.code);
    if (lane < 0) return false;
    this.release(lane, e.timeStamp);
    return true;
  }

  /** MIDI input: any four neighbouring white keys map onto the four lanes. */
  midiNote(midi: number, down: boolean) {
    const WHITE = [0, 2, 4, 5, 7, 9, 11];
    const pc = midi % 12;
    const wi = WHITE.indexOf(pc);
    if (wi < 0) return;
    const lane = (Math.floor(midi / 12) * 7 + wi) % 4;
    if (down) this.press(lane, performance.now());
    else this.release(lane, performance.now());
  }

  private onPointer(e: PointerEvent, down: boolean) {
    if (this.phase !== 'playing' && this.phase !== 'countdown') return;
    const { x, laneW } = this.fieldGeometry();
    const r = this.canvas.getBoundingClientRect();
    const lane = Math.floor((e.clientX - r.left - x) / laneW);
    if (lane < 0 || lane > 3) return;
    e.preventDefault();
    if (down) this.press(lane, e.timeStamp);
    else this.release(lane, e.timeStamp);
  }

  /**
   * The game's song clock. It runs on the audio scheduling clock rather than
   * the latency-compensated one: a note reaches the hit line at the moment its
   * accompaniment is scheduled, so a key hit on the line sounds together with
   * the accompaniment instead of one output latency behind it.
   */
  private clock(ctxNow = this.engine.ctx.currentTime) {
    return this.player.songTime(ctxNow, false);
  }

  /** Song time at the moment an input event happened. */
  private eventTime(stamp: number) {
    const ago = Math.max(0, (performance.now() - stamp) / 1000);
    return this.clock(this.engine.ctx.currentTime - ago) - (this.opts.offset / 1000) * this.opts.speed;
  }

  private press(lane: number, stamp: number) {
    this.pressed[lane] = true;
    const s = this.session;
    if (!s || (this.phase !== 'playing' && this.phase !== 'countdown')) return;
    const hit = s.press(lane, this.eventTime(stamp));
    if (hit) this.onHit(hit);
  }

  private release(lane: number, stamp: number) {
    this.pressed[lane] = false;
    const s = this.session;
    if (!s || (this.phase !== 'playing' && this.phase !== 'countdown')) return;
    const hit = s.release(lane, this.eventTime(stamp));
    if (hit) this.onHit(hit);
  }

  private onHit(e: HitEvent) {
    const now = this.engine.ctx.currentTime;
    if (e.kind === 'head') {
      this.flash[e.lane] = performance.now();
      // Early hits sound exactly on the beat; late hits sound immediately.
      const when = Math.max(now, this.player.ctxTimeFor(e.state.note.time));
      const midis: number[] = [];
      for (const n of e.state.note.sources) {
        this.engine.noteOn(n.midi, Math.max(1, Math.round(n.velocity * 127)), when);
        midis.push(n.midi);
        if (e.state.note.end === null) this.engine.noteOff(n.midi, when + Math.max(0.08, n.duration / this.opts.speed));
      }
      if (e.state.note.end !== null) this.sounding.set(e.state, midis);
    } else if (e.kind === 'tail') {
      const midis = this.sounding.get(e.state);
      if (midis) {
        for (const m of midis) this.engine.noteOff(m, now);
        this.sounding.delete(e.state);
      }
    }
    if (e.judgement === 'miss' && this.opts.missSound) this.missSound();
    this.showJudgement(e.judgement);
    this.updateHud();
    if (this.opts.fail && this.session && this.session.keeper.health <= 0) {
      this.failed = true;
      this.finish();
    }
  }

  private releaseSounding() {
    const now = this.engine.ctx.currentTime;
    for (const midis of this.sounding.values()) for (const m of midis) this.engine.noteOff(m, now);
    this.sounding.clear();
  }

  private showJudgement(j: Judgement) {
    const el = this.judgeEl;
    el.textContent = LABELS[j];
    el.style.color = JUDGE_COLORS[j];
    el.classList.remove('pop');
    void el.offsetWidth;
    el.classList.add('pop');
    const combo = this.session?.keeper.combo || 0;
    this.comboEl.textContent = combo >= 5 ? String(combo) : '';
    this.comboEl.classList.remove('pop');
    void this.comboEl.offsetWidth;
    if (combo >= 5) this.comboEl.classList.add('pop');
  }

  private updateHud() {
    const k = this.session?.keeper;
    if (!k) return;
    for (const j of JUDGEMENTS) this.hudEls[j].textContent = String(k.counts[j]);
    this.hudEls.score.textContent = k.score.toLocaleString();
    this.hudEls.accuracy.textContent = `${(k.accuracy * 100).toFixed(2)}%`;
    this.hudEls.combo.textContent = `${k.combo}×`;
    this.hudEls.misses.textContent = String(k.counts.miss);
    this.hudEls.health.style.width = `${k.health * 100}%`;
    this.hudEls.health.classList.toggle('low', k.health < 0.25);
  }

  private beep(when: number, freq: number) {
    const ctx = this.engine.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = freq;
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(0.18, when + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.12);
    o.connect(g).connect(this.engine.clickBus);
    o.start(when);
    o.stop(when + 0.15);
    o.onended = () => g.disconnect();
  }

  private missSound() {
    const ctx = this.engine.ctx;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'triangle';
    o.frequency.setValueAtTime(180, t);
    o.frequency.exponentialRampToValueAtTime(70, t + 0.12);
    g.gain.setValueAtTime(0.12, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    o.connect(g).connect(this.engine.clickBus);
    o.start(t);
    o.stop(t + 0.18);
    o.onended = () => g.disconnect();
  }

  // ------------------------------------------------------------- render ----

  private resize() {
    const r = this.el.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.w = r.width;
    this.hgt = r.height;
    this.canvas.width = Math.max(1, Math.round(r.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * this.dpr));
  }

  private fieldGeometry() {
    const laneW = this.opts.skin === 'arrows' ? Math.max(58, Math.min(112, this.hgt * 0.12, this.w / 7)) : Math.max(56, Math.min(100, this.w / 9));
    const x = (this.w - laneW * 4) / 2;
    const recY = this.opts.scroll === 'up' ? Math.max(70, laneW * 0.9) : this.hgt - Math.max(90, laneW * 1.1);
    return { laneW, x, recY };
  }

  private loop() {
    this.raf = 0;
    if (!this.visible) return;
    try {
      this.tick();
      this.draw();
    } catch (err) {
      console.error(err);
    }
    this.raf = requestAnimationFrame(() => this.loop());
  }

  private tick() {
    const s = this.session;
    if (!s) return;
    if (this.phase === 'countdown') {
      const t = this.clock();
      const n = Math.ceil(-t / this.opts.speed);
      if (t >= 0) {
        this.phase = 'playing';
        if (/^\d$/.test(this.judgeEl.textContent ?? '')) this.judgeEl.textContent = '';
      } else if (n !== this.lastCount && n <= 3) {
        this.lastCount = n;
        this.judgeEl.textContent = n > 0 ? String(n) : '';
        this.judgeEl.style.color = '#fff';
        this.judgeEl.classList.remove('pop');
        void this.judgeEl.offsetWidth;
        this.judgeEl.classList.add('pop');
      }
    }
    if (this.phase === 'playing') {
      const t = this.clock() - (this.opts.offset / 1000) * this.opts.speed;
      for (const e of s.update(t)) this.onHit(e);
      this.hudEls.progress.style.width = `${Math.min(100, (Math.max(0, t) / Math.max(1, this.chart!.duration)) * 100)}%`;
      if (s.finished && t > this.chart!.duration + 0.5) this.finish();
    }
  }

  private draw() {
    const c = this.g;
    const W = this.w;
    const H = this.hgt;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, W, H);
    if (!W || !H) return;
    const { laneW, x, recY } = this.fieldGeometry();
    const arrows = this.opts.skin === 'arrows';
    const dir = this.opts.scroll === 'up' ? 1 : -1;
    const pxPerSec = H * 0.55 * this.opts.scrollSpeed;
    const t = this.session ? this.clock() - (this.opts.offset / 1000) * this.opts.speed : -LEAD_IN;
    const y = (time: number) => recY + dir * ((time - t) / this.opts.speed) * pxPerSec;
    const nowMs = performance.now();

    // Lanes.
    c.fillStyle = arrows ? 'rgba(0,0,0,0.28)' : 'rgba(6,7,10,0.86)';
    c.fillRect(x, 0, laneW * 4, H);
    if (!arrows) {
      for (let i = 0; i <= 4; i++) {
        c.fillStyle = i === 0 || i === 4 ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.06)';
        c.fillRect(x + i * laneW - 1, 0, 2, H);
      }
      for (let i = 0; i < 4; i++) {
        if (!this.pressed[i]) continue;
        const grad = c.createLinearGradient(0, recY, 0, recY - dir * H * 0.5);
        grad.addColorStop(0, 'rgba(255,255,255,0.16)');
        grad.addColorStop(1, 'rgba(255,255,255,0)');
        c.fillStyle = grad;
        c.fillRect(x + i * laneW, dir > 0 ? recY : 0, laneW, dir > 0 ? H - recY : recY);
      }
    }

    // Receptors / hit line.
    for (let i = 0; i < 4; i++) {
      const cx = x + (i + 0.5) * laneW;
      const flash = Math.max(0, 1 - (nowMs - this.flash[i]) / 180);
      if (arrows) {
        const size = laneW * 0.42 * (this.pressed[i] ? 0.88 : 1);
        if (flash > 0) {
          c.shadowColor = LANE_COLORS[i];
          c.shadowBlur = 30 * flash;
        }
        drawArrow(c, cx, recY, size, ARROW_ROTATION[i], flash > 0 ? mix('#5a5f70', LANE_COLORS[i], flash) : this.pressed[i] ? mix('#2b2f3b', LANE_COLORS[i], 0.4) : '#2b2f3b', '#9aa0b4', 3);
        c.shadowBlur = 0;
      } else {
        c.fillStyle = this.pressed[i] ? BAR_COLORS[i] : 'rgba(255,255,255,0.08)';
        c.globalAlpha = this.pressed[i] ? 0.85 : 1;
        roundRect(c, x + i * laneW + 4, recY + (dir > 0 ? -laneW * 0.62 - 12 : 14), laneW - 8, laneW * 0.62, 8);
        c.fill();
        c.globalAlpha = 1;
        c.fillStyle = this.pressed[i] ? '#0b0d12' : '#aeb4c6';
        c.font = `700 ${Math.round(laneW * 0.26)}px Inter, system-ui, sans-serif`;
        c.textAlign = 'center';
        c.fillText(keyLabel(this.opts.keys[i]), x + (i + 0.5) * laneW, recY + (dir > 0 ? -laneW * 0.31 - 12 : 14 + laneW * 0.31) + laneW * 0.09);
        c.textAlign = 'left';
      }
    }
    if (!arrows) {
      c.fillStyle = '#ffffff';
      c.globalAlpha = 0.85;
      c.fillRect(x, recY - 2, laneW * 4, 4);
      c.globalAlpha = 1;
    }

    // Notes.
    const s = this.session;
    const states = s ? s.states : [];
    const lookAhead = (H / pxPerSec) * this.opts.speed + 0.2;
    for (const st of states) {
      const n = st.note;
      if (n.time > t + lookAhead) break;
      const end = n.end ?? n.time;
      if (end < t - 0.6 * this.opts.speed) continue;
      if (st.judged !== null && st.judged !== 'miss' && !st.holding && (n.end === null || st.tail !== null)) continue;
      const missed = st.judged === 'miss' || st.tail === 'miss';
      const lx = x + n.lane * laneW;
      const cx = lx + laneW / 2;
      const headY = st.holding ? recY : y(n.time);
      c.globalAlpha = missed ? 0.3 : 1;
      if (n.end !== null) {
        const tailY = y(n.end);
        const top = Math.min(headY, tailY);
        const hgt = Math.abs(tailY - headY);
        if (arrows) {
          c.fillStyle = LANE_COLORS[n.lane];
          c.globalAlpha *= 0.75;
          roundRect(c, cx - laneW * 0.12, top, laneW * 0.24, hgt, laneW * 0.12);
          c.fill();
          c.globalAlpha = missed ? 0.3 : 1;
        } else {
          c.fillStyle = BAR_COLORS[n.lane];
          c.globalAlpha *= 0.55;
          c.fillRect(lx + 12, top, laneW - 24, hgt);
          c.globalAlpha = missed ? 0.3 : 1;
        }
      }
      if (arrows) {
        drawArrow(c, cx, headY, laneW * 0.42, ARROW_ROTATION[n.lane], LANE_COLORS[n.lane], '#ffffff', 3);
      } else {
        c.fillStyle = BAR_COLORS[n.lane];
        roundRect(c, lx + 4, headY - laneW * 0.14, laneW - 8, laneW * 0.28, 5);
        c.fill();
      }
      c.globalAlpha = 1;
    }

    // Hit-error meter.
    if (s) {
      const mw = Math.min(260, laneW * 3);
      const my = this.opts.scroll === 'up' ? H - 26 : H - 12;
      const scale = mw / 2 / WINDOWS.bad;
      const zones: [number, string][] = [[WINDOWS.bad, JUDGE_COLORS.bad], [WINDOWS.good, JUDGE_COLORS.good], [WINDOWS.excellent, JUDGE_COLORS.excellent], [WINDOWS.perfect, JUDGE_COLORS.perfect]];
      for (const [wdw, col] of zones) {
        c.fillStyle = col;
        c.globalAlpha = 0.28;
        c.fillRect(W / 2 - wdw * scale, my - 3, wdw * scale * 2, 6);
      }
      c.globalAlpha = 1;
      c.fillStyle = '#fff';
      c.fillRect(W / 2 - 1, my - 8, 2, 16);
      for (const e of s.keeper.recentErrors) {
        const age = t - e.at;
        if (age > 3 * this.opts.speed) continue;
        c.globalAlpha = Math.max(0.15, 1 - age / (3 * this.opts.speed));
        c.fillStyle = '#ffffff';
        c.fillRect(W / 2 + Math.max(-1, Math.min(1, e.delta / WINDOWS.bad)) * (mw / 2) - 1, my - 6, 2, 12);
      }
      c.globalAlpha = 1;
    }
  }
}

function drawArrow(c: CanvasRenderingContext2D, cx: number, cy: number, size: number, rot: number, fill: string, stroke: string, lw: number) {
  c.save();
  c.translate(cx, cy);
  c.rotate(rot);
  c.beginPath();
  const pts: [number, number][] = [[0, -1], [0.95, -0.02], [0.42, -0.02], [0.42, 0.92], [-0.42, 0.92], [-0.42, -0.02], [-0.95, -0.02]];
  pts.forEach(([px, py], i) => (i ? c.lineTo(px * size, py * size) : c.moveTo(px * size, py * size)));
  c.closePath();
  c.lineJoin = 'round';
  c.fillStyle = fill;
  c.fill();
  c.lineWidth = lw;
  c.strokeStyle = stroke;
  c.stroke();
  c.restore();
}

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  c.beginPath();
  c.moveTo(x + rr, y);
  c.arcTo(x + w, y, x + w, y + h, rr);
  c.arcTo(x + w, y + h, x, y + h, rr);
  c.arcTo(x, y + h, x, y, rr);
  c.arcTo(x, y, x + w, y, rr);
  c.closePath();
}

function mix(a: string, b: string, t: number): string {
  const pa = parseInt(a.slice(1), 16);
  const pb = parseInt(b.slice(1), 16);
  const ch = (s: number) => Math.round(((pa >> s) & 255) * (1 - t) + ((pb >> s) & 255) * t);
  return `rgb(${ch(16)},${ch(8)},${ch(0)})`;
}
