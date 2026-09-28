// Player controls shown under the visualiser: autoplay transport or clicker
// controls, depending on the mode.

import type { AppSettings } from '../core/settings';
import { formatTime } from '../core/music';
import type { PlayerState } from '../player/autoplayer';
import { segmented, select } from './controls';
import { h, icon } from './dom';

export interface TransportHandlers {
  toggle(): void;
  stop(): void;
  seek(t: number): void;
  speed(v: number): void;
  hands(hand: 'L' | 'R', on: boolean): void;
  loopA(): void;
  loopB(): void;
  loopClear(): void;
  option(key: keyof AppSettings['player'], value: boolean): void;
  clickerOption<K extends keyof AppSettings['clicker']>(key: K, value: AppSettings['clicker'][K]): void;
  clickerReset(): void;
  clickerBack(): void;
  clickerTap(): void;
}

const SPEEDS = [0.25, 0.4, 0.5, 0.6, 0.75, 0.85, 1, 1.1, 1.25, 1.5, 2];

export class Transport {
  readonly el: HTMLElement;
  private auto: HTMLElement;
  private clicker: HTMLElement;
  private playBtn: HTMLButtonElement;
  private timeLabel: HTMLElement;
  private seekInput: HTMLInputElement;
  private loopBand: HTMLElement;
  private seeking = false;
  private duration = 0;
  private speedSelect: ReturnType<typeof select>;
  private handBtns: Record<'L' | 'R', HTMLButtonElement>;
  private optBtns = new Map<string, HTMLButtonElement>();
  private clickerProgress: HTMLElement;
  private clickerLabel: HTMLElement;
  private clickerFill: HTMLElement;
  private waitBadge: HTMLElement;

  constructor(handlers: TransportHandlers, settings: AppSettings) {
    this.playBtn = h('button', { class: 'play-btn', title: 'Play / pause (Space)', onclick: () => handlers.toggle() }, icon('play', 22));
    this.timeLabel = h('span', { class: 'time' }, '0:00 / 0:00');
    this.seekInput = h('input', { type: 'range', class: 'seek', min: '0', max: '1000', value: '0', 'aria-label': 'Position' }) as HTMLInputElement;
    this.seekInput.addEventListener('input', () => {
      this.seeking = true;
      const t = (parseInt(this.seekInput.value, 10) / 1000) * this.duration;
      this.timeLabel.textContent = `${formatTime(t)} / ${formatTime(this.duration)}`;
    });
    this.seekInput.addEventListener('change', () => {
      this.seeking = false;
      handlers.seek((parseInt(this.seekInput.value, 10) / 1000) * this.duration);
    });
    this.loopBand = h('div', { class: 'loop-band', hidden: true });

    this.speedSelect = select({
      value: String(settings.player.speed),
      options: SPEEDS.map((s) => ({ value: String(s), label: `${Math.round(s * 100)}%` })),
      help: 'Playback speed',
      onChange: (v) => handlers.speed(parseFloat(v)),
      cls: 'speed-select',
    });
    const handBtn = (hand: 'L' | 'R') =>
      h('button', {
        class: `hand-btn hand-${hand} ${settings.player[hand === 'L' ? 'handL' : 'handR'] ? 'on' : ''}`,
        title: `${hand === 'L' ? 'Left' : 'Right'} hand: autoplay on/off. Turn a hand off to play it yourself.`,
        onclick: () => handlers.hands(hand, !this.handBtns[hand].classList.contains('on')),
      }, hand === 'L' ? 'LH' : 'RH');
    this.handBtns = { L: handBtn('L'), R: handBtn('R') };
    const opt = (key: keyof AppSettings['player'], label: string, iconName: string, title: string) => {
      const b = h('button', {
        class: `opt-btn ${settings.player[key] ? 'on' : ''}`,
        title,
        onclick: () => handlers.option(key, !b.classList.contains('on')),
      }, icon(iconName, 16), h('span', null, label));
      this.optBtns.set(key, b);
      return b;
    };
    this.waitBadge = h('span', { class: 'wait-badge', hidden: true }, icon('wait', 14), 'Waiting for you…');

    this.auto = h('div', { class: 'transport-auto' },
      h('div', { class: 'transport-main' },
        h('button', { class: 'icon-btn', title: 'Back to start', onclick: () => handlers.stop() }, icon('rewind')),
        this.playBtn,
        this.timeLabel,
        h('div', { class: 'seek-wrap' }, this.loopBand, this.seekInput),
      ),
      h('div', { class: 'transport-opts' },
        h('span', { class: 'opt-group', title: 'Speed' }, icon('forward', 15), this.speedSelect.el),
        h('span', { class: 'opt-group' }, this.handBtns.L, this.handBtns.R),
        h('span', { class: 'opt-group' },
          h('button', { class: 'opt-btn', title: 'Set loop start here (A)', onclick: () => handlers.loopA() }, 'A'),
          h('button', { class: 'opt-btn', title: 'Set loop end here (B)', onclick: () => handlers.loopB() }, 'B'),
          h('button', { class: 'opt-btn', title: 'Clear A–B loop', onclick: () => handlers.loopClear() }, icon('x', 14)),
          opt('loop', 'Loop', 'loop', 'Loop the whole piece'),
        ),
        opt('waitMode', 'Wait for me', 'wait', 'Practice: pauses at each chord of the hand you switched off until you play it'),
        opt('countIn', 'Count-in', 'metronome', 'One bar of clicks before playback starts'),
        opt('applyPedal', 'Pedal', 'sparkle', "Use the score's pedal markings"),
        this.waitBadge,
      ),
    );

    // Clicker.
    this.clickerLabel = h('span', { class: 'time' }, 'Chord 0 / 0');
    this.clickerFill = h('div', { class: 'progress-fill' });
    this.clickerProgress = h('div', { class: 'progress clicker-progress' }, this.clickerFill);
    const c = settings.clicker;
    this.clicker = h('div', { class: 'transport-clicker' },
      h('div', { class: 'transport-main' },
        h('button', { class: 'icon-btn', title: 'Back to the beginning (Home)', onclick: () => handlers.clickerReset() }, icon('rewind')),
        h('button', { class: 'icon-btn', title: 'One chord back (Backspace)', onclick: () => handlers.clickerBack() }, icon('back')),
        h('button', { class: 'tap-btn', title: 'Tap – or press any key, click the notes area, or hit any MIDI key', onpointerdown: (e: PointerEvent) => (e.preventDefault(), handlers.clickerTap()) }, icon('pointer', 18), 'TAP'),
        this.clickerLabel,
        this.clickerProgress,
      ),
      h('div', { class: 'transport-opts' },
        h('span', { class: 'opt-pair' }, h('span', { class: 'opt-label' }, 'Taps play'), segmented({
          value: c.target,
          options: [
            { value: 'both', label: 'Both hands' },
            { value: 'R', label: 'Right hand' },
            { value: 'L', label: 'Left hand' },
          ],
          onChange: (v) => handlers.clickerOption('target', v),
          cls: 'small',
        }).el),
        h('span', { class: 'opt-pair' }, h('span', { class: 'opt-label' }, 'Notes last'), segmented({
          value: c.duration,
          options: [
            { value: 'natural', label: 'As written', title: 'Scaled to how fast you are tapping' },
            { value: 'hold', label: 'While held', title: 'Until you release the key or button' },
            { value: 'next', label: 'Until next tap' },
          ],
          onChange: (v) => handlers.clickerOption('duration', v),
          cls: 'small',
        }).el),
        h('span', { class: 'opt-pair' }, h('span', { class: 'opt-label' }, 'Loudness'), segmented({
          value: c.velocity,
          options: [
            { value: 'score', label: 'Score' },
            { value: 'input', label: 'Your touch', title: 'MIDI velocity / where you click' },
            { value: 'fixed', label: 'Fixed' },
          ],
          onChange: (v) => handlers.clickerOption('velocity', v),
          cls: 'small',
        }).el),
        h('button', {
          class: `opt-btn ${c.accompany ? 'on' : ''}`,
          title: 'When tapping one hand, the other hand plays along at your tempo',
          onclick: (e: MouseEvent) => {
            const b = e.currentTarget as HTMLElement;
            b.classList.toggle('on');
            handlers.clickerOption('accompany', b.classList.contains('on'));
          },
        }, icon('hand', 16), h('span', null, 'Other hand follows')),
        h('button', {
          class: `opt-btn ${c.allowRepeat ? 'on' : ''}`,
          title: 'Holding a computer key down auto-repeats taps',
          onclick: (e: MouseEvent) => {
            const b = e.currentTarget as HTMLElement;
            b.classList.toggle('on');
            handlers.clickerOption('allowRepeat', b.classList.contains('on'));
          },
        }, icon('repeat', 16), h('span', null, 'Key repeat')),
      ),
    );

    this.el = h('div', { class: 'transport' }, this.auto, this.clicker);
  }

