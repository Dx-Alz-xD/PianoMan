// PIANO-BEATS – main-process side of the 4K area.
//
//  * the song library on disk: <userData>/beats/songs/<id>/ holds song.json,
//    maps/<map>.json and the song's media (audio, video, cover, keysounds)
//  * the media:// protocol that streams those files to the page, with HTTP
//    range support so background videos can seek
//  * yt-dlp: downloaded on first use from its GitHub releases, then used to
//    search YouTube and download audio (and optionally video) for new songs
'use strict';

const { app, dialog, ipcMain, net, protocol, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { Readable } = require('node:stream');

const MEDIA_TYPES = {
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  weba: 'audio/webm',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  json: 'application/json',
  musicxml: 'application/xml',
  xml: 'application/xml',
};

const IMPORT_FILTERS = {
  audio: [{ name: 'Audio & video', extensions: ['mp3', 'ogg', 'opus', 'wav', 'flac', 'm4a', 'aac', 'webm', 'mp4', 'm4v', 'mov'] }],
  video: [{ name: 'Video', extensions: ['mp4', 'm4v', 'webm', 'mov'] }],
  image: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'] }],
  osu: [{ name: 'osu! beatmaps', extensions: ['osz', 'osu'] }],
  score: [{ name: 'Scores', extensions: ['musicxml', 'xml', 'mxl', 'mid', 'midi', 'kar', 'abc'] }],
  any: [{ name: 'All files', extensions: ['*'] }],
};

let getWindow = () => null;

const songsDir = () => path.join(app.getPath('userData'), 'beats', 'songs');
const binDir = () => path.join(app.getPath('userData'), 'bin');

function songId(id) {
  if (typeof id !== 'string' || !/^[a-z0-9-]{4,64}$/i.test(id)) throw new Error('Invalid song id');
  return id;
}

/** A file name (or relative path) inside a song folder; never escapes it. */
function relName(name) {
  if (typeof name !== 'string' || !name) throw new Error('Invalid file name');
  const parts = name.replace(/\\/g, '/').split('/').filter(Boolean);
  if (!parts.length || parts.some((p) => p === '..' || p === '.' || /[\0<>:"|?*]/.test(p))) throw new Error(`Invalid file name: ${name}`);
  return parts.join(path.sep);
}

const songPath = (id, ...rest) => path.join(songsDir(), songId(id), ...rest);

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

async function writeAtomic(file, data) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, data);
  await fsp.rename(tmp, file);
}

async function readJson(file) {
  return JSON.parse(await fsp.readFile(file, 'utf8'));
}

const toBytes = (buf) => new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);

// -------------------------------------------------------------- library ----

async function listSongs() {
  let entries = [];
  try {
    entries = await fsp.readdir(songsDir(), { withFileTypes: true });
  } catch {
    return [];
  }
  const songs = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      songs.push(await readJson(path.join(songsDir(), e.name, 'song.json')));
    } catch {
      /* half-written or foreign folder */
    }
  }
  return songs.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

async function saveMap(id, map, summary) {
  if (!map || typeof map.id !== 'string' || !/^[a-z0-9-]{4,64}$/i.test(map.id)) throw new Error('Invalid map id');
  await writeAtomic(songPath(id, 'maps', `${map.id}.json`), JSON.stringify(map));
  const song = await readJson(songPath(id, 'song.json'));
  const maps = (song.maps || []).filter((m) => m.id !== map.id);
  maps.push(summary || { id: map.id, name: map.name });
  maps.sort((a, b) => (a.level || 0) - (b.level || 0));
  song.maps = maps;
  song.updatedAt = new Date().toISOString();
  await writeAtomic(songPath(id, 'song.json'), JSON.stringify(song, null, 2));
  return song;
}

async function deleteMap(id, mapId) {
  if (!/^[a-z0-9-]{4,64}$/i.test(mapId)) throw new Error('Invalid map id');
  await fsp.rm(songPath(id, 'maps', `${mapId}.json`), { force: true });
  const song = await readJson(songPath(id, 'song.json'));
  song.maps = (song.maps || []).filter((m) => m.id !== mapId);
  await writeAtomic(songPath(id, 'song.json'), JSON.stringify(song, null, 2));
  return song;
}

// ----------------------------------------------------------------- media ----

