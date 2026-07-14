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
const { ParakeetAsr } = require('./asr_parakeet');
const { injectText, replaceText } = require('./inject');
const { LlmEngine } = require('./llm');
const { cleanupTranscript } = require('./cleanup');
const { SileroVad } = require('./vad');
const { RealtimeSession } = require('./realtime');
const provision = require('./provision');
const engines = require('./engines');
const models = require('./models');

let llm = null;      // cleanup LLM sidecar (only started when enabled + configured)
let vad = null;      // Silero VAD (loaded on first real-time use)
let rt = null;       // RealtimeSession
let settingsWin = null;
let llmState = 'off';  // 'off' | 'downloading' | 'loading' | 'ready'
let llmPct = 0;
let transcribing = false;  // re-entrancy guard so transcriptions can't overlap/loop

function cleaningStatus() {
  if (!settings.cleanupEnabled) return 'off';
  if (llmState === 'downloading') return `downloading ${llmPct}%`;
  if (llmState === 'loading') return 'loading model…';
  if (llmState === 'ready') return `${settings.cleanupModel} ✓ ready`;
  return settings.cleanupModel || 'on';
}

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

// State is just an orb colour change; the window stays put. `pct` is used by
// the 'downloading' state to show progress in the tooltip.
function setPill(state, pct) { if (pill) pill.webContents.send('state', state, pct); }

// ---------- recording lifecycle ----------
async function ensureRealtime() {
  if (!vad) {
    setPill('downloading');
    const modelPath = await provision.ensureVadModel({ onProgress: ({ pct }) => log('vad download', pct + '%') });
    vad = await new SileroVad(modelPath).load();
    setPill('idle');
    log('Silero VAD loaded');
  }
  if (!rt) {
    rt = new RealtimeSession({
      vad,
      getSettings: () => settings,
      transcribe: (pcm) => asr.transcribe(pcm),
      cleanup: (text) => (settings.cleanupEnabled && llm) ? cleanupTranscript(llm, text) : Promise.resolve(null),
      hooks: {
        setState: (s) => setPill(s === 'idle' ? 'idle' : 'recording'), // orb: red during session, black when idle
        typeDelta: async (t) => { if (settings.autoInject) await injectText(t); },
        replaceAll: async (oldT, newT, glen) => {
          if (!settings.realtimeReplace) { require('electron').clipboard.writeText(newT); log('[rt] replace off -> clipboard'); return; }
          const r = await replaceText(oldT, newT, glen);
          log('[rt] replace:', JSON.stringify(r));
        },
        log: (m) => log('[rt]', m),
      },
    });
  }
  return rt;
}

async function startRecording() {
  log('hotkey -> start. modelReady =', modelReady, 'realtime =', !!settings.realtimeMode);
  if (recording || !modelReady) {
    if (!modelReady) notify('Model not ready', 'Run the conversion pipeline first (see RUNBOOK.md).');
    return;
  }
  recording = true;
  if (settings.realtimeMode) {
    try {
      await ensureRealtime();
      rt.start();
      pill.webContents.send('record', { action: 'start', mode: 'realtime' });
      return;
    } catch (e) {
      recording = false; setPill('idle');
      log('realtime start failed:', e && e.message || e);
      notify('Real-time unavailable', 'Falling back — see logs. ' + (e && e.message || e));
      return;
    }
  }
  setPill('recording');
  pill.webContents.send('record', { action: 'start' });
}

async function stopRecording() {
  log('hotkey -> stop');
  if (!recording) return;
  recording = false;
  if (settings.realtimeMode && rt) {
    pill.webContents.send('record', { action: 'stop' });  // renderer stops streaming
    try { await rt.finish(); } catch (e) { log('rt finish err:', e && e.message || e); setPill('idle'); }
    return;
  }
  setPill('transcribing');
  pill.webContents.send('record', { action: 'stop' });
}

let lastToggle = 0;
function toggleRecording() {
  const now = Date.now();
  if (now - lastToggle < 500) { log('toggle debounced (key repeat?)'); return; } // ignore rapid re-fires
  lastToggle = now;
  log('hotkey fired');
  recording ? stopRecording() : startRecording();
}

