// The 4K area's settings: a panel that slides in from the right, over any
// screen (menu, song select, even the pause menu).

import { clear, h, icon } from '../../ui/dom';
import { ACCENTS, DEFAULT_BEATS, PALETTES, type Accent, type BeatsSettings, type Hitsound } from '../settings';
import { updateYtDlp, ytDlpStatus, canDownload } from '../web';
import type { BeatsApp } from './app';
import { btn, keyBinder, keyName, modal, row, segmented, select, slider, sounding, textInput, toast, toggle } from './widgets';

type Tab = 'gameplay' | 'display' | 'audio' | 'input' | 'library' | 'interface';

const KEY_PRESETS: { label: string; keys: string[] }[] = [
  { label: 'A S D F', keys: ['KeyA', 'KeyS', 'KeyD', 'KeyF'] },
  { label: 'D F J K', keys: ['KeyD', 'KeyF', 'KeyJ', 'KeyK'] },
  { label: '← ↓ ↑ →', keys: ['ArrowLeft', 'ArrowDown', 'ArrowUp', 'ArrowRight'] },
  { label: 'Z X , .', keys: ['KeyZ', 'KeyX', 'Comma', 'Period'] },
  { label: 'S D K L', keys: ['KeyS', 'KeyD', 'KeyK', 'KeyL'] },
];

export class SettingsPanel {
  private el: HTMLElement;
  private body: HTMLElement;
  private tabs: HTMLElement;
  private tab: Tab = 'gameplay';
  private binders: { onKey(e: KeyboardEvent): boolean; listening: boolean }[] = [];
  isOpen = false;

  constructor(private app: BeatsApp) {
    this.body = h('div', { class: 'pb-set-body' });
    this.tabs = h('nav', { class: 'pb-set-tabs' });
    this.el = h(
      'div',
      { class: 'pb-settings' },
      h('div', { class: 'pb-settings-scrim', onclick: () => this.close() }),
      h(
        'aside',
        { class: 'pb-settings-panel glass' },
        h('div', { class: 'pb-set-head' }, h('h2', null, icon('gear', 20), 'Settings'), sounding(h('button', { class: 'pb-icon-btn', title: 'Close (Esc)', onclick: () => this.close() }, icon('x', 18)), 'back')),
        h('div', { class: 'pb-set-main' }, this.tabs, this.body),
      ),
    );
  }

  private get s(): BeatsSettings {
    return this.app.settings;
  }

  private changed() {
    this.app.settingsChanged();
  }

  open(focus?: string) {
    if (focus && ['gameplay', 'display', 'audio', 'input', 'library', 'interface'].includes(focus)) this.tab = focus as Tab;
    if (!this.el.isConnected) this.app.root.append(this.el);
    this.isOpen = true;
    this.render();
    requestAnimationFrame(() => this.el.classList.add('open'));
    this.app.audio.sfx('whoosh');
  }

  close() {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.el.classList.remove('open');
    this.app.audio.sfx('back');
    setTimeout(() => !this.isOpen && this.el.remove(), 300);
  }

  keyDown(e: KeyboardEvent) {
    for (const b of this.binders) if (b.listening && b.onKey(e)) return;
    if (e.code === 'Escape') {
      e.preventDefault();
      this.close();
    }
  }

