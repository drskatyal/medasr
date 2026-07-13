'use strict';
// MedASR Dictate -- main process.
// Flow: global hotkey toggles recording. The (hidden) renderer captures mic
// audio, downsamples to 16kHz mono, and on stop sends PCM to the main process,
// which runs the ONNX MedASR model and types the transcript into the focused app.

const path = require('path');
const {
  app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, nativeImage, Notification, session, screen,
} = require('electron');

function log(...a) { console.log('[medasr]', ...a); }

const { Asr } = require('./asr');
const { injectText } = require('./inject');
const { LlmSidecar } = require('./llm');
const { cleanupTranscript } = require('./cleanup');
const models = require('./models');

let llm = null;   // cleanup LLM sidecar (only started when enabled + configured)

let tray = null;
let pill = null;         // small always-on-top status window (the "pill")
let asr = null;
let settings = models.loadSettings();
let recording = false;
let modelReady = false;

// ---------- widget window (persistent mic orb, superwhisper-style) ----------
// Window is larger than the orb so the glow + expanding ring never get clipped
// (that clipping was the visible "border"). The extra area is transparent.
const ORB_W = 120, ORB_H = 120;

function createPill() {
  pill = new BrowserWindow({
    width: ORB_W, height: ORB_H, show: false, frame: false, resizable: false,
    movable: true, alwaysOnTop: true, skipTaskbar: true, transparent: true,
    hasShadow: false, focusable: false, backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
    },
  });
  pill.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  pill.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Park it bottom-centre of the primary display and keep it visible (no
  // show/hide cycling -> no flicker). State is conveyed by orb colour only.
  pill.once('ready-to-show', () => {
    const wa = screen.getPrimaryDisplay().workArea;
    pill.setBounds({
      x: Math.round(wa.x + wa.width / 2 - ORB_W / 2),
      y: Math.round(wa.y + wa.height - ORB_H - 24),
      width: ORB_W, height: ORB_H,
    });
    pill.setAlwaysOnTop(true, 'screen-saver');
    pill.showInactive();
  });
}

// State is just an orb colour change; the window stays put.
function setPill(state) { if (pill) pill.webContents.send('state', state); }

// ---------- recording lifecycle ----------
function startRecording() {
  log('hotkey -> start. modelReady =', modelReady);
  if (recording || !modelReady) {
    if (!modelReady) notify('Model not ready', 'Run the conversion pipeline first (see RUNBOOK.md).');
    return;
  }
  recording = true;
  setPill('recording');
  pill.webContents.send('record', { action: 'start' });
}

function stopRecording() {
  log('hotkey -> stop');
  if (!recording) return;
  recording = false;
  setPill('transcribing');
  pill.webContents.send('record', { action: 'stop' });
}

function toggleRecording() { log('hotkey fired'); recording ? stopRecording() : startRecording(); }

// Renderer delivers the captured 16kHz mono PCM here.
ipcMain.handle('audio-chunk', async (_evt, float32Array) => {
  try {
    const pcm = float32Array instanceof Float32Array ? float32Array : new Float32Array(float32Array);
    log('audio-chunk received:', pcm.length, 'samples (', (pcm.length / 16000).toFixed(2), 's )');
    if (pcm.length < 1600) {              // < 0.1s of audio
      setPill('idle');
      notify('No audio captured', 'The mic recorded nothing — check microphone permission for this app.');
      log('PCM too short -> likely mic permission/capture issue');
      return { text: '' };
    }
    const t0 = Date.now();
    let text = await asr.transcribe(pcm);
    const ms = Date.now() - t0;
    log('transcript:', JSON.stringify(text), `(${ms}ms)`);

    // Optional local cleanup pass (off by default). When enabled and the LLM
    // sidecar is ready, replace the raw transcript with the corrected one.
    // TODO(next): show raw-vs-cleaned diff + explicit accept instead of silent.
    if (text && settings.cleanupEnabled && llm) {
      try {
        const c0 = Date.now();
        const cleaned = await cleanupTranscript(llm, text);
        log('cleaned:', JSON.stringify(cleaned), `(${Date.now() - c0}ms)`);
        if (cleaned) text = cleaned;
      } catch (e) { log('cleanup failed, using raw:', e && e.message || e); }
    }

    setPill('done');
    setTimeout(() => setPill('idle'), 900);
    if (text && settings.autoInject) { log('injecting text…'); await injectText(text); log('inject done'); }
    if (text) notify('Transcribed', `${text.slice(0, 80)}${text.length > 80 ? '…' : ''} (${ms}ms)`);
    else notify('Empty transcript', 'Audio was captured but no speech was recognized.');
    return { text, ms };
  } catch (e) {
    setPill('idle');
    log('ERROR in audio-chunk:', e);
    notify('Transcription failed', String(e && e.message || e));
    return { text: '', error: String(e) };
  }
});

// Renderer forwards its console/errors here so they show in the terminal.
ipcMain.on('renderer-log', (_e, msg) => log('[renderer]', msg));

// Clicking the mic orb toggles dictation (same as the hotkey).
ipcMain.on('toggle-record', () => { log('orb clicked'); toggleRecording(); });

// Dragging the orb moves the widget window.
ipcMain.on('move-widget', (_e, { dx, dy }) => {
  if (!pill) return;
  const b = pill.getBounds();
  pill.setBounds({ x: b.x + Math.round(dx), y: b.y + Math.round(dy), width: b.width, height: b.height });
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
    const ok = globalShortcut.register(settings.hotkey, toggleRecording);
    log('hotkey registered:', settings.hotkey, '->', ok);
    if (!ok) notify('Hotkey busy', `${settings.hotkey} is taken by another app. Change it in the tray menu.`);
  } catch (e) {
    log('hotkey register error:', e);
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
  // Grant microphone (and other) permission requests from our own renderer.
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(true));
  session.defaultSession.setPermissionCheckHandler(() => true);

  createPill();
  buildTray();
  registerHotkey();

  const modelPath = models.resolveModelPath();
  const assetsDir = models.resolveAssetsDir();
  log('modelPath =', modelPath);
  log('assetsDir =', assetsDir);
  if (modelPath) {
    try {
      asr = await new Asr({ modelPath, assetsDir }).init();
      modelReady = true;
      log('model loaded OK. Press', settings.hotkey, 'to dictate.');
    } catch (e) {
      log('model load FAILED:', e);
      notify('Failed to load model', String(e && e.message || e));
    }
  } else {
    log('NO MODEL FOUND at expected locations');
    notify('No model found', 'Convert the model first — see RUNBOOK.md.');
  }
  // Optional: start the cleanup LLM sidecar if enabled and configured.
  if (settings.cleanupEnabled && settings.llmServerPath && settings.llmModelPath) {
    try {
      llm = new LlmSidecar({
        serverPath: settings.llmServerPath,
        modelPath: settings.llmModelPath,
        mmprojPath: settings.llmMmprojPath || undefined,
      });
      await llm.start();
      log('cleanup LLM ready');
    } catch (e) {
      log('cleanup LLM failed to start (continuing without it):', e && e.message || e);
      llm = null;
    }
  }

  refreshTrayMenu();
  initAutoUpdate();
}

app.on('will-quit', () => { if (llm) llm.stop(); });

if (process.platform === 'darwin' && app.dock) app.dock.hide(); // menubar app
if (!app.requestSingleInstanceLock()) app.quit();

app.whenReady().then(boot);
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', (e) => { /* keep running in tray */ });
