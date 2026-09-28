// Clicker mode: the score only moves when you tap. Every key press, mouse
// click or MIDI note plays the next chord – so mashing keys in rhythm
// "performs" the piece. Optionally one hand is tapped while the other hand
// follows automatically at the tempo you are tapping.

import { Emitter } from '../core/emitter';
import type { PianoEngine } from '../audio/engine';
import type { Hand, Score, ScoreNote } from '../score/model';

export interface ClickerOptions {
  /** 'tap': each tap plays one chord at your tempo. 'flow': taps keep the music going at its written timing. */
  style: 'tap' | 'flow';
  target: 'both' | Hand;
  duration: 'natural' | 'hold' | 'next';
  velocity: 'score' | 'input' | 'fixed';
  fixedVelocity: number;
  allowRepeat: boolean;
  accompany: boolean;
}

interface Step {
  time: number;
  notes: ScoreNote[];
  /** Notes of the other hand that fall between this step and the next. */
  accompaniment: ScoreNote[];
}

interface Pending {
  at: number;
  midi: number;
  velocity: number;
  duration: number;
  hand: Hand;
}

export interface ClickerEvents {
  step: { index: number; total: number; time: number };
  end: undefined;
}

const CHORD_WINDOW = 0.035;

export class Clicker extends Emitter<ClickerEvents> {
  options: ClickerOptions = { style: 'tap', target: 'both', duration: 'natural', velocity: 'score', fixedVelocity: 90, allowRepeat: false, accompany: true };
  private score: Score | null = null;
  private steps: Step[] = [];
  private index = 0;
  private lastTap = 0;
  private rate = 1;
  private byInput = new Map<string, number[]>();
  private sinceLastTap: number[] = [];
  private pending: Pending[] = [];
  private timer = 0;
  private sustainDown = false;
  private lit: { midi: number; hand: Hand; until: number; input: string }[] = [];
  active = false;

  constructor(private engine: PianoEngine) {
    super();
  }

  load(score: Score | null) {
    this.score = score;
    this.build();
  }

  setOptions(o: Partial<ClickerOptions>) {
    const rebuild = o.target !== undefined && o.target !== this.options.target;
    this.options = { ...this.options, ...o };
    if (rebuild) this.build();
  }

  private build() {
    const t = this.index < this.steps.length ? this.steps[this.index]?.time ?? 0 : 0;
    this.steps = [];
    const s = this.score;
    if (!s) return;
    const target = this.options.target;
    const isStepNote = (n: ScoreNote) => target === 'both' || n.hand === target;
    for (const n of s.notes) {
      if (!isStepNote(n)) continue;
      const last = this.steps[this.steps.length - 1];
      if (last && n.time - last.time < CHORD_WINDOW) last.notes.push(n);
      else this.steps.push({ time: n.time, notes: [n], accompaniment: [] });
    }
    if (target !== 'both') {
      let k = 0;
      for (const n of s.notes) {
        if (isStepNote(n)) continue;
        while (k + 1 < this.steps.length && this.steps[k + 1].time <= n.time + CHORD_WINDOW) k++;
        if (this.steps[k]) this.steps[k].accompaniment.push(n);
      }
    }
    this.index = Math.max(0, this.steps.findIndex((st) => st.time >= t - 1e-6));
    this.emitStep();
  }

  get total() {
    return this.steps.length;
  }

  /** Onset time of every step (chord), for flow mode's tap points. */
  stepTimes(): number[] {
    return this.steps.map((s) => s.time);
  }

  /** Notes of the step at or after score time `t` (flow-mode hints). */
  notesAt(t: number): ScoreNote[] {
    return this.steps.find((s) => s.time >= t - 1e-3)?.notes || [];
  }

  get current() {
    return this.index;
  }

  /** Score time of the most recently played step (for visuals). */
  get position(): number {
    if (!this.steps.length) return 0;
    const i = Math.max(0, this.index - 1);
    return this.index === 0 ? Math.max(0, this.steps[0].time - 0.25) : this.steps[i].time;
  }

  /** Score time of the next chord to be tapped. */
  get nextTime(): number {
    return this.steps[this.index]?.time ?? this.score?.duration ?? 0;
  }

  /** Notes that will sound on the next tap. */
  get upcoming(): ScoreNote[] {
    return this.steps[this.index]?.notes || [];
  }

  start() {
    this.active = true;
    clearInterval(this.timer);
    this.timer = window.setInterval(() => this.pump(), 10);
  }

  stop() {
    this.active = false;
    clearInterval(this.timer);
    this.pending = [];
    this.releaseAllNotes();
  }

  reset() {
    this.releaseAllNotes();
    this.pending = [];
    this.index = 0;
    this.lastTap = 0;
    this.rate = 1;
    this.emitStep();
  }

  back(n = 1) {
    this.index = Math.max(0, this.index - n);
    this.lastTap = 0;
    this.emitStep();
  }

  seek(time: number) {
    const i = this.steps.findIndex((s) => s.time >= time - 1e-6);
    this.index = i < 0 ? this.steps.length : i;
    this.lastTap = 0;
    this.emitStep();
  }

