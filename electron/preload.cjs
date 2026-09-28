// Exposes a small, explicit API to the renderer. Nothing else from Node or
// Electron is reachable from the page.
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

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
});
