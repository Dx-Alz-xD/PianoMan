// Canvas visualiser: score notes fall towards the keyboard; notes you play
// rise up from it. Lanes line up exactly with the on-screen keys.

import { noteName } from '../core/music';
import type { Score, ScoreNote } from '../score/model';
import type { KeyGeometry } from './keyboard';

interface Rising {
  midi: number;
  start: number;
  end: number | null;
  velocity: number;
}

interface Spark {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  color: string;
}

export interface FallingOptions {
  lookahead: number;
  showNames: boolean;
  colorR: string;
  colorL: string;
  guides: boolean;
  particles: boolean;
}

export class FallingNotes {
  readonly el: HTMLElement;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private score: Score | null = null;
  private maxDur = 0;
  private geo = new Map<number, KeyGeometry>();
  private rising: Rising[] = [];
  private sparks: Spark[] = [];
  private lastActive = new Set<ScoreNote>();
  private raf = 0;
  private visible = true;
  private w = 0;
  private hgt = 0;
  private dpr = 1;
  private emptyHint = '';
  private lastSignature = '';
  opts: FallingOptions = { lookahead: 3, showNames: true, colorR: '#4fc3f7', colorL: '#ffb74d', guides: true, particles: true };
  getTime: () => number = () => 0;
  /** Notes that the next tap will play (clicker) – drawn with a pulse. */
  getHighlight: () => Set<ScoreNote> | null = () => null;
  hands: { L: boolean; R: boolean } = { L: true, R: true };

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'falling-canvas';
    this.ctx = this.canvas.getContext('2d')!;
    this.el = document.createElement('div');
    this.el.className = 'falling';
    this.el.append(this.canvas);
    new ResizeObserver(() => this.resize()).observe(this.el);
    this.loop = this.loop.bind(this);
    this.raf = requestAnimationFrame(this.loop);
  }

  setScore(score: Score | null) {
    this.score = score;
    this.maxDur = score ? score.notes.reduce((m, n) => Math.max(m, n.duration), 0) : 0;
    this.lastActive.clear();
  }

  setGeometry(g: Map<number, KeyGeometry>) {
    this.geo = g;
    this.lastSignature = '';
  }

  setVisible(v: boolean) {
    this.visible = v;
    if (v && !this.raf) this.raf = requestAnimationFrame(this.loop);
  }

  setEmptyHint(text: string) {
    this.emptyHint = text;
  }

  userNoteOn(midi: number, velocity: number) {
    this.userNoteOff(midi);
    this.rising.push({ midi, start: performance.now(), end: null, velocity });
    if (this.opts.particles) this.burst(midi, '#b388ff');
  }

  userNoteOff(midi: number) {
    const now = performance.now();
    for (const r of this.rising) if (r.midi === midi && r.end === null) r.end = now;
  }

  private resize() {
    const r = this.el.getBoundingClientRect();
    this.dpr = window.devicePixelRatio || 1;
    this.w = r.width;
    this.hgt = r.height;
    this.canvas.width = Math.max(1, Math.round(r.width * this.dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * this.dpr));
    this.canvas.style.width = `${r.width}px`;
    this.canvas.style.height = `${r.height}px`;
    this.lastSignature = '';
  }

  private burst(midi: number, color: string) {
    const g = this.geo.get(midi);
    if (!g) return;
    for (let i = 0; i < 7; i++) {
      this.sparks.push({
        x: g.x + g.w / 2 + (Math.random() - 0.5) * g.w,
        y: this.hgt - 2,
        vx: (Math.random() - 0.5) * 60,
        vy: -60 - Math.random() * 120,
        life: 1,
        color,
      });
    }
    if (this.sparks.length > 400) this.sparks.splice(0, this.sparks.length - 400);
  }

  private loop() {
    this.raf = 0;
    if (!this.visible) return;
    try {
      this.draw();
    } catch (err) {
      console.error(err);
    }
    this.raf = requestAnimationFrame(this.loop);
  }

  private draw() {
    const c = this.ctx;
    const W = this.w;
    const H = this.hgt;
    // Skip frames where nothing on screen can have changed (keeps an idle app idle).
    const highlight0 = this.getHighlight();
    const animating = this.rising.length > 0 || this.sparks.length > 0 || (highlight0 !== null && highlight0.size > 0);
    const signature = `${this.getTime().toFixed(4)}|${W}|${H}|${this.geo.size}|${this.score?.id}|${JSON.stringify(this.opts)}|${this.hands.L}${this.hands.R}|${this.emptyHint}`;
    if (!animating && signature === this.lastSignature) return;
    this.lastSignature = signature;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, W, H);
    if (!W || !H) return;

    // Octave lanes.
    if (this.opts.guides) {
      c.fillStyle = 'rgba(255,255,255,0.028)';
      for (const [m, g] of this.geo) if (!g.black && (m % 12 === 0 || m % 12 === 5)) c.fillRect(g.x, 0, 1, H);
      c.fillStyle = 'rgba(255,255,255,0.018)';
      for (const [, g] of this.geo) if (g.black) c.fillRect(g.x, 0, g.w, H);
    }

    const t = this.getTime();
    const look = Math.max(0.5, this.opts.lookahead);
    const pxPerSec = H / look;
    const s = this.score;

    if (s) {
      // Measure lines.
      if (this.opts.guides) {
        c.fillStyle = 'rgba(255,255,255,0.07)';
        c.font = '10px Inter, system-ui, sans-serif';
        for (let i = 0; i < s.measures.length; i++) {
          const m = s.measures[i];
          if (m.time < t - 0.05) continue;
          if (m.time > t + look) break;
          const y = H - (m.time - t) * pxPerSec;
          c.fillRect(0, y, W, 1);
          c.fillStyle = 'rgba(255,255,255,0.22)';
          c.fillText(String(m.src + 1), 4, y - 3);
          c.fillStyle = 'rgba(255,255,255,0.07)';
        }
      }

      const notes = s.notes;
      let lo = 0;
      let hi = notes.length;
      const from = t - this.maxDur - 0.1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (notes[mid].time < from) lo = mid + 1;
        else hi = mid;
      }
      const highlight = this.getHighlight();
      const active = new Set<ScoreNote>();
      const pulse = 0.55 + 0.45 * Math.sin(performance.now() / 160);
      // Draw white-key notes first so black-key notes sit on top.
      for (const pass of [false, true]) {
        for (let i = lo; i < notes.length; i++) {
          const n = notes[i];
          if (n.time > t + look) break;
          const end = n.time + n.duration;
          if (end < t) continue;
          const g = this.geo.get(n.midi);
          if (!g || g.black !== pass) continue;
          const yBottom = H - (n.time - t) * pxPerSec;
          const yTop = H - (end - t) * pxPerSec;
          const isActive = n.time <= t && t < end;
          if (isActive) active.add(n);
          const color = n.hand === 'L' ? this.opts.colorL : this.opts.colorR;
          const muted = !this.hands[n.hand];
          const pad = g.black ? 1 : 2;
          const x = g.x + pad;
          const w = Math.max(2, g.w - pad * 2);
          const top = Math.max(-4, yTop);
          const bottom = Math.min(H, yBottom);
          const height = Math.max(3, bottom - top);
          c.globalAlpha = muted ? 0.45 : 1;
          const grad = c.createLinearGradient(x, 0, x + w, 0);
          grad.addColorStop(0, shade(color, g.black ? -0.35 : -0.12));
          grad.addColorStop(0.5, shade(color, g.black ? -0.2 : 0.08));
          grad.addColorStop(1, shade(color, g.black ? -0.4 : -0.18));
          c.fillStyle = grad;
          if (isActive) {
            c.shadowColor = color;
            c.shadowBlur = 16;
          }
          roundRect(c, x, top, w, height, Math.min(5, w / 2.5));
          c.fill();
          c.shadowBlur = 0;
          if (muted) {
            c.strokeStyle = color;
            c.lineWidth = 1.2;
            c.setLineDash([4, 3]);
            c.stroke();
            c.setLineDash([]);
          }
          if (highlight?.has(n)) {
            c.strokeStyle = `rgba(255,255,255,${pulse})`;
            c.lineWidth = 2;
            c.stroke();
          }
          if (this.opts.showNames && height > 16 && w > 11) {
            c.fillStyle = g.black ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.62)';
            c.font = `600 ${Math.min(11, w * 0.5)}px Inter, system-ui, sans-serif`;
            c.textAlign = 'center';
            c.fillText(noteName(n.midi).replace(/-?\d+$/, ''), x + w / 2, bottom - 5);
            c.textAlign = 'left';
          }
          c.globalAlpha = 1;
        }
      }
      if (this.opts.particles) {
        for (const n of active) if (!this.lastActive.has(n) && this.hands[n.hand]) this.burst(n.midi, n.hand === 'L' ? this.opts.colorL : this.opts.colorR);
      }
      this.lastActive = active;
    } else if (!this.rising.length && this.emptyHint) {
      c.fillStyle = 'rgba(255,255,255,0.35)';
      c.font = '500 15px Inter, system-ui, sans-serif';
      c.textAlign = 'center';
      const lines = this.emptyHint.split('\n');
      lines.forEach((line, i) => c.fillText(line, W / 2, H / 2 - (lines.length - 1) * 12 + i * 24));
      c.textAlign = 'left';
    }

    // Rising notes played by the user.
    const now = performance.now();
    this.rising = this.rising.filter((r) => r.end === null || now - r.end < look * 1000 + 200);
    for (const r of this.rising) {
      const g = this.geo.get(r.midi);
      if (!g) continue;
      const bottom = H - ((r.end === null ? 0 : now - r.end) / 1000) * pxPerSec;
      const top = H - ((now - r.start) / 1000) * pxPerSec;
      const pad = g.black ? 1 : 2;
      c.globalAlpha = 0.35 + 0.55 * (r.velocity / 127);
      c.fillStyle = '#b388ff';
      c.shadowColor = '#b388ff';
      c.shadowBlur = r.end === null ? 14 : 0;
      roundRect(c, g.x + pad, Math.max(0, top), Math.max(2, g.w - pad * 2), Math.max(3, bottom - Math.max(0, top)), 4);
      c.fill();
      c.shadowBlur = 0;
      c.globalAlpha = 1;
    }

    // Sparks.
    if (this.sparks.length) {
      const dt = 1 / 60;
      for (const p of this.sparks) {
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.vy += 160 * dt;
        p.life -= dt * 1.6;
        if (p.life <= 0) continue;
        c.globalAlpha = Math.max(0, p.life);
        c.fillStyle = p.color;
        c.fillRect(p.x, p.y, 2, 2);
      }
      c.globalAlpha = 1;
      this.sparks = this.sparks.filter((p) => p.life > 0);
    }

    // Hit line.
    const glow = c.createLinearGradient(0, H - 10, 0, H);
    glow.addColorStop(0, 'rgba(255,255,255,0)');
    glow.addColorStop(1, 'rgba(255,255,255,0.18)');
    c.fillStyle = glow;
    c.fillRect(0, H - 10, W, 10);
  }
}

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  c.beginPath();
  c.moveTo(x + rr, y);
  c.arcTo(x + w, y, x + w, y + h, rr);
  c.arcTo(x + w, y + h, x, y + h, rr);
  c.arcTo(x, y + h, x, y, rr);
  c.arcTo(x, y, x + w, y, rr);
  c.closePath();
}

const shadeCache = new Map<string, string>();
function shade(hex: string, amt: number): string {
  const key = `${hex}${amt}`;
  const hit = shadeCache.get(key);
  if (hit) return hit;
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const f = (v: number) => Math.round(Math.min(255, Math.max(0, amt < 0 ? v * (1 + amt) : v + (255 - v) * amt)));
  const out = `rgb(${f(n >> 16)},${f((n >> 8) & 255)},${f(n & 255)})`;
  shadeCache.set(key, out);
  return out;
}
