// Locally generated instruments (no downloads needed). They double as the
// fallback while samples are still streaming in or when offline.

export interface SynthVoiceNodes {
  env: GainNode;
  sources: AudioScheduledSourceNode[];
  nodes: AudioNode[];
  endAt: number;
}

const waveCache = new WeakMap<BaseAudioContext, Map<string, PeriodicWave>>();
const noiseCache = new WeakMap<BaseAudioContext, AudioBuffer>();

function wave(ctx: BaseAudioContext, id: string, amps: number[]): PeriodicWave {
  let m = waveCache.get(ctx);
  if (!m) waveCache.set(ctx, (m = new Map()));
  let w = m.get(id);
  if (!w) {
    const real = new Float32Array(amps.length + 1);
    const imag = new Float32Array(amps.length + 1);
    amps.forEach((a, i) => (imag[i + 1] = a));
    w = ctx.createPeriodicWave(real, imag);
    m.set(id, w);
  }
  return w;
}

export function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  let b = noiseCache.get(ctx);
  if (!b) {
    b = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.5), ctx.sampleRate);
    const d = b.getChannelData(0);
    let seed = 12345;
    for (let i = 0; i < d.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      d[i] = seed / 0x3fffffff - 1;
    }
    noiseCache.set(ctx, b);
  }
  return b;
}

const PIANO_PARTIALS = Array.from({ length: 24 }, (_, i) => {
  const n = i + 1;
  const strike = Math.abs(Math.sin((Math.PI * n) / 7)); // hammer strikes at 1/7 of the string
  return (strike * 0.85 + 0.15) / Math.pow(n, 1.25);
});

// Hammond-style registration 88 8600 003 on harmonics of the 16' foot.
const ORGAN_PARTIALS = (() => {
  const a = new Array(16).fill(0);
  const bars: [number, number][] = [[1, 0.8], [2, 1], [3, 0.8], [4, 0.6], [6, 0.35], [8, 0.3], [16, 0.25]];
  for (const [h, g] of bars) a[h - 1] = g;
  return a;
})();

export function createSynthVoice(
  ctx: BaseAudioContext,
  engine: 'piano' | 'epiano' | 'organ',
  freq: number,
  note: number,
  velocity: number,
  when: number,
  peak: number,
  attack: number,
  brightness: number,
  dest: AudioNode,
): SynthVoiceNodes {
  const env = ctx.createGain();
  env.gain.setValueAtTime(0, when);
  env.connect(dest);
  const sources: AudioScheduledSourceNode[] = [];
  const nodes: AudioNode[] = [env];
  const bright = Math.pow(2, brightness * 1.5);
  let endAt = when + 12;

  if (engine === 'piano') {
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    const f0 = Math.min(18000, freq * (3 + 16 * velocity) * bright);
    filter.frequency.setValueAtTime(f0, when);
    filter.frequency.setTargetAtTime(Math.max(freq * 2, 200), when + 0.01, 0.5 + 0.8 * (1 - velocity));
    filter.Q.value = 0;
    filter.connect(env);
    nodes.push(filter);
    for (const det of [-3, 3.5]) {
      const osc = ctx.createOscillator();
      osc.setPeriodicWave(wave(ctx, 'piano', PIANO_PARTIALS));
      osc.frequency.value = freq;
      osc.detune.value = det;
      osc.connect(filter);
      sources.push(osc);
    }
    // Hammer "thock".
    const hammer = ctx.createBufferSource();
    hammer.buffer = noiseBuffer(ctx);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = Math.min(8000, freq * 4);
    bp.Q.value = 1.2;
    const hg = ctx.createGain();
    hg.gain.setValueAtTime(0.25 * velocity, when);
    hg.gain.setTargetAtTime(0, when, 0.012);
    hammer.connect(bp).connect(hg).connect(env);
    nodes.push(bp, hg);
    sources.push(hammer);
    const decay = Math.max(0.5, Math.min(9, 4 * Math.pow(2, -(note - 48) / 16)));
    const a = Math.max(0.002, attack);
    env.gain.linearRampToValueAtTime(peak, when + a);
    env.gain.setTargetAtTime(peak * 0.45, when + a, 0.12);
    env.gain.setTargetAtTime(0, when + a + 0.25, decay);
    endAt = when + a + 0.25 + decay * 6;
  } else if (engine === 'epiano') {
    const carrier = ctx.createOscillator();
    carrier.frequency.value = freq;
    const mod = ctx.createOscillator();
    mod.frequency.value = freq;
    const modGain = ctx.createGain();
    modGain.gain.setValueAtTime(freq * (0.5 + 2.4 * velocity) * bright, when);
    modGain.gain.setTargetAtTime(freq * 0.12, when, 0.45);
    mod.connect(modGain).connect(carrier.frequency);
    const tine = ctx.createOscillator();
    tine.frequency.value = freq * 14;
    const tineGain = ctx.createGain();
    tineGain.gain.setValueAtTime(freq * 1.6 * velocity, when);
    tineGain.gain.setTargetAtTime(0, when, 0.025);
    tine.connect(tineGain).connect(carrier.frequency);
    carrier.connect(env);
    nodes.push(modGain, tineGain);
    sources.push(carrier, mod, tine);
    const decay = Math.max(0.6, Math.min(6, 3 * Math.pow(2, -(note - 60) / 24)));
    const a = Math.max(0.003, attack);
    env.gain.linearRampToValueAtTime(peak, when + a);
    env.gain.setTargetAtTime(0, when + a, decay);
    endAt = when + a + decay * 6;
  } else {
    const osc = ctx.createOscillator();
    osc.setPeriodicWave(wave(ctx, 'organ', ORGAN_PARTIALS));
    osc.frequency.value = freq / 2;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = Math.min(16000, 6000 * bright);
    osc.connect(lp).connect(env);
    nodes.push(lp);
    sources.push(osc);
    // Key click.
    const click = ctx.createBufferSource();
    click.buffer = noiseBuffer(ctx);
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(0.05, when);
    cg.gain.setTargetAtTime(0, when, 0.004);
    click.connect(cg).connect(env);
    nodes.push(cg);
    sources.push(click);
    env.gain.linearRampToValueAtTime(peak * 0.6, when + Math.max(0.006, attack));
    endAt = Infinity;
  }

  for (const s of sources) {
    s.start(when);
    if (isFinite(endAt)) s.stop(endAt);
  }
  return { env, sources, nodes, endAt };
}
