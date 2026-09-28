// The right-hand panel: presets, instrument and every sound parameter.

import { INSTRUMENTS, getInstrument, type Instrument } from '../audio/instruments';
import { FACTORY_PRESETS } from '../audio/presets';
import { REVERB_DEFAULTS } from '../audio/reverb';
import type { LoadProgress, SampleQuality } from '../audio/samples';
import { DEFAULT_SOUND, PARAMS, SECTIONS, type ParamDef, type SectionId, type SoundSettings, type UserPreset } from '../core/settings';
import { select, slider, toggle, type Control } from './controls';
import { h, icon } from './dom';

export interface SoundPanelHandlers {
  change(patch: Partial<SoundSettings>): void;
  preset(id: string): void;
  savePreset(): void;
  deletePreset(id: string): void;
  exportPreset(): void;
  importPreset(): void;
  resetPreset(): void;
  quality(q: SampleQuality): void;
  reloadInstrument(): void;
  sectionToggled(id: SectionId, open: boolean): void;
}

type AnyControl = Control<number> | Control<string> | Control<boolean>;

export class SoundPanel {
  readonly el: HTMLElement;
  private sound: SoundSettings = { ...DEFAULT_SOUND };
  private controls = new Map<string, { def: ParamDef; ctl: AnyControl }>();
  private presetSelect!: HTMLSelectElement;
  private instSelect!: HTMLSelectElement;
  private instInfo!: HTMLElement;
  private progressBar!: HTMLElement;
  private progressText!: HTMLElement;
  private deleteBtn!: HTMLButtonElement;
  private qualitySelect!: Control<string>;
  private presetId = '';
  extra: HTMLElement;

  constructor(private handlers: SoundPanelHandlers, private openSections: Partial<Record<SectionId, boolean>>, quality: SampleQuality) {
    this.extra = h('div', { class: 'panel-extra' });
    this.el = h('aside', { class: 'panel sound-panel', 'aria-label': 'Sound settings' });
    this.build(quality);
  }

  private build(quality: SampleQuality) {
    // Presets.
    this.presetSelect = h('select', { class: 'preset-select', 'aria-label': 'Preset', onchange: () => this.handlers.preset(this.presetSelect.value) }) as HTMLSelectElement;
    this.deleteBtn = h('button', { class: 'icon-btn', title: 'Delete this preset', onclick: () => this.handlers.deletePreset(this.presetId) }, icon('trash'));
    const presetCard = h('section', { class: 'card preset-card' },
      h('div', { class: 'card-title' }, icon('star', 16), h('span', null, 'Preset'), h('span', { class: 'modified-dot', title: 'Changed from the saved preset' })),
      this.presetSelect,
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn small', title: 'Save the current sound as a new preset', onclick: () => this.handlers.savePreset() }, icon('save', 15), 'Save as…'),
        h('button', { class: 'btn small', title: 'Revert changes to this preset', onclick: () => this.handlers.resetPreset() }, icon('refresh', 15), 'Revert'),
        h('button', { class: 'icon-btn push', title: 'Export preset to a file', onclick: () => this.handlers.exportPreset() }, icon('download')),
        h('button', { class: 'icon-btn', title: 'Import a preset file', onclick: () => this.handlers.importPreset() }, icon('upload')),
        this.deleteBtn,
      ),
    );

    // Instrument.
    this.instSelect = h('select', { class: 'inst-select', 'aria-label': 'Instrument', onchange: () => this.set({ instrument: this.instSelect.value }) }) as HTMLSelectElement;
    const cats = new Map<string, HTMLOptGroupElement>();
    for (const inst of INSTRUMENTS) {
      let g = cats.get(inst.category);
      if (!g) {
        g = h('optgroup', { label: inst.category });
        cats.set(inst.category, g);
        this.instSelect.append(g);
      }
      g.append(h('option', { value: inst.id }, inst.name));
    }
    this.instInfo = h('div', { class: 'inst-info' });
    this.progressBar = h('div', { class: 'progress-fill' });
    this.progressText = h('span', { class: 'progress-text' });
    this.qualitySelect = select({
      label: 'Sample quality',
      value: quality,
      help: 'How many velocity layers to download. Full sounds best; Light downloads fastest.',
      options: [
        { value: 'full', label: 'Full – every layer' },
        { value: 'balanced', label: 'Balanced – 3 layers' },
        { value: 'light', label: 'Light – 1 layer' },
      ],
      onChange: (v) => this.handlers.quality(v as SampleQuality),
    });
    const instCard = h('section', { class: 'card inst-card' },
      h('div', { class: 'card-title' }, icon('piano', 16), h('span', null, 'Instrument')),
      this.instSelect,
      this.instInfo,
      h('div', { class: 'progress' }, this.progressBar),
      h('div', { class: 'progress-row' }, this.progressText, h('button', { class: 'link-btn', title: 'Download again', onclick: () => this.handlers.reloadInstrument() }, 'Reload')),
      this.qualitySelect.el,
    );

    const sections = SECTIONS.map((sec) => {
      const body = h('div', { class: 'section-body' });
      for (const def of PARAMS.filter((p) => p.section === sec.id)) {
        const ctl = this.makeControl(def);
        this.controls.set(def.key, { def, ctl });
        body.append(ctl.el);
      }
      const details = h('details', { class: 'section', open: !!this.openSections[sec.id] }, h('summary', null, h('span', { class: 'section-icon' }, sec.icon), sec.title, icon('chevron', 16)), body);
      details.addEventListener('toggle', () => this.handlers.sectionToggled(sec.id, details.open));
      return details;
    });

