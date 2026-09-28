// The record player on the song select screen. The record's label is the
// song's cover art. It spins while the preview plays; grab it and move it
// to scratch (the audio follows the record, backwards too); let go and the
// motor brings it back up to speed.

import { h, icon } from '../../ui/dom';
import type { ScratchDeck } from '../audio/deck';
import { sounding } from './widgets';

const OMEGA_33 = (2 * Math.PI * (100 / 3)) / 60; // rad/s at 33⅓ rpm

export class Turntable {
  readonly el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private cover: HTMLImageElement | null = null;
  private coverKey = '';
  private label = '';
  private angle = 0;
  private visualRate = 0;
  private dragging = false;
  private lastPointerAngle = 0;
  private dragDelta = 0;
  private handRate = 0;
  private lastFrame = performance.now();
  private raf = 0;
  private dpr = 1;
  private armAngle = 0;
  private playing = false;
  private loading = false;
  private progress = 0;
  private speed: 33 | 45 = 33;
  private powerBtn: HTMLButtonElement;
  private speedBtn: HTMLButtonElement;
  private glow = 'rgba(140, 108, 255, 0.55)';
  private visible = true;
  onColor: ((rgb: [number, number, number]) => void) | null = null;
  onScratch: (() => void) | null = null;
  onPower: ((on: boolean) => void) | null = null;

  constructor(private deck: ScratchDeck) {
    this.canvas = h('canvas', { class: 'tt-canvas' });
    this.g = this.canvas.getContext('2d')!;
    this.powerBtn = sounding(h('button', { class: 'tt-power', title: 'Start / stop the record', onclick: () => this.onPower?.(!this.playing) }, icon('play', 16)));
    this.speedBtn = sounding(
      h('button', { class: 'tt-speed', title: 'Record speed: 33⅓ or 45 rpm', onclick: () => this.setSpeed(this.speed === 33 ? 45 : 33) }, h('b', null, '33'), h('span', null, 'RPM')),
      'toggle',
    );
    this.el = h(
      'div',
      { class: 'turntable' },
      h('div', { class: 'tt-plinth' }, this.canvas, h('div', { class: 'tt-controls' }, this.powerBtn, this.speedBtn), h('div', { class: 'tt-led' })),
    );
    this.canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    this.canvas.addEventListener('pointermove', (e) => this.onMove(e));
    this.canvas.addEventListener('pointerup', (e) => this.onUp(e));
    this.canvas.addEventListener('pointercancel', (e) => this.onUp(e));
    new ResizeObserver(() => this.resize()).observe(this.el);
    this.loop();
  }

  setVisible(v: boolean) {
    this.visible = v;
    if (v) this.loop();
  }

  private setSpeed(s: 33 | 45) {
    this.speed = s;
    this.speedBtn.querySelector('b')!.textContent = String(s);
    if (this.playing) this.deck.motor(true);
    this.deck.hand(this.motorRate);
    this.deck.release();
  }

  private get motorRate() {
    return this.speed === 45 ? 1.35 : 1;
  }

  setPlaying(on: boolean) {
    this.playing = on;
    this.el.classList.toggle('on', on);
    this.powerBtn.replaceChildren(icon(on ? 'stop' : 'play', 16));
    if (on && this.speed === 45) {
      this.deck.motor(true);
      this.deck.hand(1.35);
      this.deck.release();
    }
  }

  setLoading(on: boolean) {
    this.loading = on;
  }

  setProgress(f: number) {
    this.progress = Math.max(0, Math.min(1, f));
  }

