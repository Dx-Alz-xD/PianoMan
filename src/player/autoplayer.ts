// Plays a Score through the engine with a sample-accurate lookahead scheduler.
// Supports speed changes, seeking, A–B looping, per-hand muting, a
// score-synchronised metronome, count-in, and a "wait for me" practice mode.

import { Emitter } from '../core/emitter';
import type { Metronome } from '../audio/metronome';
import type { PianoEngine } from '../audio/engine';
import { TempoMap, type Hand, type Score, type ScoreNote } from '../score/model';

interface TimedEvent {
  time: number;
  type: 0 | 1 | 2; // 0 = off, 1 = pedal, 2 = on (order at equal times)
  midi: number;
  velocity: number;
  value: number;
  kind: 'sustain' | 'soft' | 'sostenuto';
}

export type PlayerState = 'stopped' | 'playing' | 'paused' | 'waiting' | 'counting';

export interface AutoPlayerEvents {
  state: { state: PlayerState; position: number };
  end: undefined;
  wait: { required: number[] };
  /** Flow mode: the playhead passed a tap point. */
  gate: { index: number; total: number };
}

const LOOKAHEAD = 0.15;
const TICK_MS = 20;

export class AutoPlayer extends Emitter<AutoPlayerEvents> {
  score: Score | null = null;
  speed = 1;
  hands: Record<Hand, boolean> = { L: true, R: true };
  loop: { a: number; b: number } | null = null;
  loopWhole = false;
  applyPedal = true;
  velocityScale = 1;
  humanize = 0;
  countIn = false;
  metronomeOn = false;
  waitMode = false;
  /** Only notes for which this returns true are played (the 4K game plays the rest on hits). */
  noteFilter: ((n: ScoreNote) => boolean) | null = null;

  private events: TimedEvent[] = [];
  private idx = 0;
  private state: PlayerState = 'stopped';
  private startCtx = 0;
  private startPos = 0;
  private pausedAt = 0;
  private timer = 0;
  private held = new Map<number, number>();
  private tempo = new TempoMap([{ beat: 0, bpm: 120 }]);
  private nextClickBeat = 0;
  private waitPoints: { time: number; midis: number[] }[] = [];
  private waitIdx = 0;
  private pressed = new Set<number>();
  private waitingFor: Set<number> | null = null;
  /** Flow mode: taps unlock the timeline chord by chord; playback keeps the written timing. */
  private gate: { times: number[]; idx: number; credits: number; max: number } | null = null;
  private gateWaiting = false;

  constructor(private engine: PianoEngine, private metronome: Metronome) {
    super();
  }

  private get ctx() {
    return this.engine.ctx;
  }

  load(score: Score | null) {
    this.stop();
    this.score = score;
    this.loop = null;
    this.tempo = new TempoMap(score ? score.tempos : [{ beat: 0, bpm: 120 }]);
    this.rebuild();
    this.pausedAt = 0;
    this.emitState();
  }