  setMode(mode: 'play' | 'autoplay' | 'clicker', hasScore: boolean) {
    this.el.hidden = mode === 'play' || !hasScore;
    this.auto.hidden = mode !== 'autoplay';
    this.clicker.hidden = mode !== 'clicker';
  }

  setDuration(d: number) {
    this.duration = d;
  }

  update(position: number, state: PlayerState) {
    const playing = state === 'playing' || state === 'waiting' || state === 'counting';
    this.playBtn.classList.toggle('playing', playing);
    this.playBtn.replaceChildren(icon(playing ? 'pause' : 'play', 22));
    this.waitBadge.hidden = state !== 'waiting';
    if (!this.seeking) {
      this.timeLabel.textContent = `${formatTime(position)} / ${formatTime(this.duration)}`;
      this.seekInput.value = String(this.duration ? Math.round((position / this.duration) * 1000) : 0);
      this.seekInput.style.setProperty('--fill', `${this.duration ? (position / this.duration) * 100 : 0}%`);
    }
  }

  setLoop(loop: { a: number; b: number } | null) {
    if (!loop || !this.duration) {
      this.loopBand.hidden = true;
      return;
    }
    this.loopBand.hidden = false;
    this.loopBand.style.left = `${(loop.a / this.duration) * 100}%`;
    this.loopBand.style.width = `${((loop.b - loop.a) / this.duration) * 100}%`;
  }

  setHand(hand: 'L' | 'R', on: boolean) {
    this.handBtns[hand].classList.toggle('on', on);
  }

  setOption(key: string, on: boolean) {
    this.optBtns.get(key)?.classList.toggle('on', on);
  }

  setSpeed(v: number) {
    this.speedSelect.set(String(v));
  }

  setClicker(index: number, total: number) {
    this.clickerLabel.textContent = `Chord ${Math.min(index, total)} / ${total}`;
    this.clickerFill.style.width = `${total ? (index / total) * 100 : 0}%`;
  }
}
