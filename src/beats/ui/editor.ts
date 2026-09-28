// The map editor.
//
// Simple: pick a preset and press Generate. Advanced: every generator knob,
// then a timeline to place, move and delete notes and holds by hand, on a
// beat-snap grid over the song's waveform (or its piano roll). Also the
// song's details (title, artist, difficulty name, description, cover,
// background video, preview point), timing (BPM, offset, tap tempo) and
// test play from any point.

import { bridge } from '../../platform/bridge';
import type { ScoreNote } from '../../score/model';
import { clear, h, icon } from '../../ui/dom';
import { MusicPlayer } from '../audio/deck';
import { beatAt, estimateLevel, finishNotes, mapStats, PRESET_NAMES, PRESETS, presetOptions, timeAtBeat } from '../mapgen';
import { PALETTES, SNAP_COLORS } from '../settings';
import type { Analysis, GeneratorOptions, MapData, MapNote, Pattern, Preset, SongMeta, TimingPoint } from '../types';
import { LANES, now, uid } from '../types';
import type { BeatsApp, Screen } from './app';
import { hexA, mixHex, roundRect } from './play';
import { btn, confirmDialog, formatTime, keyName, levelColor, modal, progressBar, row, segmented, select, slider, sounding, textInput, toast, toggle } from './widgets';

type Tool = 'select' | 'note' | 'hold';
type Tab = 'generate' | 'details' | 'timing' | 'tools';

const SNAPS = [1, 2, 3, 4, 6, 8, 12, 16];
const PRESET_INFO: Record<Preset, string> = {
  easy: 'One note at a time on the strongest beats.',
  normal: 'Steady rhythms, a few two-note chords.',
  hard: 'Faster streams, more chords and holds.',
  insane: 'Dense patterns and three-note chords.',
  expert: 'Nearly everything, with jumps.',
};

interface EditorClock {
  play(from: number): void;
  stop(): number;
  now(): number;
  playing: boolean;
}

export class EditorScreen implements Screen {
  readonly el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private mini: HTMLCanvasElement;
  private mg: CanvasRenderingContext2D;
  private side: HTMLElement;
  private sideTabs!: ReturnType<typeof segmented<Tab>>;
  private titleEl: HTMLElement;
  private mapSel: HTMLSelectElement;
  private saveBtn: HTMLButtonElement;
  private timeEl: HTMLElement;
  private statsEl: HTMLElement;
  private playBtn: HTMLButtonElement;
  private toolSeg!: ReturnType<typeof segmented<Tool>>;
  private snapSeg!: ReturnType<typeof segmented<number>>;

  private song!: SongMeta;
  private map!: MapData;
  private analysis: Analysis | null = null;
  private scoreNotes: ScoreNote[] = [];
  private duration = 60;
  private timing: TimingPoint[] = [{ t: 0, bpm: 120, meter: 4 }];
  private pos = 0;
  private tab: Tab = 'generate';
  private tool: Tool = 'note';
  private selected = new Set<MapNote>();
  private undo: string[] = [];
  private redo: string[] = [];
  private dirty = false;
  private clipboard: MapNote[] = [];
  private clock: EditorClock | null = null;
  private raf = 0;
  private lastTick = 0;
  private hover: { t: number; lane: number } | null = null;
  private drag: { kind: 'box' | 'move' | 'hold'; x0: number; y0: number; t0: number; lane0: number; x1: number; y1: number; orig?: MapNote[]; note?: MapNote } | null = null;
  private advanced = false;
  private gen: GeneratorOptions = presetOptions('normal');
  private taps: number[] = [];
  private w = 0;
  private hgt = 0;
  private dpr = 1;
  private loadingToken = 0;

  constructor(private app: BeatsApp) {
    this.canvas = h('canvas', { class: 'pb-ed-canvas', tabindex: 0 });
    this.g = this.canvas.getContext('2d')!;
    this.mini = h('canvas', { class: 'pb-ed-mini' });
    this.mg = this.mini.getContext('2d')!;
    this.side = h('div', { class: 'pb-ed-side glass' });
    this.titleEl = h('div', { class: 'pb-ed-title' });
    this.mapSel = h('select', { class: 'pb-select', onchange: () => void this.switchMap(this.mapSel.value) }) as HTMLSelectElement;
    this.saveBtn = btn('Save', () => void this.save(), { icon: 'save', cls: 'primary', title: 'Save (Ctrl+S)' }) as HTMLButtonElement;
    this.timeEl = h('div', { class: 'pb-ed-time' });
    this.statsEl = h('div', { class: 'pb-ed-stats' });
    this.playBtn = btn('', () => this.togglePlay(), { icon: 'play', cls: 'pb-ed-play', title: 'Play / pause (Space)' }) as HTMLButtonElement;
    const es = app.settings.editor;
    this.toolSeg = segmented<Tool>(this.tool, [
      { value: 'select', label: 'Select', icon: 'select', title: 'Select, box-select and drag notes (1)' },
      { value: 'note', label: 'Note', icon: 'plus', title: 'Click a lane to add a note (2)' },
      { value: 'hold', label: 'Hold', icon: 'hold', title: 'Drag in a lane to draw a hold (3)' },
    ], (t) => (this.tool = t));
    this.snapSeg = segmented<number>(es.snap, SNAPS.map((d) => ({ value: d, label: `1/${d}` })), (d) => {
      es.snap = d;
      this.app.save();
    }, 'small snap');
    const rate = select(String(es.rate), ['0.25', '0.5', '0.75', '1'].map((v) => ({ value: v, label: `${Math.round(parseFloat(v) * 100)}%` })), (v) => {
      es.rate = parseFloat(v);
      this.app.save();
      if (this.clock?.playing) {
        const t = this.clock.stop();
        this.startClock(t);
      }
    });
    const zoom = slider({ value: es.zoom, min: 0.3, max: 4, step: 0.05, reset: 1, format: (v) => `${v.toFixed(1)}×`, onInput: (v) => ((es.zoom = v), this.app.save()) });
    const header = h(
      'div',
      { class: 'pb-ed-head glass' },
      btn('Back', () => void this.back(), { icon: 'back', cls: 'ghost', title: 'Back (Esc)' }),
      this.titleEl,
      h('div', { class: 'pb-spacer' }),
      h('label', { class: 'pb-ed-map' }, h('span', null, 'Difficulty'), this.mapSel),
      btn('New', () => void this.newMap(false), { icon: 'plus', title: 'New empty difficulty' }),
      btn('Duplicate', () => void this.newMap(true), { icon: 'copy', title: 'Copy this difficulty' }),
      this.saveBtn,
      btn('Test play', () => void this.test(), { icon: 'gamepad', title: 'Play from the cursor (F5)' }),
      btn('Export', () => void this.exportOsz(), { icon: 'upload', title: 'Save as an osu! beatmap (.osz)' }),
    );
    const bottom = h(
      'div',
      { class: 'pb-ed-bottom glass' },
      this.playBtn,
      this.timeEl,
      h('label', { class: 'pb-inline' }, icon('clock', 15), rate),
      this.toolSeg,
      h('div', { class: 'pb-inline' }, icon('magnet', 15), this.snapSeg),
      h('div', { class: 'pb-inline zoom' }, icon('zoomIn', 15), zoom),
      toggle(es.hitsounds, (v) => ((es.hitsounds = v), this.app.save()), 'Ticks'),
      toggle(es.metronome, (v) => ((es.metronome = v), this.app.save()), 'Metronome'),
      h('div', { class: 'pb-spacer' }),
      this.statsEl,
    );
    this.el = h(
      'div',
      { class: 'pb-screen pb-editor' },
      header,
      h('div', { class: 'pb-ed-main' }, this.side, h('div', { class: 'pb-ed-stage' }, this.canvas, this.mini)),
      bottom,
    );
    this.canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    this.canvas.addEventListener('pointermove', (e) => this.onMove(e));
    this.canvas.addEventListener('pointerup', (e) => this.onUp(e));
    this.canvas.addEventListener('pointerleave', () => (this.hover = null));
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    this.mini.addEventListener('pointerdown', (e) => this.onMini(e));
    this.mini.addEventListener('pointermove', (e) => e.buttons & 1 && this.onMini(e));
    new ResizeObserver(() => this.resize()).observe(this.el);
  }

