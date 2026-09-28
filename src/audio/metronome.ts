// Sample-accurate metronome with a lookahead scheduler.

export type ClickSound = 'click' | 'wood' | 'beep';

export class Metronome {
  bpm = 100;
  beats = 4;
  volume = 0.6;
  accent = true;
  sound: ClickSound = 'click';
  onBeat: ((beat: number, when: number) => void) | null = null;

  private timer = 0;
  private nextTime = 0;
  private beat = 0;
  private running = false;
  private stopAt = Infinity;

  constructor(private ctx: AudioContext, private out: AudioNode) {}

  get isRunning() {
    return this.running;
  }

  /** Starts clicking at `when`; `count` limits the number of clicks (for count-ins). */
  start(when = this.ctx.currentTime + 0.05, count = Infinity) {
    this.stop();
    this.running = true;
    this.nextTime = when;
    this.beat = 0;
    this.stopAt = count === Infinity ? Infinity : when + (count * 60) / this.bpm - 0.001;
    this.tick();
    this.timer = window.setInterval(() => this.tick(), 25);
  }

  stop() {
    this.running = false;
    clearInterval(this.timer);
  }

  private tick() {
    const horizon = this.ctx.currentTime + 0.12;
    while (this.running && this.nextTime < horizon) {
      if (this.nextTime >= this.stopAt) {
        this.stop();
        return;
      }
      const downbeat = this.beat % this.beats === 0;
      this.click(this.nextTime, downbeat && this.accent);
      const beatIndex = this.beat % this.beats;
      const at = this.nextTime;
      const delay = Math.max(0, (at - this.ctx.currentTime) * 1000);
      window.setTimeout(() => this.onBeat?.(beatIndex, at), delay);
      this.nextTime += 60 / this.bpm;
      this.beat++;
    }
  }

  click(when: number, accent: boolean) {
    const ctx = this.ctx;
    const g = ctx.createGain();
    const level = this.volume * (accent ? 1 : 0.6);
    g.connect(this.out);
    if (this.sound === 'wood') {
      const len = Math.floor(ctx.sampleRate * 0.05);
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (len / 8));
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = accent ? 2200 : 1600;
      bp.Q.value = 6;
      g.gain.value = level * 3;
      src.connect(bp).connect(g);
      src.start(when);
      src.onended = () => g.disconnect();
    } else {
      const osc = ctx.createOscillator();
      osc.type = this.sound === 'beep' ? 'square' : 'sine';
      osc.frequency.value = this.sound === 'beep' ? (accent ? 1320 : 880) : accent ? 1760 : 1175;
      const dur = this.sound === 'beep' ? 0.06 : 0.03;
      g.gain.setValueAtTime(0, when);
      g.gain.linearRampToValueAtTime(level * (this.sound === 'beep' ? 0.25 : 0.7), when + 0.001);
      g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
      osc.connect(g);
      osc.start(when);
      osc.stop(when + dur + 0.01);
      osc.onended = () => g.disconnect();
    }
  }
}
