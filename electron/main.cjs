// PianoMan – Electron main process.
//
// Responsibilities:
//  * the app window, menu and the app:// protocol that serves the built UI
//  * all network access for the renderer (sample libraries, score search APIs,
//    score downloads), with an on-disk cache so instruments work offline once
//    they have been downloaded
//  * file dialogs, the score library on disk, and opening files from the OS
'use strict';

const { app, BrowserWindow, Menu, dialog, ipcMain, net, protocol, session, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

const DEV_URL = process.env.VITE_DEV_SERVER_URL;
const DIST = path.join(__dirname, '..', 'dist');
const SCORE_EXTENSIONS = ['musicxml', 'xml', 'mxl', 'mid', 'midi', 'kar', 'abc'];
const USER_AGENT = `PianoMan/${app.getVersion()} (+https://github.com/Dx-Alz-xD/PianoMan)`;

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

let mainWindow = null;
const pendingOpenPaths = [];

// ---------------------------------------------------------------- paths ----

const userDir = () => app.getPath('userData');
const cacheDir = (bucket) => path.join(userDir(), 'cache', bucket.replace(/[^a-z0-9_-]/gi, ''));
const libraryDir = () => path.join(userDir(), 'library');
const libraryIndexPath = () => path.join(libraryDir(), 'index.json');

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

// --------------------------------------------------------- cached fetch ----

/**
 * Fetches a URL on behalf of the renderer.
 * cache: false | 'samples' | 'scores' | 'api'. Samples and scores never expire;
 * 'api' responses expire after `maxAge` seconds (default one hour).
 */
async function cachedFetch(req) {
  const { url, responseType = 'text', cache = false, maxAge = 3600, headers = {}, method = 'GET', body, cacheKey } = req;
  if (!/^https?:\/\//i.test(url)) throw new Error(`Unsupported URL: ${url}`);
  // cacheKey lets mirrors of the same file share one cache entry.
  const key = crypto.createHash('sha1').update(cacheKey || `${method} ${url} ${body || ''}`).digest('hex');
  let file = null;
  if (cache) {
    file = path.join(await ensureDir(cacheDir(cache)), key);
    try {
      const st = await fsp.stat(file);
      const fresh = cache !== 'api' || Date.now() - st.mtimeMs < maxAge * 1000;
      if (fresh) {
        const buf = await fsp.readFile(file);
        return { ok: true, status: 200, fromCache: true, url, data: decode(buf, responseType) };
      }
    } catch {
      /* not cached */
    }
  }
  const init = { method, body, headers: { 'User-Agent': USER_AGENT, ...headers }, redirect: 'follow' };
  let res;
  try {
    res = await net.fetch(url, init);
  } catch (err) {
    // raw.githubusercontent.com answers with an unquoted Content-Disposition
    // filename, which Chromium rejects when the path contains a comma (e.g.
    // "Harpsichord, Flemish"). Node's HTTP client accepts it.
    if (!/ERR_RESPONSE_HEADERS_MULTIPLE_CONTENT_DISPOSITION|ERR_INVALID_RESPONSE/.test(String(err))) throw err;
    res = await fetch(url, init);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (res.ok && file) {
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, buf);
    await fsp.rename(tmp, file);
  }
  return {
    ok: res.ok,
    status: res.status,
    fromCache: false,
    url: res.url || url,
    contentType: res.headers.get('content-type') || '',
    data: decode(buf, responseType),
  };
}

function decode(buf, responseType) {
  if (responseType === 'arraybuffer') return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const text = buf.toString('utf8');
  if (responseType === 'json') return JSON.parse(text);
  return text;
}

async function dirSize(dir) {
  let total = 0;
  let count = 0;
  try {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const s = await dirSize(p);
        total += s.bytes;
        count += s.files;
      } else {
        total += (await fsp.stat(p)).size;
        count += 1;
      }
    }
  } catch {
    /* missing dir */
  }
  return { bytes: total, files: count };
}

// -------------------------------------------------------------- library ----

async function readLibraryIndex() {
  try {
    return JSON.parse(await fsp.readFile(libraryIndexPath(), 'utf8'));
  } catch {
    return [];
  }
}

