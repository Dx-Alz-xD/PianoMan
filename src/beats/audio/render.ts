// Renders a piano score to audio faster than real time: a second PianoEngine
// on an OfflineAudioContext that shares the live engine's samples and sound
// settings. Used for score songs' previews on the record player and for
// exporting them as osu! beatmaps.

import { PianoEngine } from '../../audio/engine';
import type { Score } from '../../score/model';

const PREROLL = 0.25;
const STEP = 0.5;

export interface RenderOptions {
  from?: number;
  to?: number;
  /** Fade out over the last seconds (previews). */
  fadeOut?: number;
  onProgress?: (p: number) => void;
}

export async function renderScore(live: PianoEngine, score: Score, opts: RenderOptions = {}): Promise<AudioBuffer> {
  const from = Math.max(0, opts.from ?? 0);
  const to = Math.min(score.duration + 2.5, opts.to ?? score.duration + 2.5);
  const length = Math.max(0.5, to - from);
  const sr = live.ctx.sampleRate;
  const ctx = new OfflineAudioContext(2, Math.ceil((length + PREROLL) * sr), sr);
  const engine = new PianoEngine({ context: ctx, store: live.store });
  engine.copyFrom(live);

  type Ev = { t: number; run: (when: number) => void };
  const events: Ev[] = [];
  for (const n of score.notes) {
    const end = n.time + n.duration;
    if (end < from - 0.05 || n.time > to) continue;
    const start = Math.max(n.time, from);
    const vel = Math.max(1, Math.min(127, Math.round(n.velocity * 127)));
    events.push({ t: start, run: (w) => engine.noteOn(n.midi, vel, w) });
    events.push({ t: Math.min(end, to), run: (w) => engine.noteOff(n.midi, w) });
  }
  for (const p of score.pedals) {
    if (p.time > to) continue;
    const t = Math.max(p.time, from);
    if (p.kind === 'sustain') events.push({ t, run: (w) => engine.setSustain(p.value, w) });
    else if (p.kind === 'sostenuto') events.push({ t, run: (w) => engine.setSostenuto(p.value >= 64, w) });
  }
  events.sort((a, b) => a.t - b.t);

  let next = 0;
  const schedule = (windowEnd: number) => {
    while (next < events.length && events[next].t - from < windowEnd) {
      const e = events[next++];
      e.run(PREROLL + Math.max(0, e.t - from));
    }
  };
  const steps = Math.ceil((length + PREROLL) / STEP);
  for (let i = 1; i < steps; i++) {
    const at = i * STEP;
    void ctx.suspend(at).then(() => {
      schedule(at - PREROLL + STEP * 1.5);
      opts.onProgress?.(at / (length + PREROLL));
      void ctx.resume();
    });
  }
  schedule(STEP * 1.5);
  const rendered = await ctx.startRendering();

  // Drop the pre-roll and apply the fade.
  const out = new AudioBuffer({ numberOfChannels: 2, length: Math.max(1, rendered.length - Math.round(PREROLL * sr)), sampleRate: sr });
  const fade = opts.fadeOut ? Math.round(opts.fadeOut * sr) : 0;
  for (let c = 0; c < 2; c++) {
    const src = rendered.getChannelData(c).subarray(Math.round(PREROLL * sr));
    const dst = out.getChannelData(c);
    dst.set(src.subarray(0, dst.length));
    for (let i = 0; i < fade; i++) dst[dst.length - 1 - i] *= i / fade;
  }
  opts.onProgress?.(1);
  return out;
}
