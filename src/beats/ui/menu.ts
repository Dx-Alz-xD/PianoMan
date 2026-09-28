// The 4K area's main menu: the PIANO-BEATS emblem ringed by a spectrum
// visualizer that follows the menu music, and the way into everything else.

import { h, icon } from '../../ui/dom';
import type { SongMeta } from '../types';
import type { BeatsApp, Screen } from './app';
import { modal, sounding, toast } from './widgets';

const TIPS = [
  'Drop an .osz, an audio file or a video anywhere to import it.',
  'Grab the record on the song screen and move it to scratch.',
  'Press F1 on the song screen for mods: speed, mirror, hidden, auto…',
  'Hold ` during play to restart instantly.',
  'Press − and = while playing to nudge this map’s offset.',
  'The map editor can generate a map for you, then you fine-tune it.',
  'Export any map as an .osz and play it in osu! too.',
  'Piano scores become maps where your hits play the melody.',
];

export class MenuScreen implements Screen {
  readonly el: HTMLElement;
  private viz: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private emblem: HTMLElement;
  private raf = 0;
  private np: HTMLElement;
  private npTitle: HTMLElement;
  private npArtist: HTMLElement;
  private npCover: HTMLImageElement;
  private npToggle: HTMLButtonElement;
  private stats: HTMLElement;
  private tip: HTMLElement;
  private buttons: HTMLButtonElement[] = [];
  private focus = 0;
  private musicSong: SongMeta | null = null;
  private musicOn = false;
  private tipTimer = 0;
  private smooth = new Float32Array(128);
  private spin = 0;

  constructor(private app: BeatsApp) {
    this.viz = h('canvas', { class: 'pb-viz' });
    this.g = this.viz.getContext('2d')!;
    this.emblem = h(
      'button',
      { class: 'pb-emblem', title: 'Play', onclick: () => this.go('select') },
      this.viz,
      h(
        'div',
        { class: 'pb-emblem-core' },
        emblemGlyph(),
        h('div', { class: 'pb-emblem-word' }, h('span', null, 'PIANO'), h('i', null, '-'), h('b', null, 'BEATS')),
        h('div', { class: 'pb-emblem-sub' }, '4K RHYTHM'),
      ),
    );
    const item = (label: string, sub: string, ic: string, key: string, onclick: () => void, cls = '') => {
      const b = sounding(
        h('button', { class: `pb-menu-btn ${cls}`, onclick }, h('span', { class: 'pb-menu-ic' }, icon(ic, 22)), h('span', { class: 'pb-menu-txt' }, h('b', null, label), h('small', null, sub)), h('kbd', null, key)),
      ) as HTMLButtonElement;
      b.addEventListener('pointerenter', () => this.setFocus(this.buttons.indexOf(b)));
      this.buttons.push(b);
      return b;
    };
    const nav = h(
      'nav',
      { class: 'pb-menu-buttons' },
      item('Play', 'Pick a song and a difficulty', 'play', 'P', () => this.go('select'), 'primary'),
      item('Create', 'Map editor – simple or advanced', 'edit', 'C', () => void this.create()),
      item('Import', 'YouTube, audio files, osu! maps, piano scores', 'download', 'I', () => void this.app.openImport()),
      item('Settings', 'Gameplay, visuals, audio, keys', 'gear', 'S', () => this.app.openSettings()),
      item('Piano mode', 'Back to the start screen', 'piano', 'Esc', () => this.app.home(), 'ghost'),
    );
    this.npCover = h('img', { class: 'pb-np-cover', alt: '' }) as HTMLImageElement;
    this.npTitle = h('b', null, '—');
    this.npArtist = h('span', null, '');
    this.npToggle = sounding(h('button', { class: 'pb-icon-btn', title: 'Pause / play menu music', onclick: () => this.toggleMusic() }, icon('pause', 16))) as HTMLButtonElement;
    this.np = h(
      'div',
      { class: 'pb-np glass' },
      this.npCover,
      h('div', { class: 'pb-np-text' }, h('small', null, 'NOW PLAYING'), this.npTitle, this.npArtist),
      this.npToggle,
      sounding(h('button', { class: 'pb-icon-btn', title: 'Next song', onclick: () => void this.nextMusic() }, icon('forward', 16))),
    );
    this.stats = h('div', { class: 'pb-menu-stats' });
    this.tip = h('div', { class: 'pb-menu-tip' });
    this.el = h(
      'div',
      { class: 'pb-screen pb-menu' },
      h('div', { class: 'pb-menu-top' }, sounding(h('button', { class: 'pb-home', onclick: () => this.app.home() }, icon('home', 17), h('span', null, 'Home')), 'back'), h('div', { class: 'pb-spacer' }), this.np),
      h('div', { class: 'pb-menu-center' }, this.emblem, nav),
      h('div', { class: 'pb-menu-bottom' }, this.stats, this.tip),
    );
  }

