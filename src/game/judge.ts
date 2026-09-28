// Timing judgements, scoring, accuracy, health and grades for the 4K game.

export type Judgement = 'perfect' | 'excellent' | 'good' | 'bad' | 'miss';

export const JUDGEMENTS: Judgement[] = ['perfect', 'excellent', 'good', 'bad', 'miss'];

/** Hit windows in real seconds (± around the note). Outside "bad" a press is ignored; a note passed by more than "bad" is a miss. */
export const WINDOWS: Record<Exclude<Judgement, 'miss'>, number> = {
  perfect: 0.025,
  excellent: 0.05,
  good: 0.09,
  bad: 0.135,
};

export const MISS_WINDOW = WINDOWS.bad;

/** Accuracy weight of each judgement. */
export const ACCURACY: Record<Judgement, number> = { perfect: 1, excellent: 0.9, good: 0.65, bad: 0.3, miss: 0 };

const POINTS: Record<Judgement, number> = { perfect: 350, excellent: 300, good: 200, bad: 50, miss: 0 };
const HEALTH: Record<Judgement, number> = { perfect: 0.025, excellent: 0.02, good: 0.01, bad: -0.03, miss: -0.07 };

export const LABELS: Record<Judgement, string> = { perfect: 'PERFECT', excellent: 'EXCELLENT', good: 'GOOD', bad: 'BAD', miss: 'MISS' };

/** Judgement for a timing error (seconds, negative = early), or null if outside every window. */
export function judge(delta: number): Exclude<Judgement, 'miss'> | null {
  const a = Math.abs(delta);
  if (a <= WINDOWS.perfect) return 'perfect';
  if (a <= WINDOWS.excellent) return 'excellent';
  if (a <= WINDOWS.good) return 'good';
  if (a <= WINDOWS.bad) return 'bad';
  return null;
}

export type Grade = 'SS' | 'S' | 'A' | 'B' | 'C' | 'D';

export function gradeFor(accuracy: number, counts: Record<Judgement, number>): Grade {
  const total = JUDGEMENTS.reduce((s, j) => s + counts[j], 0);
  if (total > 0 && counts.perfect === total) return 'SS';
  if (accuracy >= 0.95 && counts.miss === 0) return 'S';
  if (accuracy >= 0.9) return 'A';
  if (accuracy >= 0.8) return 'B';
  if (accuracy >= 0.7) return 'C';
  return 'D';
}

export class ScoreKeeper {
  counts: Record<Judgement, number> = { perfect: 0, excellent: 0, good: 0, bad: 0, miss: 0 };
  combo = 0;
  maxCombo = 0;
  score = 0;
  health = 0.5;
  private weight = 0;
  private judged = 0;
  /** Timing errors (seconds) of recent hits, for the hit-error meter. */
  readonly recentErrors: { delta: number; at: number }[] = [];

  reset() {
    this.counts = { perfect: 0, excellent: 0, good: 0, bad: 0, miss: 0 };
    this.combo = 0;
    this.maxCombo = 0;
    this.score = 0;
    this.health = 0.5;
    this.weight = 0;
    this.judged = 0;
    this.recentErrors.length = 0;
  }

  apply(j: Judgement, delta = 0, now = 0) {
    this.counts[j]++;
    this.judged++;
    this.weight += ACCURACY[j];
    if (j === 'miss') this.combo = 0;
    else {
      this.combo++;
      this.maxCombo = Math.max(this.maxCombo, this.combo);
      this.recentErrors.push({ delta, at: now });
      if (this.recentErrors.length > 40) this.recentErrors.shift();
    }
    // Combo multiplier grows to ×2 over 200 notes.
    this.score += Math.round(POINTS[j] * (1 + Math.min(this.combo, 200) / 200));
    this.health = Math.max(0, Math.min(1, this.health + HEALTH[j]));
  }

  get accuracy(): number {
    return this.judged ? this.weight / this.judged : 1;
  }

  get total() {
    return this.judged;
  }

  get grade(): Grade {
    return gradeFor(this.accuracy, this.counts);
  }

  get fullCombo() {
    return this.judged > 0 && this.counts.miss === 0;
  }
}
