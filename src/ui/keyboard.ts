// On-screen piano keyboard: mouse/touch playing (velocity from where you strike
// the key, glissando by dragging, multi-touch), and highlighting of keys played
// by you, by the autoplayer (per hand) and hints for what comes next.

import { Emitter } from '../core/emitter';
import { isBlack, noteName, pitchClass } from '../core/music';
import type { Hand } from '../score/model';
import { h } from './dom';

export const KEY_RANGES: Record<number, [number, number]> = {
  88: [21, 108],
  76: [28, 103],
  61: [36, 96],
  49: [36, 84],
  37: [48, 84],
};

// Black key centre offsets from the boundary between neighbouring white keys.
const BLACK_SHIFT: Record<number, number> = { 1: -0.08, 3: 0.08, 6: -0.1, 8: 0, 10: 0.1 };

export interface KeyGeometry {
  x: number;
  w: number;
  black: boolean;
}

export class PianoKeyboard extends Emitter<{ noteOn: { midi: number; velocity: number }; noteOff: { midi: number } }> {
  readonly el: HTMLElement;
  private keysEl: HTMLElement;
  private keys = new Map<number, HTMLElement>();
  lo = 21;
  hi = 108;
  private pointers = new Map<number, number>();
  private auto = new Map<number, Hand>();
  private hints = new Set<number>();
  private userDown = new Set<number>();
  private labelMode: 'none' | 'c' | 'all' | 'keys' = 'c';
  private keyLabel: (midi: number) => string | null = () => null;
  private resizeObserver: ResizeObserver;
  onResize: (() => void) | null = null;

  constructor() {
    super();
    this.keysEl = h('div', { class: 'keys' });
    this.el = h('div', { class: 'keyboard' }, h('div', { class: 'keyboard-felt' }), this.keysEl);
    this.keysEl.addEventListener('pointerdown', (e) => this.onDown(e));
    this.keysEl.addEventListener('pointermove', (e) => this.onMove(e));
    const up = (e: PointerEvent) => this.onUp(e);
    this.keysEl.addEventListener('pointerup', up);
    this.keysEl.addEventListener('pointercancel', up);
    this.keysEl.addEventListener('lostpointercapture', up);
    this.keysEl.addEventListener('contextmenu', (e) => e.preventDefault());
    this.resizeObserver = new ResizeObserver(() => this.onResize?.());
    this.resizeObserver.observe(this.el);
  }

  setRange(keyCount: number) {
    const [lo, hi] = KEY_RANGES[keyCount] || KEY_RANGES[88];
    this.lo = lo;
    this.hi = hi;
    this.render();
  }

  setLabels(mode: 'none' | 'c' | 'all' | 'keys', keyLabel?: (midi: number) => string | null) {
    this.labelMode = mode;
    if (keyLabel) this.keyLabel = keyLabel;
    this.renderLabels();
  }

  private render() {
    this.keysEl.textContent = '';
    this.keys.clear();
    const whites: number[] = [];
    for (let m = this.lo; m <= this.hi; m++) if (!isBlack(m)) whites.push(m);
    const ww = 100 / whites.length;
    whites.forEach((m, i) => {
      const k = h('div', { class: 'key white', dataset: { midi: String(m) }, style: { left: `${i * ww}%`, width: `${ww}%` } }, h('span', { class: 'key-label' }));
      if (pitchClass(m) === 0) k.classList.add('c-key');
      this.keysEl.append(k);
      this.keys.set(m, k);
    });
    const bw = ww * 0.62;
    for (let m = this.lo; m <= this.hi; m++) {
      if (!isBlack(m)) continue;
      const leftWhite = whites.indexOf(m - 1);
      if (leftWhite < 0) continue;
      const center = (leftWhite + 1 + (BLACK_SHIFT[pitchClass(m)] || 0)) * ww;
      const k = h('div', { class: 'key black', dataset: { midi: String(m) }, style: { left: `${center - bw / 2}%`, width: `${bw}%` } }, h('span', { class: 'key-label' }));
      this.keysEl.append(k);
      this.keys.set(m, k);
    }
    this.renderLabels();
    this.refreshStates();
    this.onResize?.();
  }

