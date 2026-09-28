// Exposes a small, explicit API to the renderer. Nothing else from Node or
// Electron is reachable from the page.
'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const listen = (channel) => (callback) => {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('pianoman', {
  isDesktop: true,
  fetch: (req) => ipcRenderer.invoke('net:fetch', req),
  cacheStats: () => ipcRenderer.invoke('cache:stats'),
  clearCache: (bucket) => ipcRenderer.invoke('cache:clear', bucket),
  openScores: () => ipcRenderer.invoke('dialog:openScores'),
  openFile: (opts) => ipcRenderer.invoke('dialog:openFile', opts),
  saveFile: (opts) => ipcRenderer.invoke('dialog:saveFile', opts),
  library: {
    list: () => ipcRenderer.invoke('library:list'),
    save: (meta, data) => ipcRenderer.invoke('library:save', { meta, data }),
    update: (id, patch) => ipcRenderer.invoke('library:update', { id, patch }),
    load: (id) => ipcRenderer.invoke('library:load', id),
    remove: (id) => ipcRenderer.invoke('library:delete', id),
  },
  appInfo: () => ipcRenderer.invoke('app:info'),
  pendingFiles: () => ipcRenderer.invoke('app:pendingFiles'),
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  openCacheFolder: () => ipcRenderer.invoke('shell:openCacheFolder'),
  onMenu: listen('menu'),
  onOpenFile: listen('open-file'),
  onOpenBeatmap: listen('open-beatmap'),
  pendingBeatmaps: () => ipcRenderer.invoke('app:pendingBeatmaps'),
  /** Absolute path of a dropped file (Electron no longer exposes File.path). */
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || null;
    } catch {
      return null;
    }
  },
  beats: {
    list: () => ipcRenderer.invoke('beats:list'),
    dir: () => ipcRenderer.invoke('beats:dir'),
    saveSong: (meta) => ipcRenderer.invoke('beats:saveSong', meta),
    deleteSong: (id) => ipcRenderer.invoke('beats:deleteSong', id),
    writeFile: (song, name, data) => ipcRenderer.invoke('beats:writeFile', { song, name, data }),
    readFile: (song, name) => ipcRenderer.invoke('beats:readFile', { song, name }),
    hasFile: (song, name) => ipcRenderer.invoke('beats:hasFile', { song, name }),
    removeFile: (song, name) => ipcRenderer.invoke('beats:removeFile', { song, name }),
    copyIn: (song, src, name) => ipcRenderer.invoke('beats:copyIn', { song, src, name }),
    saveMap: (song, map, summary) => ipcRenderer.invoke('beats:saveMap', { song, map, summary }),
    loadMap: (song, map) => ipcRenderer.invoke('beats:loadMap', { song, map }),
    deleteMap: (song, map) => ipcRenderer.invoke('beats:deleteMap', { song, map }),
    pickFiles: (opts) => ipcRenderer.invoke('beats:pickFiles', opts),
    readPath: (p) => ipcRenderer.invoke('beats:readPath', p),
    statPath: (p) => ipcRenderer.invoke('beats:statPath', p),
    openPath: (p) => ipcRenderer.invoke('beats:openPath', p),
    showItem: (p) => ipcRenderer.invoke('beats:showItem', p),
    openSongFolder: (id) => ipcRenderer.invoke('beats:openSongFolder', id),
  },
  yt: {
    status: () => ipcRenderer.invoke('yt:status'),
    install: () => ipcRenderer.invoke('yt:install'),
    search: (query, limit) => ipcRenderer.invoke('yt:search', { query, limit }),
    download: (opts) => ipcRenderer.invoke('yt:download', opts),
    cancel: (job) => ipcRenderer.invoke('yt:cancel', job),
    onProgress: listen('yt:progress'),
  },
});
