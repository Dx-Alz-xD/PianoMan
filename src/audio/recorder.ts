// Records what you play: as MIDI events (replayable and exportable as .mid)
// and as audio (exported as WAV).

import { Midi } from '@tonejs/midi';
import type { Score, ScoreNote, PedalEvent } from '../score/model';
import { finalizeScore } from '../score/model';

interface Pending {
  midi: number;
  start: number;
  velocity: number;
}

export class PerformanceRecorder {
  private startTime = 0;
  private open = new Map<number, Pending>();
  private notes: ScoreNote[] = [];
  private pedals: PedalEvent[] = [];
  recording = false;

  constructor(private now: () => number) {}

  start() {
    this.startTime = this.now();
    this.open.clear();
    this.notes = [];
    this.pedals = [];
    this.recording = true;
  }

  noteOn(midi: number, velocity: number) {
    if (!this.recording) return;
    this.noteOff(midi);
    this.open.set(midi, { midi, start: this.now() - this.startTime, velocity: velocity / 127 });
  }

  noteOff(midi: number) {
    if (!this.recording) return;
    const p = this.open.get(midi);
    if (!p) return;
    this.open.delete(midi);
    const end = this.now() - this.startTime;
    this.notes.push({ midi, time: p.start, duration: Math.max(0.02, end - p.start), velocity: p.velocity, hand: midi >= 60 ? 'R' : 'L', track: 0, beat: 0 });
  }

  pedal(kind: PedalEvent['kind'], value: number) {
    if (!this.recording) return;
    this.pedals.push({ time: this.now() - this.startTime, value, kind, beat: 0 });
  }

  get elapsed() {
    return this.recording ? this.now() - this.startTime : 0;
  }

  get noteCount() {
    return this.notes.length + this.open.size;
  }

  /** Stops recording and returns the performance as a score (tempo 120, 1 beat = 0.5 s). */
  stop(): Score | null {
    if (!this.recording) return null;
    for (const midi of [...this.open.keys()]) this.noteOff(midi);
    this.recording = false;
    if (!this.notes.length) return null;
    const bpm = 120;
    for (const n of this.notes) n.beat = n.time / (60 / bpm);
    for (const p of this.pedals) p.beat = p.time / (60 / bpm);
    const date = new Date();
    return finalizeScore({
      title: `Recording ${date.toLocaleDateString()} ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`,
      composer: 'You',
      format: 'recording',
      notes: this.notes,
      pedals: this.pedals,
      tempos: [{ beat: 0, bpm }],
      timeSignatures: [{ beat: 0, num: 4, den: 4 }],
    });
  }
}

/** Serialises a score (e.g. a recording) as a Standard MIDI File. */
export function scoreToMidi(score: Score): Uint8Array {
  const midi = new Midi();
  midi.header.setTempo(score.tempos[0]?.bpm || 120);
  midi.header.name = score.title;
  const ts = score.timeSignatures[0];
  if (ts) midi.header.timeSignatures.push({ ticks: 0, timeSignature: [ts.num, ts.den] });
  const hands: ('R' | 'L')[] = ['R', 'L'];
  for (const hand of hands) {
    const notes = score.notes.filter((n) => n.hand === hand);
    if (!notes.length && hand === 'L') continue;
    const track = midi.addTrack();
    track.name = hand === 'R' ? 'Right hand' : 'Left hand';
    track.channel = 0;
    for (const n of notes) track.addNote({ midi: n.midi, time: n.time, duration: n.duration, velocity: n.velocity });
    if (hand === 'R') {
      for (const p of score.pedals) {
        const number = p.kind === 'sustain' ? 64 : p.kind === 'sostenuto' ? 66 : 67;
        track.addCC({ number, time: p.time, value: p.value });
      }
    }
  }
  return midi.toArray();
}

/** Records the engine output with MediaRecorder and converts it to 16-bit WAV. */
export class AudioRecorder {
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];

  constructor(private ctx: AudioContext, private stream: () => MediaStream) {}

  get recording() {
    return !!this.rec && this.rec.state === 'recording';
  }

  start() {
    this.chunks = [];
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
    this.rec = new MediaRecorder(this.stream(), mime ? { mimeType: mime, audioBitsPerSecond: 256000 } : undefined);
    this.rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.rec.start(250);
  }

  async stop(): Promise<Uint8Array | null> {
    const rec = this.rec;
    if (!rec) return null;
    await new Promise<void>((resolve) => {
      rec.onstop = () => resolve();
      rec.stop();
    });
    this.rec = null;
    if (!this.chunks.length) return null;
    const blob = new Blob(this.chunks, { type: rec.mimeType });
    const audio = await this.ctx.decodeAudioData(await blob.arrayBuffer());
    return encodeWav(audio);
  }
}

export function encodeWav(buffer: AudioBuffer): Uint8Array {
  const channels = Math.min(2, buffer.numberOfChannels);
  const rate = buffer.sampleRate;
  const frames = buffer.length;
  const bytes = 44 + frames * channels * 2;
  const view = new DataView(new ArrayBuffer(bytes));
  const str = (o: number, s: string) => [...s].forEach((c, i) => view.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  view.setUint32(4, bytes - 8, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  str(36, 'data');
  view.setUint32(40, frames * channels * 2, true);
  const data = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c));
  let o = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const s = Math.max(-1, Math.min(1, data[c][i]));
      view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return new Uint8Array(view.buffer);
}
