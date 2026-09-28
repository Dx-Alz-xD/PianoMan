// Background work for the 4K area: audio analysis, time-stretching and MP3
// encoding (lamejs is loaded on demand as its own chunk).

import { analyze, timeStretch } from './dsp';

type Req =
  | { id: number; type: 'analyze'; channels: Float32Array[]; sampleRate: number; sensitivity?: number }
  | { id: number; type: 'stretch'; channels: Float32Array[]; sampleRate: number; rate: number }
  | { id: number; type: 'mp3'; channels: Float32Array[]; sampleRate: number; kbps: number };

const post = (msg: unknown, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(msg, transfer);

async function encodeMp3(channels: Float32Array[], sampleRate: number, kbps: number, progress: (p: number) => void): Promise<Uint8Array> {
  const { Mp3Encoder } = await import('@breezystack/lamejs');
  const ch = Math.min(2, channels.length);
  const enc = new Mp3Encoder(ch, sampleRate, kbps);
  const len = channels[0].length;
  const block = 1152 * 16;
  const chunks: Uint8Array[] = [];
  const toI16 = (src: Float32Array, a: number, b: number) => {
    const out = new Int16Array(b - a);
    for (let i = a; i < b; i++) {
      const s = Math.max(-1, Math.min(1, src[i]));
      out[i - a] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  };
  for (let i = 0; i < len; i += block) {
    const b = Math.min(len, i + block);
    const l = toI16(channels[0], i, b);
    const r = ch > 1 ? toI16(channels[1], i, b) : undefined;
    const out = r ? enc.encodeBuffer(l, r) : enc.encodeBuffer(l);
    if (out.length) chunks.push(new Uint8Array(out));
    if ((i / block) % 20 === 0) progress(i / len);
  }
  const end = enc.flush();
  if (end.length) chunks.push(new Uint8Array(end));
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const bytes = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    bytes.set(c, o);
    o += c.length;
  }
  return bytes;
}

self.onmessage = async (e: MessageEvent<Req>) => {
  const req = e.data;
  const progress = (p: number) => post({ id: req.id, type: 'progress', p });
  try {
    if (req.type === 'analyze') {
      post({ id: req.id, type: 'result', result: analyze(req.channels, req.sampleRate, { sensitivity: req.sensitivity, onProgress: progress }) });
    } else if (req.type === 'stretch') {
      const out = timeStretch(req.channels, req.rate, req.sampleRate, progress);
      post({ id: req.id, type: 'result', result: out }, out.map((c) => c.buffer));
    } else if (req.type === 'mp3') {
      const bytes = await encodeMp3(req.channels, req.sampleRate, req.kbps, progress);
      post({ id: req.id, type: 'result', result: bytes }, [bytes.buffer]);
    }
  } catch (err) {
    post({ id: req.id, type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