  /** Rebuilds the event list (after hand/pedal options change). */
  rebuild() {
    const s = this.score;
    this.events = [];
    this.waitPoints = [];
    if (!s) return;
    const ev: TimedEvent[] = [];
    for (const n of s.notes) {
      if (!this.hands[n.hand]) continue;
      if (this.noteFilter && !this.noteFilter(n)) continue;
      const jitter = this.humanize ? (Math.random() - 0.5) * 0.03 * this.humanize : 0;
      const vel = Math.max(1, Math.min(127, Math.round(n.velocity * 127 * this.velocityScale * (1 + (this.humanize ? (Math.random() - 0.5) * 0.2 * this.humanize : 0)))));
      const t = Math.max(0, n.time + jitter);
      ev.push({ time: t, type: 2, midi: n.midi, velocity: vel, value: 0, kind: 'sustain' });
      ev.push({ time: t + Math.max(0.03, n.duration - 0.005), type: 0, midi: n.midi, velocity: 0, value: 0, kind: 'sustain' });
    }
    if (this.applyPedal) for (const p of s.pedals) ev.push({ time: p.time, type: 1, midi: 0, velocity: 0, value: p.value, kind: p.kind });
    ev.sort((a, b) => a.time - b.time || a.type - b.type);
    this.events = ev;

    // Practice: stop at every chord of the hands the user plays.
    const userHands = (['L', 'R'] as Hand[]).filter((h) => !this.hands[h]);
    if (userHands.length) {
      const groups: { time: number; midis: number[] }[] = [];
      for (const n of s.notes) {
        if (this.hands[n.hand]) continue;
        const g = groups[groups.length - 1];
        if (g && n.time - g.time < 0.04) {
          if (!g.midis.includes(n.midi)) g.midis.push(n.midi);
        } else groups.push({ time: n.time, midis: [n.midi] });
      }
      this.waitPoints = groups;
    }
    if (this.state === 'playing' || this.state === 'waiting') this.restartAt(this.position);
  }

  get playerState() {
    return this.state;
  }

  get isPlaying() {
    return this.state === 'playing' || this.state === 'waiting' || this.state === 'counting';
  }

  get duration() {
    return this.score?.duration || 0;
  }

  /** Current position in score seconds (what is being scheduled now). */
  get position(): number {
    if (this.state === 'playing') return Math.max(0, this.startPos + (this.ctx.currentTime - this.startCtx) * this.speed);
    if (this.state === 'counting') return this.startPos;
    return this.pausedAt;
  }

  /** Position corrected for output latency – use this for visuals. */
  get visualPosition(): number {
    if (this.state !== 'playing') return this.position;
    const lat = ((this.ctx as AudioContext & { outputLatency?: number }).outputLatency || 0) + (this.ctx.baseLatency || 0);
    return Math.max(this.startPos, this.startPos + (this.ctx.currentTime - lat - this.startCtx) * this.speed);
  }

  get tempoMap() {
    return this.tempo;
  }

  /** Unclamped song time as heard (negative during a lead-in); for the rhythm game clock. */
  songTime(ctxNow = this.ctx.currentTime, compensate = true): number {
    if (this.state !== 'playing' && this.state !== 'counting') return this.pausedAt;
    const lat = compensate ? ((this.ctx as AudioContext & { outputLatency?: number }).outputLatency || 0) + (this.ctx.baseLatency || 0) : 0;
    return this.startPos + (ctxNow - lat - this.startCtx) * this.speed;
  }

  /** The audio-context time at which score time `pos` is scheduled. */
  ctxTimeFor(pos: number): number {
    return this.ctxTimeOf(pos);
  }

  /** Starts playback of `pos` at a precise (possibly future) audio time. */
  startFrom(pos: number, ctxTime: number) {
    if (!this.score) return;
    this.halt();
    void this.engine.resume();
    this.state = ctxTime > this.ctx.currentTime + 0.05 ? 'counting' : 'playing';
    this.startPos = Math.max(0, pos);
    this.emitState();
    this.startAt(this.startPos, ctxTime);
  }

  // ------------------------------------------------------------ flow gate ----

  /** Enables flow mode with a tap point at each of `times`; `max` taps can be banked ahead. */
  setGate(times: number[] | null, max = 2) {
    this.gate = times ? { times, idx: 0, credits: 0, max } : null;
    this.gateWaiting = false;
    if (this.gate) this.gate.idx = this.gateIndexAt(this.position);
  }

  get gateProgress() {
    return this.gate ? { index: this.gate.idx, total: this.gate.times.length } : null;
  }

  private gateIndexAt(pos: number) {
    if (!this.gate) return 0;
    const i = this.gate.times.findIndex((t) => t >= pos - 0.001);
    return i < 0 ? this.gate.times.length : i;
  }

