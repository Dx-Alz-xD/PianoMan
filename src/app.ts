// PianoMan application: wires inputs, the sound engine, the players and the UI.

import { PianoEngine } from './audio/engine';
import { GameView } from './game/gameView';
import { getInstrument, INSTRUMENTS } from './audio/instruments';
import { Metronome } from './audio/metronome';
import { FACTORY_PRESETS, getFactoryPreset, presetSound } from './audio/presets';
import { AudioRecorder, PerformanceRecorder, scoreToMidi } from './audio/recorder';
import type { SampleQuality } from './audio/samples';
import { clamp, noteName, uid } from './core/music';
import {
  DEFAULT_APP,
  loadAppSettings,
  loadSoundSettings,
  loadUserPresets,
  normalizeSound,
  saveAppSettings,
  saveSoundSettings,
  saveUserPresets,
  type AppMode,
  type AppSettings,
  type SoundSettings,
  type UserPreset,
  type ViewMode,
} from './core/settings';
import { keyToMidi, midiToKeyLabel } from './input/computerKeyboard';
import { MidiInput } from './input/midiInput';
import { bridge, isDesktop, type LibraryEntry, type OpenedFile } from './platform/bridge';
import { AutoPlayer, type PlayerState } from './player/autoplayer';
import { Clicker } from './player/clicker';
import { ensureNotation, loadScore } from './score/loader';
import type { Hand, Score, ScoreNote } from './score/model';
import type { SearchResult } from './search/providers';
import { segmented, select, slider, toggle } from './ui/controls';
import { formatBytes, h, icon } from './ui/dom';
import { FallingNotes } from './ui/fallingNotes';
import { PianoKeyboard } from './ui/keyboard';
import { LibraryPanel } from './ui/libraryPanel';
import { confirmDialog, modal, prompt } from './ui/modal';
import { SheetView } from './ui/sheet';
import { SoundPanel } from './ui/soundPanel';
import { toast } from './ui/toast';
import { Transport } from './ui/transport';