  private render() {
    clear(this.tabs);
    const tabs: [Tab, string, string][] = [
      ['gameplay', 'Gameplay', 'gamepad'],
      ['display', 'Display', 'eye'],
      ['audio', 'Audio', 'headphones'],
      ['input', 'Input', 'keyboard'],
      ['library', 'Library', 'library'],
      ['interface', 'Interface', 'palette'],
    ];
    for (const [id, label, ic] of tabs) {
      this.tabs.append(
        sounding(
          h('button', { class: this.tab === id ? 'on' : '', onclick: () => ((this.tab = id), this.render()) }, icon(ic, 17), h('span', null, label)),
          'toggle',
        ),
      );
    }
    clear(this.body);
    this.binders = [];
    const sec = (title: string, ...rows: (Node | null)[]) => h('section', { class: 'pb-set-sec' }, h('h3', null, title), ...rows.filter(Boolean) as Node[]);
    const s = this.s;
    const tog = (key: keyof BeatsSettings) => toggle(s[key] as boolean, (v) => (((s as unknown as Record<string, unknown>)[key] = v), this.changed()));
    const pct = (v: number) => `${Math.round(v * 100)}%`;
    const sl = (key: keyof BeatsSettings, min: number, max: number, step: number, fmt: (v: number) => string) =>
      slider({ value: s[key] as number, min, max, step, reset: DEFAULT_BEATS[key] as number, format: fmt, onInput: (v) => (((s as unknown as Record<string, unknown>)[key] = v), this.changed()) });

    if (this.tab === 'gameplay') {
      const visible = () => `${s.scrollSpeed} · notes on screen ${(18 / Math.max(3, s.scrollSpeed)).toFixed(2)} s`;
      this.body.append(
        sec(
          'Notes',
          row('Scroll speed', slider({ value: s.scrollSpeed, min: 3, max: 40, step: 1, reset: DEFAULT_BEATS.scrollSpeed, format: () => visible(), onInput: (v) => ((s.scrollSpeed = v), this.changed()) })),
          row('Scroll direction', segmented(s.scroll, [{ value: 'down', label: 'Downscroll (osu!)' }, { value: 'up', label: 'Upscroll (FNF)' }], (v) => ((s.scroll = v), this.changed()))),
          row('Note skin', segmented(s.skin, [{ value: 'arrows', label: 'Arrows' }, { value: 'bars', label: 'Bars' }, { value: 'circles', label: 'Circles' }, { value: 'diamonds', label: 'Diamonds' }], (v) => ((s.skin = v), this.changed()))),
          row('Note colours', segmented(s.noteColors, [{ value: 'lanes', label: 'By lane' }, { value: 'snap', label: 'By beat snap' }, { value: 'single', label: 'One colour' }], (v) => ((s.noteColors = v), this.changed())), 'Beat snap: red 1/1, blue 1/2, purple 1/3, yellow 1/4…'),
          row('Lane palette', select(s.palette, (Object.keys(PALETTES) as (keyof typeof PALETTES)[]).map((p) => ({ value: p, label: { fnf: 'FNF', neon: 'Neon', osu: 'osu!mania', pastel: 'Pastel', mono: 'Mono' }[p] })), (v) => ((s.palette = v), this.changed()))),
          row('Single colour', h('input', { type: 'color', class: 'pb-color', value: s.singleColor, oninput: (e: Event) => ((s.singleColor = (e.target as HTMLInputElement).value), this.changed()) })),
          row('Hit position', sl('hitPosition', 0, 40, 1, (v) => `${v}%`), 'Distance of the receptors from the edge'),
          row('Lane width', sl('laneWidth', 48, 160, 2, (v) => `${v}px`)),
          row('Lane cover (sudden)', sl('laneCover', 0, 0.6, 0.02, pct), 'Hides the far part of the lanes'),
        ),
        sec(
          'Judging',
          row('Timing windows', segmented(s.judging, [{ value: 'lenient', label: 'Lenient' }, { value: 'normal', label: 'Normal' }, { value: 'strict', label: 'Strict' }, { value: 'map', label: 'Map OD' }], (v) => ((s.judging = v), this.changed())), 'Map OD uses osu!mania windows'),
          row('Health', segmented(s.healthMode, [{ value: 'normal', label: 'Normal' }, { value: 'nofail', label: 'No fail' }, { value: 'suddendeath', label: 'Sudden death' }, { value: 'perfect', label: 'Perfect only' }], (v) => ((s.healthMode = v), this.changed()))),
          row('Audio offset', h('div', { class: 'pb-inline' }, sl('offset', -250, 250, 1, (v) => `${v > 0 ? '+' : ''}${v} ms`), btn('Calibrate', () => this.calibrate(), { cls: 'small', icon: 'target' })), 'Raise it if you hit late'),
        ),
        sec(
          'Flow',
          row('Countdown', tog('countdown')),
          row('Skip intro with Space', tog('skipIntro')),
          row('Pause when the window loses focus', tog('pauseOnBlur')),
          row('Keep pitch when changing speed', tog('keepPitch')),
        ),
      );
    } else if (this.tab === 'display') {
      this.body.append(
        sec(
          'Background',
          row('Dim', sl('bgDim', 0, 1, 0.02, pct)),
          row('Blur', sl('bgBlur', 0, 30, 1, (v) => `${v}px`)),
          row('Background video', tog('video'), 'When the song has one'),
          row('Lane darkness', sl('laneOpacity', 0, 1, 0.02, pct)),
        ),
        sec(
          'Heads-up display',
          row('Judgements', tog('showJudgement')),
          row('Judgement position', segmented(s.judgementPos, [{ value: 'high', label: 'High' }, { value: 'center', label: 'Centre' }, { value: 'low', label: 'Low' }], (v) => ((s.judgementPos = v), this.changed()))),
          row('Early / late', tog('earlyLate')),
          row('Combo', tog('showCombo')),
          row('Hit error bar', tog('showErrorBar')),
          row('Key overlay', tog('showKeyOverlay')),
          row('Score & counts', tog('showScore')),
          row('Health bar', tog('showHealth')),
          row('Progress', tog('showProgress')),
          row('Notes per second', tog('showNps')),
          row('FPS counter', tog('showFps')),
        ),
        sec('Effects', row('Hit lighting', tog('hitLighting')), row('Particles', tog('particles')), row('Bar lines', tog('barLines')), row('Shake on miss', tog('shake'))),
      );
    } else if (this.tab === 'audio') {
      const hs = select<Hitsound>(s.hitsound, [
        { value: 'none', label: 'None' },
        { value: 'soft', label: 'Soft' },
        { value: 'tick', label: 'Tick' },
        { value: 'clap', label: 'Clap' },
        { value: 'kick', label: 'Kick' },
        { value: 'drum', label: 'Drum' },
        { value: 'piano', label: 'Piano' },
      ], (v) => {
        s.hitsound = v;
        this.changed();
        this.app.audio.hitsound(v, 1);
      });
      this.body.append(
        sec(
          'Volume',
          row('Master', sl('masterVolume', 0, 1, 0.01, pct)),
          row('Music', sl('musicVolume', 0, 1, 0.01, pct)),
          row('Hitsounds', sl('hitsoundVolume', 0, 1, 0.01, pct)),
          row('Keysounds', sl('keysoundVolume', 0, 1, 0.01, pct)),
          row('Effects', sl('effectsVolume', 0, 1, 0.01, pct)),
        ),
        sec(
          'Sounds',
          row('Hitsound', h('div', { class: 'pb-inline' }, hs, btn('Test', () => this.app.audio.hitsound(s.hitsound, 1), { cls: 'small', icon: 'play' }))),
          row('Keysounds of osu! maps', tog('keysounds')),
          row('Miss sound', tog('missSound')),
          row('Menu music', tog('menuMusic')),
          row('Play previews on song select', tog('previewMusic')),
          row('Record crackle', sl('crackle', 0, 1, 0.05, pct)),
        ),
      );
    } else if (this.tab === 'input') {
      const colors = PALETTES[s.palette] || PALETTES.fnf;
      const main = keyBinder(s.keys, colors, (k) => ((s.keys = k), this.changed()));
      const alt = keyBinder(s.altKeys, colors, (k) => ((s.altKeys = k), this.changed()));
      const retry = keyBinder([s.retryKey], ['#8c6cff'], (k) => ((s.retryKey = k[0]), this.changed()));
      this.binders.push(main, alt, retry);
      const presets = h('div', { class: 'pb-inline wrap' }, ...KEY_PRESETS.map((p) => btn(p.label, () => {
        s.keys = [...p.keys];
        main.set(s.keys);
        this.changed();
      }, { cls: 'small ghost' })));
      this.body.append(
        sec('Lanes', row('Keys', main, 'Click a key, then press the new one'), row('Presets', presets), row('Alternate keys', alt, 'Also work, e.g. arrows')),
        sec(
          'Shortcuts',
          row('Quick retry key', retry, `Hold it during play (${keyName(s.retryKey)})`),
          row('Retry hold time', sl('retryHold', 0, 1500, 50, (v) => `${v} ms`)),
          row('−/= nudge the offset', tog('offsetKeys')),
        ),
        sec(
          'Other input',
          row('MIDI keyboard', segmented(s.midi, [{ value: 'white', label: 'Any 4 white keys' }, { value: 'cdef', label: 'C D E F' }, { value: 'off', label: 'Off' }], (v) => ((s.midi = v), this.changed()))),
          row('Touch / mouse on lanes', tog('touch')),
        ),
      );
    } else if (this.tab === 'library') {
      const yt = h('span', { class: 'pb-muted small' }, canDownload ? 'Checking…' : 'Needs the desktop app');
      if (canDownload) void ytDlpStatus().then((st) => (yt.textContent = st.installed ? `yt-dlp ${st.version}` : 'Not installed yet (installed on first download)'));
      this.body.append(
        sec(
          'Mapping',
          row('Your mapper name', textInput(s.creator, (v) => ((s.creator = v.trim()), this.app.save()), { placeholder: 'Shown on maps you make', maxLength: 40 })),
          row('Open the editor after importing', tog('openEditorAfterImport')),
        ),
        sec(
          'Downloads',
          row('Download background videos', tog('importVideo')),
          row('Video quality', select(String(s.videoHeight), ['360', '480', '720', '1080'].map((v) => ({ value: v, label: `${v}p` })), (v) => ((s.videoHeight = parseInt(v, 10)), this.app.save()))),
          row('YouTube downloader', h('div', { class: 'pb-inline' }, yt, canDownload ? btn('Update', async () => {
            yt.textContent = 'Updating…';
            try {
              yt.textContent = `yt-dlp ${await updateYtDlp()}`;
              toast('yt-dlp updated.', 'ok');
            } catch (err) {
              yt.textContent = `Update failed: ${err instanceof Error ? err.message : err}`;
            }
          }, { cls: 'small', icon: 'refresh' }) : null)),
          row('Song files', btn('Open songs folder', () => void this.app.store.openSongFolder(), { cls: 'small', icon: 'folder' })),
        ),
      );
    } else {
      const swatches = h('div', { class: 'pb-swatches' });
      for (const a of Object.keys(ACCENTS) as Accent[]) {
        const [c1, c2, c3] = ACCENTS[a];
        swatches.append(sounding(h('button', { class: `pb-swatch ${s.accent === a ? 'on' : ''}`, title: a, style: { background: `linear-gradient(135deg, ${c1}, ${c2}, ${c3})` }, onclick: () => ((s.accent = a), this.changed(), this.render()) }), 'toggle'));
      }
      this.body.append(
        sec('Look', row('Accent colour', swatches), row('Menu visualizer', tog('visualizer')), row('Reduce motion', tog('reduceMotion'))),
        sec(
          'Reset',
          row('All 4K settings', btn('Reset to defaults', () => {
            const keep = { lastSong: s.lastSong, lastMap: s.lastMap, creator: s.creator };
            Object.assign(s, structuredClone(DEFAULT_BEATS), keep);
            this.changed();
            this.render();
            toast('Settings reset.', 'ok');
          }, { cls: 'small danger' })),
        ),
      );
    }
  }