/** Privileges for media://; registered together with app:// (that API may only be called once). */
const MEDIA_SCHEME = { scheme: 'media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } };

/** media://song/<id>/<file> – streams a song file, honouring Range requests. */
function registerMediaProtocol() {
  protocol.handle('media', async (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== 'song') return new Response('Not found', { status: 404 });
      const [, id, ...rest] = decodeURIComponent(url.pathname).split('/');
      const file = songPath(id, relName(rest.join('/')));
      const st = await fsp.stat(file);
      const type = MEDIA_TYPES[path.extname(file).slice(1).toLowerCase()] || 'application/octet-stream';
      const range = /bytes=(\d*)-(\d*)/.exec(request.headers.get('range') || '');
      let start = 0;
      let end = st.size - 1;
      let status = 200;
      if (range && st.size > 0) {
        if (range[1]) start = Math.min(parseInt(range[1], 10), st.size - 1);
        if (range[2]) end = Math.min(parseInt(range[2], 10), st.size - 1);
        if (!range[1] && range[2]) {
          start = Math.max(0, st.size - parseInt(range[2], 10));
          end = st.size - 1;
        }
        status = 206;
      }
      const headers = {
        'Content-Type': type,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(Math.max(0, end - start + 1)),
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
      };
      if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
      if (request.method === 'HEAD' || st.size === 0) return new Response(null, { status, headers });
      const stream = Readable.toWeb(fs.createReadStream(file, { start, end }));
      return new Response(stream, { status, headers });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });
}

// ---------------------------------------------------------------- yt-dlp ----

function ytBinaryName() {
  if (process.platform === 'win32') return 'yt-dlp.exe';
  if (process.platform === 'darwin') return 'yt-dlp_macos';
  return process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux';
}

const ytPath = () => path.join(binDir(), process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

function send(channel, payload) {
  const win = getWindow();
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

const jobs = new Map();

/** Runs yt-dlp; resolves with stdout. Progress lines are reported through `onLine`. */
function runYt(args, { job, onLine, timeoutMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    // Electron doubles as the JavaScript runtime yt-dlp needs for YouTube.
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', PYTHONIOENCODING: 'utf-8' };
    const full = ['--js-runtimes', `node:${process.execPath}`, '--no-colors', ...args];
    const child = spawn(ytPath(), full, { env, windowsHide: true });
    if (job) jobs.set(job, child);
    let out = '';
    let err = '';
    let buf = '';
    let timer = 0;
    if (timeoutMs) timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on('data', (d) => {
      const s = d.toString('utf8');
      out += s;
      if (onLine) {
        buf += s;
        let i;
        while ((i = buf.search(/[\r\n]/)) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line) onLine(line);
        }
      }
    });
    child.stderr.on('data', (d) => {
      err += d.toString('utf8');
      if (err.length > 20000) err = err.slice(-20000);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      if (job) jobs.delete(job);
      reject(e);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (job) jobs.delete(job);
      if (code === 0) resolve(out);
      else {
        const msg = err.split('\n').filter((l) => /ERROR|error/.test(l)).pop() || err.trim().split('\n').pop() || `yt-dlp exited with ${signal || code}`;
        const e = new Error(signal ? 'Cancelled' : msg.replace(/^ERROR:\s*/, ''));
        e.cancelled = !!signal;
        reject(e);
      }
    });
  });
}

async function ytStatus() {
  try {
    await fsp.access(ytPath(), fs.constants.X_OK);
    const version = (await runYt(['--version'], { timeoutMs: 30000 })).trim();
    return { installed: true, version, path: ytPath() };
  } catch {
    return { installed: false, version: null, path: ytPath() };
  }
}

async function ytInstall() {
  const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${ytBinaryName()}`;
  send('yt:progress', { job: 'install', stage: 'install', percent: 0 });
  const res = await net.fetch(url, { headers: { 'User-Agent': 'PIANO-BEATS' } });
  if (!res.ok || !res.body) throw new Error(`Couldn't download yt-dlp (HTTP ${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;
  await ensureDir(binDir());
  const tmp = `${ytPath()}.download`;
  const out = fs.createWriteStream(tmp);
  let got = 0;
  let last = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    got += value.byteLength;
    if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r));
    if (total && Date.now() - last > 150) {
      last = Date.now();
      send('yt:progress', { job: 'install', stage: 'install', percent: (got / total) * 100 });
    }
  }
  await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
  await fsp.chmod(tmp, 0o755);
  await fsp.rename(tmp, ytPath());
  send('yt:progress', { job: 'install', stage: 'install', percent: 100 });
  return ytStatus();
}