  setCover(url: string | null, label: string) {
    this.label = label;
    const key = url || `none:${label}`;
    if (key === this.coverKey) return;
    this.coverKey = key;
    if (!url) {
      this.cover = null;
      this.onColor?.([140, 108, 255]);
      this.glow = 'rgba(140, 108, 255, 0.5)';
      return;
    }
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (this.coverKey !== key) return;
      this.cover = img;
      const c = dominantColor(img);
      this.glow = `rgba(${c[0]}, ${c[1]}, ${c[2]}, 0.6)`;
      this.onColor?.(c);
    };
    img.onerror = () => {
      if (this.coverKey === key) this.cover = null;
    };
    img.src = url;
  }

  private resize() {
    const r = this.canvas.getBoundingClientRect();
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(r.width * this.dpr);
    this.canvas.height = Math.round(r.height * this.dpr);
  }

  // ------------------------------------------------------------- input ----

  private geometry() {
    const r = this.canvas.getBoundingClientRect();
    const cx = r.width * 0.42;
    const cy = r.height * 0.5;
    const R = Math.min(r.width * 0.38, r.height * 0.45);
    return { r, cx, cy, R };
  }

  private pointerAngle(e: PointerEvent) {
    const { r, cx, cy } = this.geometry();
    return Math.atan2(e.clientY - r.top - cy, e.clientX - r.left - cx);
  }

  private onDown(e: PointerEvent) {
    const { r, cx, cy, R } = this.geometry();
    const d = Math.hypot(e.clientX - r.left - cx, e.clientY - r.top - cy);
    if (d > R * 0.98 || d < R * 0.08) return;
    e.preventDefault();
    this.canvas.setPointerCapture(e.pointerId);
    this.dragging = true;
    this.lastPointerAngle = this.pointerAngle(e);
    this.dragDelta = 0;
    this.handRate = 0;
    this.el.classList.add('scratching');
    this.onScratch?.();
  }

  private onMove(e: PointerEvent) {
    if (!this.dragging) return;
    const a = this.pointerAngle(e);
    let d = a - this.lastPointerAngle;
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    this.lastPointerAngle = a;
    this.dragDelta += d;
    this.angle += d;
  }

  private onUp(e: PointerEvent) {
    if (!this.dragging) return;
    this.dragging = false;
    this.el.classList.remove('scratching');
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
    this.deck.release();
  }

  // ------------------------------------------------------------- frame ----

  private loop = () => {
    cancelAnimationFrame(this.raf);
    if (!this.visible) return;
    this.raf = requestAnimationFrame(this.loop);
    const t = performance.now();
    const dt = Math.min(0.1, (t - this.lastFrame) / 1000);
    this.lastFrame = t;
    if (this.dragging) {
      // Hand speed from how far the record moved this frame (smoothed, so a still hand stops it).
      const omega = dt > 0 ? this.dragDelta / dt : 0;
      this.dragDelta = 0;
      this.handRate += (omega / OMEGA_33 - this.handRate) * Math.min(1, dt * 22);
      const rate = Math.max(-8, Math.min(8, this.handRate));
      this.deck.hand(rate);
      this.visualRate = rate;
    } else {
      const target = this.deck.rate;
      this.visualRate += (target - this.visualRate) * Math.min(1, dt * 12);
      this.angle += this.visualRate * OMEGA_33 * dt;
    }
    const armTarget = this.playing || this.dragging ? 1 : 0;
    this.armAngle += (armTarget - this.armAngle) * Math.min(1, dt * 4);
    this.draw(t);
  };

  private draw(now: number) {
    const c = this.g;
    const W = this.canvas.width / this.dpr;
    const H = this.canvas.height / this.dpr;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, W, H);
    const { cx, cy, R } = this.geometry();

    // Glow in the cover's colour.
    const glow = c.createRadialGradient(cx, cy, R * 0.6, cx, cy, R * 1.25);
    glow.addColorStop(0, this.glow);
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    c.fillStyle = glow;
    c.globalAlpha = 0.35 + 0.35 * Math.min(1, Math.abs(this.visualRate));
    c.beginPath();
    c.arc(cx, cy, R * 1.25, 0, Math.PI * 2);
    c.fill();
    c.globalAlpha = 1;

    // Platter with strobe dots.
    const plat = c.createLinearGradient(cx - R, cy - R, cx + R, cy + R);
    plat.addColorStop(0, '#9aa0ae');
    plat.addColorStop(0.5, '#4a4f5c');
    plat.addColorStop(1, '#a8aebb');
    c.fillStyle = plat;
    c.beginPath();
    c.arc(cx, cy, R * 1.02, 0, Math.PI * 2);
    c.fill();
    c.save();
    c.translate(cx, cy);
    c.rotate(this.angle);
    c.fillStyle = 'rgba(20,22,28,0.55)';
    for (let i = 0; i < 90; i++) {
      const a = (i / 90) * Math.PI * 2;
      c.beginPath();
      c.arc(Math.cos(a) * R * 0.995, Math.sin(a) * R * 0.995, R * 0.012, 0, Math.PI * 2);
      c.fill();
    }
    c.restore();

    // The record.
    const RR = R * 0.955;
    c.save();
    c.translate(cx, cy);
    c.rotate(this.angle);
    const vinyl = c.createRadialGradient(0, 0, RR * 0.3, 0, 0, RR);
    vinyl.addColorStop(0, '#15151a');
    vinyl.addColorStop(0.6, '#0b0b0e');
    vinyl.addColorStop(1, '#050507');
    c.fillStyle = vinyl;
    c.beginPath();
    c.arc(0, 0, RR, 0, Math.PI * 2);
    c.fill();
    // Grooves (with a lead-in and lead-out band).
    for (let r = RR * 0.4; r < RR * 0.97; r += RR * 0.0085) {
      const band = r > RR * 0.93 || (r > RR * 0.55 && r < RR * 0.565) || (r > RR * 0.74 && r < RR * 0.752);
      c.strokeStyle = band ? 'rgba(255,255,255,0.02)' : `rgba(255,255,255,${0.035 + 0.02 * Math.sin(r * 0.9)})`;
      c.lineWidth = 0.6;
      c.beginPath();
      c.arc(0, 0, r, 0, Math.PI * 2);
      c.stroke();
    }
    // Label: the cover art.
    const LR = RR * 0.37;
    c.save();
    c.beginPath();
    c.arc(0, 0, LR, 0, Math.PI * 2);
    c.clip();
    if (this.cover) {
      const img = this.cover;
      const s = Math.min(img.naturalWidth, img.naturalHeight);
      c.drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, -LR, -LR, LR * 2, LR * 2);
      c.fillStyle = 'rgba(0,0,0,0.08)';
      c.fillRect(-LR, -LR, LR * 2, LR * 2);
    } else {
      const lg = c.createLinearGradient(-LR, -LR, LR, LR);
      lg.addColorStop(0, '#ff3cac');
      lg.addColorStop(0.5, '#784ba0');
      lg.addColorStop(1, '#2b86c5');
      c.fillStyle = lg;
      c.fillRect(-LR, -LR, LR * 2, LR * 2);
      c.fillStyle = 'rgba(255,255,255,0.92)';
      c.font = `700 ${Math.round(LR * 0.16)}px 'Outfit Variable', system-ui, sans-serif`;
      c.textAlign = 'center';
      const words = (this.label || 'PIANO-BEATS').slice(0, 40);
      c.fillText(words.length > 18 ? `${words.slice(0, 17)}…` : words, 0, -LR * 0.25);
      c.font = `600 ${Math.round(LR * 0.1)}px 'Outfit Variable', system-ui, sans-serif`;
      c.fillStyle = 'rgba(255,255,255,0.7)';
      c.fillText('33⅓ RPM · STEREO', 0, LR * 0.45);
    }
    c.restore();
    c.strokeStyle = 'rgba(0,0,0,0.6)';
    c.lineWidth = 2;
    c.beginPath();
    c.arc(0, 0, LR, 0, Math.PI * 2);
    c.stroke();
    c.restore();

    // Fixed reflection: light doesn't rotate with the record.
    c.save();
    c.beginPath();
    c.arc(cx, cy, RR, 0, Math.PI * 2);
    c.clip();
    const sheen = c.createConicGradient ? c.createConicGradient(-Math.PI / 4, cx, cy) : null;
    if (sheen) {
      sheen.addColorStop(0, 'rgba(255,255,255,0)');
      sheen.addColorStop(0.08, 'rgba(255,255,255,0.10)');
      sheen.addColorStop(0.16, 'rgba(255,255,255,0)');
      sheen.addColorStop(0.5, 'rgba(255,255,255,0)');
      sheen.addColorStop(0.58, 'rgba(255,255,255,0.07)');
      sheen.addColorStop(0.66, 'rgba(255,255,255,0)');
      sheen.addColorStop(1, 'rgba(255,255,255,0)');
      c.fillStyle = sheen;
      c.fillRect(cx - RR, cy - RR, RR * 2, RR * 2);
    }
    c.restore();

    // Spindle.
    c.fillStyle = '#d5d9e2';
    c.beginPath();
    c.arc(cx, cy, R * 0.022, 0, Math.PI * 2);
    c.fill();

    if (this.loading) {
      c.strokeStyle = 'rgba(255,255,255,0.8)';
      c.lineWidth = 3;
      c.beginPath();
      const a = (now / 300) % (Math.PI * 2);
      c.arc(cx, cy, LR * 0.5, a, a + Math.PI * 1.2);
      c.stroke();
    }

    this.drawArm(cx, cy, R);
  }

  private drawArm(cx: number, cy: number, R: number) {
    const c = this.g;
    const px = cx + R * 1.2;
    const py = cy - R * 0.78;
    // Rest angle points down past the record; playing angle moves inward with the preview's progress.
    const rest = Math.PI * 0.5 + 0.18;
    const outer = Math.PI * 0.5 + 0.42;
    const inner = Math.PI * 0.5 + 0.72;
    const play = outer + (inner - outer) * this.progress;
    const a = rest + (play - rest) * this.armAngle;
    const len = R * 1.38;
    // Base.
    c.fillStyle = '#2b2e37';
    c.beginPath();
    c.arc(px, py, R * 0.13, 0, Math.PI * 2);
    c.fill();
    const ring = c.createRadialGradient(px - R * 0.03, py - R * 0.03, 2, px, py, R * 0.1);
    ring.addColorStop(0, '#eef0f5');
    ring.addColorStop(1, '#8a8f9c');
    c.fillStyle = ring;
    c.beginPath();
    c.arc(px, py, R * 0.085, 0, Math.PI * 2);
    c.fill();
    // Counterweight.
    c.save();
    c.translate(px, py);
    c.rotate(a);
    c.fillStyle = '#9ca1ad';
    c.fillRect(-R * 0.28, -R * 0.05, R * 0.14, R * 0.1);
    // Arm tube.
    const tube = c.createLinearGradient(0, -3, 0, 3);
    tube.addColorStop(0, '#f2f4f8');
    tube.addColorStop(1, '#9197a3');
    c.strokeStyle = tube;
    c.lineWidth = Math.max(3, R * 0.022);
    c.lineCap = 'round';
    c.beginPath();
    c.moveTo(0, 0);
    c.lineTo(len * 0.82, 0);
    c.lineTo(len, R * 0.07);
    c.stroke();
    // Headshell.
    c.translate(len, R * 0.07);
    c.rotate(0.35);
    c.fillStyle = '#1a1c22';
    c.fillRect(-R * 0.02, -R * 0.035, R * 0.12, R * 0.07);
    c.fillStyle = '#ff3c6d';
    c.fillRect(R * 0.07, -R * 0.02, R * 0.04, R * 0.04);
    c.restore();
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.visible = false;
  }
}

/** Average colour of an image, weighted towards saturated pixels. */
export function dominantColor(img: HTMLImageElement): [number, number, number] {
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 24;
    const g = c.getContext('2d', { willReadFrequently: true })!;
    g.drawImage(img, 0, 0, 24, 24);
    const d = g.getImageData(0, 0, 24, 24).data;
    let r = 0;
    let gg = 0;
    let b = 0;
    let w = 0;
    for (let i = 0; i < d.length; i += 4) {
      const mx = Math.max(d[i], d[i + 1], d[i + 2]);
      const mn = Math.min(d[i], d[i + 1], d[i + 2]);
      const sat = mx ? (mx - mn) / mx : 0;
      const weight = 0.15 + sat * sat * (mx / 255);
      r += d[i] * weight;
      gg += d[i + 1] * weight;
      b += d[i + 2] * weight;
      w += weight;
    }
    return [Math.round(r / w), Math.round(gg / w), Math.round(b / w)];
  } catch {
    return [140, 108, 255];
  }
}
