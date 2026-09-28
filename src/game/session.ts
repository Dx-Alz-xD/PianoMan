// The state of one play-through of a 4K chart: which notes were hit or
// missed, holds in progress, and the score. Times are song (score) seconds;
// judgement windows are real seconds, so they stay the same at any speed.

import type { Chart, ChartNote } from './chart';
import { judge, MISS_WINDOW, ScoreKeeper, type Judgement } from './judge';

export interface NoteState {
  note: ChartNote;
  judged: Judgement | null;
  delta: number;
  holding: boolean;
  tail: Judgement | null;
}

export interface HitEvent {
  lane: number;
  judgement: Judgement;
  delta: number;
  state: NoteState;
  kind: 'head' | 'tail' | 'miss';
}

/** Releasing a hold this close to its end (real seconds) still counts as complete. */
const TAIL_GRACE = 0.12;

export class GameSession {
  readonly keeper = new ScoreKeeper();
  readonly states: NoteState[];
  private lanes: NoteState[][] = [[], [], [], []];
  private cursor = [0, 0, 0, 0];
  private missCursor = 0;
  private active = new Set<NoteState>();

  constructor(readonly chart: Chart, readonly speed = 1) {
    this.states = chart.notes.map((note) => ({ note, judged: null, delta: 0, holding: false, tail: note.end === null ? 'perfect' : null }));
    for (const s of this.states) this.lanes[s.note.lane].push(s);
  }

  /** Real-time difference between the song time `t` and a note time. */
  private real(t: number, noteTime: number) {
    return (t - noteTime) / this.speed;
  }

  /** A key went down in `lane` at song time `t`. Returns the hit, or null for a ghost tap. */
  press(lane: number, t: number): HitEvent | null {
    const list = this.lanes[lane];
    let i = this.cursor[lane];
    while (i < list.length && list[i].judged !== null) i++;
    this.cursor[lane] = i;
    const s = list[i];
    if (!s) return null;
    const delta = this.real(t, s.note.time);
    const j = judge(delta);
    if (!j) return null; // too early: ignored (no penalty)
    s.judged = j;
    s.delta = delta;
    this.keeper.apply(j, delta, t);
    if (s.note.end !== null) {
      s.holding = true;
      this.active.add(s);
    }
    return { lane, judgement: j, delta, state: s, kind: 'head' };
  }

  /** A key went up in `lane` at song time `t`. */
  release(lane: number, t: number): HitEvent | null {
    const s = [...this.active].find((x) => x.note.lane === lane);
    if (!s || s.note.end === null) return null;
    s.holding = false;
    this.active.delete(s);
    const complete = this.real(t, s.note.end) >= -TAIL_GRACE;
    s.tail = complete ? 'perfect' : 'miss';
    this.keeper.apply(s.tail, 0, t);
    return { lane, judgement: s.tail, delta: 0, state: s, kind: 'tail' };
  }

  /** Advances to song time `t`: notes that went past unhit are missed, finished holds complete. */
  update(t: number): HitEvent[] {
    const out: HitEvent[] = [];
    while (this.missCursor < this.states.length) {
      const s = this.states[this.missCursor];
      if (s.judged === null) {
        if (this.real(t, s.note.time) <= MISS_WINDOW) break;
        s.judged = 'miss';
        s.tail = s.tail ?? 'miss';
        this.keeper.apply('miss', 0, t);
        out.push({ lane: s.note.lane, judgement: 'miss', delta: 0, state: s, kind: 'miss' });
      }
      this.missCursor++;
    }
    for (const s of [...this.active]) {
      if (s.note.end !== null && t >= s.note.end) {
        s.holding = false;
        this.active.delete(s);
        s.tail = 'perfect';
        this.keeper.apply('perfect', 0, t);
        out.push({ lane: s.note.lane, judgement: 'perfect', delta: 0, state: s, kind: 'tail' });
      }
    }
    return out;
  }

  get finished(): boolean {
    return this.missCursor >= this.states.length && this.active.size === 0 && this.states.every((s) => s.judged !== null);
  }

  /** Holds currently being held. */
  get holding(): ReadonlySet<NoteState> {
    return this.active;
  }

  /** Fraction of the chart already judged (for the progress bar). */
  get progress(): number {
    return this.states.length ? this.states.filter((s) => s.judged !== null).length / this.states.length : 1;
  }
}