  renderLabels() {
    for (const [m, k] of this.keys) {
      const label = k.querySelector('.key-label')!;
      let text = '';
      if (this.labelMode === 'all' && !isBlack(m)) text = noteName(m);
      else if (this.labelMode === 'c' && pitchClass(m) === 0) text = noteName(m);
      else if (this.labelMode === 'keys') text = this.keyLabel(m) || '';
      label.textContent = text;
    }
  }

  /** Horizontal geometry (px, relative to the keyboard) of every key, for the note visualiser. */
  geometry(): Map<number, KeyGeometry> {
    const out = new Map<number, KeyGeometry>();
    const base = this.keysEl.getBoundingClientRect();
    for (const [m, k] of this.keys) {
      const r = k.getBoundingClientRect();
      out.set(m, { x: r.left - base.left, w: r.width, black: isBlack(m) });
    }
    return out;
  }

  get width() {
    return this.keysEl.getBoundingClientRect().width;
  }

  // ------------------------------------------------------------ input ----

  private keyAt(x: number, y: number): { midi: number; el: HTMLElement } | null {
    const el = document.elementFromPoint(x, y) as HTMLElement | null;
    const key = el?.closest<HTMLElement>('.key');
    if (!key || !this.keysEl.contains(key)) return null;
    return { midi: parseInt(key.dataset.midi!, 10), el: key };
  }

  private velocityFor(e: PointerEvent, el: HTMLElement) {
    if (e.pointerType === 'pen' && e.pressure > 0) return Math.round(20 + e.pressure * 107);
    const r = el.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    // Striking nearer the front of the key plays louder, like leverage on a real key.
    return Math.round(38 + frac * 89);
  }

  private onDown(e: PointerEvent) {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    const hit = this.keyAt(e.clientX, e.clientY);
    if (!hit) return;
    e.preventDefault();
    this.keysEl.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, hit.midi);
    this.press(hit.midi, this.velocityFor(e, hit.el));
  }

  private onMove(e: PointerEvent) {
    const cur = this.pointers.get(e.pointerId);
    if (cur === undefined) return;
    const hit = this.keyAt(e.clientX, e.clientY);
    if (!hit || hit.midi === cur) return;
    this.release(cur);
    this.pointers.set(e.pointerId, hit.midi);
    this.press(hit.midi, this.velocityFor(e, hit.el));
  }

  private onUp(e: PointerEvent) {
    const cur = this.pointers.get(e.pointerId);
    if (cur === undefined) return;
    this.pointers.delete(e.pointerId);
    this.release(cur);
  }

  private press(midi: number, velocity: number) {
    this.emit('noteOn', { midi, velocity });
  }

  private release(midi: number) {
    this.emit('noteOff', { midi });
  }

  // ---------------------------------------------------------- visuals ----

  setUserDown(midi: number, down: boolean) {
    if (down) this.userDown.add(midi);
    else this.userDown.delete(midi);
    const k = this.keys.get(midi);
    if (k) k.classList.toggle('down', down);
  }

  clearUser() {
    for (const m of [...this.userDown]) this.setUserDown(m, false);
  }

  /** Keys sounding from the autoplayer / clicker, coloured by hand. */
  setAuto(notes: { midi: number; hand: Hand }[]) {
    const next = new Map<number, Hand>();
    for (const n of notes) if (!next.has(n.midi) || n.hand === 'R') next.set(n.midi, n.hand);
    for (const [m, hand] of this.auto) {
      if (next.get(m) !== hand) this.keys.get(m)?.classList.remove('auto-L', 'auto-R');
    }
    for (const [m, hand] of next) {
      if (this.auto.get(m) !== hand) this.keys.get(m)?.classList.add(`auto-${hand}`);
    }
    this.auto = next;
  }

  /** Keys the user should press next (practice / clicker preview). */
  setHints(midis: Iterable<number>) {
    const next = new Set(midis);
    for (const m of this.hints) if (!next.has(m)) this.keys.get(m)?.classList.remove('hint');
    for (const m of next) if (!this.hints.has(m)) this.keys.get(m)?.classList.add('hint');
    this.hints = next;
  }

  private refreshStates() {
    for (const m of this.userDown) this.keys.get(m)?.classList.add('down');
    for (const [m, hand] of this.auto) this.keys.get(m)?.classList.add(`auto-${hand}`);
    for (const m of this.hints) this.keys.get(m)?.classList.add('hint');
  }

  setHandColors(right: string, left: string) {
    this.el.style.setProperty('--hand-r', right);
    this.el.style.setProperty('--hand-l', left);
  }
}