  /** A tap in flow mode: lets the music continue to the next chord. */
  gateTap() {
    const g = this.gate;
    if (!g) return;
    if (!this.isPlaying) {
      g.credits = 1;
      this.play();
      return;
    }
    if (this.gateWaiting) {
      this.gateWaiting = false;
      g.credits = 0;
      this.passGate();
      this.startPos = this.pausedAt;
      this.startCtx = this.ctx.currentTime + 0.005;
      this.state = 'playing';
      this.emitState();
      this.tick();
      return;
    }
    g.credits = Math.min(g.max, g.credits + 1);
  }

  private passGate() {
    const g = this.gate!;
    g.idx++;
    this.emit('gate', { index: g.idx, total: g.times.length });
  }

  play() {
    if (!this.score || this.isPlaying) return;
    void this.engine.resume();
    let from = this.pausedAt;
    if (from >= this.duration - 0.01) from = this.loop ? this.loop.a : 0;
    if (this.countIn) {
      const beat = this.tempo.timeToBeat(from);
      const bpm = this.tempo.bpmAt(beat) * this.speed;
      const sig = this.score.timeSignatures.filter((t) => t.beat <= beat + 1e-6).pop() || { num: 4, den: 4 };
      const beats = sig.num;
      const beatDur = (60 / bpm) * (4 / sig.den);
      const t0 = this.ctx.currentTime + 0.08;
      for (let i = 0; i < beats; i++) this.metronome.click(t0 + i * beatDur, i === 0);
      this.state = 'counting';
      this.startPos = from;
      this.emitState();
      this.startAt(from, t0 + beats * beatDur);
      return;
    }
    this.startAt(from, this.ctx.currentTime + 0.06);
  }

  private startAt(pos: number, ctxTime: number) {
    this.startPos = pos;
    this.startCtx = ctxTime;
    this.idx = this.lowerBound(pos);
    this.waitIdx = this.waitPoints.findIndex((w) => w.time >= pos - 0.001);
    if (this.waitIdx < 0) this.waitIdx = this.waitPoints.length;
    if (this.gate) this.gate.idx = this.gateIndexAt(pos);
    this.gateWaiting = false;
    this.nextClickBeat = Math.ceil(this.tempo.timeToBeat(pos) - 1e-6);
    this.applyPedalStateAt(pos, ctxTime);
    clearInterval(this.timer);
    this.timer = window.setInterval(() => this.tick(), TICK_MS);
    if (this.state === 'counting') {
      // Events are scheduled normally; the start time simply lies in the future.
      window.setTimeout(() => {
        if (this.state === 'counting') {
          this.state = 'playing';
          this.emitState();
        }
      }, Math.max(0, (ctxTime - this.ctx.currentTime) * 1000));
    } else {
      this.state = 'playing';
      this.emitState();
    }
    this.tick();
  }

  private restartAt(pos: number) {
    this.releaseAll();
    this.startAt(pos, this.ctx.currentTime + 0.03);
  }

  pause() {
    if (!this.isPlaying) return;
    this.pausedAt = Math.min(this.position, this.duration);
    this.halt();
    this.state = 'paused';
    this.emitState();
  }

  stop() {
    const was = this.state;
    this.halt();
    this.pausedAt = this.loop ? this.loop.a : 0;
    this.state = 'stopped';
    if (was !== 'stopped') this.emitState();
  }

  toggle() {
    if (this.isPlaying) this.pause();
    else this.play();
  }

  seek(pos: number) {
    pos = Math.max(0, Math.min(pos, this.duration));
    if (this.isPlaying && this.state !== 'counting') {
      this.restartAt(pos);
    } else {
      this.pausedAt = pos;
      this.emitState();
    }
  }

  setSpeed(speed: number) {
    const pos = this.position;
    this.speed = Math.max(0.1, Math.min(3, speed));
    if (this.state === 'playing') this.restartAt(pos);
  }

