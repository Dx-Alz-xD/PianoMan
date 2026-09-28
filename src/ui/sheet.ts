// Sheet-music view (OpenSheetMusicDisplay) with a cursor that follows
// playback, auto-scrolling, zoom and click-to-seek.

import { OpenSheetMusicDisplay, PointF2D } from 'opensheetmusicdisplay';
import { h, icon } from './dom';

interface Step {
  m: number;
  o: number;
}

export class SheetView {
  readonly el: HTMLElement;
  private scroller: HTMLElement;
  private paper: HTMLElement;
  private status: HTMLElement;
  private toolbar: HTMLElement;
  private osmd: OpenSheetMusicDisplay | null = null;
  private steps: Step[] = [];
  private byMeasure = new Map<number, { o: number; i: number }[]>();
  private cur = 0;
  private loadedKey = '';
  private loading: Promise<void> | null = null;
  private zoom = 1;
  private lastScroll = 0;
  follow = true;
  onSeek: ((m: number, o: number) => void) | null = null;
  private zoomLabel: HTMLElement;

  constructor() {
    this.paper = h('div', { class: 'sheet-paper' });
    this.status = h('div', { class: 'sheet-status' });
    this.zoomLabel = h('span', { class: 'zoom-label' }, '100%');
    this.toolbar = h('div', { class: 'sheet-toolbar' },
      h('button', { class: 'icon-btn', title: 'Zoom out', onclick: () => this.setZoom(this.zoom - 0.1) }, icon('zoomOut')),
      this.zoomLabel,
      h('button', { class: 'icon-btn', title: 'Zoom in', onclick: () => this.setZoom(this.zoom + 0.1) }, icon('zoomIn')),
      h('label', { class: 'follow-toggle', title: 'Scroll with the playback cursor' },
        h('input', { type: 'checkbox', checked: true, onchange: (e: Event) => (this.follow = (e.target as HTMLInputElement).checked) }),
        ' Follow'),
    );
    this.scroller = h('div', { class: 'sheet-scroll' }, this.paper);
    this.el = h('div', { class: 'sheet' }, this.toolbar, this.scroller, this.status);
    this.paper.addEventListener('click', (e) => this.onClick(e));
    this.showMessage('Open a score to see its sheet music.');
  }

  private showMessage(text: string, busy = false) {
    this.status.textContent = '';
    this.status.append(busy ? h('span', { class: 'spinner' }) : '', h('span', null, text));
    this.status.hidden = false;
  }

  get isLoaded() {
    return !!this.osmd && !this.loading;
  }

  clear() {
    this.loadedKey = '';
    this.paper.textContent = '';
    this.osmd = null;
    this.steps = [];
    this.byMeasure.clear();
    this.showMessage('Open a score to see its sheet music.');
  }

  /** Renders MusicXML. `key` identifies the score so re-showing it is instant. */
  async load(xml: string, key: string, generated = false): Promise<void> {
    if (key === this.loadedKey && this.osmd) return this.loading || undefined;
    this.loadedKey = key;
    this.paper.textContent = '';
    this.showMessage('Engraving sheet music…', true);
    const run = async () => {
      // Let the spinner paint before the (synchronous) layout work.
      await new Promise((r) => setTimeout(r, 30));
      if (this.loadedKey !== key) return;
      const osmd = new OpenSheetMusicDisplay(this.paper, {
        autoResize: true,
        backend: 'svg',
        drawTitle: true,
        drawComposer: true,
        drawPartNames: false,
        drawCredits: true,
        autoBeam: generated,
        pageFormat: 'Endless',
        followCursor: false,
        cursorsOptions: [{ type: 0, color: '#26c6da', alpha: 0.45, follow: false }],
      });
      await osmd.load(xml);
      if (this.loadedKey !== key) return;
      osmd.Zoom = this.zoom;
      osmd.render();
      this.osmd = osmd;
      this.indexCursor();
      this.status.hidden = true;
    };
    this.loading = run()
      .catch((err) => {
        console.error(err);
        this.showMessage(`Couldn't draw this score: ${err instanceof Error ? err.message : err}`);
        this.osmd = null;
      })
      .finally(() => (this.loading = null));
    return this.loading;
  }

