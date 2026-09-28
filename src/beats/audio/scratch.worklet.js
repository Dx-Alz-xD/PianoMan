// Record-player voice for the song select screen.
//
// Plays a window of the song at a variable rate, including backwards, so the
// record can be scratched. A motor pulls the speed back to 1× (or to 0 when
// stopped) with realistic spin-up and braking; while the record is held,
// the hand sets the speed directly. Needle friction noise rises with sudden
// speed changes, which gives the screech, and a little vinyl crackle plays
// underneath.

class ScratchProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ch = null;
    this.srcRate = sampleRate;
    this.pos = 0;
    this.rate = 0;
    this.motor = 0;
    this.hand = null;
    this.gain = 1;
    this.gainTarget = 1;
    this.crackle = 0.25;
    this.friction = 0;
    this.lastRate = 0;
    this.seed = 12345;
    this.hp = 0;
    this.lp = 0;
    this.report = 0;
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.type === 'load') {
        this.ch = d.channels;
        this.srcRate = d.sampleRate;
        this.pos = d.pos || 0;
      } else if (d.type === 'motor') this.motor = d.on ? 1 : 0;
      else if (d.type === 'hand') this.hand = d.rate;
      else if (d.type === 'release') this.hand = null;
      else if (d.type === 'seek') this.pos = d.pos * this.srcRate;
      else if (d.type === 'gain') this.gainTarget = d.value;
      else if (d.type === 'crackle') this.crackle = d.value;
      else if (d.type === 'unload') {
        this.ch = null;
        this.rate = 0;
      }
    };
  }

  noise() {
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    return this.seed / 2147483648 - 1;
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const L = out[0];
    const R = out[1] || out[0];
    const n = L.length;
    const ch = this.ch;
    if (!ch) {
      L.fill(0);
      if (R !== L) R.fill(0);
      return true;
    }
    const len = ch[0].length;
    const step = this.srcRate / sampleRate;
    // Spin-up about 0.5 s, brake about 0.8 s; the hand is almost immediate.
    const kMotor = 1 - Math.exp(-1 / ((this.motor ? 0.16 : 0.25) * sampleRate));
    const kHand = 1 - Math.exp(-1 / (0.012 * sampleRate));
    const kGain = 1 - Math.exp(-1 / (0.05 * sampleRate));
    const fade = Math.round(0.03 * this.srcRate);
    for (let i = 0; i < n; i++) {
      const target = this.hand !== null ? this.hand : this.motor;
      this.rate += (target - this.rate) * (this.hand !== null ? kHand : kMotor);
      this.gain += (this.gainTarget - this.gain) * kGain;
      let p = this.pos;
      if (p < 0) p += len;
      if (p >= len) p -= len;
      const j = Math.floor(p);
      const f = p - j;
      const j2 = j + 1 >= len ? 0 : j + 1;
      const edge = Math.min(j, len - 1 - j);
      const fadeGain = edge < fade ? edge / fade : 1;
      let l = ch[0][j] * (1 - f) + ch[0][j2] * f;
      let r = ch[1] ? ch[1][j] * (1 - f) + ch[1][j2] * f : l;
      // Slow speeds lose top end, like a real record.
      const speed = Math.abs(this.rate);
      const g = this.gain * fadeGain * Math.min(1, speed * 3);
      l *= g;
      r *= g;
      // Needle friction: noise that follows sudden speed changes (the screech).
      const accel = Math.abs(this.rate - this.lastRate) * sampleRate;
      this.lastRate = this.rate;
      this.friction += (Math.min(1, accel / 60) - this.friction) * 0.002;
      const hiss = this.noise();
      this.hp = hiss - this.lp;
      this.lp += (hiss - this.lp) * 0.2;
      const scratchNoise = this.hp * this.friction * 0.08 * this.gain;
      let crackle = 0;
      if (speed > 0.05 && this.crackle > 0) {
        crackle = this.noise() * 0.0025 * this.crackle;
        if (this.noise() > 0.9993) crackle += this.noise() * 0.05 * this.crackle;
        crackle *= this.gain * Math.min(1, speed);
      }
      L[i] = l + scratchNoise + crackle;
      R[i] = r + scratchNoise + crackle;
      this.pos += this.rate * step;
      if (this.pos >= len) this.pos -= len;
      if (this.pos < 0) this.pos += len;
    }
    this.report += n;
    if (this.report >= sampleRate / 30) {
      this.report = 0;
      this.port.postMessage({ pos: this.pos / this.srcRate, rate: this.rate });
    }
    return true;
  }
}

registerProcessor('pb-scratch', ScratchProcessor);
