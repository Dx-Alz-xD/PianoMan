// Player controls docked at the bottom of the window. The main row (play,
// position, speed, hands / tap controls) is always visible for autoplay and
// clicker; everything else lives in a collapsible options drawer above it.

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
  drawer(open: boolean): void;
}

const SPEEDS = [0.25, 0.4, 0.5, 0.6, 0.75, 0.85, 1, 1.1, 1.25, 1.5, 2];

export class Transport {
  /** Main row, placed in the bottom bar. */
  readonly bar: HTMLElement;
  /** Collapsible options, placed right above the bottom bar. */
  readonly drawer: HTMLElement;
  private autoBar: HTMLElement;
  private clickerBar: HTMLElement;
  private autoOpts: HTMLElement;
  private clickerOpts: HTMLElement;
  private playBtn: HTMLButtonElement;
  private timeLabel: HTMLElement;
  private seekInput: HTMLInputElement;
  private loopBand: HTMLElement;
  private seeking = false;
  private duration = 0;
  private speedSelect: ReturnType<typeof select>;
  private handBtns: Record<'L' | 'R', HTMLButtonElement>;
  private optBtns = new Map<string, HTMLButtonElement>();
  private clickerLabel: HTMLElement;
  private clickerFill: HTMLElement;
  private waitBadge: HTMLElement;
  private drawerBtns: HTMLButtonElement[] = [];
  private tapOnly: HTMLElement[] = [];
  private flowHint: HTMLElement;
  private drawerOpen: boolean;

  constructor(private handlers: TransportHandlers, settings: AppSettings) {
    this.drawerOpen = settings.panels.drawer;
    this.playBtn = h('button', { class: 'play-btn', title: 'Play / pause (Space)', onclick: () => handlers.toggle() }, icon('play', 20));
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

    this.autoBar = h('div', { class: 'bar-controls' },
      h('button', { class: 'icon-btn', title: 'Back to start (Home)', onclick: () => handlers.stop() }, icon('rewind')),
      this.playBtn,
      this.timeLabel,
      h('div', { class: 'seek-wrap' }, this.loopBand, this.seekInput),
      h('span', { class: 'opt-group', title: 'Speed' }, this.speedSelect.el),
      h('span', { class: 'opt-group' }, this.handBtns.L, this.handBtns.R),
      this.waitBadge,
      this.drawerButton(),
    );
    this.autoOpts = h('div', { class: 'drawer-row' },
      h('span', { class: 'opt-label' }, 'Loop'),
      h('span', { class: 'opt-group' },
        h('button', { class: 'opt-btn', title: 'Set loop start here (A)', onclick: () => handlers.loopA() }, 'A'),
        h('button', { class: 'opt-btn', title: 'Set loop end here (B)', onclick: () => handlers.loopB() }, 'B'),
        h('button', { class: 'opt-btn', title: 'Clear A–B loop', onclick: () => handlers.loopClear() }, icon('x', 14)),
        opt('loop', 'Whole piece', 'loop', 'Loop the whole piece'),
      ),
      h('span', { class: 'opt-label' }, 'Practice'),
      opt('waitMode', 'Wait for me', 'wait', 'Pauses at each chord of the hand you switched off until you play it'),
      opt('countIn', 'Count-in', 'metronome', 'One bar of clicks before playback starts'),
      opt('applyPedal', 'Score pedal', 'sparkle', "Use the score's pedal markings"),
    );

    // Clicker.
    this.clickerLabel = h('span', { class: 'time' }, 'Chord 0 / 0');
    this.clickerFill = h('div', { class: 'progress-fill' });
    const c = settings.clicker;
    this.flowHint = h('span', { class: 'flow-hint muted' }, 'Keep tapping – the music flows at its written tempo');
    const styleSeg = segmented({
      value: c.style,
      options: [
        { value: 'flow', label: 'Flow', title: 'Taps keep the music going at its written timing – just like autoplay' },
        { value: 'tap', label: 'Tap tempo', title: 'Each tap plays one chord – the music follows your tapping speed' },
      ],
      onChange: (v) => {
        handlers.clickerOption('style', v);
        this.setClickerStyle(v);
      },
      cls: 'small style-seg',
    });
    this.clickerBar = h('div', { class: 'bar-controls' },
      h('button', { class: 'icon-btn', title: 'Back to the beginning (Home)', onclick: () => handlers.clickerReset() }, icon('rewind')),
      h('button', { class: 'icon-btn', title: 'One chord back (Backspace)', onclick: () => handlers.clickerBack() }, icon('back')),
      h('button', { class: 'tap-btn', title: 'Tap – or press any key, click the notes area, or hit any MIDI key', onpointerdown: (e: PointerEvent) => (e.preventDefault(), handlers.clickerTap()) }, icon('pointer', 16), 'TAP'),
      this.clickerLabel,
      h('div', { class: 'progress clicker-progress' }, this.clickerFill),
      styleSeg.el,
      this.drawerButton(),
    );
    const pair = (label: string, control: HTMLElement) => h('span', { class: 'opt-pair' }, h('span', { class: 'opt-label' }, label), control);
    const toggleBtn = (key: 'accompany' | 'allowRepeat', label: string, iconName: string, title: string) =>
      h('button', {
        class: `opt-btn ${c[key] ? 'on' : ''}`,
        title,
        onclick: (e: MouseEvent) => {
          const b = e.currentTarget as HTMLElement;
          b.classList.toggle('on');
          handlers.clickerOption(key, b.classList.contains('on'));
        },
      }, icon(iconName, 16), h('span', null, label));
    const notesLast = pair('Notes last', segmented({
      value: c.duration,
      options: [
        { value: 'natural', label: 'As written', title: 'Scaled to how fast you are tapping' },
        { value: 'hold', label: 'While held', title: 'Until you release the key or button' },
        { value: 'next', label: 'Until next tap' },
      ],
      onChange: (v) => handlers.clickerOption('duration', v),
      cls: 'small',
    }).el);
    const loudness = pair('Loudness', segmented({
      value: c.velocity,
      options: [
        { value: 'score', label: 'Score' },
        { value: 'input', label: 'Your touch', title: 'MIDI velocity / where you click' },
        { value: 'fixed', label: 'Fixed' },
      ],
      onChange: (v) => handlers.clickerOption('velocity', v),
      cls: 'small',
    }).el);
    const follows = toggleBtn('accompany', 'Other hand follows', 'hand', 'When tapping one hand, the other hand plays along at your tempo');
    this.tapOnly = [notesLast, loudness, follows];
    this.clickerOpts = h('div', { class: 'drawer-row' },
      pair('Taps play', segmented({
        value: c.target,
        options: [
          { value: 'both', label: 'Both hands' },
          { value: 'R', label: 'Right hand' },
          { value: 'L', label: 'Left hand' },
        ],
        onChange: (v) => handlers.clickerOption('target', v),
        cls: 'small',
      }).el),
      notesLast,
      loudness,
      follows,
      toggleBtn('allowRepeat', 'Key repeat', 'repeat', 'Holding a computer key down auto-repeats taps'),
      this.flowHint,
    );

    this.bar = h('div', { class: 'transport-bar' }, this.autoBar, this.clickerBar);
    this.drawer = h('div', { class: 'transport-drawer' }, this.autoOpts, this.clickerOpts);
    this.setClickerStyle(c.style);
    this.setDrawer(this.drawerOpen);
  }

