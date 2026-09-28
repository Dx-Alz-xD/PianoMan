// Downloads, decodes and caches instrument samples.

import { fetchFirst } from '../platform/bridge';
import type { Region, SampledInstrument } from './instruments';
import { sampleUrls } from './instruments';

export type SampleQuality = 'full' | 'balanced' | 'light';

export interface LoadProgress {
  instrument: string;
  loaded: number;
  failed: number;
  total: number;
  fromNetwork: number;
  done: boolean;
}

/** Velocities whose layers are kept at each quality level (MIDI 1–127). */
const QUALITY_TARGETS: Record<SampleQuality, number[] | null> = {
  full: null,
  balanced: [45, 80, 115],
  light: [95],
};

const velDistance = (v: number, r: Region) => (v < r.vl ? r.vl - v : v > r.vh ? v - r.vh : 0);

/**
 * Chooses the regions to download for a quality level: for every sampled key,
 * the velocity layer(s) closest to the target velocities. "light" also drops
 * round-robin alternatives and release/pedal samples.
 */
export function selectRegions(regions: Region[], quality: SampleQuality): Region[] {
  const targets = QUALITY_TARGETS[quality];
  if (!targets) return regions;
  const attacks = regions.filter((r) => r.trigger === 'a');
  const keep = new Set<Region>();
  for (const r of attacks) {
    const rivals = attacks.filter((o) => o.lo <= r.key && r.key <= o.hi && o.pedal === r.pedal);
    for (const v of targets) {
      const best = Math.min(...rivals.map((o) => velDistance(v, o)));
      if (velDistance(v, r) === best && (quality !== 'light' || (r.rrPos || 1) === 1)) keep.add(r);
    }
  }
  const extras = quality === 'light' ? [] : regions.filter((r) => r.trigger !== 'a');
  return [...attacks.filter((r) => keep.has(r)), ...extras];
}

export class SampleStore {
  private buffers = new Map<string, AudioBuffer>();
  private inflight = new Map<string, Promise<AudioBuffer | null>>();
  private preferredHost = new Map<string, number>();
  private generation = 0;

  constructor(private ctx: BaseAudioContext) {}

  key(inst: SampledInstrument, path: string) {
    return `${inst.id}|${path}`;
  }

  get(inst: SampledInstrument, path: string): AudioBuffer | undefined {
    return this.buffers.get(this.key(inst, path));
  }

  has(inst: SampledInstrument, path: string): boolean {
    return this.buffers.has(this.key(inst, path));
  }

  /** Drops decoded audio of every instrument except those listed. */
  retainOnly(ids: string[]) {
    const keep = new Set(ids);
    for (const k of [...this.buffers.keys()]) {
      if (!keep.has(k.slice(0, k.indexOf('|')))) this.buffers.delete(k);
    }
  }

  private async fetchOne(inst: SampledInstrument, path: string, counters: { net: number }): Promise<AudioBuffer | null> {
    const k = this.key(inst, path);
    const existing = this.buffers.get(k);
    if (existing) return existing;
    let p = this.inflight.get(k);
    if (!p) {
      p = (async () => {
        const urls = sampleUrls(inst, path);
        const pref = this.preferredHost.get(inst.id) || 0;
        const ordered = [urls[pref], ...urls.filter((_, i) => i !== pref)];
        const res = await fetchFirst<Uint8Array>(ordered, {
          responseType: 'arraybuffer',
          cache: 'samples',
          cacheKey: `${inst.id}/${path}.${inst.ext}`,
        });
        // Remember which mirror answered so the rest of the set goes straight there.
        this.preferredHost.set(inst.id, urls.indexOf(ordered[res.mirror]));
        if (!res.fromCache) counters.net++;
        const bytes = res.data;
        const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        const audio = await this.ctx.decodeAudioData(copy);
        this.buffers.set(k, audio);
        return audio;
      })()
        .catch((err) => {
          console.warn(`[samples] ${inst.id}: ${path}`, err);
          return null;
        })
        .finally(() => this.inflight.delete(k));
      this.inflight.set(k, p);
    }
    return p;
  }

  /**
   * Loads the regions needed for `quality`. Samples near the middle of the
   * keyboard and at medium velocity come first so the instrument is playable
   * within a second or two; the rest stream in behind.
   */
  async load(inst: SampledInstrument, quality: SampleQuality, onProgress: (p: LoadProgress) => void, concurrency = 6): Promise<LoadProgress> {
    const gen = ++this.generation;
    const regions = selectRegions(inst.regions(), quality);
    const priority = (r: Region) =>
      (r.trigger === 'a' ? 0 : 1000) + Math.abs(r.key - 62) + Math.abs((r.vl + r.vh) / 2 - 90) / 8 + ((r.rrPos || 1) - 1) * 40;
    const paths: string[] = [];
    const seen = new Set<string>();
    for (const r of [...regions].sort((a, b) => priority(a) - priority(b))) {
      if (!seen.has(r.path)) {
        seen.add(r.path);
        paths.push(r.path);
      }
    }
    const progress: LoadProgress = { instrument: inst.id, loaded: 0, failed: 0, total: paths.length, fromNetwork: 0, done: false };
    const counters = { net: 0 };
    let next = 0;
    const worker = async () => {
      while (next < paths.length) {
        if (gen !== this.generation) return; // superseded by another load
        const path = paths[next++];
        const buf = await this.fetchOne(inst, path, counters);
        if (buf) progress.loaded++;
        else progress.failed++;
        progress.fromNetwork = counters.net;
        if (gen === this.generation) onProgress({ ...progress });
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    progress.done = true;
    if (gen === this.generation) onProgress({ ...progress });
    return progress;
  }
}
