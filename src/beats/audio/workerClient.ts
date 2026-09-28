// Promise wrapper around the 4K audio worker.

import type { Analysis } from '../types';

type Progress = (p: number) => void;

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; progress?: Progress }>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ id: number; type: string; p?: number; result?: unknown; message?: string }>) => {
      const job = pending.get(e.data.id);
      if (!job) return;
      if (e.data.type === 'progress') job.progress?.(e.data.p ?? 0);
      else {
        pending.delete(e.data.id);
        if (e.data.type === 'error') job.reject(new Error(e.data.message || 'Worker failed'));
        else job.resolve(e.data.result);
      }
    };
    worker.onerror = (e) => {
      for (const job of pending.values()) job.reject(new Error(e.message || 'Worker crashed'));
      pending.clear();
      worker = null;
    };
  }
  return worker;
}

function call<T>(type: string, payload: Record<string, unknown>, transfer: Transferable[], progress?: Progress): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, progress });
    getWorker().postMessage({ id, type, ...payload }, transfer);
  });
}

/** Copies the channels of an AudioBuffer (the copies are transferred to the worker). */
export function channelsOf(buf: AudioBuffer, maxChannels = 2): Float32Array[] {
  const out: Float32Array[] = [];
  for (let c = 0; c < Math.min(maxChannels, buf.numberOfChannels); c++) out.push(buf.getChannelData(c).slice());
  return out;
}

export function analyzeAudio(buf: AudioBuffer, progress?: Progress, sensitivity = 0.6): Promise<Analysis> {
  const channels = channelsOf(buf);
  return call<Analysis>('analyze', { channels, sampleRate: buf.sampleRate, sensitivity }, channels.map((c) => c.buffer), progress);
}

export function stretchAudio(buf: AudioBuffer, rate: number, progress?: Progress): Promise<Float32Array[]> {
  const channels = channelsOf(buf);
  return call<Float32Array[]>('stretch', { channels, sampleRate: buf.sampleRate, rate }, channels.map((c) => c.buffer), progress);
}

export function encodeMp3(buf: AudioBuffer, kbps = 192, progress?: Progress): Promise<Uint8Array> {
  const channels = channelsOf(buf);
  return call<Uint8Array>('mp3', { channels, sampleRate: buf.sampleRate, kbps }, channels.map((c) => c.buffer), progress);
}