// Renderer delivers the captured 16kHz mono PCM here.
ipcMain.handle('audio-chunk', async (_evt, float32Array) => {
  if (transcribing) { log('busy — ignoring overlapping audio-chunk'); return { text: '' }; }
  transcribing = true;
  try {
    const pcm = float32Array instanceof Float32Array ? float32Array : new Float32Array(float32Array);
    log('audio-chunk received:', pcm.length, 'samples (', (pcm.length / 16000).toFixed(2), 's )');
    if (pcm.length < 1600) {              // < 0.1s of audio
      setPill('idle');
      log('PCM too short -> skipping');
      return { text: '' };
    }
    const t0 = Date.now();
    let text = await asr.transcribe(pcm);
    const ms = Date.now() - t0;
    log('transcript:', JSON.stringify(text), `(${ms}ms)`);

    if (text && settings.cleanupEnabled && llm) {
      setPill('cleaning');
      try {
        const c0 = Date.now();
        const cleaned = await cleanupTranscript(llm, text);
        log('cleaned:', JSON.stringify(cleaned), `(${Date.now() - c0}ms)`);
        if (cleaned) text = cleaned;
      } catch (e) { log('cleanup failed, using raw:', e && e.message || e); }
    }

    setPill('idle');
    if (text && settings.autoInject) { log('injecting text…'); await injectText(text); log('inject done'); }
    return { text, ms };
  } catch (e) {
    setPill('idle');
    log('ERROR in audio-chunk:', e);
    return { text: '', error: String(e) };
  } finally {
    transcribing = false;
  }
});