const IGNORED_TAP_KEYS = new Set(['Escape', 'Tab', 'Backspace', 'Home', 'End', 'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'CapsLock', 'ContextMenu']);

export class App {
  private app: AppSettings;
  private sound: SoundSettings;
  private presetBase: SoundSettings;
  private userPresets: UserPreset[];
  private engine: PianoEngine;
  private metronome: Metronome;
  private player: AutoPlayer;
  private clicker: Clicker;
  private midi = new MidiInput();
  private recorder: PerformanceRecorder;
  private audioRec: AudioRecorder;
  private score: Score | null = null;
  private scoreLibraryId: string | null = null;
  private library: LibraryEntry[] = [];

  // UI
  private root: HTMLElement;
  private keyboard = new PianoKeyboard();
  private falling = new FallingNotes();
  private sheet = new SheetView();
  private soundPanel: SoundPanel;
  private libraryPanel: LibraryPanel;
  private transport: Transport;
  private modeTabs!: ReturnType<typeof segmented<AppMode>>;
  private viewTabs!: ReturnType<typeof segmented<ViewMode>>;
  private viewport!: HTMLElement;
  private titleEl!: HTMLElement;
  private recordBtn!: HTMLButtonElement;
  private recordTime!: HTMLElement;
  private metroBtn!: HTMLButtonElement;
  private meterFill!: HTMLElement;
  private status: Record<string, HTMLElement> = {};
  private game!: GameView;
  private railBtns: Record<string, HTMLButtonElement> = {};
  private kbdWrap!: HTMLElement;
  private kbdToggle!: HTMLButtonElement;
  private focusBtn!: HTMLButtonElement;
  private splashDone = false;
  private splashStart = performance.now();
  private pedalEls: Record<'sustain' | 'sostenuto' | 'soft', HTMLElement> = {} as never;

  // input state
  private pressedCodes = new Map<string, number>();
  private userSustain = 0;
  private lastSheetKey = '';
  private clickerDisplay = 0;
  private saveTimer = 0;
  private lastNoteIdx = -1;

  constructor(root: HTMLElement) {
    this.root = root;
    this.app = loadAppSettings();
    this.userPresets = loadUserPresets();
    const presetId = this.app.presetId;
    this.presetBase = this.presetSoundById(presetId) || presetSound(FACTORY_PRESETS[0]);
    this.sound = loadSoundSettings() || { ...this.presetBase };
    if (!INSTRUMENTS.some((i) => i.id === this.sound.instrument)) this.sound.instrument = this.presetBase.instrument;

    this.engine = new PianoEngine(this.app.latency);
    this.metronome = new Metronome(this.engine.ctx, this.engine.clickBus);
    this.player = new AutoPlayer(this.engine, this.metronome);
    this.clicker = new Clicker(this.engine);
    this.recorder = new PerformanceRecorder(() => this.engine.ctx.currentTime);
    this.audioRec = new AudioRecorder(this.engine.ctx, () => this.engine.recordStream());

    this.soundPanel = new SoundPanel(
      {
        change: (patch) => this.changeSound(patch),
        preset: (id) => this.applyPreset(id),
        savePreset: () => void this.savePreset(),
        deletePreset: (id) => void this.deletePreset(id),
        exportPreset: () => void this.exportPreset(),
        importPreset: () => void this.importPreset(),
        resetPreset: () => this.applyPreset(this.app.presetId),
        quality: (q) => this.setQuality(q),
        reloadInstrument: () => void this.engine.loadInstrument(this.sound.instrument, this.app.sampleQuality),
        sectionToggled: (id, open) => {
          this.app.settingsSections[id] = open;
          this.saveApp();
        },
      },
      this.app.settingsSections,
      this.app.sampleQuality,
    );
    this.libraryPanel = new LibraryPanel(
      {
        openFile: () => void this.openFileDialog(),
        openUrl: () => void this.openUrlDialog(),
        openEntry: (e) => void this.openLibraryEntry(e),
        deleteEntry: (e) => void this.deleteLibraryEntry(e),
        favoriteEntry: (e) => void this.favoriteLibraryEntry(e),
        openResult: (r) => this.openSearchResult(r),
        selectTune: (i) => this.selectTune(i),
        saveCurrent: () => void this.saveCurrentToLibrary(true),
        exportMidi: () => void this.exportCurrentMidi(),
        externalLink: (url) => bridge.openExternal(url),
        tabChanged: (tab) => {
          this.app.panels.libraryTab = tab;
          this.saveApp();
          this.applyPanels();
        },
      },
      this.app.panels.libraryTab,
    );
    this.transport = new Transport(
      {
        toggle: () => this.togglePlay(),
        stop: () => {
          this.player.stop();
          this.player.seek(0);
        },
        seek: (t) => this.player.seek(t),
        speed: (v) => {
          this.app.player.speed = v;
          this.player.setSpeed(v);
          this.saveApp();
        },
        hands: (hand, on) => this.setHand(hand, on),
        loopA: () => this.player.setLoop(this.player.position, this.player.loop?.b ?? this.player.duration),
        loopB: () => this.player.setLoop(this.player.loop?.a ?? 0, this.player.position),
        loopClear: () => this.player.setLoop(null, null),
        option: (key, value) => this.setPlayerOption(key, value),
        clickerOption: (key, value) => {
          (this.app.clicker as Record<string, unknown>)[key] = value;
          this.clicker.setOptions({ [key]: value });
          this.saveApp();
          if (this.app.mode === 'clicker' && (key === 'style' || key === 'target')) this.setMode('clicker', false);
        },
        clickerReset: () => this.clickerReset(),
        clickerBack: () => this.clickerBack(),
        clickerTap: () => this.tap('button', 96),
        drawer: (open) => {
          this.app.panels.drawer = open;
          this.saveApp();
          this.refreshGeometrySoon();
        },
      },
      this.app,
    );

    this.buildLayout();
    this.applyAppSettings();
    this.wireEngine();
    this.wireInputs();
    this.wirePlayers();
    this.wirePlatform();

    this.engine.setSettings({ ...this.sound, instrument: this.engine.instrument.id });
    this.splash(`Loading ${getInstrument(this.sound.instrument).name}…`, 0.15);
    void this.engine.loadInstrument(this.sound.instrument, this.app.sampleQuality);
    // Never keep the loading screen up for long (e.g. offline): the synth fallback plays meanwhile.
    window.setTimeout(() => this.hideSplash(), 9000);
    this.soundPanel.sync(this.sound);
    this.refreshPresetList();
    void this.midi.init().then(() => this.renderMidiStatus());
    void this.refreshLibrary();
    this.setMode(this.app.mode, false);
    this.setView(this.app.view);
    requestAnimationFrame(() => this.frame());
    window.setInterval(() => this.slowTick(), 150);
  }

  // =========================================================== layout ====

  private buildLayout() {
    this.modeTabs = segmented<AppMode>({
      value: this.app.mode,
      options: [
        { value: 'play', label: 'Free play', icon: icon('piano', 16), title: 'Play the piano yourself' },
        { value: 'autoplay', label: 'Autoplay', icon: icon('play', 16), title: 'The piano plays the score for you' },
        { value: 'clicker', label: 'Clicker', icon: icon('pointer', 16), title: 'Every key press or click moves the score on' },
        { value: 'game', label: '4K', icon: icon('keyboard', 16), title: '4-key rhythm game made from any score' },
      ],
      onChange: (m) => this.setMode(m),
      cls: 'mode-tabs',
    });
    this.viewTabs = segmented<ViewMode>({
      value: this.app.view,
      options: [
        { value: 'notes', label: 'Notes', icon: icon('notes', 16), title: 'Falling notes (Ctrl+1)' },
        { value: 'sheet', label: 'Sheet', icon: icon('sheet', 16), title: 'Sheet music (Ctrl+2)' },
        { value: 'split', label: 'Split', icon: icon('split', 16), title: 'Sheet music above falling notes (Ctrl+3)' },
      ],
      onChange: (v) => this.setView(v),
      cls: 'view-tabs',
    });
    this.titleEl = h('button', { class: 'score-title-btn', title: 'Score details', onclick: () => this.showPanel('library', 'info') }, 'No score – open one from the library');
    this.recordTime = h('span', { class: 'record-time' });
    this.recordBtn = h('button', { class: 'tool-btn record-btn', title: 'Record what you play (MIDI + audio)', onclick: () => void this.toggleRecord() }, icon('record', 16), this.recordTime);
    this.metroBtn = h('button', { class: 'tool-btn', title: 'Metronome', onclick: () => this.toggleMetronome() }, icon('metronome', 17));
    const metroMenu = h('button', { class: 'tool-btn caret', title: 'Metronome settings', onclick: (e: MouseEvent) => this.metronomePopover(e.currentTarget as HTMLElement) }, icon('chevron', 14));
    this.meterFill = h('div', { class: 'meter-fill' });
    this.focusBtn = h('button', { class: 'tool-btn', title: 'Focus: collapse everything except the music (Ctrl+.)', onclick: () => this.toggleFocus() }, icon('eye', 17));
    const header = h('header', { class: 'topbar' },
      h('div', { class: 'brand' }, h('span', { class: 'brand-mark' }, icon('piano', 20)), h('span', { class: 'brand-name' }, 'Piano', h('b', null, 'Man'))),
      this.modeTabs.el,
      this.titleEl,
      h('div', { class: 'spacer' }),
      this.viewTabs.el,
      h('div', { class: 'tool-group' }, this.recordBtn, h('span', { class: 'metro-wrap' }, this.metroBtn, metroMenu)),
      h('div', { class: 'meter', title: 'Output level' }, this.meterFill),
      this.focusBtn,
      h('button', { class: 'tool-btn', title: 'Keyboard shortcuts & help (F1)', onclick: () => this.showHelp() }, icon('help')),
    );

    // Side rails: always-visible icons that open and close the panels.
    const railBtn = (id: string, iconName: string, title: string, onclick: () => void) => {
      const b = h('button', { class: 'rail-btn', title, 'aria-label': title, onclick }, icon(iconName, 19));
      this.railBtns[id] = b;
      return b;
    };
    const leftRail = h('nav', { class: 'rail rail-left' },
      railBtn('library', 'library', 'Library & demos (Ctrl+B)', () => this.railPanel('library')),
      railBtn('search', 'search', 'Search scores (Ctrl+F)', () => this.railPanel('search')),
      railBtn('info', 'info', 'Score details', () => this.railPanel('info')),
    );
    const rightRail = h('nav', { class: 'rail rail-right' },
      railBtn('settings', 'sliders', 'Sound settings (Ctrl+,)', () => this.togglePanel('settings')),
    );

    this.game = new GameView(this.engine, this.player, this.app.game, {
      optionsChanged: () => this.saveApp(),
      openLibrary: () => this.showPanel('library', 'library'),
      openSearch: () => this.showPanel('library', 'search'),
    });
    this.viewport = h('div', { class: 'viewport' }, this.sheet.el, this.falling.el, this.game.el);
    this.falling.el.addEventListener('pointerdown', (e) => {
      if (this.app.mode !== 'clicker') return;
      e.preventDefault();
      const r = this.falling.el.getBoundingClientRect();
      const vel = Math.round(50 + ((e.clientY - r.top) / r.height) * 77);
      this.tap(`pointer:${e.pointerId}`, vel);
    });
    const releasePointer = (e: PointerEvent) => this.app.mode === 'clicker' && this.clicker.release(`pointer:${e.pointerId}`);
    this.falling.el.addEventListener('pointerup', releasePointer);
    this.falling.el.addEventListener('pointercancel', releasePointer);
    this.sheet.onSeek = (m, o) => this.seekToWritten(m, o);

    const pedal = (kind: 'sustain' | 'sostenuto' | 'soft', label: string, title: string) => {
      const el = h('button', { class: 'pedal', title }, h('span', { class: 'pedal-dot' }), label);
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        const down = !el.classList.contains('latched');
        el.classList.toggle('latched', down);
        if (kind === 'sustain') this.userPedal(down ? 1 : 0);
        else if (kind === 'sostenuto') this.engine.setSostenuto(down);
        else this.engine.setSoft(down);
      });
      this.pedalEls[kind] = el;
      return el;
    };
    this.kbdToggle = h('button', { class: 'kbd-toggle', title: 'Collapse / expand the keyboard (Ctrl+K)', onclick: () => this.toggleKeyboard() }, icon('chevron', 15), h('span', null, 'Keyboard'));
    const pedalBar = h('div', { class: 'pedal-bar' },
      pedal('soft', 'Una corda', 'Soft pedal – click to latch'),
      pedal('sostenuto', 'Sostenuto', 'Sostenuto pedal – click to latch'),
      pedal('sustain', 'Sustain', 'Damper pedal – hold Space (free play) or Shift, or click to latch'),
      h('span', { class: 'kbd-info' }),
      this.kbdToggle,
    );
    this.status.kbd = pedalBar.querySelector('.kbd-info')!;
    this.kbdWrap = h('div', { class: 'keyboard-wrap' }, pedalBar, this.keyboard.el);

    const stage = h('main', { class: 'stage' }, this.viewport, this.kbdWrap);

    // Bottom bar: player controls on the left, status on the right.
    const status = h('div', { class: 'status-chips' });
    for (const key of ['midi', 'instrument', 'voices', 'latency', 'rec']) {
      this.status[key] = h('span', { class: `status-item status-${key}` });
      status.append(this.status[key]);
    }
    const bottom = h('footer', { class: 'bottom' }, this.transport.drawer, h('div', { class: 'bottombar' }, this.transport.bar, h('div', { class: 'spacer' }), status));

    this.root.append(header, h('div', { class: 'body' }, leftRail, this.libraryPanel.el, stage, this.soundPanel.el, rightRail), bottom);
    this.buildExtraSettings();

    this.keyboard.onResize = () => this.falling.setGeometry(this.keyboard.geometry());
    this.applyPanels();
  }

  /** Reflects open/closed panels, keyboard and focus state in the DOM. */
  private applyPanels() {
    const p = this.app.panels;
    this.root.classList.toggle('hide-library', !p.library);
    this.root.classList.toggle('hide-settings', !p.settings);
    this.root.classList.toggle('kbd-collapsed', !p.keyboard);
    this.root.classList.toggle('focus', p.focus);
    this.focusBtn?.classList.toggle('on', p.focus);
    for (const id of ['library', 'search', 'info']) this.railBtns[id]?.classList.toggle('active', p.library && p.libraryTab === id);
    this.railBtns.settings?.classList.toggle('active', p.settings);
    this.refreshGeometrySoon();
  }

  private refreshGeometrySoon() {
    for (const ms of [30, 280]) window.setTimeout(() => this.falling.setGeometry(this.keyboard.geometry()), ms);
  }

  private railPanel(tab: 'library' | 'search' | 'info') {
    const p = this.app.panels;
    if (p.library && p.libraryTab === tab) {
      p.library = false;
    } else {
      p.library = true;
      p.focus = false;
      this.libraryPanel.show(tab);
    }
    this.saveApp();
    this.applyPanels();
  }

  private toggleKeyboard() {
    this.app.panels.keyboard = !this.app.panels.keyboard;
    this.saveApp();
    this.applyPanels();
  }

  /** Focus mode collapses the panels, drawer and keyboard chrome in one go. */
  private toggleFocus() {
    const p = this.app.panels;
    p.focus = !p.focus;
    if (p.focus) {
      p.library = false;
      p.settings = false;
      p.drawer = false;
      this.transport.setDrawer(false);
    }
    this.saveApp();
    this.applyPanels();
  }

  /** App-level settings shown at the bottom of the sound panel. */
  private buildExtraSettings() {
    const a = this.app;
    const extra = this.soundPanel.extra;
    const midiSelect = h('select', { class: 'midi-select', onchange: () => {
      a.midi.input = midiSelect.value;
      this.midi.select(a.midi.input);
      this.saveApp();
    } }) as HTMLSelectElement;
    this.status.midiSelect = midiSelect;
    const cacheInfo = h('span', { class: 'muted' }, '…');
    this.status.cache = cacheInfo;
    const keyboardSection = h('details', { class: 'section', open: !!a.settingsSections['keyboard' as never] },
      h('summary', null, h('span', { class: 'section-icon' }, '🎹'), 'Keyboard & MIDI', icon('chevron', 16)),
      h('div', { class: 'section-body' },
        select({ label: 'Keys on screen', value: String(a.keyboard.keyCount), options: ['88', '76', '61', '49', '37'].map((v) => ({ value: v, label: `${v} keys` })), onChange: (v) => {
          a.keyboard.keyCount = parseInt(v, 10) as AppSettings['keyboard']['keyCount'];
          this.keyboard.setRange(a.keyboard.keyCount);
          this.saveApp();
        } }).el,
        select({ label: 'Key labels', value: a.keyboard.labels, options: [
          { value: 'none', label: 'None' }, { value: 'c', label: 'C notes (C4)' }, { value: 'all', label: 'All white keys' }, { value: 'keys', label: 'Computer keys' },
        ], onChange: (v) => {
          a.keyboard.labels = v as AppSettings['keyboard']['labels'];
          this.updateKeyLabels();
          this.saveApp();
        } }).el,
        select({ label: 'Computer keyboard layout', value: a.keyboard.layout, help: 'Tracker: two rows (Z–M and Q–P) with sharps on the rows above. Single row: A–L with sharps on W E T Y U O P.', options: [
          { value: 'tracker', label: 'Two rows (Z… / Q…)' }, { value: 'single', label: 'Single row (A S D F…)' },
        ], onChange: (v) => {
          a.keyboard.layout = v as AppSettings['keyboard']['layout'];
          this.updateKeyLabels();
          this.saveApp();
        } }).el,
        slider({ label: 'Computer keyboard velocity', min: 10, max: 127, step: 1, value: a.keyboard.velocity, defaultValue: 96, help: 'Arrow Up/Down also change it.', onInput: (v) => {
          a.keyboard.velocity = v;
          this.updateKbdInfo();
          this.saveApp();
        } }).el,
        h('label', { class: 'ctl ctl-select' }, h('span', { class: 'ctl-label' }, 'MIDI input'), midiSelect),
        select({ label: 'MIDI channel', value: String(a.midi.channel), options: [{ value: '0', label: 'All channels' }, ...Array.from({ length: 16 }, (_, i) => ({ value: String(i + 1), label: `Channel ${i + 1}` }))], onChange: (v) => {
          a.midi.channel = parseInt(v, 10);
          this.midi.channel = a.midi.channel;
          this.saveApp();
        } }).el,
      ),
    );
    const n = a.notes;
    const visualSection = h('details', { class: 'section' },
      h('summary', null, h('span', { class: 'section-icon' }, '🌈'), 'Visuals', icon('chevron', 16)),
      h('div', { class: 'section-body' },
        slider({ label: 'Falling notes look-ahead', min: 1, max: 10, step: 0.5, value: n.lookahead, defaultValue: 3, format: (v) => `${v} s`, onInput: (v) => {
          n.lookahead = v;
          this.applyVisualOptions();
        } }).el,
        toggle({ label: 'Note names on notes', value: n.showNames, onChange: (v) => ((n.showNames = v), this.applyVisualOptions()) }).el,
        toggle({ label: 'Bar lines & lanes', value: n.guides, onChange: (v) => ((n.guides = v), this.applyVisualOptions()) }).el,
        toggle({ label: 'Sparkles', value: n.particles, onChange: (v) => ((n.particles = v), this.applyVisualOptions()) }).el,
        h('label', { class: 'ctl ctl-color' }, h('span', { class: 'ctl-label' }, 'Right hand colour'), h('input', { type: 'color', value: n.colorR, oninput: (e: Event) => ((n.colorR = (e.target as HTMLInputElement).value), this.applyVisualOptions()) })),
        h('label', { class: 'ctl ctl-color' }, h('span', { class: 'ctl-label' }, 'Left hand colour'), h('input', { type: 'color', value: n.colorL, oninput: (e: Event) => ((n.colorL = (e.target as HTMLInputElement).value), this.applyVisualOptions()) })),
        select({ label: 'Theme', value: a.theme, options: [{ value: 'dark', label: 'Dark' }, { value: 'light', label: 'Light' }], onChange: (v) => {
          a.theme = v as AppSettings['theme'];
          document.documentElement.dataset.theme = a.theme;
          this.saveApp();
        } }).el,
      ),
    );
    const systemSection = h('details', { class: 'section' },
      h('summary', null, h('span', { class: 'section-icon' }, '⚙️'), 'Audio device & storage', icon('chevron', 16)),
      h('div', { class: 'section-body' },
        select({ label: 'Audio latency', value: a.latency, help: 'Lower latency feels more responsive; higher is more robust on slow machines. Applies after restarting PianoMan.', options: [
          { value: 'interactive', label: 'Lowest (interactive)' }, { value: 'balanced', label: 'Balanced' }, { value: 'playback', label: 'Safe (playback)' },
        ], onChange: (v) => {
          a.latency = v as AppSettings['latency'];
          this.saveApp();
          toast('Latency setting will apply the next time PianoMan starts.');
        } }).el,
        h('div', { class: 'ctl' }, h('span', { class: 'ctl-label' }, 'Downloaded samples & scores'), cacheInfo),
        h('div', { class: 'btn-row' },
          isDesktop ? h('button', { class: 'btn small', onclick: () => bridge.openCacheFolder() }, icon('folder', 14), 'Open folder') : '',
          h('button', { class: 'btn small danger', onclick: async () => {
            if (!(await confirmDialog('Clear downloads', 'Delete all downloaded instrument samples and cached scores? Instruments will download again when used.', 'Delete'))) return;
            await bridge.clearCache();
            void this.refreshCacheInfo();
            toast('Download cache cleared.', 'success');
          } }, icon('trash', 14), 'Clear cache'),
        ),
        h('button', { class: 'btn small', onclick: () => this.showAbout() }, icon('info', 14), 'About & credits'),
      ),
    );
    extra.append(keyboardSection, visualSection, systemSection);
    keyboardSection.addEventListener('toggle', () => {
      (a.settingsSections as Record<string, boolean>).keyboard = keyboardSection.open;
      this.saveApp();
    });
    void this.refreshCacheInfo();
  }

  private async refreshCacheInfo() {
    const s = await bridge.cacheStats();
    this.status.cache.textContent = s ? `${formatBytes(s.samples.bytes + s.scores.bytes + s.api.bytes)} (${s.samples.files} samples, ${s.scores.files} scores)` : 'Kept in memory for this session (web version)';
  }

  private applyAppSettings() {
    const a = this.app;
    document.documentElement.dataset.theme = a.theme;
    this.keyboard.setRange(a.keyboard.keyCount);
    this.updateKeyLabels();
    this.applyVisualOptions();
    this.player.speed = a.player.speed;
    this.player.hands = { L: a.player.handL, R: a.player.handR };
    this.player.applyPedal = a.player.applyPedal;
    this.player.countIn = a.player.countIn;
    this.player.waitMode = a.player.waitMode;
    this.player.loopWhole = a.player.loop;
    this.player.velocityScale = a.player.velocityScale;
    this.clicker.setOptions({ ...a.clicker });
    this.metronome.bpm = a.metronome.bpm;
    this.metronome.beats = a.metronome.beats;
    this.metronome.volume = a.metronome.volume;
    this.metronome.accent = a.metronome.accent;
    this.metronome.sound = a.metronome.sound;
    this.midi.selected = a.midi.input;
    this.midi.channel = a.midi.channel;
    this.updateKbdInfo();
  }

  private applyVisualOptions() {
    const n = this.app.notes;
    this.falling.opts = { ...n };
    this.keyboard.setHandColors(n.colorR, n.colorL);
    this.saveApp();
  }

  private updateKeyLabels() {
    const k = this.app.keyboard;
    this.keyboard.setLabels(k.labels, (m) => midiToKeyLabel(m, k.layout, k.octave));
  }

  private updateKbdInfo() {
    const k = this.app.keyboard;
    const low = k.layout === 'single' ? (k.octave + 1) * 12 : k.octave * 12;
    this.status.kbd.textContent = `Keys ${noteName(low)}–${noteName(low + (k.layout === 'single' ? 17 : 31))} · velocity ${k.velocity}`;
    this.status.kbd.title = '← → octave · ↑ ↓ velocity';
  }

  private togglePanel(which: 'library' | 'settings') {
    this.app.panels[which] = !this.app.panels[which];
    if (this.app.panels[which]) this.app.panels.focus = false;
    this.saveApp();
    this.applyPanels();
  }

  private showPanel(which: 'library' | 'settings', tab?: 'library' | 'search' | 'info') {
    if (tab) {
      this.libraryPanel.show(tab);
      this.app.panels.libraryTab = tab;
    }
    if (!this.app.panels[which]) this.togglePanel(which);
    else this.applyPanels();
  }

  // ============================================================ modes ====

  private get flow() {
    return this.app.mode === 'clicker' && this.app.clicker.style === 'flow';
  }

  private setMode(mode: AppMode, save = true) {
    const prev = this.app.mode;
    this.app.mode = mode;
    this.modeTabs.set(mode);
    const p = this.player;
    p.setGate(null);
    if (prev === 'autoplay' && mode !== 'autoplay') p.pause();
    if (prev === 'clicker' || mode === 'clicker') p.stop();
    this.game.setVisible(mode === 'game');
    if (!(mode === 'clicker' && this.app.clicker.style === 'tap')) this.clicker.stop();
    // The autoplayer's own options apply in autoplay; flow mode always plays everything as written.
    if (mode === 'autoplay') {
      p.hands = { L: this.app.player.handL, R: this.app.player.handR };
      p.waitMode = this.app.player.waitMode;
      p.loopWhole = this.app.player.loop;
      p.speed = this.app.player.speed;
      p.rebuild();
    } else if (mode === 'clicker' && this.flow) {
      p.hands = { L: true, R: true };
      p.waitMode = false;
      p.loopWhole = false;
      p.loop = null;
      p.speed = 1;
      p.rebuild();
      this.flowTimes = this.clicker.stepTimes();
      p.setGate(this.flowTimes, 2);
      this.transport.setClicker(0, this.flowTimes.length);
    } else if (mode === 'clicker') {
      this.clicker.start();
      this.clicker.reset();
    }
    if (mode === 'game') this.game.load(this.score);
    this.keyboard.setAuto([]);
    this.keyboard.setHints([]);
    this.falling.setScore(mode === 'play' || mode === 'game' ? null : this.score);
    this.falling.setVisible(mode !== 'game' && this.app.view !== 'sheet');
    this.falling.setEmptyHint(
      mode === 'play'
        ? 'Play with your computer keyboard (Z–M and Q–P rows), the mouse, or a MIDI keyboard.\nSpace = sustain pedal · ← → change octave'
        : 'Open a score from the library or search to start.',
    );
    this.falling.getHighlight =
      mode !== 'clicker' ? () => null : this.flow ? () => new Set(this.flowUpcoming()) : () => new Set(this.clicker.upcoming);
    p.metronomeOn = mode === 'autoplay' && this.app.metronome.enabled;
    if (this.app.metronome.enabled) {
      if (mode === 'play') this.metronome.start();
      else this.metronome.stop();
    }
    this.transport.setMode(mode, !!this.score);
    this.root.dataset.mode = mode;
    if (save) this.saveApp();
    if (mode !== 'play' && mode !== 'game' && !this.score) {
      this.showPanel('library', this.app.panels.libraryTab === 'info' ? 'library' : this.app.panels.libraryTab);
    }
    this.refreshGeometrySoon();
  }

  private flowTimes: number[] = [];

  /** Notes of the chord the next tap unlocks (flow mode). */
  private flowUpcoming() {
    const g = this.player.gateProgress;
    const t = g ? this.flowTimes[g.index] : undefined;
    return t === undefined ? [] : this.clicker.notesAt(t);
  }

  /** A tap in clicker mode, from any input. */
  private tap(source: string, velocity: number) {
    if (this.app.mode !== 'clicker' || !this.score) return;
    if (this.app.clicker.style === 'flow') {
      void this.engine.resume();
      this.player.gateTap();
    } else this.clicker.tap(source, velocity);
  }

  private clickerReset() {
    if (this.flow) {
      this.player.stop();
      this.player.setGate(this.flowTimes, 2);
      this.transport.setClicker(0, this.flowTimes.length);
    } else this.clicker.reset();
  }

  private clickerBack() {
    if (!this.flow) {
      this.clicker.back();
      return;
    }
    const pos = this.player.position;
    const prev = [...this.flowTimes].reverse().find((t) => t < pos - 0.05) ?? 0;
    this.player.pause();
    this.player.seek(prev);
    this.transport.setClicker(Math.max(0, this.flowTimes.indexOf(prev)), this.flowTimes.length);
  }

  private setView(view: ViewMode) {
    this.app.view = view;
    this.viewTabs.set(view);
    this.viewport.dataset.view = view;
    this.falling.setVisible(view !== 'sheet' && this.app.mode !== 'game');
    if (view !== 'notes') void this.ensureSheet();
    this.saveApp();
    window.setTimeout(() => this.falling.setGeometry(this.keyboard.geometry()), 50);
  }

  private async ensureSheet() {
    const s = this.score;
    if (!s) {
      this.sheet.clear();
      return;
    }
    if (this.lastSheetKey === s.id) return;
    this.lastSheetKey = s.id;
    try {
      const xml = ensureNotation(s);
      await this.sheet.load(xml, s.id, !!s.generatedNotation);
    } catch (err) {
      console.error(err);
      toast(`Couldn't show sheet music: ${err instanceof Error ? err.message : err}`, 'error');
    }
  }

  private setHand(hand: Hand, on: boolean) {
    if (hand === 'L') this.app.player.handL = on;
    else this.app.player.handR = on;
    this.player.setHands({ [hand]: on });
    this.falling.hands = { ...this.player.hands };
    this.transport.setHand(hand, on);
    this.saveApp();
  }

  private setPlayerOption(key: keyof AppSettings['player'], value: boolean) {
    (this.app.player as Record<string, unknown>)[key] = value;
    this.transport.setOption(key, value);
    if (key === 'applyPedal') {
      this.player.applyPedal = value;
      this.player.rebuild();
    } else if (key === 'countIn') this.player.countIn = value;
    else if (key === 'waitMode') {
      this.player.waitMode = value;
      if (value && this.player.hands.L && this.player.hands.R) toast('Turn off the hand you want to practise (LH or RH) – playback then waits for you at each of its chords.', 'info', 6000);
    } else if (key === 'loop') this.player.loopWhole = value;
    this.saveApp();
  }

  private togglePlay() {
    if (!this.score) {
      this.showPanel('library');
      toast('Open a score first.');
      return;
    }
    if (this.app.mode !== 'autoplay') this.setMode('autoplay');
    void this.engine.resume();
    this.player.toggle();
  }

  // =========================================================== inputs ====

  private wireInputs() {
    // On-screen keyboard.
    this.keyboard.on('noteOn', ({ midi, velocity }) => this.userNoteOn(midi, velocity, `mouse:${midi}`));
    this.keyboard.on('noteOff', ({ midi }) => this.userNoteOff(midi, `mouse:${midi}`));

    // MIDI.
    this.midi.on('noteOn', ({ midi, velocity }) => this.userNoteOn(midi, velocity, `midi:${midi}`));
    this.midi.on('noteOff', ({ midi }) => this.userNoteOff(midi, `midi:${midi}`));
    this.midi.on('sustain', ({ value }) => this.userPedal(value));
    this.midi.on('sostenuto', ({ down }) => {
      this.engine.setSostenuto(down);
      this.recorder.pedal('sostenuto', down ? 1 : 0);
    });
    this.midi.on('soft', ({ down }) => {
      this.engine.setSoft(down);
      this.recorder.pedal('soft', down ? 1 : 0);
    });
    this.midi.on('allOff', () => this.engine.allNotesOff());
    this.midi.on('devices', () => this.renderMidiStatus());
    this.midi.on('activity', () => {
      this.status.midi.classList.add('blink');
      window.setTimeout(() => this.status.midi.classList.remove('blink'), 80);
    });

    // Computer keyboard.
    window.addEventListener('keydown', (e) => this.onKeyDown(e));
    window.addEventListener('keyup', (e) => this.onKeyUp(e));
    window.addEventListener('blur', () => {
      for (const [code, midi] of this.pressedCodes) {
        if (this.app.mode === 'clicker') this.clicker.release(`key:${code}`);
        else this.userNoteOff(midi, `key:${code}`);
      }
      this.pressedCodes.clear();
      if (this.userSustain > 0) this.userPedal(0);
    });

    // Browsers only allow audio after a gesture.
    const unlock = () => void this.engine.resume();
    window.addEventListener('pointerdown', unlock, { capture: true });
    window.addEventListener('keydown', unlock, { capture: true });

    // Drag & drop.
    window.addEventListener('dragover', (e) => {
      e.preventDefault();
      this.root.classList.add('dragging');
    });
    window.addEventListener('dragleave', (e) => {
      if (!e.relatedTarget) this.root.classList.remove('dragging');
    });
    window.addEventListener('drop', async (e) => {
      e.preventDefault();
      this.root.classList.remove('dragging');
      const files = Array.from(e.dataTransfer?.files || []);
      for (const [i, f] of files.entries()) {
        const data = new Uint8Array(await f.arrayBuffer());
        await this.openScoreData(data, f.name, { source: 'Your files', open: i === 0 });
      }
    });
  }

  private isTyping(e: KeyboardEvent) {
    const t = e.target as HTMLElement | null;
    if (!t) return false;
    if (t.isContentEditable) return true;
    if (t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return true;
    if (t.tagName === 'INPUT') return !['range', 'checkbox', 'button', 'color'].includes((t as HTMLInputElement).type);
    return false;
  }

  private onKeyDown(e: KeyboardEvent) {
    if (this.isTyping(e) || document.querySelector('.modal-backdrop')) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod) {
      if (e.key === '1') this.setView('notes');
      else if (e.key === '2') this.setView('sheet');
      else if (e.key === '3') this.setView('split');
      else if (e.key === ',') this.togglePanel('settings');
      else if (e.key.toLowerCase() === 'k') this.toggleKeyboard();
      else if (e.key === '.') this.toggleFocus();
      else if (e.key.toLowerCase() === 'b') this.railPanel(this.app.panels.libraryTab);
      else if (!isDesktop && e.key.toLowerCase() === 'o') void this.openFileDialog();
      else return;
      e.preventDefault();
      return;
    }
    if (e.code === 'F1') {
      e.preventDefault();
      this.showHelp();
      return;
    }
    if (this.app.mode === 'game') {
      if (this.game.keyDown(e)) return;
    }
    if (e.code === 'Escape') {
      this.player.pause();
      this.engine.panic();
      this.keyboard.clearUser();
      for (const el of Object.values(this.pedalEls)) el.classList.remove('latched');
      return;
    }
    const mode = this.app.mode;

    if (mode === 'game') return;
    if (mode === 'clicker') {
      if (e.code === 'Backspace') {
        e.preventDefault();
        this.clickerBack();
        return;
      }
      if (e.code === 'Home') {
        this.clickerReset();
        return;
      }
      if (IGNORED_TAP_KEYS.has(e.code) || /^F\d+$/.test(e.code)) return;
      if (e.repeat && !this.app.clicker.allowRepeat) {
        e.preventDefault();
        return;
      }
      e.preventDefault();
      this.pressedCodes.set(e.code, -1);
      this.tap(`key:${e.code}`, this.app.keyboard.velocity);
      return;
    }

    if (e.code === 'Space') {
      e.preventDefault();
      if (e.repeat) return;
      if (mode === 'autoplay') this.togglePlay();
      else this.userPedal(1);
      return;
    }
    if (e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
      if (!e.repeat) this.userPedal(1);
      return;
    }
    if (mode === 'autoplay' && (e.code === 'Home' || e.code === 'End')) {
      this.player.seek(e.code === 'Home' ? 0 : this.player.duration);
      return;
    }
    const k = this.app.keyboard;
    if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
      if (e.target instanceof HTMLInputElement && e.target.type === 'range') return;
      e.preventDefault();
      k.octave = clamp(k.octave + (e.code === 'ArrowLeft' ? -1 : 1), 1, 7);
      this.updateKeyLabels();
      this.updateKbdInfo();
      this.saveApp();
      return;
    }
    if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
      if (e.target instanceof HTMLInputElement && e.target.type === 'range') return;
      e.preventDefault();
      k.velocity = clamp(k.velocity + (e.code === 'ArrowUp' ? 10 : -10), 10, 127);
      this.updateKbdInfo();
      this.saveApp();
      return;
    }
    if (e.repeat) return;
    const midi = keyToMidi(e.code, k.layout, k.octave);
    if (midi === null) return;
    e.preventDefault();
    this.pressedCodes.set(e.code, midi);
    this.userNoteOn(midi, k.velocity, `key:${e.code}`);
  }

  private onKeyUp(e: KeyboardEvent) {
    const mode = this.app.mode;
    if (mode === 'game') {
      this.game.keyUp(e);
      return;
    }
    if (mode === 'clicker') {
      if (this.pressedCodes.has(e.code)) {
        this.pressedCodes.delete(e.code);
        this.clicker.release(`key:${e.code}`);
      }
      return;
    }
    if (e.code === 'Space' || e.code === 'ShiftLeft' || e.code === 'ShiftRight') {
      if (e.code !== 'Space' || mode !== 'autoplay') {
        if (!this.pedalEls.sustain.classList.contains('latched')) this.userPedal(0);
      }
      return;
    }
    const midi = this.pressedCodes.get(e.code);
    if (midi === undefined) return;
    this.pressedCodes.delete(e.code);
    this.userNoteOff(midi, `key:${e.code}`);
  }

  private userNoteOn(midi: number, velocity: number, source: string) {
    if (this.app.mode === 'game') {
      this.game.midiNote(midi, true);
      return;
    }
    if (this.app.mode === 'clicker') {
      this.tap(source, velocity);
      return;
    }
    this.engine.noteOn(midi, velocity);
    this.keyboard.setUserDown(midi, true);
    this.falling.userNoteOn(midi, velocity);
    this.recorder.noteOn(midi, velocity);
    this.player.userNoteOn(midi);
  }

  private userNoteOff(midi: number, source: string) {
    if (this.app.mode === 'game') {
      this.game.midiNote(midi, false);
      return;
    }
    if (this.app.mode === 'clicker') {
      this.clicker.release(source);
      return;
    }
    this.engine.noteOff(midi);
    this.keyboard.setUserDown(midi, false);
    this.falling.userNoteOff(midi);
    this.recorder.noteOff(midi);
    this.player.userNoteOff(midi);
  }

  private userPedal(value: number) {
    this.userSustain = value;
    this.engine.setSustain(value);
    this.recorder.pedal('sustain', value);
  }

  // ========================================================= loading ====

  private splash(text: string, fraction: number) {
    if (this.splashDone) return;
    const status = document.getElementById('splash-status');
    const fill = document.getElementById('splash-fill');
    if (status) status.textContent = text;
    if (fill) fill.style.width = `${Math.round(Math.max(0.04, Math.min(1, fraction)) * 100)}%`;
  }

  private hideSplash() {
    if (this.splashDone) return;
    this.splashDone = true;
    const el = document.getElementById('splash');
    if (!el) return;
    const wait = Math.max(0, 800 - (performance.now() - this.splashStart));
    window.setTimeout(() => {
      const fill = document.getElementById('splash-fill');
      if (fill) fill.style.width = '100%';
      el.classList.add('done');
      window.setTimeout(() => el.remove(), 600);
    }, wait);
  }

  // ========================================================== engine ====

  private wireEngine() {
    let firstNetwork = true;
    this.engine.on('progress', (p) => {
      if (!this.splashDone) {
        const name = getInstrument(p.instrument).name;
        this.splash(p.fromNetwork ? `Downloading ${name} · ${p.loaded}/${p.total} samples` : `Loading ${name} · ${p.loaded}/${p.total}`, 0.15 + 0.85 * (p.loaded / Math.max(1, p.total)));
        // Playable once the middle of the keyboard has arrived; the rest streams in.
        if (p.done || p.loaded >= Math.min(p.total, 24)) this.hideSplash();
      }
      this.soundPanel.setProgress(p, p.done ? 'ready' : 'loading');
      const inst = getInstrument(p.instrument);
      this.status.instrument.textContent = p.done ? inst.name : `${inst.name} · downloading ${p.loaded}/${p.total}`;
      if (!p.done && p.fromNetwork > 0 && firstNetwork) {
        firstNetwork = false;
        toast(`Downloading "${inst.name}" samples – you can already play; quality improves as they arrive.`, 'info', 5000);
      }
    });
    this.engine.on('ready', ({ id, failed }) => {
      this.hideSplash();
      const inst = getInstrument(id);
      this.status.instrument.textContent = inst.name;
      if (inst.kind === 'synth') this.soundPanel.setProgress(null, 'synth');
      if (failed > 0 && inst.kind === 'sampled') toast(`${failed} sample(s) of "${inst.name}" couldn't be downloaded; neighbouring samples are used instead.`, 'warn');
      void this.refreshCacheInfo();
    });
    this.engine.on('error', ({ message }) => {
      this.hideSplash();
      this.soundPanel.setProgress(null, 'error', 'Offline – using the synth piano until samples can be downloaded');
      this.status.instrument.textContent = 'Offline fallback';
      toast(message, 'error', 8000);
    });
    this.engine.on('pedal', ({ sustain, soft, sostenuto }) => {
      this.pedalEls.sustain.classList.toggle('on', sustain >= 0.5);
      this.pedalEls.sustain.style.setProperty('--amount', String(sustain));
      this.pedalEls.soft.classList.toggle('on', soft);
      this.pedalEls.sostenuto.classList.toggle('on', sostenuto);
    });
  }

  // ============================================================ sound ====

  private presetSoundById(id: string): SoundSettings | null {
    const f = getFactoryPreset(id);
    if (f) return presetSound(f);
    const u = this.userPresets.find((p) => p.id === id);
    return u ? { ...u.sound } : null;
  }

  private changeSound(patch: Partial<SoundSettings>) {
    this.sound = { ...this.sound, ...patch };
    if (patch.instrument && patch.instrument !== this.engine.instrument.id) {
      this.engine.setSettings({ ...patch, instrument: this.engine.instrument.id });
      void this.engine.loadInstrument(patch.instrument, this.app.sampleQuality);
    } else this.engine.setSettings(patch);
    this.soundPanel.setModified(JSON.stringify(this.sound) !== JSON.stringify(this.presetBase));
    clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => saveSoundSettings(this.sound), 300);
  }

  private applyPreset(id: string) {
    const s = this.presetSoundById(id);
    if (!s) return;
    this.app.presetId = id;
    this.presetBase = { ...s };
    const instrumentChanged = s.instrument !== this.engine.instrument.id;
    this.sound = { ...s };
    this.engine.setSettings({ ...s, instrument: this.engine.instrument.id });
    if (instrumentChanged) void this.engine.loadInstrument(s.instrument, this.app.sampleQuality);
    this.soundPanel.sync(this.sound);
    this.refreshPresetList();
    saveSoundSettings(this.sound);
    this.saveApp();
  }

  private refreshPresetList() {
    this.soundPanel.setPresets(this.userPresets, this.app.presetId, JSON.stringify(this.sound) !== JSON.stringify(this.presetBase));
  }

  private async savePreset() {
    const inst = getInstrument(this.sound.instrument);
    const name = await prompt('Save preset', 'Preset name', `My ${inst.name}`);
    if (!name) return;
    const preset: UserPreset = { id: `user-${uid()}`, name, sound: { ...this.sound }, createdAt: new Date().toISOString() };
    this.userPresets.push(preset);
    saveUserPresets(this.userPresets);
    this.app.presetId = preset.id;
    this.presetBase = { ...this.sound };
    this.refreshPresetList();
    this.saveApp();
    toast(`Saved preset "${name}".`, 'success');
  }

  private async deletePreset(id: string) {
    const p = this.userPresets.find((x) => x.id === id);
    if (!p) return;
    if (!(await confirmDialog('Delete preset', `Delete "${p.name}"?`, 'Delete'))) return;
    this.userPresets = this.userPresets.filter((x) => x.id !== id);
    saveUserPresets(this.userPresets);
    this.applyPreset(DEFAULT_APP.presetId);
  }

  private async exportPreset() {
    const name = FACTORY_PRESETS.find((p) => p.id === this.app.presetId)?.name || this.userPresets.find((p) => p.id === this.app.presetId)?.name || 'PianoMan preset';
    const json = JSON.stringify({ pianomanPreset: 1, name, sound: this.sound }, null, 2);
    const path = await bridge.saveFile(`${name}.pianoman.json`, json, [{ name: 'PianoMan preset', extensions: ['json'] }]);
    if (path) toast('Preset exported.', 'success');
  }

  private async importPreset() {
    const file = await bridge.openFile({ title: 'Import preset', accept: '.json', extensions: ['json'] });
    if (!file) return;
    try {
      const data = JSON.parse(new TextDecoder().decode(file.data));
      if (!data || typeof data !== 'object' || !data.sound) throw new Error('Not a PianoMan preset file.');
      const preset: UserPreset = { id: `user-${uid()}`, name: String(data.name || file.name.replace(/\.json$/i, '')), sound: normalizeSound(data.sound), createdAt: new Date().toISOString() };
      this.userPresets.push(preset);
      saveUserPresets(this.userPresets);
      this.applyPreset(preset.id);
      toast(`Imported preset "${preset.name}".`, 'success');
    } catch (err) {
      toast(`Couldn't import preset: ${err instanceof Error ? err.message : err}`, 'error');
    }
  }

  private setQuality(q: SampleQuality) {
    this.app.sampleQuality = q;
    this.saveApp();
    void this.engine.loadInstrument(this.sound.instrument, q);
  }

  // =========================================================== scores ====

  private wirePlayers() {
    this.player.on('state', ({ state, position }) => {
      this.transport.update(position, state);
      this.transport.setLoop(this.player.loop);
      // Hints for the waited-for chord are set by the 'wait' event; clear them once playback moves on.
      if (state !== 'waiting') this.keyboard.setHints([]);
    });
    this.player.on('end', () => {
      this.keyboard.setAuto([]);
      if (this.flow) {
        toast('End of the piece! Tap again to start over.', 'success');
        this.player.setGate(this.flowTimes, 2);
        this.transport.setClicker(0, this.flowTimes.length);
      }
    });
    this.player.on('wait', ({ required }) => this.keyboard.setHints(required));
    this.clicker.on('step', ({ index, total }) => {
      if (this.flow) return;
      this.transport.setClicker(index, total);
      this.keyboard.setHints(this.clicker.upcoming.map((n) => n.midi));
    });
    this.player.on('gate', ({ index, total }) => this.transport.setClicker(index, total));
    this.clicker.on('end', () => toast('End of the piece! Press Home (or ⏮) to start again.', 'success'));
  }

  async openScoreData(data: Uint8Array, fileName: string, meta: { source?: string; sourceUrl?: string; libraryId?: string; open?: boolean; save?: boolean; titleHint?: string; composerHint?: string } = {}) {
    let score: Score;
    try {
      score = loadScore(data, { fileName, source: meta.source, sourceUrl: meta.sourceUrl });
    } catch (err) {
      toast(`Couldn't open ${fileName}: ${err instanceof Error ? err.message : err}`, 'error', 7000);
      throw err;
    }
    const fromFileName = (t: string) => t === fileName.replace(/\.[^.]+$/, '') || t === fileName.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
    if (meta.titleHint && (!score.title || fromFileName(score.title) || /xml_score|midi_score|midi score/i.test(score.title))) score.title = meta.titleHint;
    if (meta.composerHint && !score.composer) score.composer = meta.composerHint;
    let libraryId = meta.libraryId || null;
    if (meta.save !== false && !libraryId) {
      try {
        const entry = await bridge.library.save(
          { title: score.title, composer: score.composer, format: score.format, fileName, source: meta.source, sourceUrl: meta.sourceUrl, lastOpenedAt: new Date().toISOString() },
          data,
        );
        libraryId = entry.id;
        void this.refreshLibrary();
      } catch (err) {
        console.warn('library save failed', err);
      }
    }
    if (meta.open !== false) {
      this.scoreLibraryId = libraryId;
      this.setScore(score);
      for (const w of score.warnings) toast(w, 'warn');
    }
    return score;
  }

  private setScore(score: Score | null) {
    this.score = score;
    this.lastSheetKey = '';
    this.lastNoteIdx = -1;
    this.player.load(score);
    this.clicker.load(score);
    this.clicker.reset();
    this.transport.setDuration(score?.duration || 0);
    this.transport.update(0, 'stopped');
    this.libraryPanel.setScore(score);
    this.titleEl.textContent = score ? `${score.title}${score.composer ? ` — ${score.composer}` : ''}` : 'No score – open one from the library';
    this.titleEl.title = this.titleEl.textContent;
    this.falling.hands = { ...this.player.hands };
    if (score && this.app.mode === 'play') this.setMode('autoplay');
    else this.setMode(this.app.mode, false);
    if (this.app.view !== 'notes') void this.ensureSheet();
    else if (score) this.sheet.clear();
  }

  private selectTune(i: number) {
    const s = this.score;
    if (!s?.abcText) return;
    const data = new TextEncoder().encode(s.abcText);
    try {
      const next = loadScore(data, { fileName: s.fileName, source: s.source, sourceUrl: s.sourceUrl, tuneIndex: i });
      this.setScore(next);
    } catch (err) {
      toast(String(err), 'error');
    }
  }

  private seekToWritten(m: number, o: number) {
    const s = this.score;
    if (!s) return;
    let best: ScoreNote | null = null;
    for (const n of s.notes) {
      if (!n.src || n.src.m !== m) continue;
      if (!best || Math.abs(n.src.o - o) < Math.abs(best.src!.o - o)) best = n;
    }
    if (!best) return;
    if (this.app.mode === 'clicker') this.clicker.seek(best.time);
    else this.player.seek(best.time);
  }

  private async openFileDialog() {
    const files: OpenedFile[] = await bridge.openScores();
    for (const [i, f] of files.entries()) await this.openScoreData(f.data, f.name, { source: 'Your files', open: i === 0 }).catch(() => {});
  }

  private async openUrlDialog() {
    const url = await prompt('Open score from URL', 'Link to a MusicXML, MXL, MIDI or ABC file', '', 'https://…');
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) {
      toast('Please enter an http(s) link.', 'error');
      return;
    }
    try {
      const res = await bridge.fetch<Uint8Array>({ url, responseType: 'arraybuffer', cache: 'scores' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const parts = decodeURIComponent(new URL(res.url || url).pathname).split('/').filter(Boolean);
      const name = parts[parts.length - 1] || 'score';
      // Generic file names ("midi_score.mid", "score.xml") get a title from their folders.
      const generic = /^(midi_?score|xml_?score|score|index|file|download|music)\.[a-z0-9]+$/i.test(name);
      const titleHint = generic && parts.length > 1 ? parts.slice(Math.max(0, parts.length - 4), -1).join(' ').replace(/[_-]+/g, ' ') : undefined;
      await this.openScoreData(res.data, name, { source: new URL(url).hostname, sourceUrl: url, titleHint });
    } catch (err) {
      toast(`Download failed: ${err instanceof Error ? err.message : err}`, 'error');
    }
  }

  private async openSearchResult(r: SearchResult) {
    try {
      const { data, fileName, url } = await r.download();
      await this.openScoreData(data, fileName, {
        source: r.provider,
        sourceUrl: r.pageUrl || url,
        titleHint: r.title,
        composerHint: r.composer,
        save: r.provider !== 'Demo',
      });
    } catch (err) {
      if (!(err instanceof Error && /Couldn't open/.test(err.message))) toast(`Couldn't get "${r.title}": ${err instanceof Error ? err.message : err}`, 'error');
      throw err;
    }
  }

  private async refreshLibrary() {
    try {
      this.library = await bridge.library.list();
      this.libraryPanel.setEntries(this.library);
    } catch (err) {
      console.warn(err);
    }
  }

  private async openLibraryEntry(e: LibraryEntry) {
    try {
      const data = await bridge.library.load(e.id);
      const s = await this.openScoreData(data, e.fileName, { source: e.source, sourceUrl: e.sourceUrl, libraryId: e.id, titleHint: e.title, composerHint: e.composer });
      if (s) await bridge.library.update(e.id, { lastOpenedAt: new Date().toISOString() });
      void this.refreshLibrary();
    } catch {
      /* toast shown */
    }
  }

  private async deleteLibraryEntry(e: LibraryEntry) {
    if (!(await confirmDialog('Remove score', `Remove "${e.title}" from your library?`, 'Remove'))) return;
    await bridge.library.remove(e.id);
    void this.refreshLibrary();
  }

  private async favoriteLibraryEntry(e: LibraryEntry) {
    await bridge.library.update(e.id, { favorite: !e.favorite });
    void this.refreshLibrary();
  }

  private async saveCurrentToLibrary(explicit: boolean) {
    const s = this.score;
    if (!s) return;
    if (this.scoreLibraryId) {
      if (explicit) toast('Already in your library.', 'success');
      return;
    }
    const data = s.format === 'recording' ? scoreToMidi(s) : new TextEncoder().encode(s.musicXml || ensureNotation(s));
    const entry = await bridge.library.save({ title: s.title, composer: s.composer, format: s.format === 'recording' ? 'midi' : 'musicxml', fileName: `${s.title}.${s.format === 'recording' ? 'mid' : 'musicxml'}`, source: s.source || 'PianoMan' }, data);
    this.scoreLibraryId = entry.id;
    void this.refreshLibrary();
    if (explicit) toast('Saved to your library.', 'success');
  }

  private async exportCurrentMidi() {
    const s = this.score;
    if (!s) return;
    const path = await bridge.saveFile(`${s.title}.mid`.replace(/[\\/:*?"<>|]/g, ''), scoreToMidi(s), [{ name: 'MIDI file', extensions: ['mid'] }]);
    if (path) toast('MIDI exported.', 'success');
  }

  // ======================================================== recording ====

  private lastRecording: { score: Score; wav: Uint8Array | null } | null = null;

  private async toggleRecord() {
    if (!this.recorder.recording) {
      void this.engine.resume();
      this.recorder.start();
      try {
        this.audioRec.start();
      } catch (err) {
        console.warn('audio recording unavailable', err);
      }
      this.recordBtn.classList.add('recording');
      toast('Recording… play something, then press ● again to stop.');
      return;
    }
    this.recordBtn.classList.remove('recording');
    this.recordTime.textContent = '';
    const score = this.recorder.stop();
    const wav = this.audioRec.recording ? await this.audioRec.stop().catch(() => null) : null;
    if (!score) {
      toast('Nothing was recorded.');
      return;
    }
    this.lastRecording = { score, wav };
    this.showRecordingDialog();
  }

  private showRecordingDialog() {
    const rec = this.lastRecording;
    if (!rec) return;
    const m = modal('Recording finished', [
      h('p', null, `${rec.score.notes.length} notes · ${Math.round(rec.score.duration)} seconds`),
      h('p', { class: 'muted' }, 'Play it back with the autoplayer, view it as sheet music, or save it.'),
    ], {
      actions: [
        h('button', { class: 'btn', onclick: () => void this.exportRecording('wav') }, icon('download', 15), 'Save WAV'),
        h('button', { class: 'btn', onclick: () => void this.exportRecording('midi') }, icon('download', 15), 'Save MIDI'),
        h('button', { class: 'btn primary', onclick: () => {
          m.close();
          this.scoreLibraryId = null;
          this.setScore(rec.score);
          this.setMode('autoplay');
        } }, icon('play', 15), 'Open in player'),
      ],
    });
  }

  private async exportRecording(kind: 'midi' | 'wav') {
    const rec = this.lastRecording;
    if (!rec) {
      toast('Record something first (● in the top bar).');
      return;
    }
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
    if (kind === 'midi') {
      const p = await bridge.saveFile(`PianoMan ${stamp}.mid`, scoreToMidi(rec.score), [{ name: 'MIDI file', extensions: ['mid'] }]);
      if (p) toast('MIDI saved.', 'success');
    } else if (rec.wav) {
      const p = await bridge.saveFile(`PianoMan ${stamp}.wav`, rec.wav, [{ name: 'WAV audio', extensions: ['wav'] }]);
      if (p) toast('WAV saved.', 'success');
    } else toast('No audio was captured for this recording.', 'warn');
  }

  // ======================================================== metronome ====

  private toggleMetronome() {
    const m = this.app.metronome;
    m.enabled = !m.enabled;
    this.metroBtn.classList.toggle('on', m.enabled);
    void this.engine.resume();
    if (this.app.mode === 'autoplay') {
      this.player.metronomeOn = m.enabled;
      if (m.enabled && !this.player.isPlaying) toast('The metronome follows the score while it plays.');
    } else if (m.enabled) this.metronome.start();
    else this.metronome.stop();
    if (!m.enabled) this.metronome.stop();
    this.saveApp();
  }

  private metronomePopover(anchor: HTMLElement) {
    document.querySelector('.popover')?.remove();
    const m = this.app.metronome;
    const apply = () => {
      this.metronome.bpm = m.bpm;
      this.metronome.beats = m.beats;
      this.metronome.volume = m.volume;
      this.metronome.accent = m.accent;
      this.metronome.sound = m.sound;
      if (this.metronome.isRunning) this.metronome.start();
      this.saveApp();
    };
    let taps: number[] = [];
    const bpmSlider = slider({ label: 'Tempo', min: 30, max: 260, step: 1, value: m.bpm, defaultValue: 100, format: (v) => `${v} BPM`, onInput: (v) => ((m.bpm = v), apply()) });
    const pop = h('div', { class: 'popover' },
      bpmSlider.el,
      h('button', { class: 'btn small', title: 'Tap a few times to set the tempo', onclick: () => {
        const now = performance.now();
        taps = taps.filter((t) => now - t < 3000);
        taps.push(now);
        if (taps.length >= 2) {
          const avg = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
          m.bpm = Math.round(clamp(60000 / avg, 30, 260));
          bpmSlider.set(m.bpm);
          apply();
        }
      } }, 'Tap tempo'),
      select({ label: 'Beats per bar', value: String(m.beats), options: [1, 2, 3, 4, 5, 6, 7, 9, 12].map((b) => ({ value: String(b), label: String(b) })), onChange: (v) => ((m.beats = parseInt(v, 10)), apply()) }).el,
      select({ label: 'Sound', value: m.sound, options: [{ value: 'click', label: 'Click' }, { value: 'wood', label: 'Woodblock' }, { value: 'beep', label: 'Beep' }], onChange: (v) => ((m.sound = v as typeof m.sound), apply()) }).el,
      slider({ label: 'Volume', min: 0, max: 1, step: 0.01, value: m.volume, defaultValue: 0.6, format: (v) => `${Math.round(v * 100)}%`, onInput: (v) => ((m.volume = v), apply()) }).el,
      toggle({ label: 'Accent first beat', value: m.accent, onChange: (v) => ((m.accent = v), apply()) }).el,
    );
    const r = anchor.getBoundingClientRect();
    pop.style.top = `${r.bottom + 6}px`;
    pop.style.left = `${Math.max(8, Math.min(window.innerWidth - 280, r.right - 260))}px`;
    document.body.append(pop);
    const close = (e: MouseEvent) => {
      if (!pop.contains(e.target as Node) && e.target !== anchor) {
        pop.remove();
        document.removeEventListener('mousedown', close);
      }
    };
    window.setTimeout(() => document.addEventListener('mousedown', close), 0);
  }

  // ========================================================= platform ====

  private wirePlatform() {
    bridge.onMenu((action) => {
      switch (action) {
        case 'open-score':
          void this.openFileDialog();
          break;
        case 'open-url':
          void this.openUrlDialog();
          break;
        case 'search':
          this.showPanel('library', 'search');
          break;
        case 'export-midi':
          void this.exportRecording('midi');
          break;
        case 'export-wav':
          void this.exportRecording('wav');
          break;
        case 'view-notes':
          this.setView('notes');
          break;
        case 'view-sheet':
          this.setView('sheet');
          break;
        case 'view-split':
          this.setView('split');
          break;
        case 'toggle-settings':
          this.togglePanel('settings');
          break;
        case 'toggle-library':
          this.railPanel(this.app.panels.libraryTab);
          break;
        case 'toggle-keyboard':
          this.toggleKeyboard();
          break;
        case 'focus':
          this.toggleFocus();
          break;
        case 'shortcuts':
          this.showHelp();
          break;
        case 'about':
          this.showAbout();
          break;
      }
    });
    bridge.onOpenFile((f) => void this.openScoreData(f.data, f.name, { source: 'Your files' }).catch(() => {}));
    void bridge.pendingFiles().then((files) => {
      if (files[0]) void this.openScoreData(files[0].data, files[0].name, { source: 'Your files' }).catch(() => {});
    });
  }

  private renderMidiStatus() {
    const devices = this.midi.devices.filter((d) => d.connected);
    const el = this.status.midi;
    el.textContent = '';
    el.append(icon('plug', 13), ' ');
    if (!this.midi.supported) el.append('MIDI not supported');
    else if (this.midi.error) {
      el.append('MIDI unavailable');
      el.title = this.midi.error;
    } else if (!devices.length) el.append('No MIDI keyboard – plug one in any time');
    else el.append(devices.length === 1 ? devices[0].name : `${devices.length} MIDI inputs`);
    el.classList.toggle('connected', devices.length > 0);
    const sel = this.status.midiSelect as HTMLSelectElement;
    sel.textContent = '';
    sel.append(h('option', { value: 'all' }, 'All connected devices'));
    for (const d of this.midi.devices) sel.append(h('option', { value: d.id }, `${d.name}${d.connected ? '' : ' (disconnected)'}`));
    sel.value = this.app.midi.input;
    if (sel.value !== this.app.midi.input) sel.value = 'all';
  }

  // ============================================================ loops ====

  private frame() {
    requestAnimationFrame(() => this.frame());
    const mode = this.app.mode;
    const s = this.score;
    let t = 0;
    if (mode === 'autoplay' && s) {
      t = this.player.visualPosition;
      const active = this.player.activeNotesAt(t);
      const hands = this.player.hands;
      this.keyboard.setAuto(active.filter((n) => hands[n.hand]));
      if (this.player.playerState !== 'waiting') this.keyboard.setHints(active.filter((n) => !hands[n.hand]).map((n) => n.midi));
      this.transport.update(this.player.position, this.player.playerState as PlayerState);
    } else if (this.flow && s) {
      // Flow mode: the autoplayer's timeline, gated by taps.
      t = this.player.visualPosition;
      this.keyboard.setAuto(this.player.activeNotesAt(t));
      this.keyboard.setHints(this.player.playerState === 'waiting' || !this.player.isPlaying ? this.flowUpcoming().map((n) => n.midi) : []);
    } else if (mode === 'clicker' && s) {
      const target = this.clicker.position;
      this.clickerDisplay += (target - this.clickerDisplay) * 0.18;
      if (Math.abs(target - this.clickerDisplay) < 0.002 || Math.abs(target - this.clickerDisplay) > 30) this.clickerDisplay = target;
      t = this.clickerDisplay;
      this.keyboard.setAuto(this.clicker.litNotes());
    }
    this.falling.getTime = () => t;
    if (s && mode !== 'play' && mode !== 'game' && this.app.view !== 'notes' && this.sheet.isLoaded) {
      this.updateSheetCursor(mode === 'clicker' && !this.flow ? this.clicker.position + 1e-4 : t);
    }
  }

  private updateSheetCursor(t: number) {
    const notes = this.score!.notes;
    let lo = 0;
    let hi = notes.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (notes[mid].time <= t + 0.01) lo = mid + 1;
      else hi = mid;
    }
    const idx = Math.max(0, lo - 1);
    if (idx === this.lastNoteIdx) return;
    this.lastNoteIdx = idx;
    const n = notes[idx];
    if (n?.src) this.sheet.setPosition(n.src);
  }

  private slowTick() {
    const level = this.engine.level();
    this.meterFill.style.width = `${Math.min(100, level * 100)}%`;
    this.meterFill.classList.toggle('hot', level > 0.95);
    this.status.voices.textContent = `${this.engine.voiceCount} voices`;
    this.status.latency.textContent = `${this.engine.latencyMs()} ms latency · ${this.engine.ctx.sampleRate / 1000} kHz`;
    if (this.recorder.recording) {
      const e = this.recorder.elapsed;
      this.recordTime.textContent = `${Math.floor(e / 60)}:${String(Math.floor(e % 60)).padStart(2, '0')}`;
      this.status.rec.textContent = `● REC ${this.recorder.noteCount} notes`;
    } else this.status.rec.textContent = '';
    if (this.engine.ctx.state === 'suspended') this.status.latency.textContent = 'Audio paused – click or press a key to start';
  }

  // ============================================================ misc ====

  private saveApp() {
    saveAppSettings(this.app);
  }

  private showHelp() {
    const row = (keys: string, what: string) => h('tr', null, h('td', null, ...keys.split(' + ').flatMap((k, i) => [i ? ' + ' : '', h('kbd', null, k)])), h('td', null, what));
    modal('Keyboard shortcuts', [
      h('div', { class: 'help-grid' },
        h('div', null,
          h('h3', null, 'Playing'),
          h('table', { class: 'keys-table' },
            row('Z … M', 'Lower octave (S D G H J = sharps)'),
            row('Q … P', 'Upper octave (2 3 5 6 7 9 0 = sharps)'),
            row('← →', 'Octave down / up'),
            row('↑ ↓', 'Velocity up / down'),
            row('Space', 'Sustain pedal (free play) · Play/pause (autoplay)'),
            row('Shift', 'Sustain pedal'),
            row('Esc', 'Stop everything (panic)'),
          ),
          h('h3', null, 'Clicker mode'),
          h('table', { class: 'keys-table' },
            row('Any key', 'Flow: keep the music going · Tap tempo: play the next chord'),
            row('Click', 'Notes area or TAP button also plays'),
            row('Backspace', 'One chord back'),
            row('Home', 'Back to the start'),
          ),
          h('h3', null, '4K rhythm mode'),
          h('table', { class: 'keys-table' },
            row('A S D F', 'The four lanes (rebind them on the song screen)'),
            row('Enter', 'Start / retry'),
            row('Esc', 'Pause · R restart · Q quit'),
          ),
        ),
        h('div', null,
          h('h3', null, 'Views & files'),
          h('table', { class: 'keys-table' },
            row('Ctrl + 1', 'Falling notes'),
            row('Ctrl + 2', 'Sheet music'),
            row('Ctrl + 3', 'Split view'),
            row('Ctrl + O', 'Open a score'),
            row('Ctrl + F', 'Search scores'),
            row('Ctrl + ,', 'Sound settings'),
            row('Ctrl + B', 'Library'),
            row('Ctrl + K', 'Collapse / expand the keyboard'),
            row('Ctrl + .', 'Focus mode (hide everything but the music)'),
            row('Home / End', 'Jump to start / end (autoplay)'),
          ),
          h('h3', null, 'Tips'),
          h('ul', { class: 'tips' },
            h('li', null, 'Click on the piano keys higher or lower to play softer or louder.'),
            h('li', null, 'Double-click any slider to reset it.'),
            h('li', null, 'Autoplay: turn off LH or RH to play that hand yourself; "Wait for me" pauses until you do.'),
            h('li', null, 'Click a note in the sheet music to jump there.'),
            h('li', null, 'Plug in a MIDI keyboard at any time – sustain, sostenuto and soft pedals are supported, including half-pedalling.'),
          ),
        ),
      ),
    ], { wide: true });
  }

  private async showAbout() {
    const info = await bridge.appInfo();
    const credits = INSTRUMENTS.filter((i) => i.kind === 'sampled').map((i) => h('li', null, h('b', null, i.name), ` – ${i.credit} (${i.license})`));
    modal('About PianoMan', [
      h('p', null, `PianoMan ${info.version}${info.electron ? ` · Electron ${info.electron}` : ''}`),
      h('p', null, 'A desktop piano with streamed sampled instruments, a full sound-design panel, a score autoplayer, sheet music and clicker mode.'),
      h('h3', null, 'Instrument samples'),
      h('ul', { class: 'credits' }, ...credits),
      h('h3', null, 'Scores'),
      h('p', { class: 'muted' }, 'ASAP dataset (CC BY-NC-SA 4.0), music21 corpus, BitMidi, Mutopia Project, The Session. Scores belong to their respective sources.'),
      h('h3', null, 'Open-source libraries'),
      h('p', { class: 'muted' }, 'OpenSheetMusicDisplay & VexFlow (BSD), abcjs (MIT), @tonejs/midi (MIT), fflate (MIT), Electron (MIT).'),
    ], { wide: true });
  }
}