  private drawerButton() {
    const b = h('button', { class: 'icon-btn drawer-btn', title: 'More options', onclick: () => this.setDrawer(!this.drawerOpen, true) }, icon('sliders', 16), h('span', null, 'Options'));
    this.drawerBtns.push(b);
    return b;
  }

  setDrawer(open: boolean, fromUser = false) {
    this.drawerOpen = open;
    this.drawer.classList.toggle('open', open);
    for (const b of this.drawerBtns) b.classList.toggle('on', open);
    if (fromUser) this.handlers.drawer(open);
  }

  private setClickerStyle(style: 'tap' | 'flow') {
    for (const el of this.tapOnly) el.hidden = style === 'flow';
    this.flowHint.hidden = style !== 'flow';
  }

  setMode(mode: 'play' | 'autoplay' | 'clicker' | 'game', hasScore: boolean) {
    // The bar stays visible without a score (dimmed) so Play is always where you expect it.
    const show = mode === 'autoplay' || mode === 'clicker';
    this.bar.hidden = !show;
    this.bar.classList.toggle('no-score', !hasScore);
    this.drawer.hidden = !show || !hasScore;
    this.autoBar.hidden = mode !== 'autoplay';
    this.autoOpts.hidden = mode !== 'autoplay';
    this.clickerBar.hidden = mode !== 'clicker';
    this.clickerOpts.hidden = mode !== 'clicker';
  }

  setDuration(d: number) {
    this.duration = d;
  }

  update(position: number, state: PlayerState) {
    const playing = state === 'playing' || state === 'waiting' || state === 'counting';
    if (this.playBtn.classList.contains('playing') !== playing) {
      this.playBtn.classList.toggle('playing', playing);
      this.playBtn.replaceChildren(icon(playing ? 'pause' : 'play', 20));
    }
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