  private indexCursor() {
    const osmd = this.osmd;
    if (!osmd) return;
    this.steps = [];
    this.byMeasure.clear();
    const cursor = osmd.cursor;
    cursor.show();
    cursor.reset();
    const it = cursor.iterator;
    let guard = 0;
    while (!it.EndReached && guard++ < 200000) {
      const m = it.CurrentMeasureIndex;
      const o = it.CurrentRelativeInMeasureTimestamp.RealValue * 4;
      this.steps.push({ m, o });
      it.moveToNextVisibleVoiceEntry(false);
    }
    this.steps.forEach((s, i) => {
      let list = this.byMeasure.get(s.m);
      if (!list) this.byMeasure.set(s.m, (list = []));
      list.push({ o: s.o, i });
    });
    cursor.reset();
    this.cur = 0;
  }

  /** Moves the cursor to the written position (source measure, offset in quarters). */
  setPosition(pos: { m: number; o: number } | null) {
    const osmd = this.osmd;
    if (!osmd || !pos || !this.steps.length) return;
    const list = this.byMeasure.get(pos.m);
    let target = -1;
    if (list) {
      let bestO = -Infinity;
      for (const e of list) if (e.o <= pos.o + 1e-3 && e.o > bestO) bestO = e.o;
      if (bestO === -Infinity) bestO = list[0].o;
      // The same spot can appear several times when OSMD unrolls repeats: take the nearest.
      const candidates = list.filter((e) => Math.abs(e.o - bestO) < 1e-6).map((e) => e.i);
      target = candidates.find((i) => i >= this.cur) ?? candidates[0];
    } else {
      // Measure without notes (e.g. rests only): nearest earlier step.
      for (let i = this.steps.length - 1; i >= 0; i--) {
        if (this.steps[i].m <= pos.m) {
          target = i;
          break;
        }
      }
    }
    if (target < 0) return;
    this.moveTo(target);
  }

  private moveTo(target: number) {
    const osmd = this.osmd!;
    if (target === this.cur) return;
    const cursor = osmd.cursor;
    if (target < this.cur || target - this.cur > 2000) {
      cursor.reset();
      this.cur = 0;
    }
    const it = cursor.iterator;
    while (this.cur < target && !it.EndReached) {
      it.moveToNextVisibleVoiceEntry(false);
      this.cur++;
    }
    cursor.update();
    this.scrollIntoView();
  }

  private scrollIntoView() {
    if (!this.follow) return;
    const el = this.osmd?.cursor.cursorElement;
    if (!el) return;
    const now = performance.now();
    const r = el.getBoundingClientRect();
    const box = this.scroller.getBoundingClientRect();
    const top = r.top - box.top + this.scroller.scrollTop;
    const margin = box.height * 0.25;
    if (r.top < box.top + 10 || r.bottom > box.bottom - margin) {
      if (now - this.lastScroll < 120) return;
      this.lastScroll = now;
      this.scroller.scrollTo({ top: Math.max(0, top - box.height * 0.2), behavior: 'smooth' });
    }
  }

  setZoom(z: number) {
    this.zoom = Math.min(2.5, Math.max(0.4, Math.round(z * 10) / 10));
    this.zoomLabel.textContent = `${Math.round(this.zoom * 100)}%`;
    if (this.osmd) {
      const keep = this.cur;
      this.osmd.Zoom = this.zoom;
      this.osmd.render();
      this.osmd.cursor.show();
      this.osmd.cursor.reset();
      this.cur = 0;
      this.moveTo(keep);
    }
  }

  private onClick(e: MouseEvent) {
    const osmd = this.osmd;
    if (!osmd || !this.onSeek) return;
    try {
      const sheet = osmd.GraphicSheet;
      const at = sheet.svgToOsmd(sheet.domToSvg(new PointF2D(e.clientX, e.clientY)));
      const entry = sheet.GetNearestStaffEntry(at);
      const m = entry?.parentMeasure?.parentSourceMeasure?.measureListIndex;
      const o = (entry?.relInMeasureTimestamp?.RealValue ?? 0) * 4;
      if (typeof m === 'number') this.onSeek(m, o);
    } catch (err) {
      console.warn('[sheet] click-to-seek failed', err);
    }
  }
}
