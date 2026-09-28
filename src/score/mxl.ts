// Compressed MusicXML (.mxl) is a zip archive with a container manifest.

import { unzipSync, strFromU8 } from 'fflate';

export function isZip(data: Uint8Array): boolean {
  return data.length > 4 && data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04;
}

/** What a zip contains: a (compressed) MusicXML score, or a bundle of MIDI files. */
export function zipContents(data: Uint8Array): { kind: 'mxl' | 'midi' | 'unknown'; midi?: { name: string; data: Uint8Array }[] } {
  const files = unzipSync(data);
  const names = Object.keys(files);
  if (files['META-INF/container.xml'] || names.some((n) => !n.startsWith('META-INF/') && /\.(musicxml|xml)$/i.test(n))) return { kind: 'mxl' };
  const midi = names.filter((n) => /\.(mid|midi|kar)$/i.test(n) && !n.startsWith('__MACOSX')).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (midi.length) return { kind: 'midi', midi: midi.map((name) => ({ name, data: files[name] })) };
  return { kind: 'unknown' };
}

export function extractMxl(data: Uint8Array): { xml: string; name: string } {
  const files = unzipSync(data);
  const names = Object.keys(files);
  let rootPath: string | null = null;
  const container = files['META-INF/container.xml'];
  if (container) {
    const m = /full-path\s*=\s*"([^"]+)"/.exec(strFromU8(container));
    if (m && files[m[1]]) rootPath = m[1];
  }
  if (!rootPath) {
    rootPath = names.find((n) => !n.startsWith('META-INF/') && /\.(musicxml|xml)$/i.test(n)) || null;
  }
  if (!rootPath) throw new Error('This .mxl archive does not contain a MusicXML file.');
  return { xml: decodeText(files[rootPath]), name: rootPath };
}

/** Decodes XML bytes honouring UTF-16 byte-order marks. */
export function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  const head = new TextDecoder('ascii').decode(bytes.slice(0, 200));
  const enc = /encoding\s*=\s*["']([\w-]+)["']/i.exec(head)?.[1];
  try {
    return new TextDecoder(enc && !/utf-?8/i.test(enc) ? enc : 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}
