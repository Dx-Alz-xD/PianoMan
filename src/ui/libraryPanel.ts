// The left-hand panel: your library, online score search, and details of the
// open score.

import { formatTime } from '../core/music';
import type { LibraryEntry } from '../platform/bridge';
import type { Score } from '../score/model';
import { PROVIDERS, getProvider, type SearchResult } from '../search/providers';
import { segmented } from './controls';
import { clear, h, icon } from './dom';

export interface LibraryHandlers {
  openFile(): void;
  openUrl(): void;
  openEntry(e: LibraryEntry): void;
  deleteEntry(e: LibraryEntry): void;
  favoriteEntry(e: LibraryEntry): void;
  openResult(r: SearchResult): Promise<void>;
  selectTune(i: number): void;
  saveCurrent(): void;
  exportMidi(): void;
  externalLink(url: string): void;
  tabChanged(tab: 'library' | 'search' | 'info'): void;
}

const FORMAT_LABEL: Record<string, string> = { musicxml: 'MusicXML', mxl: 'MXL', midi: 'MIDI', abc: 'ABC', recording: 'Recording' };
const KEYS = ['C♭', 'G♭', 'D♭', 'A♭', 'E♭', 'B♭', 'F', 'C', 'G', 'D', 'A', 'E', 'B', 'F♯', 'C♯'];

export class LibraryPanel {
  readonly el: HTMLElement;
  private tabs: ReturnType<typeof segmented<'library' | 'search' | 'info'>>;
  private libraryView: HTMLElement;
  private searchView: HTMLElement;
  private infoView: HTMLElement;
  private libraryList: HTMLElement;
  private filterInput: HTMLInputElement;
  private entries: LibraryEntry[] = [];
  private demos: HTMLElement;
  private providerId = 'asap';
  private queryInput!: HTMLInputElement;
  private results!: HTMLElement;
  private providerInfo!: HTMLElement;
  private providerChips!: HTMLElement;
  private page = 0;
  private lastQuery = '';
  private searchToken = 0;

  constructor(private handlers: LibraryHandlers, tab: 'library' | 'search' | 'info') {
    this.tabs = segmented({
      value: tab,
      options: [
        { value: 'library', label: 'Library', icon: icon('library', 15) },
        { value: 'search', label: 'Search', icon: icon('search', 15) },
        { value: 'info', label: 'Score', icon: icon('info', 15) },
      ],
      onChange: (t) => this.show(t),
      cls: 'panel-tabs',
    });

    // Library.
    this.filterInput = h('input', { type: 'search', class: 'text-input', placeholder: 'Filter your library…', oninput: () => this.renderLibrary() }) as HTMLInputElement;
    this.libraryList = h('div', { class: 'list' });
    this.demos = h('div', { class: 'list demo-list' });
    this.libraryView = h('div', { class: 'tab-view' },
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn primary', onclick: () => handlers.openFile() }, icon('folder', 16), 'Open file…'),
        h('button', { class: 'btn', onclick: () => handlers.openUrl() }, icon('link', 16), 'From URL…'),
      ),
      h('p', { class: 'hint' }, 'MusicXML (.musicxml, .xml, .mxl), MIDI (.mid, .midi, .kar) and ABC (.abc). You can also drop files anywhere on the window.'),
      h('h3', { class: 'list-title' }, 'Demos'),
      this.demos,
      h('h3', { class: 'list-title' }, 'Your library'),
      this.filterInput,
      this.libraryList,
    );

    // Search.
    this.searchView = h('div', { class: 'tab-view' });
    this.buildSearch();

    this.infoView = h('div', { class: 'tab-view' }, h('p', { class: 'empty' }, 'No score open yet.'));

