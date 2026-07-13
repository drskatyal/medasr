'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('medasr', {
  onState: (cb) => ipcRenderer.on('state', (_e, s) => cb(s)),
  onRecord: (cb) => ipcRenderer.on('record', (_e, msg) => cb(msg)),
  // Send captured PCM (transferable ArrayBuffer of Float32) to main.
  sendAudio: (float32) => ipcRenderer.invoke('audio-chunk', float32),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSettings: (s) => ipcRenderer.invoke('set-settings', s),
  log: (msg) => ipcRenderer.send('renderer-log', String(msg)),
});