  private get es() {
    return this.app.settings.editor;
  }

  // ------------------------------------------------------------ enter ----

  async enter(arg?: unknown) {
    const a = arg as { song: SongMeta; mapId: string | null; resumeAt?: number };
    this.app.backdrop.intensity = 0.15;
    const same = this.song && this.map && a.song.id === this.song.id && a.mapId === this.map.id && a.resumeAt !== undefined;
    if (same) {
      this.pos = a.resumeAt!;
      this.loop();
      return;
    }
    const token = ++this.loadingToken;
    this.song = this.app.store.song(a.song.id) || a.song;
    this.analysis = null;
    this.scoreNotes = [];
    this.selected.clear();
    this.undo = [];
    this.redo = [];
    this.dirty = false;
    this.pos = 0;
    const url = this.song.cover ? this.app.store.urlSync(this.song.id, this.song.cover) : null;
    this.app.backdrop.setCover(url);
    const bar = progressBar();
    const busy = h('div', { class: 'pb-ed-loading glass' }, h('h3', null, 'Opening the editor…'), bar);
    this.el.append(busy);
    try {
      if (this.song.source === 'score') {
        const score = await this.app.library.score(this.song);
        this.scoreNotes = score.notes;
        this.duration = score.duration + 1;
      } else {
        this.analysis = await this.app.library.analysis(this.song, (l, f) => bar.set(l, f));
        this.duration = this.analysis.duration;
      }
      if (token !== this.loadingToken) return;
      let map: MapData | null = null;
      if (a.mapId) {
        try {
          map = await this.app.library.loadMap(this.song, a.mapId);
        } catch {
          map = null;
        }
      }
      if (!map && this.song.maps[0]) map = await this.app.library.loadMap(this.song, this.song.maps[0].id);
      if (!map) {
        map = this.app.library.newMap(this.song, 'Normal', presetOptions('normal'));
        this.tab = 'generate';
      }
      await this.useMap(map);
    } catch (err) {
      toast(`Couldn't open the editor: ${err instanceof Error ? err.message : err}`, 'error', 6000);
      void this.app.show('select', { songId: this.song.id });
      return;
    } finally {
      busy.remove();
    }
    this.loop();
  }

  private async useMap(map: MapData) {
    this.map = structuredClone(map);
    this.gen = { ...presetOptions('normal'), ...(map.generator || {}) };
    this.timing = map.timing.length ? structuredClone(map.timing) : await this.app.library.timing(this.song, null);
    this.selected.clear();
    this.undo = [];
    this.redo = [];
    this.dirty = false;
    this.refreshHeader();
    this.renderSide();
  }

  leave() {
    this.clockToken++;
    this.clock?.stop();
    this.clock = null;
    this.app.scorePlayer.stop();
    this.app.deps.engine.allNotesOff();
    this.playBtn.replaceChildren(icon('play', 18));
    cancelAnimationFrame(this.raf);
  }

  private refreshHeader() {
    this.titleEl.replaceChildren(h('b', null, this.song.title), h('span', null, this.song.artist));
    clear(this.mapSel);
    const maps = this.song.maps.some((m) => m.id === this.map.id) ? this.song.maps : [...this.song.maps, { id: this.map.id, name: this.map.name, level: this.map.level } as SongMeta['maps'][number]];
    for (const m of maps) this.mapSel.append(h('option', { value: m.id, selected: m.id === this.map.id }, `${m.id === this.map.id ? this.map.name : m.name} (${(m.id === this.map.id ? this.map.level : m.level).toFixed(1)}★)`));
    this.saveBtn.classList.toggle('dirty', this.dirty);
  }

  private markDirty() {
    this.dirty = true;
    this.saveBtn.classList.add('dirty');
  }

  // --------------------------------------------------------- editing ----

  private snapshot() {
    this.undo.push(JSON.stringify(this.map.notes));
    if (this.undo.length > 200) this.undo.shift();
    this.redo = [];
    this.markDirty();
  }

  private restore(json: string) {
    this.map.notes = JSON.parse(json);
    this.selected.clear();
    this.markDirty();
  }

  private undoStep() {
    const s = this.undo.pop();
    if (!s) return;
    this.redo.push(JSON.stringify(this.map.notes));
    this.restore(s);
  }

  private redoStep() {
    const s = this.redo.pop();
    if (!s) return;
    this.undo.push(JSON.stringify(this.map.notes));
    this.restore(s);
  }

  private sortNotes() {
    this.map.notes.sort((a, b) => a.t - b.t || a.l - b.l);
  }

  private noteAt(t: number, lane: number, tol: number): MapNote | null {
    let best: MapNote | null = null;
    let bestD = tol;
    for (const n of this.map.notes) {
      if (n.l !== lane) continue;
      const end = n.e ?? n.t;
      const d = t >= n.t && t <= end ? 0 : Math.min(Math.abs(t - n.t), Math.abs(t - end));
      if (d <= bestD) {
        bestD = d;
        best = n;
      }
    }
    return best;
  }

  private addNote(t: number, lane: number, end?: number) {
    const existing = this.map.notes.find((n) => n.l === lane && Math.abs(n.t - t) < 0.002);
    if (existing) return existing;
    this.snapshot();
    const n: MapNote = { t: round4(t), l: lane };
    if (end !== undefined && end - t > 0.05) n.e = round4(end);
    // Remove anything this note (or hold) now covers in its lane.
    this.map.notes = this.map.notes.filter((o) => !(o.l === lane && o.t > t - 0.002 && o.t < (n.e ?? t) + 0.002));
    this.map.notes.push(n);
    this.sortNotes();
    this.app.audio.hitsound('tick', lane, undefined, 0.6);
    return n;
  }

  private deleteNotes(list: MapNote[]) {
    if (!list.length) return;
    this.snapshot();
    const set = new Set(list);
    this.map.notes = this.map.notes.filter((n) => !set.has(n));
    for (const n of list) this.selected.delete(n);
  }

  private mirrorSelection() {
    const list = this.selected.size ? [...this.selected] : this.map.notes;
    this.snapshot();
    for (const n of list) n.l = LANES - 1 - n.l;
    this.map.notes = finishNotes(this.map.notes, 0.05);
    this.selected.clear();
  }

  private copy(cut: boolean) {
    const list = [...this.selected].sort((a, b) => a.t - b.t);
    if (!list.length) return;
    const t0 = list[0].t;
    this.clipboard = list.map((n) => ({ ...n, t: n.t - t0, e: n.e !== undefined ? n.e - t0 : undefined }));
    if (cut) this.deleteNotes(list);
    toast(`${cut ? 'Cut' : 'Copied'} ${list.length} notes`, 'info', 1200);
  }

  private paste() {
    if (!this.clipboard.length) return;
    this.snapshot();
    const at = this.snapTime(this.pos);
    const added = this.clipboard.map((n) => {
      const c: MapNote = { ...n, t: round4(at + n.t) };
      if (n.e !== undefined) c.e = round4(at + n.e);
      else delete c.e;
      return c;
    });
    const keys = new Set(added.map((n) => `${n.l}:${Math.round(n.t * 1000)}`));
    this.map.notes = this.map.notes.filter((n) => !keys.has(`${n.l}:${Math.round(n.t * 1000)}`));
    this.map.notes.push(...added);
    this.map.notes = finishNotes(this.map.notes, 0.05);
    this.selected = new Set(this.map.notes.filter((n) => keys.has(`${n.l}:${Math.round(n.t * 1000)}`)));
  }

  // ------------------------------------------------------------ timing ----

  private tpAt(t: number): TimingPoint {
    let cur = this.timing[0];
    for (const tp of this.timing) if (tp.t <= t + 1e-6) cur = tp;
    return cur;
  }

  private snapTime(t: number, div = this.es.snap): number {
    const tp = this.tpAt(t);
    const grid = 60 / tp.bpm / div;
    return round4(tp.t + Math.round((t - tp.t) / grid) * grid);
  }

  private step(t: number, dir: number, div = this.es.snap): number {
    const tp = this.tpAt(t);
    const grid = 60 / tp.bpm / div;
    const k = Math.round((t - tp.t) / grid);
    const onGrid = Math.abs(tp.t + k * grid - t) < 0.002;
    return tp.t + (onGrid ? k + dir : dir > 0 ? Math.ceil((t - tp.t) / grid) : Math.floor((t - tp.t) / grid)) * grid;
  }

