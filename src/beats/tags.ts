// Reads title, artist, album and cover art embedded in audio files:
// ID3v2 (MP3), FLAC Vorbis comments + PICTURE blocks, and MP4/M4A atoms.

export interface EmbeddedTags {
  title?: string;
  artist?: string;
  album?: string;
  picture?: { mime: string; data: Uint8Array };
}

const latin1 = (b: Uint8Array) => String.fromCharCode(...b);

function decodeText(enc: number, b: Uint8Array): string {
  let s: string;
  if (enc === 0) s = latin1(b);
  else if (enc === 3) s = new TextDecoder('utf-8').decode(b);
  else if (enc === 1) {
    const le = b[0] === 0xff && b[1] === 0xfe;
    const be = b[0] === 0xfe && b[1] === 0xff;
    s = new TextDecoder(be ? 'utf-16be' : 'utf-16le').decode(le || be ? b.subarray(2) : b);
  } else s = new TextDecoder('utf-16be').decode(b);
  return s.replace(/\0+$/, '').split('\0')[0].trim();
}

/** Index of the terminator for an ID3 string in `enc`, starting at `from`. */
function termIndex(b: Uint8Array, from: number, enc: number): number {
  if (enc === 1 || enc === 2) {
    for (let i = from; i + 1 < b.length; i += 2) if (b[i] === 0 && b[i + 1] === 0) return i;
    return b.length;
  }
  const i = b.indexOf(0, from);
  return i < 0 ? b.length : i;
}

const syncsafe = (b: Uint8Array, o: number) => ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);
const be32 = (b: Uint8Array, o: number) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];

function readId3(b: Uint8Array): EmbeddedTags | null {
  if (b.length < 10 || latin1(b.subarray(0, 3)) !== 'ID3') return null;
  const ver = b[3];
  const flags = b[5];
  const size = syncsafe(b, 6);
  const end = Math.min(b.length, 10 + size);
  let o = 10;
  if (flags & 0x40 && ver >= 3) o += ver === 4 ? syncsafe(b, o) : be32(b, o) + 4;
  const tags: EmbeddedTags = {};
  const idLen = ver === 2 ? 3 : 4;
  const hdr = ver === 2 ? 6 : 10;
  while (o + hdr <= end) {
    const id = latin1(b.subarray(o, o + idLen));
    if (!/^[A-Z0-9]{3,4}$/.test(id)) break;
    const len = ver === 2 ? (b[o + 3] << 16) | (b[o + 4] << 8) | b[o + 5] : ver === 4 ? syncsafe(b, o + 4) : be32(b, o + 4);
    const body = b.subarray(o + hdr, Math.min(end, o + hdr + len));
    o += hdr + len;
    if (!body.length) continue;
    const enc = body[0];
    if (id === 'TIT2' || id === 'TT2') tags.title = decodeText(enc, body.subarray(1));
    else if (id === 'TPE1' || id === 'TP1') tags.artist = decodeText(enc, body.subarray(1));
    else if (id === 'TALB' || id === 'TAL') tags.album = decodeText(enc, body.subarray(1));
    else if ((id === 'APIC' || id === 'PIC') && !tags.picture) {
      let p = 1;
      let mime: string;
      if (id === 'PIC') {
        const fmt = latin1(body.subarray(1, 4)).toLowerCase();
        mime = fmt === 'png' ? 'image/png' : 'image/jpeg';
        p = 4;
      } else {
        const mEnd = body.indexOf(0, 1);
        mime = latin1(body.subarray(1, mEnd)) || 'image/jpeg';
        p = mEnd + 1;
      }
      p += 1; // picture type
      const dEnd = termIndex(body, p, enc);
      p = dEnd + (enc === 1 || enc === 2 ? 2 : 1);
      const data = body.subarray(p);
      if (data.length > 100) tags.picture = { mime: mime.includes('/') ? mime : `image/${mime}`, data: data.slice() };
    }
  }
  return tags;
}

