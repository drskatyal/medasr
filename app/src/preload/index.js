'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('medasr', {
  onState: (cb) => ipcRenderer.on('state', (_e, s, pct) => cb(s, pct)),
  onRecord: (cb) => ipcRenderer.on('record', (_e, msg) => cb(msg)),
  // Send captured PCM (transferable ArrayBuffer of Float32) to main.
  sendAudio: (float32) => ipcRenderer.invoke('audio-chunk', float32),
  // Real-time mode: stream 16k PCM frames continuously.
  sendFrame: (float32) => ipcRenderer.send('audio-frame', float32),
  // Always-on command listener: stream 16k PCM frames + toggle from main.
  sendCmdFrame: (float32) => ipcRenderer.send('cmd-frame', float32),
  onCmdListen: (cb) => ipcRenderer.on('cmd-listen', (_e, on) => cb(on)),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSettings: (s) => ipcRenderer.invoke('set-settings', s),
  getEngines: () => ipcRenderer.invoke('get-engines'),
  getCommands: () => ipcRenderer.invoke('get-commands'),
  getStatus: () => ipcRenderer.invoke('get-status'),
  setup: (what, id) => ipcRenderer.invoke('setup', what, id),
  log: (msg) => ipcRenderer.send('renderer-log', String(msg)),
  toggle: () => ipcRenderer.send('toggle-record'),
  moveBy: (dx, dy) => ipcRenderer.send('move-widget', { dx, dy }),
});