  private go(name: 'select') {
    this.app.audio.sfx('start');
    void this.app.show(name);
  }

  /** Create: a map for a new song (import, then the editor) or for one already in the library. */
  private async create() {
    const songs = this.app.store.songs;
    const choice = (ic: string, title: string, text: string, onclick: () => void) =>
      sounding(h('button', { class: 'pb-create-choice', onclick }, h('span', { class: 'pb-menu-ic' }, icon(ic, 22)), h('span', null, h('b', null, title), h('small', null, text))));
    const m = modal('Create a map', [
      h('p', { class: 'pb-muted' }, 'The editor can generate a whole map for you (pick a difficulty and press Generate), or you can place every note yourself.'),
      h(
        'div',
        { class: 'pb-create' },
        choice('plus', 'New song', 'Bring in a song from YouTube, a file, an osu! beatmap or a piano score, then open it in the editor.', () => {
          m.close();
          void this.app.openImport({ edit: true });
        }),
        songs.length
          ? choice('library', 'A song from your library', `${songs.length} songs – pick one, then press Edit.`, () => {
              m.close();
              const last = songs.find((s) => s.id === this.app.settings.lastSong) || songs[0];
              toast('Pick a song, then press Edit (Ctrl+E).');
              void this.app.show('select', { songId: last.id });
            })
          : null,
      ),
    ]);
  }

  private setFocus(i: number) {
    this.focus = Math.max(0, Math.min(this.buttons.length - 1, i));
    this.buttons.forEach((b, k) => b.classList.toggle('focus', k === this.focus));
  }

  async enter() {
    this.app.backdrop.intensity = 1;
    this.setFocus(0);
    const songs = this.app.store.songs;
    const maps = songs.reduce((s, x) => s + x.maps.length, 0);
    this.stats.replaceChildren(
      h('span', null, h('b', null, String(songs.length)), ' songs'),
      h('span', null, h('b', null, String(maps)), ' maps'),
      h('span', null, h('b', null, String(songs.filter((s) => s.source === 'osu').length)), ' from osu!'),
    );
    let tipIndex = Math.floor(Math.random() * TIPS.length);
    const showTip = () => {
      this.tip.replaceChildren(icon('sparkle', 14), h('span', null, TIPS[tipIndex++ % TIPS.length]));
      this.tip.classList.remove('fade');
      void this.tip.offsetWidth;
      this.tip.classList.add('fade');
    };
    showTip();
    clearInterval(this.tipTimer);
    this.tipTimer = window.setInterval(showTip, 7000);
    this.loop();
    // The deck may hold a song-select preview (or be stopped after a game): take it back.
    const ours = this.musicSong && this.app.audio.deck.loadedKey === `menu:${this.musicSong.id}`;
    if (!ours) this.musicOn = false;
    if (this.app.settings.menuMusic && !this.musicOn) await this.nextMusic();
    else if (this.musicSong) {
      this.showNowPlaying(this.musicSong);
      if (this.musicOn) {
        this.app.audio.deck.motor(true);
        this.app.audio.deck.gain(0.85);
      }
    }
    this.np.hidden = !this.musicSong;
  }

  leave() {
    cancelAnimationFrame(this.raf);
    clearInterval(this.tipTimer);
  }

  private showNowPlaying(song: SongMeta) {
    this.np.hidden = false;
    this.npTitle.textContent = song.title;
    this.npArtist.textContent = song.artist;
    const url = song.cover ? this.app.store.urlSync(song.id, song.cover) : null;
    if (url) {
      this.npCover.src = url;
      this.npCover.hidden = false;
    } else this.npCover.hidden = true;
    this.app.backdrop.setCover(url);
  }

  private async nextMusic() {
    const songs = this.app.store.songs.filter((s) => s.id !== this.musicSong?.id);
    const pool = songs.filter((s) => s.source !== 'score').length ? songs.filter((s) => s.source !== 'score') : songs;
    if (!pool.length) {
      this.np.hidden = true;
      return;
    }
    const song = pool[Math.floor(Math.random() * pool.length)];
    this.musicSong = song;
    this.showNowPlaying(song);
    try {
      const deck = this.app.audio.deck;
      deck.gain(0);
      const p = await this.app.library.preview(song);
      if (this.musicSong !== song) return;
      await deck.load(`menu:${song.id}`, p.buffer, p.start, p.length);
      deck.motor(true);
      deck.gain(0.85);
      this.musicOn = true;
      this.npToggle.replaceChildren(icon('pause', 16));
    } catch {
      /* no music: the menu still works */
    }
  }

