// The start screen after loading: choose Piano or 4K Beats.

import { h, icon } from './ui/dom';

export type Area = 'piano' | 'beats';

export class Launcher {
  readonly el: HTMLElement;
  private cards: HTMLElement[] = [];
  private focus = 0;

  constructor(private choose: (area: Area) => void) {
    const keys = h('div', { class: 'lx-keys' });
    const pattern = [0, 1, 1, 0, 1, 1, 1];
    for (let o = 0; o < 2; o++) {
      for (let i = 0; i < 7; i++) {
        const k = h('div', { class: 'lx-white', style: { animationDelay: `${(o * 7 + i) * 0.12}s` } });
        if (pattern[i]) k.append(h('div', { class: 'lx-black', style: { animationDelay: `${(o * 7 + i) * 0.12 + 0.5}s` } }));
        keys.append(k);
      }
    }
    const arrows = h('div', { class: 'lx-arrows' });
    const rot = [-90, 180, 0, 90];
    const cols = ['#ff5ac8', '#29d3ff', '#3dff6e', '#ff4d5e'];
    for (let i = 0; i < 4; i++) {
      const lane = h('div', { class: 'lx-lane' });
      lane.append(h('div', { class: 'lx-receptor', style: { '--c': cols[i], '--r': `${rot[i]}deg` } as unknown as Partial<CSSStyleDeclaration> }, arrowSvg()));
      for (let n = 0; n < 3; n++) {
        lane.append(h('div', { class: 'lx-note', style: { '--c': cols[i], '--r': `${rot[i]}deg`, animationDelay: `${(i * 0.37 + n * 0.83) % 2.4}s` } as unknown as Partial<CSSStyleDeclaration> }, arrowSvg()));
      }
      arrows.append(lane);
    }
    const card = (area: Area, title: string, sub: string, art: HTMLElement, chips: string[], key: string) => {
      const c = h(
        'button',
        { class: `lx-card lx-${area}`, onclick: () => this.pick(area) },
        h('div', { class: 'lx-art' }, art),
        h(
          'div',
          { class: 'lx-text' },
          h('h2', null, title),
          h('p', null, sub),
          h('div', { class: 'lx-chips' }, ...chips.map((x) => h('span', null, x))),
          h('div', { class: 'lx-go' }, h('kbd', null, key), h('span', null, 'Enter'), icon('forward', 18)),
        ),
      );
      c.addEventListener('pointermove', (e) => {
        const r = c.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width - 0.5;
        const y = (e.clientY - r.top) / r.height - 0.5;
        c.style.setProperty('--rx', `${(-y * 6).toFixed(2)}deg`);
        c.style.setProperty('--ry', `${(x * 8).toFixed(2)}deg`);
        c.style.setProperty('--mx', `${((x + 0.5) * 100).toFixed(1)}%`);
        c.style.setProperty('--my', `${((y + 0.5) * 100).toFixed(1)}%`);
      });
      c.addEventListener('pointerenter', () => this.setFocus(this.cards.indexOf(c)));
      c.addEventListener('pointerleave', () => {
        c.style.setProperty('--rx', '0deg');
        c.style.setProperty('--ry', '0deg');
      });
      this.cards.push(c);
      return c;
    };
    this.el = h(
      'div',
      { id: 'launcher', class: 'lx' },
      h('div', { class: 'lx-bg' }, h('div', { class: 'lx-orb a' }), h('div', { class: 'lx-orb b' }), h('div', { class: 'lx-grid' })),
      h(
        'header',
        { class: 'lx-head' },
        h('h1', { class: 'lx-logo' }, h('span', null, 'PIANO'), h('i', null, '-'), h('b', null, 'BEATS')),
        h('p', null, 'Choose how you want to play'),
      ),
      h(
        'div',
        { class: 'lx-cards' },
        card('piano', 'Piano', 'A real piano: sampled grands and more, a full sound-design panel, autoplay with sheet music, and clicker mode.', keys, ['29 sound presets', 'Autoplay', 'Sheet music', 'Clicker', 'MIDI'], '1'),
        card('beats', '4K Beats', 'A four-key rhythm game. Make maps from YouTube, your music files, osu! beatmaps or piano scores – or build them in the editor.', arrows, ['YouTube & files', 'osu! maps', 'Map editor', 'Record player'], '2'),
      ),
      h('footer', { class: 'lx-foot' }, h('span', null, '← → to choose · Enter to start'), h('span', null, 'Switch any time with the Home button')),
    );
    window.addEventListener('keydown', (e) => {
      if (!this.el.classList.contains('show')) return;
      if (e.code === 'ArrowLeft' || e.code === 'ArrowRight' || e.code === 'Tab') {
        e.preventDefault();
        this.setFocus(this.focus === 0 ? 1 : 0);
      } else if (e.code === 'Enter' || e.code === 'Space') {
        e.preventDefault();
        this.pick(this.focus === 0 ? 'piano' : 'beats');
      } else if (e.code === 'Digit1') this.pick('piano');
      else if (e.code === 'Digit2') this.pick('beats');
      else return;
      e.stopImmediatePropagation();
    }, true);
  }

  private setFocus(i: number) {
    this.focus = Math.max(0, Math.min(1, i));
    this.cards.forEach((c, k) => c.classList.toggle('focus', k === this.focus));
  }

  private pick(area: Area) {
    this.el.classList.add(`chose-${area}`);
    setTimeout(() => this.choose(area), 260);
  }

  show(focus: Area = 'piano') {
    this.el.classList.remove('chose-piano', 'chose-beats');
    this.setFocus(focus === 'piano' ? 0 : 1);
    this.el.hidden = false;
    requestAnimationFrame(() => this.el.classList.add('show'));
  }

  hide() {
    this.el.classList.remove('show');
    setTimeout(() => {
      if (!this.el.classList.contains('show')) this.el.hidden = true;
    }, 450);
  }

  get visible() {
    return this.el.classList.contains('show');
  }
}

function arrowSvg(): SVGSVGElement {
  const wrap = document.createElement('span');
  wrap.innerHTML = '<svg viewBox="0 0 18 18" aria-hidden="true"><path d="M9 1 17 9h-4.5v8h-7V9H1z"/></svg>';
  return wrap.firstElementChild as SVGSVGElement;
}