  /** Tap along with clicks; the average error becomes the offset. */
  private calibrate() {
    const audio = this.app.audio;
    const ctx = audio.ctx;
    const bpm = 100;
    const spb = 60 / bpm;
    const start = ctx.currentTime + 0.6;
    const beats = 24;
    for (let i = 0; i < beats; i++) audio.hitsound('tick', 1, start + i * spb, 1);
    const errs: number[] = [];
    const out = h('div', { class: 'pb-calib-out' }, 'Tap any key (or click) on every click…');
    const dots = h('div', { class: 'pb-calib-dots' });
    const onTap = (stamp: number) => {
      const t = ctx.currentTime - Math.max(0, (performance.now() - stamp) / 1000) - audio.latency;
      const k = Math.round((t - start) / spb);
      if (k < 2 || k >= beats) return;
      const e = t - (start + k * spb);
      if (Math.abs(e) > spb / 3) return;
      errs.push(e);
      dots.append(h('i', { style: { left: `${50 + (e / 0.15) * 50}%` } }));
      const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
      out.textContent = `${errs.length} taps · you tap ${Math.abs(mean * 1000).toFixed(0)} ms ${mean >= 0 ? 'late' : 'early'}`;
    };
    const key = (e: KeyboardEvent) => {
      if (e.code === 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) onTap(e.timeStamp);
    };
    window.addEventListener('keydown', key, true);
    const apply = btn('Use it', () => {
      if (errs.length < 4) return toast('Tap along a few more times.', 'error');
      const mean = errs.reduce((a, b) => a + b, 0) / errs.length;
      this.s.offset = Math.round(mean * 1000);
      this.changed();
      toast(`Offset set to ${this.s.offset} ms`, 'ok');
      m.close();
    }, { cls: 'primary' });
    const m = modal('Calibrate offset', [h('p', { class: 'pb-muted' }, 'Clicks play at 100 BPM. Tap along; the average of your taps sets the audio offset.'), dots, out], {
      onClose: () => {
        window.removeEventListener('keydown', key, true);
        this.render();
      },
      actions: [btn('Cancel', () => m.close(), { cls: 'ghost' }), apply],
    });
    m.body.addEventListener('pointerdown', (e) => onTap(e.timeStamp));
  }
}