  private toggleMusic() {
    const deck = this.app.audio.deck;
    this.musicOn = !this.musicOn;
    deck.motor(this.musicOn);
    deck.gain(this.musicOn ? 0.85 : 0);
    this.npToggle.replaceChildren(icon(this.musicOn ? 'pause' : 'play', 16));
  }

  keyDown(e: KeyboardEvent) {
    const k = e.key.toLowerCase();
    if (e.code === 'Escape') this.app.home();
    else if (e.code === 'ArrowDown' || e.code === 'ArrowRight') this.setFocus(this.focus + 1);
    else if (e.code === 'ArrowUp' || e.code === 'ArrowLeft') this.setFocus(this.focus - 1);
    else if (e.code === 'Enter' || e.code === 'Space') this.buttons[this.focus].click();
    else if (k === 'p') this.go('select');
    else if (k === 'c') void this.create();
    else if (k === 'i') void this.app.openImport();
    else if (k === 's') this.app.openSettings();
    else return false;
    return true;
  }

  private loop = () => {
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(this.loop);
    const c = this.viz;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const size = c.clientWidth;
    if (c.width !== Math.round(size * dpr)) {
      c.width = Math.round(size * dpr);
      c.height = Math.round(size * dpr);
    }
    const g = this.g;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, size, size);
    const bass = this.app.backdrop.bass;
    this.emblem.style.setProperty('--pulse', (1 + bass * 0.06).toFixed(3));
    if (!this.app.settings.visualizer) return;
    const f = this.app.backdrop.frequencies;
    const bars = this.smooth.length;
    const cx = size / 2;
    const r0 = size * 0.36;
    this.spin += 0.0015 + bass * 0.01;
    for (let i = 0; i < bars; i++) {
      // Log-spaced bins, mirrored so the ring is symmetric.
      const k = i < bars / 2 ? i : bars - 1 - i;
      const bin = Math.floor(2 + Math.pow(k / (bars / 2), 2) * (f.length * 0.45));
      const v = (f[bin] || 0) / 255;
      this.smooth[i] += (v - this.smooth[i]) * 0.35;
      const len = size * 0.012 + this.smooth[i] * size * 0.13;
      const a = (i / bars) * Math.PI * 2 + this.spin - Math.PI / 2;
      const x1 = cx + Math.cos(a) * r0;
      const y1 = cx + Math.sin(a) * r0;
      const x2 = cx + Math.cos(a) * (r0 + len);
      const y2 = cx + Math.sin(a) * (r0 + len);
      const grad = g.createLinearGradient(x1, y1, x2, y2);
      const hue = (i / bars) * 360;
      grad.addColorStop(0, `hsla(${(hue + 280) % 360}, 90%, 65%, 0.95)`);
      grad.addColorStop(1, `hsla(${(hue + 200) % 360}, 90%, 70%, 0.1)`);
      g.strokeStyle = grad;
      g.lineWidth = Math.max(2, (size / bars) * 1.7);
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(x1, y1);
      g.lineTo(x2, y2);
      g.stroke();
    }
  };
}

/** The emblem's glyph: three piano keys that turn into the four 4K arrows. */
export function emblemGlyph(): SVGSVGElement {
  const wrap = document.createElement('span');
  const arrow = (x: number, rot: number, color: string) =>
    `<g transform="translate(${x} 30) rotate(${rot} 9 9)"><path d="M9 1 17 9h-4.5v8h-7V9H1z" fill="${color}" stroke="rgba(0,0,0,.35)" stroke-width="1" stroke-linejoin="round"/></g>`;
  wrap.innerHTML = `<svg class="pb-glyph" viewBox="0 0 124 80" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <g fill="#fff"><rect x="2" y="10" width="15" height="60" rx="3.5"/><rect x="19" y="10" width="15" height="60" rx="3.5"/><rect x="36" y="10" width="15" height="60" rx="3.5"/></g>
    <g fill="#1b1033"><rect x="12" y="10" width="10" height="36" rx="2.5"/><rect x="30" y="10" width="10" height="36" rx="2.5"/></g>
    ${arrow(52, -90, '#ff5ac8')}${arrow(70, 180, '#29d3ff')}${arrow(88, 0, '#3dff6e')}${arrow(106, 90, '#ff4d5e')}
  </svg>`;
  return wrap.firstElementChild as SVGSVGElement;
}