  setHands(hands: Partial<Record<Hand, boolean>>) {
    this.hands = { ...this.hands, ...hands };
    this.rebuild();
  }

  setLoop(a: number | null, b: number | null) {
    if (a === null || b === null || b - a < 0.2) this.loop = null;
    else this.loop = { a: Math.max(0, a), b: Math.min(b, this.duration) };
    this.emitState();
  }

  /** Called for every note the user plays (drives "wait for me"). */
  userNoteOn(midi: number) {
    this.pressed.add(midi);
    if (this.state === 'waiting' && this.waitingFor) {
      this.waitingFor.delete(midi);
      if (this.waitingFor.size === 0) this.resumeFromWait();
    }
  }

  userNoteOff(midi: number) {
    this.pressed.delete(midi);
  }

  private resumeFromWait() {
    this.waitingFor = null;
    const point = this.waitPoints[this.waitIdx];
    this.waitIdx++;
    this.startPos = point ? point.time : this.pausedAt;
    this.startCtx = this.ctx.currentTime + 0.01;
    this.state = 'playing';
    this.emitState();
    this.tick();
  }

  private halt() {
    clearInterval(this.timer);
    this.timer = 0;
    this.releaseAll();
    this.waitingFor = null;
    this.gateWaiting = false;
  }

  private releaseAll() {
    const now = this.ctx.currentTime;
    this.engine.cancelScheduled(now);
    for (const [midi, count] of this.held) for (let i = 0; i < count; i++) this.engine.noteOff(midi, now);
    this.held.clear();
    if (this.applyPedal && this.score?.pedals.length) {
      this.engine.setSustain(0, now);
      this.engine.setSostenuto(false, now);
      this.engine.setSoft(false);
    }
  }

  private applyPedalStateAt(pos: number, when: number) {
    if (!this.applyPedal || !this.score) return;
    const state = { sustain: 0, soft: 0, sostenuto: 0 };
    for (const p of this.score.pedals) {
      if (p.time > pos) break;
      state[p.kind] = p.value;
    }
    this.engine.setSustain(state.sustain, when);
    this.engine.setSoft(state.soft >= 0.5);
    this.engine.setSostenuto(state.sostenuto >= 0.5, when);
  }

  private lowerBound(pos: number) {
    let lo = 0;
    let hi = this.events.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.events[mid].time < pos - 1e-6) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private ctxTimeOf(pos: number) {
    return this.startCtx + (pos - this.startPos) / this.speed;
  }

  private tick() {
    if (this.state !== 'playing' && this.state !== 'counting') return;
    this.schedule(this.ctx.currentTime + LOOKAHEAD);
  }