function pickInfo(j) {
  return {
    id: j.id,
    title: j.title,
    track: j.track || null,
    artist: j.artist || j.creator || null,
    album: j.album || null,
    uploader: j.uploader || j.channel || null,
    duration: j.duration || null,
    thumbnail: j.thumbnail || null,
    thumbnails: (j.thumbnails || []).filter((t) => t.url).map((t) => ({ url: t.url, width: t.width || 0, height: t.height || 0 })).slice(-12),
    webpage_url: j.webpage_url || j.original_url || null,
    extractor: j.extractor_key || j.extractor || null,
    description: typeof j.description === 'string' ? j.description.slice(0, 600) : null,
    hasVideo: (j.formats || []).some((f) => f.vcodec && f.vcodec !== 'none') || (j.vcodec && j.vcodec !== 'none'),
  };
}

async function ytSearch(query, limit = 16) {
  const out = await runYt([`ytsearch${Math.max(1, Math.min(40, limit))}:${query}`, '--flat-playlist', '-J', '--no-warnings'], { timeoutMs: 60000 });
  const j = JSON.parse(out);
  return (j.entries || []).map((e) => ({
    id: e.id,
    title: e.title,
    channel: e.channel || e.uploader || '',
    duration: e.duration || 0,
    views: e.view_count || 0,
    thumbnail: (e.thumbnails || []).slice(-1)[0]?.url || `https://i.ytimg.com/vi/${e.id}/hqdefault.jpg`,
    url: e.url || `https://www.youtube.com/watch?v=${e.id}`,
  }));
}

const PROGRESS_PREFIX = 'PBPROG';

async function ytDownload({ job, url, song, video = false, maxHeight = 720 }) {
  const dir = await ensureDir(songPath(song));
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'piano-beats-'));
  const infoFile = path.join(tmpDir, 'info.json');
  try {
    send('yt:progress', { job, stage: 'info', percent: 0 });
    const infoText = await runYt(['-J', '--no-playlist', '--no-warnings', url], { job, timeoutMs: 120000 });
    await fsp.writeFile(infoFile, infoText);
    const info = pickInfo(JSON.parse(infoText));
    const progressArgs = ['--newline', '--progress-template', `download:${PROGRESS_PREFIX} %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(progress.speed)s %(progress.eta)s`];
    const onLine = (stage) => (line) => {
      if (!line.startsWith(PROGRESS_PREFIX)) return;
      const [, done, total, estimate, speed, eta] = line.split(/\s+/).map((x) => (x === 'NA' || x === 'None' ? NaN : Number(x)));
      const all = Number.isFinite(total) ? total : estimate;
      send('yt:progress', { job, stage, percent: Number.isFinite(all) && all > 0 ? (done / all) * 100 : null, speed: Number.isFinite(speed) ? speed : null, eta: Number.isFinite(eta) ? eta : null });
    };
    const clear = async (prefix) => {
      for (const f of await fsp.readdir(dir)) if (f.startsWith(`${prefix}.`)) await fsp.rm(path.join(dir, f), { force: true });
    };
    const found = async (prefix) => (await fsp.readdir(dir)).find((f) => f.startsWith(`${prefix}.`) && !/\.(part|ytdl|temp)$/.test(f));

    await clear('audio');
    await runYt(
      ['--load-info-json', infoFile, '-f', 'bestaudio[ext=m4a]/bestaudio[acodec^=mp4a]/bestaudio/best', '-o', path.join(dir, 'audio.%(ext)s'), '--no-playlist', '--no-mtime', ...progressArgs],
      { job, onLine: onLine('audio') },
    );
    const audio = await found('audio');
    if (!audio) throw new Error('yt-dlp finished but no audio file was written');

    let videoFile = null;
    if (video && info.hasVideo) {
      await clear('video');
      const h = Math.max(144, Math.min(2160, Number(maxHeight) || 720));
      try {
        await runYt(
          [
            '--load-info-json', infoFile,
            '-f', `bv*[height<=${h}][ext=mp4][vcodec^=avc1]/bv*[height<=${h}][ext=mp4]/bv*[height<=${h}][ext=webm]/bv*[height<=${h}]`,
            '-o', path.join(dir, 'video.%(ext)s'), '--no-playlist', '--no-mtime', ...progressArgs,
          ],
          { job, onLine: onLine('video') },
        );
        videoFile = (await found('video')) || null;
      } catch (e) {
        if (e.cancelled) throw e;
        send('yt:progress', { job, stage: 'video', percent: null, warning: `No background video: ${e.message}` });
      }
    }
    const size = (await fsp.stat(path.join(dir, audio))).size;
    return { audio, video: videoFile, info, size };
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
}

// ------------------------------------------------------------------ IPC ----