  // ------------------------------------------------------------- clock ----

  private clockToken = 0;

  private startClock(from: number) {
    const rate = this.es.rate;
    const ctx = this.app.audio.ctx;
    const token = ++this.clockToken;
    void this.app.deps.engine.resume();
    // A placeholder until the audio (or score) is ready.
    this.clock = { play: () => {}, stop: () => from, now: () => from, playing: true };
    void (async () => {
      if (this.song.source === 'score') {
        const score = await this.app.library.score(this.song);
        if (token !== this.clockToken) return;
        const p = this.app.scorePlayer;
        if (p.score !== score) p.load(score);
        p.noteFilter = null;
        p.setGate(null);
        p.loop = null;
        p.loopWhole = false;
        p.waitMode = false;
        p.metronomeOn = false;
        p.hands = { L: true, R: true };
        p.speed = rate;
        p.rebuild();
        p.startFrom(Math.max(0, from), ctx.currentTime + 0.05);
        this.clock = {
          play: () => {},
          stop: () => {
            const t = p.songTime(undefined, false);
            p.pause();
            return t;
          },
          now: () => p.songTime(undefined, false),
          get playing() {
            return p.isPlaying;
          },
        };
        return;
      }
      const buf = await this.app.library.audioBuffer(this.song);
      if (token !== this.clockToken) return;
      const mp = new MusicPlayer(ctx, this.app.audio.music);
      mp.set(buf, rate, false);
      mp.start(Math.max(0, from), ctx.currentTime + 0.05);
      this.clock = {
        play: () => {},
        stop: () => mp.stop(),
        now: () => mp.time(ctx.currentTime, true),
        get playing() {
          return mp.playing;
        },
      };
    })();
  }

  private togglePlay() {
    if (this.clock?.playing) {
      this.clockToken++;
      this.pos = Math.max(0, this.clock.stop());
      this.clock = null;
      this.app.deps.engine.allNotesOff();
    } else {
      this.startClock(this.pos);
      this.lastTick = this.pos;
    }
    this.playBtn.replaceChildren(icon(this.clock?.playing ? 'pause' : 'play', 18));
  }

  // ------------------------------------------------------------- input ----

  private geom() {
    const W = this.w;
    const H = this.hgt;
    const laneW = Math.max(44, Math.min(88, W / 11));
    const waveW = Math.min(180, W * 0.2);
    const fieldW = laneW * LANES;
    const x0 = Math.max(waveW + 30, (W - fieldW) / 2);
    const waveX = x0 - waveW - 16;
    const lineY = H * 0.78;
    const pps = 320 * this.es.zoom;
    return { laneW, x0, waveX, waveW, lineY, pps, fieldW };
  }

  private yToTime(y: number) {
    const { lineY, pps } = this.geom();
    return this.pos + (lineY - y) / pps;
  }

  private timeToY(t: number) {
    const { lineY, pps } = this.geom();
    return lineY - (t - this.pos) * pps;
  }

  private laneAt(x: number): number {
    const { x0, laneW } = this.geom();
    const l = Math.floor((x - x0) / laneW);
    return l >= 0 && l < LANES ? l : -1;
  }

  private local(e: PointerEvent | WheelEvent) {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private onWheel(e: WheelEvent) {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      this.es.zoom = Math.max(0.3, Math.min(4, this.es.zoom * (e.deltaY > 0 ? 0.9 : 1.1)));
      this.app.save();
      return;
    }
    const dir = e.deltaY > 0 ? -1 : 1;
    if (this.clock?.playing) this.togglePlay();
    this.pos = Math.max(0, Math.min(this.duration, this.step(this.pos, dir, e.shiftKey ? 1 : this.es.snap)));
  }

  private onDown(e: PointerEvent) {
    this.canvas.focus();
    const { x, y } = this.local(e);
    const lane = this.laneAt(x);
    const t = this.yToTime(y);
    const { pps } = this.geom();
    const hit = lane >= 0 ? this.noteAt(t, lane, 10 / pps) : null;
    if (e.button === 2) {
      if (hit) this.deleteNotes([hit]);
      return;
    }
    if (lane < 0) {
      // Outside the lanes: seek.
      this.pos = Math.max(0, Math.min(this.duration, this.snapTime(t)));
      return;
    }
    this.canvas.setPointerCapture(e.pointerId);
    const st = this.snapTime(t);
    if (this.tool === 'select' || (hit && this.tool !== 'hold')) {
      if (hit) {
        if (e.shiftKey) {
          if (this.selected.has(hit)) this.selected.delete(hit);
          else this.selected.add(hit);
        } else if (!this.selected.has(hit)) this.selected = new Set([hit]);
        this.drag = { kind: 'move', x0: x, y0: y, t0: st, lane0: lane, x1: x, y1: y, orig: this.map.notes.map((n) => ({ ...n })) };
        this.undo.push(JSON.stringify(this.map.notes));
        this.redo = [];
      } else {
        if (!e.shiftKey) this.selected.clear();
        this.drag = { kind: 'box', x0: x, y0: y, t0: t, lane0: lane, x1: x, y1: y };
      }
      return;
    }
    if (this.tool === 'note') {
      this.addNote(st, lane);
      return;
    }
    // Hold: drag from the snapped start.
    this.drag = { kind: 'hold', x0: x, y0: y, t0: st, lane0: lane, x1: x, y1: y };
  }

  private onMove(e: PointerEvent) {
    const { x, y } = this.local(e);
    const lane = this.laneAt(x);
    this.hover = lane >= 0 ? { t: this.snapTime(this.yToTime(y)), lane } : null;
    const d = this.drag;
    if (!d) return;
    d.x1 = x;
    d.y1 = y;
    if (d.kind === 'move' && d.orig) {
      const dt = this.snapTime(this.yToTime(y)) - d.t0;
      const dl = (lane >= 0 ? lane : d.lane0) - d.lane0;
      const idx = this.map.notes.map((n, i) => (this.selected.has(n) ? i : -1)).filter((i) => i >= 0);
      const minL = Math.min(...idx.map((i) => d.orig![i].l));
      const maxL = Math.max(...idx.map((i) => d.orig![i].l));
      const cl = Math.max(-minL, Math.min(LANES - 1 - maxL, dl));
      for (const i of idx) {
        const o = d.orig[i];
        const n = this.map.notes[i];
        n.t = round4(Math.max(0, o.t + dt));
        n.l = o.l + cl;
        if (o.e !== undefined) n.e = round4(Math.max(n.t + 0.01, o.e + dt));
      }
      if (dt || cl) this.markDirty();
    }
  }

