'use strict';
// MedASR Dictate -- main process.
// Flow: global hotkey toggles recording. The (hidden) renderer captures mic
// audio, downsamples to 16kHz mono, and on stop sends PCM to the main process,
// which runs the ONNX MedASR model and types the transcript into the focused app.

const path = require('path');
const {
  app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, nativeImage, Notification,
} = require('electron');

const { Asr } = require('./asr');
const { injectText } = require('./inject');
const models = require('./models');

let tray = null;
let pill = null;         // small always-on-top status window (the "pill")
let asr = null;
let settings = models.loadSettings();
let recording = false;
let modelReady = false;

// ---------- windows ----------
function createPill() {
  pill = new BrowserWindow({
    width: 260, height: 92, show: false, frame: false, resizable: false,
    alwaysOnTop: true, skipTaskbar: true, transparent: true, focusable: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  pill.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  pill.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
}

function showPill(state) {
  if (!pill) return;
  pill.webContents.send('state', state);
  if (!pill.isVisible()) pill.showInactive();
}
function hidePill() { if (pill && pill.isVisible()) pill.hide(); }

// ---------- recording lifecycle ----------
function startRecording() {
  if (recording || !modelReady) {
    if (!modelReady) notify('Model not ready', 'Run the conversion pipeline first (see RUNBOOK.md).');
    return;
  }
  recording = true;
  showPill('recording');
  pill.webContents.send('record', { action: 'start' });
}

function stopRecording() {
  if (!recording) return;
  recording = false;
  showPill('transcribing');
  pill.webContents.send('record', { action: 'stop' });
}

function toggleRecording() { recording ? stopRecording() : startRecording(); }

// Renderer delivers the captured 16kHz mono PCM here.
ipcMain.handle('audio-chunk', async (_evt, float32Array) => {
  try {
    const pcm = float32Array instanceof Float32Array ? float32Array : new Float32Array(float32Array);
    if (pcm.length < 1600) { hidePill(); return { text: '' }; } // < 0.1s -> ignore
    const t0 = Date.now();
    const text = await asr.transcribe(pcm);
    const ms = Date.now() - t0;
    showPill('done');
    setTimeout(hidePill, 900);
    if (text && settings.autoInject) await injectText(text);
    if (text) notify('Transcribed', `${text.slice(0, 80)}${text.length > 80 ? '…' : ''} (${ms}ms)`);
    return { text, ms };
  } catch (e) {
    hidePill();
    notify('Transcription failed', String(e && e.message || e));
    return { text: '', error: String(e) };
  }
});

ipcMain.handle('get-settings', () => settings);
ipcMain.handle('set-settings', (_e, s) => {
  settings = { ...settings, ...s };
  models.saveSettings(settings);
  registerHotkey();
  return settings;
});

// ---------- hotkey ----------
function registerHotkey() {
  globalShortcut.unregisterAll();
  try {
    globalShortcut.register(settings.hotkey, toggleRecording);
  } catch (e) {
    notify('Hotkey error', `Could not register ${settings.hotkey}`);
  }
}

// ---------- tray ----------
function buildTray() {
  const icon = nativeImage.createFromNamedImage
    ? nativeImage.createEmpty()
    : nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip('MedASR Dictate');
  refreshTrayMenu();
}

function refreshTrayMenu() {
  const menu = Menu.buildFromTemplate([
    { label: modelReady ? 'Ready' : 'Model not loaded', enabled: false },
    { label: `Dictate  (${settings.hotkey})`, click: toggleRecording, enabled: modelReady },
    { type: 'separator' },
    {
      label: 'Auto-type into focused app', type: 'checkbox', checked: settings.autoInject,
      click: (i) => { settings.autoInject = i.checked; models.saveSettings(settings); },
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
}

function notify(title, body) {
  if (Notification.isSupported()) new Notification({ title, body, silent: !settings.playSounds }).show();
}

// ---------- auto-update (optional; needs MEDASR_UPDATE_URL at build) ----------
function initAutoUpdate() {
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = true;
    autoUpdater.on('update-downloaded', () => notify('Update ready', 'Restart to apply.'));
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  } catch (e) { /* updater not configured in dev */ }
}

// ---------- boot ----------
async function boot() {
  createPill();
  buildTray();
  registerHotkey();

  const modelPath = models.resolveModelPath();
  const assetsDir = models.resolveAssetsDir();
  if (modelPath) {
    try {
      asr = await new Asr({ modelPath, assetsDir }).init();
      modelReady = true;
    } catch (e) {
      notify('Failed to load model', String(e && e.message || e));
    }
  } else {
    notify('No model found', 'Convert the model first — see RUNBOOK.md.');
  }
  refreshTrayMenu();
  initAutoUpdate();
}

if (process.platform === 'darwin' && app.dock) app.dock.hide(); // menubar app
if (!app.requestSingleInstanceLock()) app.quit();

app.whenReady().then(boot);
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', (e) => { /* keep running in tray */ });
