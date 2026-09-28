// The state of one play-through of a 4K chart: which notes were hit or
// missed, holds in progress, and the score. Times are song seconds;
// judgement windows are real seconds, so they stay the same at any speed.

import { judge, ScoreKeeper, WINDOWS, type Judgement, type Windows } from './judge';

export interface PlayNote {
  id: number;
  time: number;
  lane: number;
  end: number | null;
}

export interface NoteState<N extends PlayNote = PlayNote> {
  note: N;
  judged: Judgement | null;
  delta: number;
  holding: boolean;
  tail: Judgement | null;
}

export interface HitEvent<N extends PlayNote = PlayNote> {
  lane: number;
  judgement: Judgement;
  delta: number;
  state: NoteState<N>;
  kind: 'head' | 'tail' | 'miss';
}

export interface SessionOptions {
  speed?: number;
  windows?: Windows;
  /** Treat every hold as a plain note (the "no holds" mod). */
  noHolds?: boolean;
}

/** Releasing a hold this close to its end (real seconds) still counts as complete. */
const TAIL_GRACE = 0.12;

export class GameSession<N extends PlayNote = PlayNote> {
  readonly keeper = new ScoreKeeper();
  readonly states: NoteState<N>[];
  readonly speed: number;
  readonly windows: Windows;
  private lanes: NoteState<N>[][] = [[], [], [], []];
  private cursor = [0, 0, 0, 0];
  private missCursor = 0;
  private active = new Set<NoteState<N>>();

  constructor(notes: N[], opts: SessionOptions | number = {}) {
    const o = typeof opts === 'number' ? { speed: opts } : opts;
    this.speed = o.speed ?? 1;
    this.windows = o.windows ?? WINDOWS;
    const list = o.noHolds ? notes.map((n) => ({ ...n, end: null })) : notes;
    this.states = list.map((note) => ({ note, judged: null, delta: 0, holding: false, tail: note.end === null ? 'perfect' : null }));
    this.states.sort((a, b) => a.note.time - b.note.time || a.note.lane - b.note.lane);
    for (const s of this.states) this.lanes[s.note.lane]?.push(s);
  }

  /** Real-time difference between the song time `t` and a note time. */
  private real(t: number, noteTime: number) {
    return (t - noteTime) / this.speed;
  }

  get missWindow() {
    return this.windows.bad;
  }

  /** The next unjudged note in a lane (for auto-play and hints). */
  nextIn(lane: number): NoteState<N> | undefined {
    const list = this.lanes[lane];
    let i = this.cursor[lane];
    while (i < list.length && list[i].judged !== null) i++;
    return list[i];
  }

  /** A key went down in `lane` at song time `t`. Returns the hit, or null for a ghost tap. */
  press(lane: number, t: number): HitEvent<N> | null {
    const list = this.lanes[lane];
    if (!list) return null;
    let i = this.cursor[lane];
    while (i < list.length && list[i].judged !== null) i++;
    this.cursor[lane] = i;
    const s = list[i];
    if (!s) return null;
    const delta = this.real(t, s.note.time);
    const j = judge(delta, this.windows);
    if (!j) return null; // too early: ignored (no penalty)
    s.judged = j;
    s.delta = delta;
    this.keeper.apply(j, delta, t, true);
    if (s.note.end !== null) {
      s.holding = true;
      this.active.add(s);
    }
    return { lane, judgement: j, delta, state: s, kind: 'head' };
  }

  /** A key went up in `lane` at song time `t`. */
  release(lane: number, t: number): HitEvent<N> | null {
    const s = [...this.active].find((x) => x.note.lane === lane);
    if (!s || s.note.end === null) return null;
    s.holding = false;
    this.active.delete(s);
    const complete = this.real(t, s.note.end) >= -TAIL_GRACE;
    s.tail = complete ? 'perfect' : 'miss';
    this.keeper.apply(s.tail, 0, t, false);
    return { lane, judgement: s.tail, delta: 0, state: s, kind: 'tail' };
  }

  /** Advances to song time `t`: notes that went past unhit are missed, finished holds complete. */
  update(t: number): HitEvent<N>[] {
    const out: HitEvent<N>[] = [];
    while (this.missCursor < this.states.length) {
      const s = this.states[this.missCursor];
      if (s.judged === null) {
        if (this.real(t, s.note.time) <= this.windows.bad) break;
        s.judged = 'miss';
        s.tail = s.tail ?? 'miss';
        this.keeper.apply('miss', 0, t, false);
        out.push({ lane: s.note.lane, judgement: 'miss', delta: 0, state: s, kind: 'miss' });
      }
      this.missCursor++;
    }
    for (const s of [...this.active]) {
      if (s.note.end !== null && t >= s.note.end) {
        s.holding = false;
        this.active.delete(s);
        s.tail = 'perfect';
        this.keeper.apply('perfect', 0, t, false);
        out.push({ lane: s.note.lane, judgement: 'perfect', delta: 0, state: s, kind: 'tail' });
      }
    }
    return out;
  }

  get finished(): boolean {
    return this.missCursor >= this.states.length && this.active.size === 0 && this.states.every((s) => s.judged !== null);
  }

  /** Holds currently being held. */
  get holding(): ReadonlySet<NoteState<N>> {
    return this.active;
  }

  /** Fraction of the chart already judged (for the progress bar). */
  get progress(): number {
    return this.states.length ? this.states.filter((s) => s.judged !== null).length / this.states.length : 1;
  }

  /** Marks everything before `t` as skipped (practice from a point): not scored. */
  skipBefore(t: number) {
    for (const s of this.states) {
      if (s.note.time < t - 0.001 && s.judged === null) {
        s.judged = 'perfect';
        s.tail = 'perfect';
        (s as NoteState<N> & { skipped?: boolean }).skipped = true;
      }
    }
    for (let l = 0; l < 4; l++) {
      let i = 0;
      while (i < this.lanes[l].length && this.lanes[l][i].judged !== null) i++;
      this.cursor[l] = i;
    }
    while (this.missCursor < this.states.length && this.states[this.missCursor].judged !== null) this.missCursor++;
  }
}