  private onUp(e: PointerEvent) {
    const d = this.drag;
    this.drag = null;
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* not captured */
    }
    if (!d) return;
    if (d.kind === 'box') {
      const t1 = this.yToTime(d.y0);
      const t2 = this.yToTime(d.y1);
      const l1 = this.laneAt(Math.min(d.x0, d.x1));
      const l2 = this.laneAt(Math.max(d.x0, d.x1));
      const lo = Math.min(t1, t2);
      const hi = Math.max(t1, t2);
      const la = l1 < 0 ? 0 : l1;
      const lb = l2 < 0 ? LANES - 1 : l2;
      if (Math.abs(d.y1 - d.y0) < 3 && Math.abs(d.x1 - d.x0) < 3) {
        // A plain click on empty space with the select tool: move the cursor there.
        if (!this.clock?.playing) this.pos = Math.max(0, this.snapTime(this.yToTime(d.y1)));
        return;
      }
      for (const n of this.map.notes) if (n.l >= la && n.l <= lb && (n.e ?? n.t) >= lo && n.t <= hi) this.selected.add(n);
    } else if (d.kind === 'hold') {
      const end = this.snapTime(this.yToTime(d.y1));
      this.addNote(d.t0, d.lane0, end > d.t0 + 0.01 ? end : undefined);
    } else if (d.kind === 'move') {
      this.map.notes = finishNotes(this.map.notes, 0.05);
      const moved = JSON.stringify(this.map.notes) !== this.undo[this.undo.length - 1];
      if (!moved) this.undo.pop();
      this.selected = new Set(this.map.notes.filter((n) => [...this.selected].some((s) => s.t === n.t && s.l === n.l)));
    }
  }

  private onMini(e: PointerEvent) {
    const r = this.mini.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / r.height));
    if (this.clock?.playing) this.togglePlay();
    this.pos = f * this.duration;
  }

  keyDown(e: KeyboardEvent) {
    const typing = /INPUT|TEXTAREA|SELECT/.test((e.target as HTMLElement)?.tagName || '') && (e.target as HTMLInputElement).type !== 'range' && (e.target as HTMLInputElement).type !== 'checkbox';
    if (typing) return false;
    const mod = e.ctrlKey || e.metaKey;
    const lane = this.es.keys.indexOf(e.code);
    if (lane >= 0 && !mod && !e.repeat) {
      // Live mapping: tap lane keys to place notes at the playhead.
      const t = this.clock?.playing ? this.clock.now() : this.pos;
      this.addNote(this.snapTime(t), lane);
      return true;
    }
    if (mod && e.code === 'KeyS') void this.save();
    else if (mod && e.code === 'KeyZ') e.shiftKey ? this.redoStep() : this.undoStep();
    else if (mod && e.code === 'KeyY') this.redoStep();
    else if (mod && e.code === 'KeyA') this.selected = new Set(this.map.notes);
    else if (mod && e.code === 'KeyC') this.copy(false);
    else if (mod && e.code === 'KeyX') this.copy(true);
    else if (mod && e.code === 'KeyV') this.paste();
    else if (e.code === 'Space') this.togglePlay();
    else if (e.code === 'Digit1') this.toolSeg.set((this.tool = 'select'));
    else if (e.code === 'Digit2') this.toolSeg.set((this.tool = 'note'));
    else if (e.code === 'Digit3') this.toolSeg.set((this.tool = 'hold'));
    else if (e.code === 'Delete' || e.code === 'Backspace') this.deleteNotes([...this.selected]);
    else if (e.code === 'KeyH' && !mod) this.mirrorSelection();
    else if (e.code === 'ArrowUp' || e.code === 'ArrowRight' || e.code === 'ArrowDown' || e.code === 'ArrowLeft') {
      if (this.clock?.playing) this.togglePlay();
      const dir = e.code === 'ArrowUp' || e.code === 'ArrowRight' ? 1 : -1;
      this.pos = Math.max(0, Math.min(this.duration, this.step(this.pos, dir, e.shiftKey ? 1 : this.es.snap)));
    } else if (e.code === 'PageUp' || e.code === 'PageDown') {
      const tp = this.tpAt(this.pos);
      this.pos = Math.max(0, Math.min(this.duration, this.pos + (e.code === 'PageUp' ? 1 : -1) * (60 / tp.bpm) * (tp.meter || 4)));
    } else if (e.code === 'Home') this.pos = 0;
    else if (e.code === 'End') this.pos = this.map.notes.length ? this.map.notes[this.map.notes.length - 1].t : this.duration;
    else if (e.code === 'F5' || (e.code === 'KeyT' && !mod)) void this.test();
    else if (e.code === 'Escape') {
      if (this.selected.size) this.selected.clear();
      else void this.back();
    } else return false;
    return true;
  }

  // ------------------------------------------------------------ actions ----

  private async back() {
    if (this.dirty && !(await confirmDialog('Leave without saving?', 'Your changes to this map will be lost.', 'Leave', true))) return;
    this.dirty = false;
    void this.app.show('select', { songId: this.song.id });
  }

  private buildMap(): MapData {
    const m = this.map;
    const level = m.levelManual ? m.level : estimateLevel(m.notes);
    return { ...m, notes: finishNotes(m.notes, 0.05), timing: this.timing, level, generator: this.gen, updatedAt: now() };
  }

  async save(silent = false) {
    if (!this.map.name.trim()) this.map.name = 'Untitled';
    const map = this.buildMap();
    this.map.level = map.level;
    try {
      this.song = await this.app.library.saveMap(map);
      this.dirty = false;
      this.refreshHeader();
      if (!silent) {
        this.app.audio.sfx('select');
        toast(`Saved "${map.name}" (${map.notes.length} notes, ${map.level.toFixed(1)}★)`, 'ok');
      }
    } catch (err) {
      toast(`Couldn't save: ${err instanceof Error ? err.message : err}`, 'error');
    }
  }

  private async saveSong(patch: Partial<SongMeta>) {
    this.song = await this.app.store.saveSong({ ...this.song, ...patch, updatedAt: now() });
    this.refreshHeader();
  }

  private async switchMap(id: string) {
    if (id === this.map.id) return;
    if (this.dirty) {
      if (!(await confirmDialog('Switch without saving?', 'Unsaved changes to this difficulty will be lost.', 'Switch', true))) {
        this.mapSel.value = this.map.id;
        return;
      }
    }
    await this.useMap(await this.app.library.loadMap(this.song, id));
  }

  private async newMap(duplicate: boolean) {
    if (this.dirty) await this.save(true);
    const base = this.app.library.newMap(this.song, duplicate ? `${this.map.name} (copy)` : 'New difficulty', this.gen);
    if (duplicate) Object.assign(base, { notes: structuredClone(this.map.notes), timing: structuredClone(this.timing), description: this.map.description, level: this.map.level, od: this.map.od, hp: this.map.hp, origin: 'edited' as const });
    else base.timing = structuredClone(this.timing);
    this.map = base;
    this.selected.clear();
    this.undo = [];
    this.redo = [];
    this.markDirty();
    this.tab = duplicate ? this.tab : 'generate';
    this.refreshHeader();
    this.renderSide();
  }

  private async test() {
    if (!this.map.notes.length) {
      toast('Add or generate some notes first.', 'error');
      return;
    }
    if (this.clock?.playing) this.togglePlay();
    const map = this.buildMap();
    const resumeAt = this.pos;
    const song = this.song;
    this.app.play(song, map, {
      from: Math.max(0, this.pos - 0.5),
      test: true,
      // Back to the same spot in the editor, with the unsaved work intact.
      onExit: () => void this.app.show('editor', { song, mapId: map.id, resumeAt }),
    });
  }

  private async exportOsz() {
    if (this.dirty) await this.save(true);
    const bar = progressBar();
    const m = modal('Export to osu!', [h('p', { class: 'pb-muted' }, `Packing "${this.map.name}" and the song's other difficulties as an osu!mania 4K beatmap…`), bar]);
    try {
      const maps = await Promise.all(this.song.maps.map((x) => this.app.library.loadMap(this.song, x.id)));
      const { name, bytes } = await this.app.library.exportOsz(this.song, maps, { video: !!this.song.video && this.song.video !== this.song.audio }, (l, f) => bar.set(l, f));
      const path = await bridge.saveFile(name, bytes, [{ name: 'osu! beatmap', extensions: ['osz'] }]);
      if (path) toast(`Exported ${name}`, 'ok');
    } catch (err) {
      toast(`Export failed: ${err instanceof Error ? err.message : err}`, 'error', 6000);
    } finally {
      m.close();
    }
  }

  // ------------------------------------------------------------- side ----

  private renderSide() {
    clear(this.side);
    this.sideTabs = segmented<Tab>(this.tab, [
      { value: 'generate', label: 'Generate', icon: 'wand' },
      { value: 'details', label: 'Details', icon: 'info' },
      { value: 'timing', label: 'Timing', icon: 'metronome' },
      { value: 'tools', label: 'Tools', icon: 'sliders' },
    ], (t) => ((this.tab = t), this.renderSide()), 'pb-ed-tabs');
    const body = h('div', { class: 'pb-ed-side-body' });
    this.side.append(this.sideTabs, body);
    if (this.tab === 'generate') this.sideGenerate(body);
    else if (this.tab === 'details') this.sideDetails(body);
    else if (this.tab === 'timing') this.sideTiming(body);
    else this.sideTools(body);
  }

  private sideGenerate(body: HTMLElement) {
    const o = this.gen;
    const isScore = this.song.source === 'score';
    const cards = h('div', { class: 'pb-presets' });
    for (const p of ['easy', 'normal', 'hard', 'insane', 'expert'] as Preset[]) {
      cards.append(
        sounding(
          h('button', {
            class: `pb-preset p-${p} ${o.preset === p ? 'on' : ''}`,
            onclick: () => {
              this.gen = { ...presetOptions(p), seed: o.seed, hands: o.hands, focus: o.focus, dynamics: o.dynamics, mirror: o.mirror };
              if (/^(easy|normal|hard|insane|expert|new difficulty)$/i.test(this.map.name)) this.map.name = PRESET_NAMES[p];
              this.renderSide();
            },
          }, h('b', null, PRESET_NAMES[p]), h('span', null, PRESET_INFO[p]), h('small', null, `~${PRESETS[p].density} notes/s`)),
          'toggle',
        ),
      );
    }
    const result = h('div', { class: 'pb-gen-result' });
    const run = async (range?: { from: number; to: number }) => {
      result.textContent = 'Generating…';
      try {
        const opts = { ...this.gen, ...(range || {}) };
        const g = await this.app.library.generateMap(this.song, opts);
        this.snapshot();
        if (range) {
          const keep = this.map.notes.filter((n) => n.t < range.from || n.t > range.to);
          this.map.notes = finishNotes([...keep, ...g.notes], 0.05);
        } else {
          this.map.notes = g.notes;
          if (!this.map.timing.length) this.timing = g.timing;
        }
        this.map.origin = this.map.origin === 'osu' ? 'edited' : range ? 'edited' : 'generated';
        this.map.level = estimateLevel(this.map.notes);
        this.selected.clear();
        const st = mapStats(this.map.notes);
        result.replaceChildren(icon('check', 14), `${st.notes} notes · ${st.holds} holds · ${st.chords} chord notes · ${st.nps.toFixed(1)}/s · ${this.map.level.toFixed(1)}★`);
        this.app.audio.sfx('select');
        this.refreshHeader();
      } catch (err) {
        result.textContent = `Failed: ${err instanceof Error ? err.message : err}`;
      }
    };
    body.append(
      h('p', { class: 'pb-muted small' }, 'Pick a difficulty and generate a whole map in one go – then fine-tune it on the timeline, or not at all.'),
      cards,
      h(
        'div',
        { class: 'pb-inline wrap' },
        btn('Generate map', () => void run(), { icon: 'wand', cls: 'primary' }),
        btn('Only the selection', () => {
          const sel = [...this.selected];
          if (!sel.length) return toast('Select some notes (Select tool) to regenerate that part.', 'error');
          void run({ from: Math.min(...sel.map((n) => n.t)) - 0.001, to: Math.max(...sel.map((n) => n.e ?? n.t)) + 0.001 });
        }, { icon: 'select', cls: 'ghost small' }),
      ),
      result,
      h('button', { class: 'pb-advanced-toggle', onclick: () => ((this.advanced = !this.advanced), this.renderSide()) }, icon('chevron', 14), this.advanced ? 'Hide advanced options' : 'Advanced options'),
    );
    if (!this.advanced) return;
    const set = <K extends keyof GeneratorOptions>(k: K, v: GeneratorOptions[K]) => {
      this.gen = { ...this.gen, [k]: v };
    };
    const sl = (k: 'density' | 'chords' | 'holds' | 'holdMin' | 'jackGap' | 'followPitch' | 'sensitivity' | 'maxChord', min: number, max: number, step: number, fmt: (v: number) => string) =>
      slider({ value: o[k] as number, min, max, step, format: fmt, onInput: (v) => set(k, v) });
    const pct = (v: number) => `${Math.round(v * 100)}%`;
    body.append(
      h(
        'div',
        { class: 'pb-adv' },
        row('Density', sl('density', 0.5, 16, 0.1, (v) => `${v.toFixed(1)} notes/s`)),
        row('Snap to', select(String(o.snap), [{ value: '0', label: 'Off (keep exact timing)' }, ...[1, 2, 3, 4, 6, 8].map((d) => ({ value: String(d), label: `1/${d} beat` }))], (v) => set('snap', parseInt(v, 10)))),
        row('Chords', sl('chords', 0, 1, 0.05, pct)),
        row('Largest chord', sl('maxChord', 1, 4, 1, (v) => `${v} note${v > 1 ? 's' : ''}`)),
        row('Holds', sl('holds', 0, 1, 0.05, pct)),
        row('Shortest hold', sl('holdMin', 0.2, 2, 0.05, (v) => `${v.toFixed(2)} s`)),
        row('Fastest repeat in a lane', sl('jackGap', 0.08, 1, 0.01, (v) => `${Math.round(v * 1000)} ms`)),
        row('Patterns', select<Pattern>(o.pattern, [{ value: 'flow', label: 'Flow (follow the melody)' }, { value: 'stairs', label: 'Stairs' }, { value: 'trills', label: 'Trills' }, { value: 'jumps', label: 'Jumps' }, { value: 'random', label: 'Random' }], (v) => set('pattern', v))),
        row('Follow the pitch', sl('followPitch', 0, 1, 0.05, pct)),
        isScore
          ? row('Hands', segmented(o.hands, [{ value: 'both', label: 'Both hands' }, { value: 'melody', label: 'Melody only' }], (v) => ((this.map.hands = v), set('hands', v))))
          : row('Listen to', segmented(o.focus, [{ value: 'all', label: 'Everything' }, { value: 'drums', label: 'Drums' }, { value: 'melody', label: 'Melody' }, { value: 'bass', label: 'Bass' }], (v) => set('focus', v))),
        isScore ? null : row('Sensitivity', sl('sensitivity', 0, 1, 0.05, pct), 'Higher finds quieter sounds'),
        row('Quiet parts sparser', toggle(o.dynamics, (v) => set('dynamics', v))),
        row('Mirror', toggle(o.mirror, (v) => set('mirror', v))),
        row('Variation', h('div', { class: 'pb-inline' }, h('b', null, `#${o.seed}`), btn('Reroll', () => {
          set('seed', Math.floor(Math.random() * 9999) + 1);
          this.renderSide();
          void run();
        }, { cls: 'small', icon: 'shuffle' }))),
      ),
    );
  }

  private sideDetails(body: HTMLElement) {
    const song = this.song;
    const m = this.map;
    const coverUrl = song.cover ? this.app.store.urlSync(song.id, song.cover) : null;
    const cover = h('div', { class: 'pb-ed-cover' }, coverUrl ? h('img', { src: coverUrl, alt: '' }) : h('div', { class: 'pb-song-cover placeholder' }, song.title.slice(0, 1)));
    const coverStatus = h('small', { class: 'pb-muted' }, song.coverSource ? `From ${song.coverSource}` : 'No cover yet');
    const findCover = async (order?: ('youtube' | 'google' | 'itunes' | 'deezer')[]) => {
      coverStatus.textContent = 'Searching…';
      const next = await this.app.library.fetchCover(this.song, undefined, null, order);
      if (next.cover === this.song.cover && next.coverSource === this.song.coverSource) coverStatus.textContent = 'Nothing found';
      this.song = next;
      this.renderSide();
    };
    let songPatch: Partial<SongMeta> = {};
    let saveTimer = 0;
    const patchSong = (p: Partial<SongMeta>) => {
      songPatch = { ...songPatch, ...p };
      clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => {
        void this.saveSong(songPatch);
        songPatch = {};
      }, 400);
    };
    const parts: (Node | null)[] = [
      h('h4', null, 'Song'),
      row('Title', textInput(song.title, (v) => patchSong({ title: v || 'Untitled' }))),
      row('Artist', textInput(song.artist, (v) => patchSong({ artist: v }))),
      row('Tags', textInput(song.tags || '', (v) => patchSong({ tags: v }), { placeholder: 'genre, source…' })),
      h(
        'div',
        { class: 'pb-ed-cover-row' },
        cover,
        h(
          'div',
          { class: 'pb-inline col' },
          coverStatus,
          btn('Choose image…', async () => {
            const [f] = await this.app.store.pickFiles('image', false, 'Choose a cover image');
            if (!f) return;
            this.song = await this.app.library.setCoverFromFile(this.song, f);
            this.renderSide();
          }, { cls: 'small', icon: 'image' }),
          btn('Find online', () => void findCover(['google', 'itunes', 'deezer']), { cls: 'small', icon: 'search', title: 'First Google Images result, then iTunes and Deezer' }),
          song.youtubeId ? btn('YouTube thumbnail', () => void findCover(['youtube']), { cls: 'small', icon: 'youtube' }) : null,
        ),
      ),
      row(
        'Background video',
        h(
          'div',
          { class: 'pb-inline col' },
          h('small', { class: 'pb-muted' }, song.video ? song.video : 'None'),
          h(
            'div',
            { class: 'pb-inline' },
            btn('Choose…', async () => {
              const [f] = await this.app.store.pickFiles('video', false, 'Choose a background video');
              if (!f) return;
              this.song = await this.app.library.setVideoFromFile(this.song, f);
              this.renderSide();
            }, { cls: 'small', icon: 'video' }),
            song.video ? btn('Remove', () => void this.saveSong({ video: undefined }).then(() => this.renderSide()), { cls: 'small ghost' }) : null,
          ),
        ),
      ),
      song.video ? row('Video offset', slider({ value: Math.round((song.videoOffset || 0) * 1000), min: -5000, max: 5000, step: 10, reset: 0, format: (v) => `${v} ms`, onInput: (v) => patchSong({ videoOffset: v / 1000 }) })) : null,
      row('Preview point', h('div', { class: 'pb-inline' }, h('b', null, formatTime(Math.max(0, song.previewTime))), btn('Set to the cursor', () => void this.saveSong({ previewTime: round4(this.pos) }).then(() => this.renderSide()), { cls: 'small', icon: 'flag' }))),
      h('h4', null, 'This difficulty'),
      row('Difficulty name', textInput(m.name, (v) => {
        m.name = v;
        this.markDirty();
      }, { maxLength: 60 })),
      row('Mapper', textInput(m.creator, (v) => {
        m.creator = v;
        this.markDirty();
      }, { maxLength: 40 })),
      row('Description', textInput(m.description, (v) => {
        m.description = v;
        this.markDirty();
      }, { multiline: true, placeholder: 'What is this map like?' })),
      row(
        'Star rating',
        h(
          'div',
          { class: 'pb-inline col' },
          toggle(!!m.levelManual, (v) => {
            m.levelManual = v;
            if (!v) m.level = estimateLevel(m.notes);
            this.markDirty();
            this.renderSide();
          }, 'Set by hand'),
          m.levelManual
            ? slider({ value: m.level, min: 0.5, max: 12, step: 0.1, format: (v) => `${v.toFixed(1)}★`, onInput: (v) => ((m.level = v), this.markDirty()) })
            : h('b', { style: { color: levelColor(estimateLevel(m.notes)) } }, `${estimateLevel(m.notes).toFixed(1)}★ (estimated)`),
        ),
      ),
      row('Timing strictness (OD)', slider({ value: m.od, min: 0, max: 10, step: 0.5, reset: 8, format: (v) => v.toFixed(1), onInput: (v) => ((m.od = v), this.markDirty()) }), 'Used with "Map OD" judging and in osu!'),
      row('HP drain', slider({ value: m.hp, min: 0, max: 10, step: 0.5, reset: 7, format: (v) => v.toFixed(1), onInput: (v) => ((m.hp = v), this.markDirty()) })),
      h(
        'div',
        { class: 'pb-inline wrap' },
        btn('Delete this difficulty', async () => {
          if (!this.song.maps.some((x) => x.id === m.id)) return toast('Not saved yet.');
          if (!(await confirmDialog('Delete difficulty?', `"${m.name}" will be removed.`, 'Delete', true))) return;
          this.song = await this.app.store.deleteMap(this.song.id, m.id);
          this.dirty = false;
          const next = this.song.maps[0];
          if (next) await this.useMap(await this.app.library.loadMap(this.song, next.id));
          else void this.app.show('select', { songId: this.song.id });
        }, { cls: 'small danger', icon: 'trash' }),
      ),
    ];
    body.append(...(parts.filter(Boolean) as Node[]));
  }

  private sideTiming(body: HTMLElement) {
    const tp = this.timing[0] || { t: 0, bpm: 120, meter: 4 };
    const update = (patch: Partial<TimingPoint>, i = 0) => {
      this.timing[i] = { ...this.timing[i], ...patch };
      this.timing.sort((a, b) => a.t - b.t);
      this.markDirty();
    };
    const bpmIn = h('input', { class: 'pb-input num', type: 'number', min: 20, max: 400, step: 0.01, value: String(tp.bpm), onchange: () => update({ bpm: Math.max(20, Math.min(400, parseFloat(bpmIn.value) || tp.bpm)) }) }) as HTMLInputElement;
    const offIn = h('input', { class: 'pb-input num', type: 'number', step: 1, value: String(Math.round(tp.t * 1000)), onchange: () => update({ t: (parseFloat(offIn.value) || 0) / 1000 }) }) as HTMLInputElement;
    const tapOut = h('b', null, '—');
    const list = h('div', { class: 'pb-tp-list' });
    this.timing.forEach((p, i) => {
      list.append(
        h(
          'div',
          { class: 'pb-tp' },
          h('span', null, formatTime(p.t), h('small', null, `.${String(Math.round((p.t % 1) * 1000)).padStart(3, '0')}`)),
          h('b', null, `${p.bpm} BPM`),
          h('span', null, `${p.meter}/4`),
          i > 0 ? btn('', () => ((this.timing.splice(i, 1), this.markDirty()), this.renderSide()), { icon: 'x', cls: 'ghost small' }) : null,
        ),
      );
    });
    body.append(
      h('p', { class: 'pb-muted small' }, this.song.source === 'score' ? 'Timing comes from the score’s tempo marks.' : `Detected: ${this.analysis?.bpm ?? '?'} BPM (confidence ${Math.round((this.analysis?.bpmConfidence ?? 0) * 100)}%), first downbeat ${Math.round((this.analysis?.offset ?? 0) * 1000)} ms.`),
      row('BPM', h('div', { class: 'pb-inline' }, bpmIn, btn('×2', () => (update({ bpm: tp.bpm * 2 }), this.renderSide()), { cls: 'small ghost' }), btn('÷2', () => (update({ bpm: tp.bpm / 2 }), this.renderSide()), { cls: 'small ghost' }))),
      row('Offset (first downbeat)', h('div', { class: 'pb-inline' }, offIn, h('span', null, 'ms'), btn('At cursor', () => (update({ t: round4(this.pos) }), this.renderSide()), { cls: 'small ghost' }))),
      row('Beats per bar', select(String(tp.meter), ['2', '3', '4', '5', '6', '7'].map((v) => ({ value: v, label: v })), (v) => update({ meter: parseInt(v, 10) }))),
      row(
        'Tap tempo',
        h('div', { class: 'pb-inline' }, btn('Tap', () => {
          const t = performance.now();
          if (this.taps.length && t - this.taps[this.taps.length - 1] > 2000) this.taps = [];
          this.taps.push(t);
          if (this.taps.length >= 4) {
            const d = (this.taps[this.taps.length - 1] - this.taps[0]) / (this.taps.length - 1);
            tapOut.textContent = `${(60000 / d).toFixed(1)} BPM`;
          } else tapOut.textContent = `${this.taps.length}…`;
        }, { cls: 'small', icon: 'hand' }), tapOut, btn('Use', () => {
          const v = parseFloat(tapOut.textContent || '');
          if (v > 0) {
            update({ bpm: Math.round(v * 100) / 100 });
            this.renderSide();
          }
        }, { cls: 'small ghost' })),
      ),
      h(
        'div',
        { class: 'pb-inline wrap' },
        this.analysis ? btn('Use detected', () => {
          this.timing = [{ t: this.analysis!.offset, bpm: this.analysis!.bpm, meter: 4 }];
          this.markDirty();
          this.renderSide();
        }, { cls: 'small', icon: 'refresh' }) : null,
        btn('Add point at cursor', () => {
          const cur = this.tpAt(this.pos);
          this.timing.push({ t: round4(this.pos), bpm: cur.bpm, meter: cur.meter });
          this.timing.sort((a, b) => a.t - b.t);
          this.markDirty();
          this.renderSide();
        }, { cls: 'small ghost', icon: 'plus' }),
        btn('Snap all notes to the grid', () => {
          this.snapshot();
          for (const n of this.map.notes) {
            n.t = this.snapTime(n.t);
            if (n.e !== undefined) n.e = this.snapTime(n.e);
          }
          this.map.notes = finishNotes(this.map.notes, 0.05);
        }, { cls: 'small ghost', icon: 'magnet' }),
      ),
      h('h4', null, 'Timing points'),
      list,
    );
  }

  private sideTools(body: HTMLElement) {
    const st = mapStats(this.map.notes);
    const shiftIn = h('input', { class: 'pb-input num', type: 'number', step: 1, value: '0' }) as HTMLInputElement;
    const k = (code: string) => h('kbd', null, code);
    body.append(
      h(
        'div',
        { class: 'pb-ed-statgrid' },
        ...[
          ['Notes', st.notes],
          ['Holds', st.holds],
          ['Chord notes', st.chords],
          ['Avg NPS', st.nps.toFixed(1)],
          ['Peak NPS', st.peakNps],
          ['Stars', estimateLevel(this.map.notes).toFixed(1)],
        ].map(([a, b]) => h('div', null, h('span', null, String(a)), h('b', null, String(b)))),
      ),
      h(
        'div',
        { class: 'pb-inline wrap' },
        btn('Mirror all', () => {
          this.selected.clear();
          this.mirrorSelection();
        }, { cls: 'small', icon: 'mirror' }),
        btn('Holds → taps', () => {
          this.snapshot();
          for (const n of this.map.notes) delete n.e;
        }, { cls: 'small', icon: 'hold' }),
        btn('Clear all notes', async () => {
          if (!(await confirmDialog('Clear all notes?', 'You can undo this with Ctrl+Z.', 'Clear', true))) return;
          this.snapshot();
          this.map.notes = [];
          this.selected.clear();
        }, { cls: 'small danger', icon: 'trash' }),
      ),
      row('Shift every note', h('div', { class: 'pb-inline' }, shiftIn, h('span', null, 'ms'), btn('Apply', () => {
        const d = (parseFloat(shiftIn.value) || 0) / 1000;
        if (!d) return;
        this.snapshot();
        for (const n of this.map.notes) {
          n.t = round4(Math.max(0, n.t + d));
          if (n.e !== undefined) n.e = round4(n.e + d);
        }
      }, { cls: 'small' }))),
      h('h4', null, 'Shortcuts'),
      h(
        'div',
        { class: 'pb-shortcuts' },
        ...[
          [k('Space'), 'Play / pause'],
          [h('span', null, ...this.es.keys.map((c) => k(keyName(c)))), 'Place notes at the playhead (live mapping)'],
          [h('span', null, k('1'), k('2'), k('3')), 'Select / note / hold tool'],
          [h('span', null, 'Wheel · ', k('↑'), k('↓')), 'Move by one snap (Shift: a beat)'],
          [h('span', null, k('Ctrl'), '+ wheel'), 'Zoom'],
          [k('Right-click'), 'Delete a note'],
          [h('span', null, k('Ctrl'), k('C'), k('X'), k('V')), 'Copy / cut / paste at the playhead'],
          [h('span', null, k('Ctrl'), k('Z'), '/', k('Y')), 'Undo / redo'],
          [k('H'), 'Mirror the selection'],
          [k('Del'), 'Delete the selection'],
          [h('span', null, k('F5'), '/', k('T')), 'Test play from here'],
          [h('span', null, k('Ctrl'), k('S')), 'Save'],
        ].map(([a, b]) => h('div', null, a, h('span', null, b as string))),
      ),
    );
  }

  // -------------------------------------------------------------- draw ----

  private resize() {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = r.width;
    this.hgt = r.height;
    this.canvas.width = Math.round(r.width * this.dpr);
    this.canvas.height = Math.round(r.height * this.dpr);
    const m = this.mini.getBoundingClientRect();
    this.mini.width = Math.round(m.width * this.dpr);
    this.mini.height = Math.round(m.height * this.dpr);
  }

  private loop = () => {
    cancelAnimationFrame(this.raf);
    if (!this.el.isConnected) return;
    this.raf = requestAnimationFrame(this.loop);
    if (!this.map) return;
    if (this.clock?.playing) {
      const t = this.clock.now();
      if (t > this.duration + 0.5) this.togglePlay();
      else {
        this.ticks(this.lastTick, t);
        this.lastTick = t;
        this.pos = Math.max(0, t);
      }
    }
    this.draw();
    this.drawMini();
    const tp = this.tpAt(this.pos);
    const beat = beatAt(this.timing, this.pos);
    const bar = Math.floor(beat / (tp.meter || 4)) + 1;
    const bIn = Math.floor(((beat % (tp.meter || 4)) + (tp.meter || 4)) % (tp.meter || 4)) + 1;
    this.timeEl.replaceChildren(h('b', null, `${formatTime(this.pos)}.${String(Math.floor((this.pos % 1) * 1000)).padStart(3, '0')}`), h('span', null, `bar ${bar} · beat ${bIn} · ${tp.bpm} BPM`));
    const st = this.map.notes.length;
    this.statsEl.textContent = `${st} notes${this.selected.size ? ` · ${this.selected.size} selected` : ''}${this.dirty ? ' · unsaved' : ''}`;
  }

  private ticks(a: number, b: number) {
    if (b <= a || b - a > 0.5) return;
    const es = this.es;
    const audio = this.app.audio;
    if (es.hitsounds) {
      for (const n of this.map.notes) {
        if (n.t > a && n.t <= b) audio.hitsound('tick', n.l, undefined, 0.8);
      }
    }
    if (es.metronome) {
      const ba = beatAt(this.timing, a);
      const bb = beatAt(this.timing, b);
      if (Math.floor(bb) > Math.floor(ba)) audio.hitsound(Math.floor(bb) % (this.tpAt(b).meter || 4) === 0 ? 'clap' : 'soft', 1, undefined, 0.7);
    }
  }

  private draw() {
    const c = this.g;
    const W = this.w;
    const H = this.hgt;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, W, H);
    const { laneW, x0, waveX, waveW, lineY, pps, fieldW } = this.geom();
    const tTop = this.yToTime(0);
    const tBot = this.yToTime(H);
    const colors = PALETTES[this.app.settings.palette] || PALETTES.fnf;

    // Waveform / piano roll.
    c.fillStyle = 'rgba(8,8,16,0.55)';
    c.fillRect(waveX, 0, waveW, H);
    if (this.analysis && this.es.waveform) {
      const p = this.analysis.peaks;
      const cx = waveX + waveW / 2;
      for (let y = 0; y < H; y += 2) {
        const t = this.yToTime(y);
        const i = Math.floor(t * p.rate);
        if (i < 0 || i >= p.min.length) continue;
        const amp = (Math.max(Math.abs(p.min[i]), Math.abs(p.max[i])) / 127) * (waveW / 2 - 4);
        const lo = p.low[i] / 255;
        const mid = p.mid[i] / 255;
        const hi = p.high[i] / 255;
        const r = Math.round(90 + 165 * lo);
        const gg = Math.round(60 + 150 * mid);
        const b = Math.round(140 + 115 * hi);
        c.fillStyle = `rgba(${r},${gg},${b},0.85)`;
        c.fillRect(cx - amp, y, amp * 2, 2);
      }
    } else if (this.scoreNotes.length) {
      // Piano roll over the song's own range; right hand blue, left hand orange.
      let lo = 127;
      let hi = 0;
      for (const n of this.scoreNotes) {
        lo = Math.min(lo, n.midi);
        hi = Math.max(hi, n.midi);
      }
      lo -= 1;
      const span = Math.max(12, hi + 2 - lo);
      const step = (waveW - 8) / span;
      const bw = Math.max(3, step - 1.5);
      for (const n of this.scoreNotes) {
        if (n.time > tTop || n.time + n.duration < tBot) continue;
        const x = waveX + 4 + (n.midi - lo) * step;
        const y1 = this.timeToY(n.time);
        const y2 = this.timeToY(n.time + n.duration);
        c.fillStyle = n.hand === 'L' ? 'rgba(255,183,77,0.85)' : 'rgba(79,195,247,0.9)';
        roundRect(c, x, y2, bw, Math.max(3, y1 - y2 - 2), Math.min(3, bw / 2));
        c.fill();
      }
    }

    // Lanes and grid.
    c.fillStyle = 'rgba(6,6,12,0.82)';
    c.fillRect(x0, 0, fieldW, H);
    for (let i = 0; i <= LANES; i++) {
      c.fillStyle = i === 0 || i === LANES ? 'rgba(255,255,255,0.18)' : 'rgba(255,255,255,0.06)';
      c.fillRect(x0 + i * laneW - 0.5, 0, 1, H);
    }
    const div = this.es.snap;
    for (let ti = 0; ti < this.timing.length; ti++) {
      const tp = this.timing[ti];
      const next = this.timing[ti + 1];
      const spb = 60 / tp.bpm;
      const grid = spb / div;
      const from = Math.max(tp.t, tBot);
      const to = Math.min(next ? next.t : Infinity, tTop);
      if (to < from) continue;
      let k = Math.floor((from - tp.t) / grid);
      for (let t = tp.t + k * grid; t <= to + 1e-6; k++, t = tp.t + k * grid) {
        if (t < from - 1e-6) continue;
        const y = this.timeToY(t);
        const sub = ((k % div) + div) % div;
        const beatIdx = Math.round((t - tp.t) / spb);
        const isBeat = sub === 0;
        const isBar = isBeat && ((beatIdx % (tp.meter || 4)) + (tp.meter || 4)) % (tp.meter || 4) === 0;
        let col = 'rgba(255,255,255,0.08)';
        if (isBar) col = 'rgba(255,255,255,0.55)';
        else if (isBeat) col = 'rgba(255,255,255,0.28)';
        else {
          const d = div / gcd(sub, div);
          const sc = SNAP_COLORS.find(([x]) => x === d)?.[1] || '#888';
          col = hexA(sc, 0.35);
        }
        c.fillStyle = col;
        c.fillRect(x0, y - (isBar ? 1 : 0.5), fieldW, isBar ? 2 : 1);
        if (isBar) {
          c.fillStyle = 'rgba(255,255,255,0.6)';
          c.font = "600 11px 'Outfit Variable', system-ui, sans-serif";
          c.textAlign = 'left';
          c.fillText(String(Math.floor(beatAt(this.timing, t) / (tp.meter || 4)) + 1), x0 + fieldW + 8, y + 4);
        }
      }
    }

    // Preview point & song end.
    const pv = this.song.previewTime;
    if (pv >= 0 && pv >= tBot && pv <= tTop) {
      const y = this.timeToY(pv);
      c.fillStyle = 'rgba(255, 210, 77, 0.8)';
      c.fillRect(x0 - 10, y - 1, fieldW + 20, 2);
      c.font = "600 10px 'Outfit Variable', system-ui";
      c.fillText('PREVIEW', x0 - 60, y + 4);
    }

    // Notes.
    const noteH = Math.max(10, laneW * 0.24);
    for (const n of this.map.notes) {
      const end = n.e ?? n.t;
      if (end < tBot - 0.2 || n.t > tTop + 0.2) continue;
      const col = colors[n.l];
      const x = x0 + n.l * laneW + 4;
      const y = this.timeToY(n.t);
      const sel = this.selected.has(n);
      if (n.e !== undefined) {
        const y2 = this.timeToY(n.e);
        c.fillStyle = hexA(col, 0.5);
        roundRect(c, x + laneW * 0.22, y2, laneW - 8 - laneW * 0.44, y - y2, 6);
        c.fill();
        if (sel) {
          c.strokeStyle = '#fff';
          c.lineWidth = 2;
          c.stroke();
        }
      }
      const grad = c.createLinearGradient(0, y - noteH / 2, 0, y + noteH / 2);
      grad.addColorStop(0, mixHex(col, '#ffffff', 0.4));
      grad.addColorStop(1, col);
      c.fillStyle = grad;
      roundRect(c, x, y - noteH / 2, laneW - 8, noteH, 5);
      c.fill();
      if (n.s) {
        c.fillStyle = 'rgba(0,0,0,0.45)';
        c.fillRect(x + laneW - 18, y - 3, 6, 6);
      }
      if (sel) {
        c.strokeStyle = '#ffffff';
        c.lineWidth = 2.5;
        roundRect(c, x - 1, y - noteH / 2 - 1, laneW - 6, noteH + 2, 6);
        c.stroke();
      }
    }

    // Ghost of what a click would add.
    const hv = this.hover;
    if (hv && !this.drag && this.tool !== 'select') {
      const y = this.timeToY(hv.t);
      c.globalAlpha = 0.35;
      c.fillStyle = colors[hv.lane];
      roundRect(c, x0 + hv.lane * laneW + 4, y - noteH / 2, laneW - 8, noteH, 5);
      c.fill();
      c.globalAlpha = 1;
    }
    const d = this.drag;
    if (d?.kind === 'hold') {
      const y1 = this.timeToY(d.t0);
      const y2 = this.timeToY(this.snapTime(this.yToTime(d.y1)));
      c.globalAlpha = 0.6;
      c.fillStyle = colors[d.lane0];
      roundRect(c, x0 + d.lane0 * laneW + laneW * 0.22 + 4, Math.min(y1, y2), laneW - 8 - laneW * 0.44, Math.abs(y1 - y2), 6);
      c.fill();
      c.globalAlpha = 1;
    } else if (d?.kind === 'box') {
      c.fillStyle = 'rgba(140,108,255,0.15)';
      c.strokeStyle = 'rgba(180,160,255,0.9)';
      c.lineWidth = 1;
      const bx = Math.min(d.x0, d.x1);
      const by = Math.min(d.y0, d.y1);
      c.fillRect(bx, by, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
      c.strokeRect(bx, by, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
    }

    // Playhead.
    const glow = c.createLinearGradient(0, lineY - 14, 0, lineY + 14);
    glow.addColorStop(0, 'rgba(255,60,172,0)');
    glow.addColorStop(0.5, 'rgba(255,60,172,0.35)');
    glow.addColorStop(1, 'rgba(255,60,172,0)');
    c.fillStyle = glow;
    c.fillRect(waveX, lineY - 14, fieldW + (x0 - waveX) + 40, 28);
    c.fillStyle = '#ff3cac';
    c.fillRect(waveX, lineY - 1.5, fieldW + (x0 - waveX) + 40, 3);
    c.fillStyle = 'rgba(255,255,255,0.75)';
    c.font = "600 11px 'Outfit Variable', system-ui";
    c.textAlign = 'right';
    c.fillText(formatTime(this.pos), waveX - 8, lineY + 4);
    c.textAlign = 'left';
    void pps;
  }

  private drawMini() {
    const c = this.mg;
    const W = this.mini.width / this.dpr;
    const H = this.mini.height / this.dpr;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, W, H);
    c.fillStyle = 'rgba(8,8,16,0.6)';
    c.fillRect(0, 0, W, H);
    const dur = Math.max(1, this.duration);
    const colors = PALETTES[this.app.settings.palette] || PALETTES.fnf;
    // Energy (audio) as a faint silhouette.
    if (this.analysis) {
      const e = this.analysis.energy;
      c.fillStyle = 'rgba(140,108,255,0.25)';
      for (let i = 0; i < e.length; i++) {
        const y = H - ((i * 0.5) / dur) * H;
        c.fillRect(0, y - H / e.length, W * e[i], Math.max(1, H / e.length + 0.5));
      }
    }
    const lw = W / LANES;
    for (const n of this.map.notes) {
      const y = H - (n.t / dur) * H;
      c.fillStyle = colors[n.l];
      c.fillRect(n.l * lw + 2, y, lw - 4, 1.5);
    }
    const { lineY, pps } = this.geom();
    const top = this.pos + lineY / pps;
    const bottom = this.pos - (this.hgt - lineY) / pps;
    const y1 = H - (top / dur) * H;
    const y2 = H - (bottom / dur) * H;
    c.strokeStyle = 'rgba(255,255,255,0.8)';
    c.lineWidth = 1;
    c.strokeRect(0.5, y1, W - 1, Math.max(4, y2 - y1));
    c.fillStyle = '#ff3cac';
    c.fillRect(0, H - (this.pos / dur) * H - 1, W, 2);
  }
}

function round4(v: number) {
  return Math.round(v * 10000) / 10000;
}

function gcd(a: number, b: number): number {
  return b ? gcd(b, a % b) : a;
}

export { timeAtBeat, uid };