function registerBeatsIpc(win) {
  getWindow = win;

  ipcMain.handle('beats:list', () => listSongs());
  ipcMain.handle('beats:dir', async () => ensureDir(songsDir()));
  ipcMain.handle('beats:saveSong', async (_e, meta) => {
    songId(meta && meta.id);
    const file = songPath(meta.id, 'song.json');
    let maps = meta.maps;
    if (!maps) {
      try {
        maps = (await readJson(file)).maps || [];
      } catch {
        maps = [];
      }
    }
    const next = { ...meta, maps };
    await writeAtomic(file, JSON.stringify(next, null, 2));
    return next;
  });
  ipcMain.handle('beats:deleteSong', async (_e, id) => {
    await fsp.rm(songPath(id), { recursive: true, force: true });
    return true;
  });
  ipcMain.handle('beats:writeFile', async (_e, { song, name, data }) => {
    const file = songPath(song, relName(name));
    await writeAtomic(file, typeof data === 'string' ? data : Buffer.from(data));
    return { name, size: (await fsp.stat(file)).size };
  });
  ipcMain.handle('beats:readFile', async (_e, { song, name }) => toBytes(await fsp.readFile(songPath(song, relName(name)))));
  ipcMain.handle('beats:hasFile', async (_e, { song, name }) => {
    try {
      return (await fsp.stat(songPath(song, relName(name)))).isFile();
    } catch {
      return false;
    }
  });
  ipcMain.handle('beats:removeFile', async (_e, { song, name }) => {
    await fsp.rm(songPath(song, relName(name)), { force: true });
    return true;
  });
  ipcMain.handle('beats:copyIn', async (_e, { song, src, name }) => {
    if (typeof src !== 'string' || !path.isAbsolute(src)) throw new Error('Invalid source path');
    const st = await fsp.stat(src);
    if (!st.isFile()) throw new Error('Not a file');
    const dest = songPath(song, relName(name));
    await ensureDir(path.dirname(dest));
    await fsp.copyFile(src, dest);
    return { name, size: st.size };
  });
  ipcMain.handle('beats:saveMap', (_e, { song, map, summary }) => saveMap(song, map, summary));
  ipcMain.handle('beats:loadMap', async (_e, { song, map }) => {
    if (!/^[a-z0-9-]{4,64}$/i.test(map)) throw new Error('Invalid map id');
    return readJson(songPath(song, 'maps', `${map}.json`));
  });
  ipcMain.handle('beats:deleteMap', (_e, { song, map }) => deleteMap(song, map));
  ipcMain.handle('beats:pickFiles', async (_e, { kind = 'any', multiple = false, title } = {}) => {
    const res = await dialog.showOpenDialog(getWindow(), {
      title: title || 'Choose a file',
      properties: multiple ? ['openFile', 'multiSelections'] : ['openFile'],
      filters: [...(IMPORT_FILTERS[kind] || []), ...IMPORT_FILTERS.any],
    });
    if (res.canceled) return [];
    return Promise.all(res.filePaths.map(async (p) => ({ path: p, name: path.basename(p), size: (await fsp.stat(p)).size })));
  });
  ipcMain.handle('beats:readPath', async (_e, p) => {
    if (typeof p !== 'string' || !path.isAbsolute(p)) throw new Error('Invalid path');
    return toBytes(await fsp.readFile(p));
  });
  ipcMain.handle('beats:statPath', async (_e, p) => {
    const st = await fsp.stat(p);
    return { path: p, name: path.basename(p), size: st.size };
  });
  ipcMain.handle('beats:openPath', (_e, p) => (typeof p === 'string' && path.isAbsolute(p) ? shell.openPath(p) : 'Invalid path'));
  ipcMain.handle('beats:showItem', (_e, p) => {
    if (typeof p === 'string' && path.isAbsolute(p)) shell.showItemInFolder(p);
    return true;
  });
  ipcMain.handle('beats:openSongFolder', async (_e, id) => shell.openPath(id ? songPath(id) : await ensureDir(songsDir())));

  ipcMain.handle('yt:status', () => ytStatus());
  ipcMain.handle('yt:install', () => ytInstall());
  ipcMain.handle('yt:search', (_e, { query, limit }) => ytSearch(String(query || ''), limit));
  ipcMain.handle('yt:download', (_e, opts) => ytDownload(opts));
  ipcMain.handle('yt:cancel', (_e, job) => {
    const child = jobs.get(job);
    if (child) child.kill();
    return !!child;
  });
}

module.exports = { MEDIA_SCHEME, registerMediaProtocol, registerBeatsIpc, relName };
