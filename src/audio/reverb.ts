// Algorithmically generated impulse responses for the convolution reverb.

import type { ReverbType } from '../core/settings';

export interface ReverbShape {
  decay: number;
  preDelay: number;
  /** Reverb time and pre-delay the room type suggests when selected. */
}

export const REVERB_DEFAULTS: Record<ReverbType, { decay: number; preDelay: number; damping: number }> = {
  room: { decay: 0.7, preDelay: 4, damping: 0.6 },
  studio: { decay: 1.2, preDelay: 8, damping: 0.5 },
  chamber: { decay: 1.7, preDelay: 12, damping: 0.45 },
  hall: { decay: 2.4, preDelay: 18, damping: 0.45 },
  cathedral: { decay: 6, preDelay: 40, damping: 0.35 },
  plate: { decay: 1.8, preDelay: 0, damping: 0.25 },
  spring: { decay: 1.6, preDelay: 0, damping: 0.4 },
};

/** Early reflection pattern (seconds, gain) for rooms with walls close by. */
const EARLY: Partial<Record<ReverbType, [number, number][]>> = {
  room: [[0.007, 0.5], [0.011, 0.35], [0.017, 0.3], [0.023, 0.22], [0.031, 0.15]],
  studio: [[0.009, 0.4], [0.015, 0.3], [0.022, 0.25], [0.034, 0.18], [0.045, 0.12]],
  chamber: [[0.012, 0.35], [0.021, 0.3], [0.033, 0.22], [0.047, 0.16], [0.062, 0.1]],
  hall: [[0.019, 0.28], [0.031, 0.22], [0.046, 0.18], [0.067, 0.12], [0.088, 0.08]],
  cathedral: [[0.035, 0.2], [0.061, 0.16], [0.094, 0.12], [0.13, 0.08]],
};

// Deterministic noise so the same settings always give the same room.
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296 * 2 - 1;
  };
}

export function createImpulse(ctx: BaseAudioContext, type: ReverbType, decay: number, damping: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const seconds = Math.min(12, Math.max(0.3, decay * 1.3 + 0.1));
  const length = Math.floor(sr * seconds);
  const buffer = ctx.createBuffer(2, length, sr);
  const early = EARLY[type] || [];

  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    const rand = rng(0x9e3779b9 + ch * 7919 + type.length * 131);
    // Low-pass state for frequency-dependent decay.
    let lp = 0;
    let bp1 = 0;
    let bp2 = 0;
    const attackSamples = Math.floor(sr * (type === 'plate' ? 0.002 : 0.008));
    for (let i = 0; i < length; i++) {
      const t = i / sr;
      // RT60: amplitude reaches -60 dB at t = decay.
      const env = Math.exp((-6.907755 * t) / decay);
      const fadeIn = i < attackSamples ? i / attackSamples : 1;
      let x = rand();
      if (type === 'plate') x *= 1.2; // denser, brighter
      // Damping: the low-pass closes as the tail gets older.
      const cutoff = Math.max(0.02, 0.98 - damping * 0.9 * Math.min(1, t / Math.max(0.2, decay * 0.6)));
      lp += cutoff * (x - lp);
      let y = lp;
      if (type === 'spring') {
        // Resonant band-pass "boing" character.
        bp1 += 0.12 * (y - bp1 - 0.6 * bp2);
        bp2 += 0.12 * bp1;
        y = bp1 * 2.2 + y * 0.3;
      }
      data[i] = y * env * fadeIn;
    }
    // Early reflections, slightly different per ear.
    for (const [time, gain] of early) {
      const at = Math.floor((time + (ch ? 0.0013 : 0)) * sr);
      if (at < length) {
        for (let k = 0; k < 24 && at + k < length; k++) data[at + k] += gain * (1 - k / 24) * (k % 2 ? -1 : 1);
      }
    }
    if (type === 'spring') {
      // Spring "drip": a few decaying echoes of the tank.
      const d = Math.floor(0.031 * sr);
      for (let i = d; i < length; i++) data[i] += data[i - d] * 0.35;
    }
  }
  return buffer;
}