async function writeLibraryIndex(items) {
  await ensureDir(libraryDir());
  const tmp = `${libraryIndexPath()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(items, null, 2));
  await fsp.rename(tmp, libraryIndexPath());
}

function safeId(id) {
  if (!/^[a-z0-9-]{6,64}$/i.test(id)) throw new Error('Invalid library id');
  return id;
}

// ---------------------------------------------------------------- files ----

async function readScoreFile(filePath) {
  const data = await fsp.readFile(filePath);
  return { name: path.basename(filePath), path: filePath, data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
}

function isScorePath(p) {
  return SCORE_EXTENSIONS.includes(path.extname(p).slice(1).toLowerCase());
}

function queueOpenPath(p) {
  if (!p || !isScorePath(p) || !fs.existsSync(p)) return;
  if (mainWindow && !mainWindow.webContents.isLoading()) {
    readScoreFile(p)
      .then((file) => mainWindow.webContents.send('open-file', file))
      .catch(() => {});
  } else {
    pendingOpenPaths.push(p);
  }
}

// ----------------------------------------------------------------- IPC ----

function registerIpc() {
  ipcMain.handle('net:fetch', (_e, req) => cachedFetch(req));

  ipcMain.handle('cache:stats', async () => ({
    samples: await dirSize(cacheDir('samples')),
    scores: await dirSize(cacheDir('scores')),
    api: await dirSize(cacheDir('api')),
    dir: path.join(userDir(), 'cache'),
  }));

  ipcMain.handle('cache:clear', async (_e, bucket) => {
    const target = bucket ? cacheDir(bucket) : path.join(userDir(), 'cache');
    await fsp.rm(target, { recursive: true, force: true });
    return true;
  });

  ipcMain.handle('dialog:openScores', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Open score',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Scores (MusicXML, MXL, MIDI, ABC)', extensions: SCORE_EXTENSIONS },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (res.canceled) return [];
    return Promise.all(res.filePaths.map(readScoreFile));
  });

  ipcMain.handle('dialog:openFile', async (_e, opts = {}) => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: opts.title || 'Open',
      properties: ['openFile'],
      filters: opts.filters || [{ name: 'All files', extensions: ['*'] }],
    });
    if (res.canceled || !res.filePaths[0]) return null;
    return readScoreFile(res.filePaths[0]);
  });

  ipcMain.handle('dialog:saveFile', async (_e, { defaultName, filters, data }) => {
    const res = await dialog.showSaveDialog(mainWindow, {
      defaultPath: path.join(app.getPath('documents'), defaultName || 'untitled'),
      filters: filters || [{ name: 'All files', extensions: ['*'] }],
    });
    if (res.canceled || !res.filePath) return null;
    await fsp.writeFile(res.filePath, typeof data === 'string' ? data : Buffer.from(data));
    return res.filePath;
  });

  ipcMain.handle('library:list', () => readLibraryIndex());

  ipcMain.handle('library:save', async (_e, { meta, data }) => {
    const items = await readLibraryIndex();
    const id = meta.id && /^[a-z0-9-]{6,64}$/i.test(meta.id) ? meta.id : crypto.randomUUID();
    await ensureDir(libraryDir());
    await fsp.writeFile(path.join(libraryDir(), `${id}.bin`), Buffer.from(data));
    const entry = { ...meta, id, size: data.byteLength, addedAt: meta.addedAt || new Date().toISOString() };
    const next = items.filter((i) => i.id !== id);
    next.unshift(entry);
    await writeLibraryIndex(next);
    return entry;
  });

  ipcMain.handle('library:update', async (_e, { id, patch }) => {
    const items = await readLibraryIndex();
    const i = items.findIndex((x) => x.id === safeId(id));
    if (i < 0) return null;
    items[i] = { ...items[i], ...patch, id: items[i].id };
    await writeLibraryIndex(items);
    return items[i];
  });

  ipcMain.handle('library:load', async (_e, id) => {
    const buf = await fsp.readFile(path.join(libraryDir(), `${safeId(id)}.bin`));
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  });

  ipcMain.handle('library:delete', async (_e, id) => {
    const items = await readLibraryIndex();
    await fsp.rm(path.join(libraryDir(), `${safeId(id)}.bin`), { force: true });
    await writeLibraryIndex(items.filter((i) => i.id !== id));
    return true;
  });

  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    platform: process.platform,
    userData: userDir(),
  }));

  ipcMain.handle('app:pendingFiles', async () => {
    const files = [];
    while (pendingOpenPaths.length) {
      try {
        files.push(await readScoreFile(pendingOpenPaths.shift()));
      } catch {
        /* ignore unreadable */
      }
    }
    return files;
  });

  ipcMain.handle('shell:openExternal', (_e, url) => {
    if (/^https?:\/\//i.test(url)) return shell.openExternal(url);
    return false;
  });

  ipcMain.handle('shell:openCacheFolder', async () => {
    const dir = await ensureDir(path.join(userDir(), 'cache'));
    return shell.openPath(dir);
  });
}

// ---------------------------------------------------------------- menu ----

function sendMenu(action) {
  if (mainWindow) mainWindow.webContents.send('menu', action);
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open Score…', accelerator: 'CmdOrCtrl+O', click: () => sendMenu('open-score') },
        { label: 'Open Score from URL…', accelerator: 'CmdOrCtrl+L', click: () => sendMenu('open-url') },
        { label: 'Search Scores…', accelerator: 'CmdOrCtrl+F', click: () => sendMenu('search') },
        { type: 'separator' },
        { label: 'Export Recording as MIDI…', click: () => sendMenu('export-midi') },
        { label: 'Export Recording as WAV…', click: () => sendMenu('export-wav') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Falling Notes', accelerator: 'CmdOrCtrl+1', click: () => sendMenu('view-notes') },
        { label: 'Sheet Music', accelerator: 'CmdOrCtrl+2', click: () => sendMenu('view-sheet') },
        { label: 'Split View', accelerator: 'CmdOrCtrl+3', click: () => sendMenu('view-split') },
        { type: 'separator' },
        { label: 'Sound Settings', accelerator: 'CmdOrCtrl+,', click: () => sendMenu('toggle-settings') },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Keyboard Shortcuts', accelerator: 'F1', click: () => sendMenu('shortcuts') },
        { label: 'Open Sample Cache Folder', click: () => shell.openPath(path.join(userDir(), 'cache')) },
        { type: 'separator' },
        { label: 'About PianoMan', click: () => sendMenu('about') },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// -------------------------------------------------------------- window ----

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#0d0f14',
    title: 'PianoMan',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      autoplayPolicy: 'no-user-gesture-required',
      backgroundThrottling: false,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = DEV_URL ? url.startsWith(DEV_URL) : url.startsWith('app://');
    if (!allowed) event.preventDefault();
  });

  if (DEV_URL) mainWindow.loadURL(DEV_URL);
  else mainWindow.loadURL('app://pianoman/index.html');
}

function registerAppProtocol() {
  protocol.handle('app', (request) => {
    const { pathname } = new URL(request.url);
    const rel = decodeURIComponent(pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.normalize(path.join(DIST, rel));
    if (!file.startsWith(DIST)) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
}

function configurePermissions() {
  // Current Chromium reports every Web MIDI request as "midiSysex"; PianoMan
  // only ever reads from MIDI inputs, so both are granted.
  const allowed = new Set(['midi', 'midiSysex', 'clipboard-sanitized-write', 'fullscreen']);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed.has(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
}

// --------------------------------------------------------------- start ----

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    argv.slice(1).forEach(queueOpenPath);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.on('open-file', (event, p) => {
    event.preventDefault();
    queueOpenPath(p);
  });

  process.argv.slice(app.isPackaged ? 1 : 2).forEach((p) => {
    if (isScorePath(p) && fs.existsSync(p)) pendingOpenPaths.push(path.resolve(p));
  });

  app.whenReady().then(() => {
    registerAppProtocol();
    configurePermissions();
    registerIpc();
    buildMenu();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
