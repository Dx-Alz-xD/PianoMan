// Results after a play: grade, score, accuracy, combo, judgement counts,
// timing (unstable rate, early/late), a hit-error graph over the song and a
// histogram, and where it ranks among your plays of this map.

import { JUDGEMENTS, LABELS, type Judgement } from '../../game/judge';
import { h, icon } from '../../ui/dom';
import { loadRecords } from '../settings';
import type { BeatsApp, Screen } from './app';
import type { PlayResult } from './play';
import { btn, formatTime, levelColor } from './widgets';

const COLORS: Record<Judgement, string> = { perfect: '#7cf8ff', excellent: '#8dff7a', good: '#ffe066', bad: '#ff9f43', miss: '#ff4d6d' };

export class ResultsScreen implements Screen {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private result: PlayResult | null = null;

  constructor(private app: BeatsApp) {
    this.body = h('div', { class: 'pb-results-body' });
    this.el = h('div', { class: 'pb-screen pb-results' }, this.body);
  }

  enter(arg?: unknown) {
    const r = (this.result = arg as PlayResult);
    this.app.backdrop.intensity = 0.8;
    const song = r.song;
    const url = song.cover ? this.app.store.urlSync(song.id, song.cover) : null;
    this.app.backdrop.setCover(url);
    this.app.audio.sfx(r.failed ? 'fail' : 'clear');
    const total = JUDGEMENTS.reduce((s, j) => s + r.counts[j], 0) || 1;
    const records = loadRecords()[r.map.id] || [];
    const prevBest = records.filter((_, i) => i !== r.rank)[0];
    const newBest = r.rank === 0;
    const graph = h('canvas', { class: 'pb-graph' });
    const hist = h('canvas', { class: 'pb-hist' });
    this.body.replaceChildren(
      h(
        'div',
        { class: 'pb-results-left glass' },
        h('div', { class: `pb-grade-big g-${r.grade}` }, r.grade),
        h('div', { class: 'pb-results-tags' }, r.fc ? h('span', { class: 'pb-tag fc' }, r.counts.perfect === total ? 'ALL PERFECT' : 'FULL COMBO') : null, newBest ? h('span', { class: 'pb-tag best' }, icon('trophy', 13), 'NEW BEST') : null, r.mods ? h('span', { class: 'pb-tag' }, r.mods) : null),
        h('div', { class: 'pb-results-score' }, r.score.toLocaleString()),
        prevBest && !newBest ? h('div', { class: 'pb-muted small' }, `Best: ${prevBest.score.toLocaleString()} · ${(prevBest.accuracy * 100).toFixed(2)}%`) : null,
        prevBest && newBest ? h('div', { class: 'pb-muted small' }, `+${(r.score - prevBest.score).toLocaleString()} over your last best`) : null,
        h(
          'div',
          { class: 'pb-results-stats' },
          stat('Accuracy', `${(r.accuracy * 100).toFixed(2)}%`),
          stat('Max combo', `${r.maxCombo}×`),
          stat('Unstable rate', r.ur ? r.ur.toFixed(1) : '—'),
          stat('Mean error', `${r.mean >= 0 ? '+' : ''}${(r.mean * 1000).toFixed(1)} ms`),
          stat('Early / late', `${r.early} / ${r.late}`),
          stat('Speed', `${r.rate.toFixed(2)}×`),
        ),
        h(
          'div',
          { class: 'pb-results-counts' },
          ...JUDGEMENTS.map((j) =>
            h(
              'div',
              { class: 'pb-rc', style: { '--c': COLORS[j] } as unknown as Partial<CSSStyleDeclaration> },
              h('span', null, LABELS[j]),
              h('div', { class: 'pb-rc-bar' }, h('div', { style: { width: `${(r.counts[j] / total) * 100}%` } })),
              h('b', null, String(r.counts[j])),
            ),
          ),
        ),
      ),
      h(
        'div',
        { class: 'pb-results-right' },
        h(
          'div',
          { class: 'pb-results-song glass' },
          url ? h('img', { src: url, alt: '' }) : h('div', { class: 'pb-song-cover placeholder' }, song.title.slice(0, 1)),
          h('div', null, h('h2', null, song.title), h('p', null, song.artist), h('p', { class: 'pb-muted' }, h('span', { style: { color: levelColor(r.map.level) } }, `${r.map.level.toFixed(1)}★ `), `${r.map.name} · ${r.map.creator || 'PIANO-BEATS'}`)),
        ),
        h('div', { class: 'pb-graph-card glass' }, h('h3', null, 'Timing'), graph, h('div', { class: 'pb-graph-legend' }, h('span', null, 'early ↑'), h('span', null, formatTime(r.duration)), h('span', null, 'late ↓'))),
        h('div', { class: 'pb-graph-card glass small' }, h('h3', null, 'Hit errors'), hist),
        h(
          'div',
          { class: 'pb-results-actions' },
          btn('Back to songs', () => void this.app.show('select', { songId: song.id }), { icon: 'back', cls: 'ghost' }),
          btn('Edit map', () => this.app.edit(song, r.map.id), { icon: 'edit' }),
          btn('Retry', () => this.app.play(song, r.map), { icon: 'refresh', cls: 'primary big' }),
        ),
      ),
    );
    requestAnimationFrame(() => {
      this.drawGraph(graph, r);
      this.drawHist(hist, r);
    });
  }