  /**
   * A tap from any input. `inputId` identifies the key/button so "hold" mode
   * can release the notes when that same input is let go.
   */
  tap(inputId: string, inputVelocity = 96) {
    if (!this.score || !this.steps.length) return;
    if (this.index >= this.steps.length) {
      this.emit('end', undefined);
      return;
    }
    void this.engine.resume();
    const now = this.engine.ctx.currentTime;
    const step = this.steps[this.index];
    const prev = this.steps[this.index - 1];

    // Estimate how fast the user is going compared with the written tempo.
    if (prev && this.lastTap) {
      const scoreDt = step.time - prev.time;
      const realDt = now - this.lastTap;
      if (realDt > 0.02 && scoreDt > 0.01 && realDt < 4) {
        const r = Math.min(6, Math.max(0.15, scoreDt / realDt));
        this.rate = this.rate * 0.35 + r * 0.65;
      }
    } else {
      this.rate = 1;
    }
    this.lastTap = now;

    if (this.options.duration === 'next') {
      for (const m of this.sinceLastTap) this.engine.noteOff(m, now);
      this.sinceLastTap = [];
      for (const l of this.lit) l.until = Math.min(l.until, now);
    }
    // Accompaniment from the previous step that has not sounded yet is dropped.
    this.pending = [];

    this.applyPedal(prev ? prev.time : -1, step.time, now);

    const played: number[] = [];
    for (const n of step.notes) {
      const vel = this.velocityFor(n, inputVelocity);
      this.engine.noteOn(n.midi, vel, now);
      played.push(n.midi);
      let until = Infinity;
      if (this.options.duration === 'natural') {
        const dur = Math.min(8, Math.max(0.08, n.duration / this.rate));
        this.engine.noteOff(n.midi, now + dur);
        until = now + dur;
      }
      this.lit.push({ midi: n.midi, hand: n.hand, until, input: inputId });
    }
    if (this.options.duration === 'hold') {
      this.byInput.set(inputId, [...(this.byInput.get(inputId) || []), ...played]);
    } else if (this.options.duration === 'next') {
      this.sinceLastTap.push(...played);
    }

    if (this.options.accompany && this.options.target !== 'both') {
      for (const n of step.accompaniment) {
        this.pending.push({
          at: now + Math.max(0, n.time - step.time) / this.rate,
          midi: n.midi,
          velocity: Math.round(n.velocity * 127),
          duration: Math.min(8, Math.max(0.06, n.duration / this.rate)),
          hand: n.hand,
        });
      }
      this.pump();
    }

    this.index++;
    this.emitStep();
    if (this.index >= this.steps.length) this.emit('end', undefined);
  }

  /** The input that tapped was released ("hold" duration mode). */
  release(inputId: string) {
    const notes = this.byInput.get(inputId);
    if (!notes) return;
    this.byInput.delete(inputId);
    const now = this.engine.ctx.currentTime;
    for (const m of notes) this.engine.noteOff(m, now);
    for (const l of this.lit) if (l.input === inputId) l.until = Math.min(l.until, now);
  }

  /** Keys currently sounding because of taps (for highlighting). */
  litNotes(): { midi: number; hand: Hand }[] {
    const now = this.engine.ctx.currentTime;
    this.lit = this.lit.filter((l) => l.until > now);
    return this.lit;
  }

  private velocityFor(n: ScoreNote, input: number) {
    switch (this.options.velocity) {
      case 'input':
        return input;
      case 'fixed':
        return this.options.fixedVelocity;
      default:
        return Math.max(1, Math.round(n.velocity * 127));
    }
  }

  /** Mirrors the score's pedalling between two steps, re-pedalling where the score lifts. */
  private applyPedal(fromTime: number, toTime: number, now: number) {
    const pedals = this.score?.pedals.filter((p) => p.kind === 'sustain') || [];
    if (!pedals.length) return;
    let lifted = false;
    let state = this.sustainDown;
    for (const p of pedals) {
      if (p.time > toTime + 0.05) break;
      if (p.time > fromTime + 1e-6 || fromTime < 0) {
        if (p.value < 0.5 && state) lifted = true;
        state = p.value >= 0.5;
      }
    }
    if (lifted) this.engine.setSustain(0, now);
    if (state) this.engine.setSustain(1, now + (lifted ? 0.012 : 0));
    else if (!lifted && this.sustainDown) this.engine.setSustain(0, now);
    this.sustainDown = state;
  }

  private pump() {
    if (!this.pending.length) return;
    const now = this.engine.ctx.currentTime;
    const due = this.pending.filter((p) => p.at <= now + 0.03);
    if (!due.length) return;
    this.pending = this.pending.filter((p) => p.at > now + 0.03);
    for (const p of due) {
      const at = Math.max(now, p.at);
      this.engine.noteOn(p.midi, p.velocity, at);
      this.engine.noteOff(p.midi, at + p.duration);
      this.lit.push({ midi: p.midi, hand: p.hand, until: at + p.duration, input: '' });
    }
  }

  private releaseAllNotes() {
    const now = this.engine.ctx.currentTime;
    this.lit = [];
    for (const notes of this.byInput.values()) for (const m of notes) this.engine.noteOff(m, now);
    this.byInput.clear();
    for (const m of this.sinceLastTap) this.engine.noteOff(m, now);
    this.sinceLastTap = [];
    if (this.sustainDown) this.engine.setSustain(0, now);
    this.sustainDown = false;
  }

  private emitStep() {
    this.emit('step', { index: this.index, total: this.steps.length, time: this.position });
  }
}
