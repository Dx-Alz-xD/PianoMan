// Top level: the loading screen, then the launcher, then the Piano or the
// 4K Beats area. Both areas share one audio engine; only the visible one
// receives keys and MIDI.

import { App } from './app';
import { BeatsApp } from './beats/ui/app';
import { Launcher, type Area } from './launcher';
import { bridge } from './platform/bridge';
import { h } from './ui/dom';

const LAST_AREA = 'pianobeats.area.v1';

export class Shell {
  readonly piano: App;
  private beats: BeatsApp | null = null;
  private beatsRoot: HTMLElement;
  private launcher: Launcher;
  area: Area | 'launcher' = 'launcher';

  constructor(private pianoRoot: HTMLElement) {
    this.piano = new App(pianoRoot);
    this.piano.active = false;
    pianoRoot.classList.add('area-hidden');
    this.beatsRoot = h('div', { id: 'beats', hidden: true });
    document.body.append(this.beatsRoot);
    this.launcher = new Launcher((a) => void this.go(a));
    document.body.append(this.launcher.el);
    this.launcher.el.hidden = true;
    this.piano.onHome = () => void this.go('launcher');
    this.piano.midiElsewhere = (m, v, d) => this.beats?.midi(m, v, d);
    this.piano.onSplashDone = () => void this.go('launcher');
    // Piano menu commands (open score, views…) bring the piano forward.
    bridge.onMenu((action) => {
      if (this.area !== 'piano' && !['about', 'shortcuts'].includes(action)) void this.go('piano');
    });
    // Opening a score file from the OS goes to the piano; a beatmap to 4K Beats.
    bridge.onOpenFile(() => this.area !== 'piano' && void this.go('piano'));
    const w = window as unknown as { pianoman?: { onOpenBeatmap?: (cb: (p: string) => void) => () => void } };
    w.pianoman?.onOpenBeatmap?.(() => this.area !== 'beats' && void this.go('beats'));
  }

  private get lastArea(): Area {
    try {
      return localStorage.getItem(LAST_AREA) === 'beats' ? 'beats' : 'piano';
    } catch {
      return 'piano';
    }
  }

  async go(area: Area | 'launcher') {
    if (area === this.area && area !== 'launcher') return;
    const prev = this.area;
    this.area = area;
    if (prev === 'piano') {
      this.piano.active = false;
      this.pianoRoot.classList.add('area-hidden');
    }
    if (prev === 'beats') this.beats?.leave();
    if (area === 'launcher') {
      this.launcher.show(this.lastArea);
      return;
    }
    try {
      localStorage.setItem(LAST_AREA, area);
    } catch {
      /* ignore */
    }
    this.launcher.hide();
    if (area === 'piano') {
      this.pianoRoot.classList.remove('area-hidden');
      this.piano.active = true;
      this.piano.shown();
    } else {
      if (!this.beats) {
        this.beats = new BeatsApp(this.beatsRoot, {
          engine: this.piano.engine,
          metronome: this.piano.metronomeRef,
          onHome: () => void this.go('launcher'),
        });
      }
      await this.beats.enter();
    }
  }
}