  leave() {}

  keyDown(e: KeyboardEvent) {
    const r = this.result;
    if (!r) return false;
    if (e.code === 'Escape' || e.code === 'Backspace') void this.app.show('select', { songId: r.song.id });
    else if (e.code === 'Enter' || e.code === 'KeyR' || e.code === this.app.settings.retryKey) this.app.play(r.song, r.map);
    else return false;
    return true;
  }

  private drawGraph(c: HTMLCanvasElement, r: PlayResult) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = c.clientWidth;
    const H = c.clientHeight;
    c.width = W * dpr;
    c.height = H * dpr;
    const g = c.getContext('2d')!;
    g.scale(dpr, dpr);
    const w = r.windows;
    const mid = H / 2;
    const sy = (H / 2 - 6) / w.bad;
    const bands: [number, string][] = [[w.bad, COLORS.bad], [w.good, COLORS.good], [w.excellent, COLORS.excellent], [w.perfect, COLORS.perfect]];
    for (const [b, col] of bands) {
      g.fillStyle = hexA(col, 0.08);
      g.fillRect(0, mid - b * sy, W, b * sy * 2);
    }
    g.fillStyle = 'rgba(255,255,255,0.25)';
    g.fillRect(0, mid - 0.5, W, 1);
    const dur = Math.max(1, r.duration, ...r.history.map((x) => x.at));
    for (const hEv of r.history) {
      const x = (Math.max(0, hEv.at) / dur) * W;
      if (hEv.j === 'miss') {
        g.fillStyle = 'rgba(255,77,109,0.5)';
        g.fillRect(x - 0.5, 0, 1, H);
        continue;
      }
      if (!hEv.timed) continue;
      g.fillStyle = COLORS[hEv.j];
      g.beginPath();
      g.arc(x, mid + Math.max(-w.bad, Math.min(w.bad, hEv.delta)) * sy, 1.8, 0, Math.PI * 2);
      g.fill();
    }
  }

  private drawHist(c: HTMLCanvasElement, r: PlayResult) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const W = c.clientWidth;
    const H = c.clientHeight;
    c.width = W * dpr;
    c.height = H * dpr;
    const g = c.getContext('2d')!;
    g.scale(dpr, dpr);
    const bins = 41;
    const counts = new Array(bins).fill(0);
    const w = r.windows.bad;
    for (const e of r.history) {
      if (!e.timed) continue;
      const i = Math.round(((Math.max(-w, Math.min(w, e.delta)) + w) / (2 * w)) * (bins - 1));
      counts[i]++;
    }
    const max = Math.max(1, ...counts);
    const bw = W / bins;
    counts.forEach((n, i) => {
      const d = Math.abs(((i / (bins - 1)) * 2 - 1) * w);
      const j: Judgement = d <= r.windows.perfect ? 'perfect' : d <= r.windows.excellent ? 'excellent' : d <= r.windows.good ? 'good' : 'bad';
      const hh = (n / max) * (H - 4);
      g.fillStyle = COLORS[j];
      g.fillRect(i * bw + 1, H - hh, bw - 2, hh);
    });
    g.fillStyle = 'rgba(255,255,255,0.5)';
    g.fillRect(W / 2 - 0.5, 0, 1, H);
  }
}

function stat(label: string, value: string) {
  return h('div', { class: 'pb-stat' }, h('span', null, label), h('b', null, value));
}

function hexA(c: string, a: number) {
  const v = parseInt(c.slice(1), 16);
  return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${a})`;
}