    this.el.append(h('div', { class: 'panel-scroll' }, presetCard, instCard, ...sections, this.extra));
  }

  private makeControl(def: ParamDef): AnyControl {
    const cur = this.sound[def.key as keyof SoundSettings];
    if (def.type === 'range') {
      return slider({
        label: def.label,
        min: def.min,
        max: def.max,
        step: def.step,
        value: cur as number,
        defaultValue: DEFAULT_SOUND[def.key] as number,
        format: def.format,
        help: def.help,
        onInput: (v) => this.set({ [def.key]: v } as Partial<SoundSettings>),
      });
    }
    if (def.type === 'toggle') {
      return toggle({ label: def.label, value: cur as boolean, help: def.help, onChange: (v) => this.set({ [def.key]: v } as Partial<SoundSettings>) });
    }
    return select({
      label: def.label,
      value: String(cur),
      options: def.options,
      help: def.help,
      onChange: (v) => {
        if (def.key === 'temperamentRoot') this.set({ temperamentRoot: parseInt(v, 10) });
        else if (def.key === 'reverbType') {
          const d = REVERB_DEFAULTS[v as SoundSettings['reverbType']];
          this.set({ reverbType: v as SoundSettings['reverbType'], reverbDecay: d.decay, reverbPreDelay: d.preDelay, reverbDamping: d.damping });
        } else this.set({ [def.key]: v } as Partial<SoundSettings>);
      },
    });
  }

  private set(patch: Partial<SoundSettings>) {
    this.sound = { ...this.sound, ...patch };
    this.handlers.change(patch);
    this.sync(this.sound);
  }

  /** Updates all controls to reflect `sound`. */
  sync(sound: SoundSettings) {
    this.sound = { ...sound };
    for (const [key, { def, ctl }] of this.controls) {
      const v = sound[key as keyof SoundSettings];
      (ctl as Control<unknown>).set(def.type === 'select' ? String(v) : v);
      ctl.el.hidden = def.showIf ? !def.showIf(sound) : false;
    }
    this.instSelect.value = sound.instrument;
    this.renderInstInfo(getInstrument(sound.instrument));
  }

  private renderInstInfo(inst: Instrument) {
    this.instInfo.textContent = '';
    this.instInfo.append(
      h('p', { class: 'inst-desc' }, inst.description),
      h('p', { class: 'inst-credit' },
        inst.kind === 'sampled' ? h('span', { class: 'chip' }, icon('cloud', 12), inst.sizeHint) : h('span', { class: 'chip ok' }, 'Offline'),
        h('span', { class: 'chip' }, inst.license),
        h('span', { class: 'muted' }, inst.credit),
      ),
    );
    this.qualitySelect.el.hidden = inst.kind !== 'sampled';
  }

  setPresets(userPresets: UserPreset[], currentId: string, modified: boolean) {
    this.presetId = currentId;
    const sel = this.presetSelect;
    sel.textContent = '';
    const groups = new Map<string, HTMLOptGroupElement>();
    for (const p of FACTORY_PRESETS) {
      let g = groups.get(p.group);
      if (!g) {
        g = h('optgroup', { label: p.group });
        groups.set(p.group, g);
        sel.append(g);
      }
      g.append(h('option', { value: p.id, title: p.description }, p.name));
    }
    if (userPresets.length) {
      const g = h('optgroup', { label: 'My presets' });
      for (const p of userPresets) g.append(h('option', { value: p.id }, p.name));
      sel.append(g);
    }
    sel.value = currentId;
    this.deleteBtn.disabled = !userPresets.some((p) => p.id === currentId);
    this.el.classList.toggle('preset-modified', modified);
    const desc = FACTORY_PRESETS.find((p) => p.id === currentId)?.description;
    sel.title = desc || '';
  }

  setModified(modified: boolean) {
    this.el.classList.toggle('preset-modified', modified);
  }

  setQuality(q: SampleQuality) {
    this.qualitySelect.set(q);
  }

  setProgress(p: LoadProgress | null, state: 'loading' | 'ready' | 'error' | 'synth', message?: string) {
    this.el.dataset.loadState = state;
    if (state === 'synth') {
      this.progressBar.style.width = '100%';
      this.progressText.textContent = 'Generated locally – no download needed';
      return;
    }
    if (!p) {
      this.progressBar.style.width = state === 'ready' ? '100%' : '0%';
      this.progressText.textContent = message || '';
      return;
    }
    const pct = p.total ? ((p.loaded + p.failed) / p.total) * 100 : 0;
    this.progressBar.style.width = `${pct}%`;
    if (state === 'error') this.progressText.textContent = message || 'Download failed';
    else if (p.done) {
      const cached = p.loaded - p.fromNetwork;
      this.progressText.textContent = `${p.loaded} samples ready${p.fromNetwork ? ` · ${p.fromNetwork} downloaded` : ''}${cached > 0 ? ` · ${cached} from cache` : ''}${p.failed ? ` · ${p.failed} missing` : ''}`;
    } else this.progressText.textContent = `Downloading samples ${p.loaded}/${p.total}…`;
  }
}
