// Web MIDI input: note on/off with velocity, sustain (continuous, for
// half-pedalling), sostenuto and soft pedals, device hot-plugging.

import { Emitter } from '../core/emitter';

export interface MidiDevice {
  id: string;
  name: string;
  manufacturer: string;
  connected: boolean;
}

export interface MidiEvents {
  noteOn: { midi: number; velocity: number; channel: number };
  noteOff: { midi: number; channel: number };
  sustain: { value: number };
  sostenuto: { down: boolean };
  soft: { down: boolean };
  allOff: undefined;
  devices: MidiDevice[];
  activity: undefined;
}

export class MidiInput extends Emitter<MidiEvents> {
  private access: MIDIAccess | null = null;
  selected = 'all';
  channel = 0;
  supported = typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator;
  error: string | null = null;

  async init(): Promise<void> {
    if (!this.supported) return;
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      return;
    }
    this.access.onstatechange = () => this.attach();
    this.attach();
  }

  get devices(): MidiDevice[] {
    if (!this.access) return [];
    return [...this.access.inputs.values()].map((i) => ({ id: i.id, name: i.name || 'MIDI input', manufacturer: i.manufacturer || '', connected: i.state === 'connected' }));
  }

  private attach() {
    if (!this.access) return;
    for (const input of this.access.inputs.values()) {
      input.onmidimessage = (e) => this.onMessage(input.id, e as MIDIMessageEvent);
    }
    this.emit('devices', this.devices);
  }

  select(id: string) {
    this.selected = id;
  }

  private onMessage(id: string, e: MIDIMessageEvent) {
    if (this.selected !== 'all' && this.selected !== id) return;
    const d = e.data;
    if (!d || d.length < 1) return;
    const status = d[0] & 0xf0;
    const channel = (d[0] & 0x0f) + 1;
    if (this.channel && channel !== this.channel) return;
    const a = d[1] ?? 0;
    const b = d[2] ?? 0;
    switch (status) {
      case 0x90:
        if (b > 0) this.emit('noteOn', { midi: a, velocity: b, channel });
        else this.emit('noteOff', { midi: a, channel });
        this.emit('activity', undefined);
        break;
      case 0x80:
        this.emit('noteOff', { midi: a, channel });
        break;
      case 0xb0:
        if (a === 64) this.emit('sustain', { value: b / 127 });
        else if (a === 66) this.emit('sostenuto', { down: b >= 64 });
        else if (a === 67) this.emit('soft', { down: b >= 64 });
        else if (a === 120 || a === 123) this.emit('allOff', undefined);
        this.emit('activity', undefined);
        break;
    }
  }
}