  private schedule(horizonCtx: number) {
    const s = this.score;
    if (!s) return;
    let horizonPos = this.startPos + (horizonCtx - this.startCtx) * this.speed;

    // Flow mode: the timeline only runs past a tap point once a tap has been banked.
    const g = this.gate;
    while (g && g.idx < g.times.length && horizonPos >= g.times[g.idx]) {
      if (g.credits > 0) {
        g.credits--;
        this.passGate();
        continue;
      }
      const t = g.times[g.idx];
      horizonPos = t;
      if (this.state === 'playing' && this.position >= t - 0.005) {
        this.flush(t - 1e-6);
        this.pausedAt = t;
        this.state = 'waiting';
        this.gateWaiting = true;
        this.emitState();
        return;
      }
      break;
    }

    // Practice mode: hold the timeline at the next chord the user must play.
    const wp = this.waitMode ? this.waitPoints[this.waitIdx] : undefined;
    if (wp && horizonPos >= wp.time) {
      horizonPos = wp.time;
      const reached = this.state === 'playing' && this.position >= wp.time - 0.005;
      if (reached) {
        this.flush(wp.time - 1e-6);
        const missing = wp.midis.filter((m) => !this.pressed.has(m));
        if (!missing.length) {
          this.waitIdx++;
        } else {
          this.pausedAt = wp.time;
          this.state = 'waiting';
          this.waitingFor = new Set(missing);
          this.emit('wait', { required: wp.midis });
          this.emitState();
          return;
        }
      }
    }

    // Loop A–B (or the whole piece).
    const loopEnd = this.loop ? this.loop.b : this.loopWhole ? s.duration + 0.3 : Infinity;
    if (horizonPos >= loopEnd) {
      this.flush(loopEnd - 1e-6);
      const endCtx = this.ctxTimeOf(loopEnd);
      for (const [midi, count] of this.held) for (let i = 0; i < count; i++) this.engine.noteOff(midi, endCtx);
      this.held.clear();
      const a = this.loop ? this.loop.a : 0;
      this.startPos = a;
      this.startCtx = endCtx;
      this.idx = this.lowerBound(a);
      this.waitIdx = Math.max(0, this.waitPoints.findIndex((w) => w.time >= a - 0.001));
      this.nextClickBeat = Math.ceil(this.tempo.timeToBeat(a) - 1e-6);
      this.applyPedalStateAt(a, endCtx);
      horizonPos = this.startPos + (horizonCtx - this.startCtx) * this.speed;
    }

    this.flush(horizonPos);

    if (this.metronomeOn) this.scheduleClicks(horizonPos);

    if (!this.loop && !this.loopWhole && this.idx >= this.events.length && this.position > s.duration + 0.25) {
      this.halt();
      this.pausedAt = 0;
      this.state = 'stopped';
      this.emitState();
      this.emit('end', undefined);
    }
  }

  private flush(untilPos: number) {
    const now = this.ctx.currentTime;
    while (this.idx < this.events.length && this.events[this.idx].time <= untilPos) {
      const e = this.events[this.idx++];
      const when = Math.max(now, this.ctxTimeOf(e.time));
      if (e.type === 2) {
        this.engine.noteOn(e.midi, e.velocity, when);
        this.held.set(e.midi, (this.held.get(e.midi) || 0) + 1);
      } else if (e.type === 0) {
        const c = this.held.get(e.midi) || 0;
        if (c > 0) {
          this.engine.noteOff(e.midi, when);
          if (c === 1) this.held.delete(e.midi);
          else this.held.set(e.midi, c - 1);
        }
      } else if (e.kind === 'sustain') this.engine.setSustain(e.value, when);
      else if (e.kind === 'soft') this.engine.setSoft(e.value >= 0.5);
      else this.engine.setSostenuto(e.value >= 0.5, when);
    }
  }

  private scheduleClicks(untilPos: number) {
    const s = this.score!;
    for (;;) {
      const t = this.tempo.beatToTime(this.nextClickBeat);
      if (t > untilPos) break;
      const beat = this.nextClickBeat;
      const measure = [...s.measures].reverse().find((m) => m.beat <= beat + 1e-6);
      const downbeat = measure ? Math.abs(beat - measure.beat) < 1e-6 : beat % 4 === 0;
      const when = this.ctxTimeOf(t);
      if (when >= this.ctx.currentTime - 0.01) this.metronome.click(Math.max(this.ctx.currentTime, when), downbeat && this.metronome.accent);
      this.nextClickBeat++;
    }
  }

  private emitState() {
    this.emit('state', { state: this.state, position: this.position });
  }

  /** Notes sounding at score time t (for key highlighting). */
  activeNotesAt(t: number): { midi: number; hand: Hand }[] {
    const s = this.score;
    if (!s) return [];
    const out: { midi: number; hand: Hand }[] = [];
    // Notes are sorted by start; scan a window of the longest possible note.
    let lo = 0;
    let hi = s.notes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (s.notes[mid].time <= t) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo - 1; i >= 0 && i > lo - 400; i--) {
      const n = s.notes[i];
      if (n.time <= t && t < n.time + n.duration) out.push({ midi: n.midi, hand: n.hand });
    }
    return out;
  }
}