// Real-time mode: renderer streams 16k PCM frames here during a session.
ipcMain.on('audio-frame', (_e, arr) => {
  if (rt && recording && settings.realtimeMode) {
    rt.onFrame(arr instanceof Float32Array ? arr : new Float32Array(arr));
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

ipcMain.handle('get-engines', () => ({
  stt: engines.STT_ENGINES, cleanup: engines.CLEANUP_MODELS,
}));
ipcMain.handle('get-settings', () => settings);
ipcMain.handle('set-settings', (_e, s) => {
  const wasCleanup = settings.cleanupEnabled;
  const prevStt = settings.sttEngine;
  settings = { ...settings, ...s };
  models.saveSettings(settings);
  registerHotkey();
  refreshTrayMenu();
  // Reload the STT engine if the user switched it.
  if (settings.sttEngine !== prevStt) loadAsr();
  // If the user just turned cleaning on, provision + load the model now.
  if (settings.cleanupEnabled && !llm) ensureCleanupLlm();
  if (!settings.cleanupEnabled && llm) { llm.stop(); llm = null; llmState = 'off'; refreshTrayMenu(); }
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
    { label: `Cleaning: ${cleaningStatus()}`, enabled: false },
    { type: 'separator' },
    { label: 'Settings…', click: openSettings },
    { label: 'Quit', click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
}

function notify(title, body) {
  // Off by default — the orb (red/black) and the typed text are the feedback.
  // Everything still goes to the terminal log; enable pop-ups in settings if wanted.
  log('note:', title, '—', body);
  if (!settings.notifications) return;
  if (Notification.isSupported()) new Notification({ title, body, silent: !settings.playSounds }).show();
}

// ---------- settings window ----------
function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.show(); settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 460, height: 640, title: 'MedASR Dictate — Settings', resizable: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  settingsWin.setMenuBarVisibility(false);
  settingsWin.loadFile(path.join(__dirname, '..', 'renderer', 'panel.html'));
  settingsWin.on('closed', () => { settingsWin = null; });
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

  await loadAsr();
  // Cleanup LLM: auto-download the selected model's weights on first use and
  // cache them, then load the bundled engine. All off unless cleanup is enabled.
  if (settings.cleanupEnabled) ensureCleanupLlm();

  refreshTrayMenu();
  initAutoUpdate();
}

// Load the selected STT engine. Parakeet-TDT engines (Omi Med STT / Parakeet
// medical) run via sherpa-onnx if their model files are present; otherwise we
// fall back to MedASR so the app always works.
async function loadAsr() {
  modelReady = false;
  asr = null;
  const engId = settings.sttEngine || 'medasr';
  const eng = engines.sttEngine(engId);

  if (eng && eng.runtime === 'parakeet-tdt') {
    const dir = provision.sttModelDir(engId);
    if (ParakeetAsr.isInstalled(dir)) {
      try {
        asr = await new ParakeetAsr({ modelDir: dir }).init();
        modelReady = true;
        log(`STT engine '${engId}' (Parakeet/sherpa-onnx) loaded`);
        return;
      } catch (e) {
        log(`Parakeet engine '${engId}' failed, falling back to MedASR:`, e && e.message || e);
      }
    } else {
      log(`'${engId}' model files not found in ${dir} -> MedASR`);
      notify('Using MedASR', `“${eng.label}” needs its model files (see docs/PARAKEET.md). Falling back to MedASR.`);
    }
  } else if (eng && eng.runtime === 'llama-audio') {
    // Single-call audio LLMs (Gemma 4 audio / LFM2.5-Audio) need llama.cpp
    // audio-input support, which is still maturing — not runtime-wired yet.
    log(`'${engId}' (single-call audio LLM) not runtime-wired yet -> MedASR`);
    notify('Using MedASR', `“${eng.label}” isn’t runnable yet (llama.cpp audio input). Falling back to MedASR.`);
  }

  // Default: MedASR (onnxruntime-node + CTC).
  const modelPath = models.resolveModelPath();
  const assetsDir = models.resolveAssetsDir();
  log('modelPath =', modelPath, '| assetsDir =', assetsDir);
  if (!modelPath) { notify('No model found', 'Convert the model first — see RUNBOOK.md.'); return; }
  try {
    asr = await new Asr({ modelPath, assetsDir }).init();
    modelReady = true;
    log('MedASR loaded OK. Press', settings.hotkey, 'to dictate.');
  } catch (e) {
    log('MedASR load FAILED:', e);
    notify('Failed to load model', String(e && e.message || e));
  }
}

// Provision (download-once + cache) the cleanup weights, then load the engine.
async function ensureCleanupLlm() {
  const id = settings.cleanupModel && settings.cleanupModel !== 'off'
    ? settings.cleanupModel : 'lfm2.5-8b-a1b';
  try {
    let modelPath = settings.llmModelPath;   // explicit override wins
    if (!modelPath || !require('fs').existsSync(modelPath)) {
      if (!provision.isInstalled(id)) {
        llmState = 'downloading'; llmPct = 0; refreshTrayMenu();
        setPill('downloading', 0);
        notify('Downloading cleaning model', `${id} — one-time (a few GB), cached after. Watch the mic orb / tray for progress.`);
        let lastPct = -1;
        modelPath = await provision.ensureModel(id, {
          hfToken: process.env.HF_TOKEN,
          onProgress: ({ pct }) => {
            llmPct = pct;
            if (pct !== lastPct && pct % 5 === 0) {
              lastPct = pct; log(`download ${id}: ${pct}%`); setPill('downloading', pct); refreshTrayMenu();
            }
          },
        });
        setPill('idle');
      } else {
        modelPath = provision.localPathFor(id);
      }
    }
    llmState = 'loading'; refreshTrayMenu();
    llm = await new LlmEngine({ modelPath }).load();
    llmState = 'ready'; refreshTrayMenu();
    log('cleanup LLM ready:', id);
    notify('Cleaning ready', `${id} is loaded — dictation will be auto-cleaned.`);
  } catch (e) {
    setPill('idle');
    llmState = 'off'; refreshTrayMenu();
    log('cleanup LLM unavailable (continuing without it):', e && e.message || e);
    notify('Cleaning unavailable', 'Could not load the cleaning model — dictation still works. See docs/MODELS.md.');
    llm = null;
  }
}

app.on('will-quit', () => { if (llm) llm.stop(); });

if (process.platform === 'darwin' && app.dock) app.dock.hide(); // menubar app
if (!app.requestSingleInstanceLock()) app.quit();

app.whenReady().then(boot);
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', (e) => { /* keep running in tray */ });