function readFlac(b: Uint8Array): EmbeddedTags | null {
  if (latin1(b.subarray(0, 4)) !== 'fLaC') return null;
  const tags: EmbeddedTags = {};
  let o = 4;
  for (;;) {
    if (o + 4 > b.length) break;
    const last = b[o] & 0x80;
    const type = b[o] & 0x7f;
    const len = (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3];
    const body = b.subarray(o + 4, o + 4 + len);
    const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
    if (type === 4) {
      let p = 0;
      const vendor = dv.getUint32(p, true);
      p += 4 + vendor;
      const count = dv.getUint32(p, true);
      p += 4;
      for (let i = 0; i < count && p + 4 <= body.length; i++) {
        const l = dv.getUint32(p, true);
        p += 4;
        const s = new TextDecoder().decode(body.subarray(p, p + l));
        p += l;
        const eq = s.indexOf('=');
        const k = s.slice(0, eq).toUpperCase();
        const v = s.slice(eq + 1).trim();
        if (k === 'TITLE') tags.title = v;
        else if (k === 'ARTIST') tags.artist = v;
        else if (k === 'ALBUM') tags.album = v;
      }
    } else if (type === 6 && !tags.picture) {
      let p = 4;
      const mimeLen = dv.getUint32(p);
      p += 4;
      const mime = latin1(body.subarray(p, p + mimeLen));
      p += mimeLen;
      const descLen = dv.getUint32(p);
      p += 4 + descLen + 16;
      const dataLen = dv.getUint32(p);
      p += 4;
      tags.picture = { mime: mime || 'image/jpeg', data: body.slice(p, p + dataLen) };
    }
    o += 4 + len;
    if (last) break;
  }
  return tags;
}

function readMp4(b: Uint8Array): EmbeddedTags | null {
  if (b.length < 12 || latin1(b.subarray(4, 8)) !== 'ftyp') return null;
  const tags: EmbeddedTags = {};
  const walk = (start: number, end: number, depth: number) => {
    let o = start;
    while (o + 8 <= end && depth < 8) {
      let size = be32(b, o);
      const type = latin1(b.subarray(o + 4, o + 8));
      let hdr = 8;
      if (size === 1) {
        size = be32(b, o + 12);
        hdr = 16;
      } else if (size === 0) size = end - o;
      if (size < 8 || o + size > end) break;
      if (['moov', 'udta', 'ilst', 'trak', 'mdia', 'minf'].includes(type)) walk(o + hdr, o + size, depth + 1);
      else if (type === 'meta') walk(o + hdr + 4, o + size, depth + 1);
      else if (['\xa9nam', '\xa9ART', '\xa9alb', 'covr'].includes(type)) {
        // child "data" atom: size, 'data', type(4), locale(4), payload
        const d = o + hdr;
        if (latin1(b.subarray(d + 4, d + 8)) === 'data') {
          const dsize = be32(b, d);
          const kind = be32(b, d + 8) & 0xffffff;
          const payload = b.subarray(d + 16, d + dsize);
          if (type === 'covr') tags.picture = { mime: kind === 14 ? 'image/png' : 'image/jpeg', data: payload.slice() };
          else {
            const s = new TextDecoder().decode(payload).trim();
            if (type === '\xa9nam') tags.title = s;
            else if (type === '\xa9ART') tags.artist = s;
            else tags.album = s;
          }
        }
      }
      o += size;
    }
  };
  walk(0, b.length, 0);
  return tags;
}

/** Tags from the start of an audio file (pass the whole file or at least its first few MB). */
export function readTags(bytes: Uint8Array): EmbeddedTags {
  try {
    return readId3(bytes) || readFlac(bytes) || readMp4(bytes) || {};
  } catch {
    return {};
  }
}

export function imageExt(mime: string): string {
  return mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : mime.includes('gif') ? 'gif' : 'jpg';
}