    this.el = h('aside', { class: 'panel library-panel', 'aria-label': 'Library and search' },
      this.tabs.el,
      h('div', { class: 'panel-scroll' }, this.libraryView, this.searchView, this.infoView),
    );
    this.show(tab, false);
    void this.loadDemos();
  }

  show(tab: 'library' | 'search' | 'info', notify = true) {
    this.tabs.set(tab);
    this.libraryView.hidden = tab !== 'library';
    this.searchView.hidden = tab !== 'search';
    this.infoView.hidden = tab !== 'info';
    if (tab === 'search') window.setTimeout(() => this.queryInput.focus(), 30);
    if (notify) this.handlers.tabChanged(tab);
  }

  focusSearch() {
    this.show('search');
  }

  // ------------------------------------------------------------ library ----

  private async loadDemos() {
    try {
      const page = await getProvider('demos').search('', 0);
      clear(this.demos);
      for (const r of page.results) this.demos.append(this.resultRow(r, true));
    } catch {
      this.demos.append(h('p', { class: 'empty' }, 'Demos unavailable.'));
    }
  }

  setEntries(entries: LibraryEntry[]) {
    this.entries = entries;
    this.renderLibrary();
  }

  private renderLibrary() {
    clear(this.libraryList);
    const q = this.filterInput.value.toLowerCase().trim();
    const list = this.entries
      .filter((e) => !q || `${e.title} ${e.composer || ''} ${e.fileName}`.toLowerCase().includes(q))
      .sort((a, b) => Number(!!b.favorite) - Number(!!a.favorite) || (b.lastOpenedAt || b.addedAt || '').localeCompare(a.lastOpenedAt || a.addedAt || ''));
    if (!list.length) {
      this.libraryList.append(h('p', { class: 'empty' }, this.entries.length ? 'Nothing matches.' : 'Scores you open or download are kept here, so they work offline too.'));
      return;
    }
    for (const e of list) {
      const row = h('div', { class: 'row', tabindex: '0', role: 'button', onclick: () => this.handlers.openEntry(e), onkeydown: (ev: KeyboardEvent) => ev.key === 'Enter' && this.handlers.openEntry(e) },
        h('div', { class: 'row-main' },
          h('div', { class: 'row-title' }, e.title),
          h('div', { class: 'row-sub' }, h('span', { class: `badge fmt-${e.format}` }, FORMAT_LABEL[e.format] || e.format), e.composer ? ` ${e.composer}` : '', e.source ? ` · ${e.source}` : ''),
        ),
        h('button', { class: `icon-btn fav ${e.favorite ? 'on' : ''}`, title: e.favorite ? 'Unfavourite' : 'Favourite', onclick: (ev: MouseEvent) => (ev.stopPropagation(), this.handlers.favoriteEntry(e)) }, icon('star', 16)),
        h('button', { class: 'icon-btn', title: 'Remove from library', onclick: (ev: MouseEvent) => (ev.stopPropagation(), this.handlers.deleteEntry(e)) }, icon('trash', 16)),
      );
      this.libraryList.append(row);
    }
  }

  // ------------------------------------------------------------- search ----

  private buildSearch() {
    this.queryInput = h('input', {
      type: 'search',
      class: 'text-input search-input',
      placeholder: 'Search scores – e.g. "moonlight", "chopin etude", "mario"',
      onkeydown: (e: KeyboardEvent) => {
        e.stopPropagation();
        if (e.key === 'Enter') void this.runSearch(true);
      },
    }) as HTMLInputElement;
    this.providerChips = h('div', { class: 'chips' });
    for (const p of PROVIDERS.filter((x) => x.id !== 'demos')) {
      this.providerChips.append(
        h('button', { class: `chip-btn ${p.id === this.providerId ? 'active' : ''}`, dataset: { id: p.id }, title: p.description, onclick: () => this.selectProvider(p.id) },
          p.online ? icon('cloud', 13) : icon('library', 13), p.name),
      );
    }
    this.providerInfo = h('div', { class: 'provider-info' });
    this.results = h('div', { class: 'list results' });
    this.searchView.append(
      h('div', { class: 'search-bar' }, this.queryInput, h('button', { class: 'btn primary', onclick: () => void this.runSearch(true) }, icon('search', 16))),
      this.providerChips,
      this.providerInfo,
      this.results,
    );
    this.renderProviderInfo();
  }

  private selectProvider(id: string) {
    this.providerId = id;
    for (const b of Array.from(this.providerChips.children) as HTMLElement[]) b.classList.toggle('active', b.dataset.id === id);
    this.renderProviderInfo();
    if (this.queryInput.value.trim() || !getProvider(id).online) void this.runSearch(true);
    else clear(this.results);
  }

  private renderProviderInfo() {
    const p = getProvider(this.providerId);
    clear(this.providerInfo);
    this.providerInfo.append(
      h('p', null, p.description),
      h('p', { class: 'muted' },
        h('span', { class: 'badge' }, p.formats), ' ', p.license, ' ',
        p.homepage ? h('a', { href: '#', onclick: (e: Event) => (e.preventDefault(), this.handlers.externalLink(p.homepage)) }, 'Website ', icon('external', 12)) : '',
      ),
    );
  }

  async runSearch(reset: boolean) {
    const p = getProvider(this.providerId);
    const q = this.queryInput.value.trim();
    if (p.online && !q) {
      this.queryInput.focus();
      return;
    }
    if (reset) {
      this.page = 0;
      this.lastQuery = q;
      clear(this.results);
    }
    const token = ++this.searchToken;
    const more = this.results.querySelector('.more-btn');
    more?.remove();
    const spinner = h('div', { class: 'loading-row' }, h('span', { class: 'spinner' }), `Searching ${p.name}…`);
    this.results.append(spinner);
    try {
      const page = await p.search(this.lastQuery, this.page);
      if (token !== this.searchToken) return;
      spinner.remove();
      if (!page.results.length && this.page === 0) {
        this.results.append(h('p', { class: 'empty' }, `No results on ${p.name}. Try another source or fewer words.`));
        return;
      }
      if (this.page === 0 && page.total !== undefined) this.results.append(h('p', { class: 'muted result-count' }, `${page.total.toLocaleString()} results`));
      for (const r of page.results) this.results.append(this.resultRow(r));
      if (page.hasMore) {
        this.results.append(h('button', { class: 'btn more-btn', onclick: () => (this.page++, void this.runSearch(false)) }, 'Load more'));
      }
    } catch (err) {
      if (token !== this.searchToken) return;
      spinner.remove();
      this.results.append(h('p', { class: 'error' }, `${p.name} search failed: ${err instanceof Error ? err.message : err}. Check your internet connection.`));
    }
  }

  private resultRow(r: SearchResult, compact = false): HTMLElement {
    const status = h('span', { class: 'row-status' });
    const row = h('div', { class: `row ${compact ? 'compact' : ''}`, tabindex: '0', role: 'button' },
      h('div', { class: 'row-main' },
        h('div', { class: 'row-title' }, r.title),
        h('div', { class: 'row-sub' }, h('span', { class: `badge fmt-${r.format}` }, FORMAT_LABEL[r.format]), r.composer ? ` ${r.composer}` : '', r.detail && !compact ? ` · ${r.detail}` : ''),
      ),
      status,
      r.pageUrl ? h('button', { class: 'icon-btn', title: 'Open source page', onclick: (e: MouseEvent) => (e.stopPropagation(), this.handlers.externalLink(r.pageUrl!)) }, icon('external', 15)) : null,
    );
    const open = async () => {
      if (row.classList.contains('busy')) return;
      row.classList.add('busy');
      clear(status).append(h('span', { class: 'spinner small' }));
      try {
        await this.handlers.openResult(r);
        clear(status).append(icon('check', 15));
      } catch {
        clear(status).append(icon('x', 15));
      } finally {
        row.classList.remove('busy');
      }
    };
    row.addEventListener('click', open);
    row.addEventListener('keydown', (e) => e.key === 'Enter' && open());
    return row;
  }

  // --------------------------------------------------------------- info ----

  setScore(score: Score | null) {
    clear(this.infoView);
    if (!score) {
      this.infoView.append(h('p', { class: 'empty' }, 'No score open yet.'));
      return;
    }
    const hands = { L: 0, R: 0 };
    for (const n of score.notes) hands[n.hand]++;
    const ts = score.timeSignatures[0];
    const tempo = score.tempos[0]?.bpm;
    const uniqueMeasures = new Set(score.measures.map((m) => m.src)).size;
    const rows: [string, string][] = [
      ['Format', FORMAT_LABEL[score.format] || score.format],
      ['Duration', formatTime(score.duration)],
      ['Notes', `${score.notes.length.toLocaleString()} (right ${hands.R.toLocaleString()} · left ${hands.L.toLocaleString()})`],
      ['Measures', score.measures.length === uniqueMeasures ? String(uniqueMeasures) : `${uniqueMeasures} written · ${score.measures.length} played (repeats)`],
      ['Time signature', ts ? `${ts.num}/${ts.den}${score.timeSignatures.length > 1 ? ` (+${score.timeSignatures.length - 1} changes)` : ''}` : '—'],
      ['Tempo', tempo ? `♩ = ${Math.round(tempo)}${score.tempos.length > 1 ? ` (${score.tempos.length - 1} changes)` : ''}` : '—'],
      ['Key', score.keyFifths !== undefined ? `${KEYS[score.keyFifths + 7] || '?'} major / relative minor` : '—'],
      ['Pedal marks', score.pedals.length ? String(score.pedals.length) : 'None'],
    ];
    if (score.source) rows.push(['Source', score.source]);
    this.infoView.append(
      h('h2', { class: 'score-title' }, score.title),
      score.composer ? h('p', { class: 'score-composer' }, score.composer) : '',
      h('dl', { class: 'facts' }, ...rows.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)])),
    );
    if (score.tunes && score.tunes.length > 1) {
      const sel = h('select', { onchange: () => this.handlers.selectTune(parseInt(sel.value, 10)) }, ...score.tunes.map((t, i) => h('option', { value: String(i) }, `${i + 1}. ${t}`))) as HTMLSelectElement;
      sel.value = String(score.tuneIndex || 0);
      this.infoView.append(h('label', { class: 'ctl ctl-select' }, h('span', { class: 'ctl-label' }, `This file has ${score.tunes.length} tunes`), sel));
    }
    if (score.parts.length > 1) {
      this.infoView.append(h('h3', { class: 'list-title' }, 'Parts / tracks'), h('ul', { class: 'parts' }, ...score.parts.map((p) => h('li', null, `${p.name} – ${p.notes} notes`))));
    }
    if (score.warnings.length) this.infoView.append(h('div', { class: 'warn-box' }, ...score.warnings.map((w) => h('p', null, w))));
    if (score.generatedNotation) this.infoView.append(h('p', { class: 'hint' }, 'Sheet music for this file was generated automatically from its notes (quantised to 16ths and triplets).'));
    this.infoView.append(
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn', onclick: () => this.handlers.saveCurrent() }, icon('save', 15), 'Save to library'),
        h('button', { class: 'btn', onclick: () => this.handlers.exportMidi() }, icon('download', 15), 'Export MIDI'),
        score.sourceUrl ? h('button', { class: 'btn', onclick: () => this.handlers.externalLink(score.sourceUrl!) }, icon('external', 15), 'Source') : '',
      ),
    );
  }
}
