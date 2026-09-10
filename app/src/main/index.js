'use strict';
// MedASR Dictate -- main process.
// Flow: global hotkey toggles recording. The (hidden) renderer captures mic
// audio, downsamples to 16kHz mono, and on stop sends PCM to the main process,
// which runs the ONNX MedASR model and types the transcript into the focused app.

const path = require('path');
const {
  app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain, nativeImage, Notification, session, screen, clipboard,
} = require('electron');

function log(...a) { console.log('[medasr]', ...a); }

const { Asr } = require('./asr');
const { injectText, replaceText, setFocusLock, setReplaceMode } = require('./inject');
const focus = require('./focus');
const { LlmEngine } = require('./llm');
const { cleanupTranscript } = require('./cleanup');
const { applyCommands } = require('./commands');
const { parseNav, navigate } = require('./nav');
const actions = require('./actions');
const { SileroVad } = require('./vad');
const { RealtimeSession } = require('./realtime');
const { VoskCommand } = require('./vosk_cmd');
const provision = require('./provision');
const engines = require('./engines');
const models = require('./models');
const branding = require('./branding');
const hotkeys = require('./hotkeys');
const { startHoldHook } = require('./hold_keys');

let llm = null;      // cleanup LLM sidecar (only started when enabled + configured)
let vad = null;      // Silero VAD (loaded on first real-time use)
let rt = null;       // RealtimeSession
let settingsWin = null;
let llmState = 'off';  // 'off' | 'downloading' | 'loading' | 'ready'
let llmPct = 0;
let transcribing = false;  // re-entrancy guard so transcriptions can't overlap/loop
let vadStatus = 'not loaded';  // 'not loaded'|'downloading'|'loading'|'ready'|'error: …'
let sttActive = 'none';        // engine actually running
let sttNote = '';              // e.g. fallback reason
let voskCmd = null;            // always-on command listener (Vosk)
let cmdStatus = 'off';         // 'off'|'downloading …'|'loading'|'ready'|'error: …'
let sttDlStatus = '';          // STT engine download progress ('', 'downloading N%', 'installed', 'error: …')
let dl = { id: null, pct: 0 }; // the model currently downloading (any kind) — for the per-model list UI

function cleaningStatus() {
  if (!settings.cleanupEnabled) return 'off';
  if (llmState === 'downloading') return `downloading ${llmPct}%`;
  if (llmState === 'loading') return 'loading model…';
  if (llmState === 'ready') return `${settings.cleanupModel} ✓ ready`;
  return settings.cleanupModel || 'on';
}

let tray = null;
let pill = null;         // small always-on-top status window (the "pill")
let scratchpadWin = null;
let holdHook = null;
let holdActive = false;
let quitting = false;
let scratchSaveTimer = 0;
let asr = null;
let settings = models.loadSettings();
let recording = false;
let modelReady = false;

// Hugging Face token is only needed if a bundled weight is missing (dev builds).
function hfToken() { return (settings.hfToken && settings.hfToken.trim()) || process.env.HF_TOKEN || ''; }

function acceptLicenses() {
  if (settings.licenseAccepted) return Promise.resolve(true);
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 560, height: 660, title: branding.APP_NAME + ' — licenses',
      resizable: true, minimizable: false, maximizable: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'index.js'),
        contextIsolation: true, nodeIntegration: false,
      },
    });
    win.setMenuBarVisibility(false);
    win.loadFile(path.join(__dirname, '..', 'renderer', 'license.html'));
    const finish = (ok) => {
      ipcMain.removeListener('license-accept', onOk);
      ipcMain.removeListener('license-decline', onNo);
      if (!win.isDestroyed()) win.close();
      resolve(ok);
    };
    const onOk = () => {
      settings.licenseAccepted = true;
      models.saveSettings(settings);
      finish(true);
    };
    const onNo = () => finish(false);
    ipcMain.once('license-accept', onOk);
    ipcMain.once('license-decline', onNo);
    win.on('closed', () => resolve(!!settings.licenseAccepted));
  });
}

// ---------- widget window (persistent mic orb, superwhisper-style) ----------
// Window is larger than the bar so the glow + expanding ring never get clipped.
// The extra area is transparent.
const ORB_W = 380, ORB_H = 96;

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
  // Re-assert the command-listen state once the renderer is up (in case the
  // listener became ready before the orb finished loading).
  pill.webContents.on('did-finish-load', () => { if (voskCmd && settings.alwaysOnCommands) setCmdListen(true); });
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

const SCRATCH_W = 420, SCRATCH_H = 280;

function persistScratchpadSoon() {
  clearTimeout(scratchSaveTimer);
  scratchSaveTimer = setTimeout(() => { try { models.saveSettings(settings); } catch (e) {} }, 400);
}

function appendScratchpad(text) {
  if (!text) return;
  const cur = settings.scratchpadText || '';
  const sep = !cur ? '' : (/\s$/.test(cur) ? '' : (cur.endsWith('\n') ? '' : ' '));
  settings.scratchpadText = cur + sep + text;
  persistScratchpadSoon();
  if (scratchpadWin && !scratchpadWin.isDestroyed()) {
    scratchpadWin.webContents.send('scratchpad-set', settings.scratchpadText);
  }
}

function showScratchpad(opts) {
  settings.showScratchpad = true;
  persistScratchpadSoon();
  if (!scratchpadWin || scratchpadWin.isDestroyed()) createScratchpad();
  else if (opts && opts.focus) { scratchpadWin.show(); scratchpadWin.focus(); }
  else if (!scratchpadWin.isVisible()) scratchpadWin.showInactive();
}

function hideScratchpad() {
  settings.showScratchpad = false;
  persistScratchpadSoon();
  if (scratchpadWin && !scratchpadWin.isDestroyed()) scratchpadWin.hide();
}

function createScratchpad() {
  if (scratchpadWin && !scratchpadWin.isDestroyed()) return;
  scratchpadWin = new BrowserWindow({
    width: SCRATCH_W, height: SCRATCH_H, show: false, frame: false,
    resizable: true, minimizable: false, maximizable: false,
    alwaysOnTop: true, skipTaskbar: true, hasShadow: true, focusable: true,
    backgroundColor: '#1e2128',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true, nodeIntegration: false,
    },
  });
  scratchpadWin.setMenuBarVisibility(false);
  scratchpadWin.loadFile(path.join(__dirname, '..', 'renderer', 'scratchpad.html'));
  scratchpadWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  scratchpadWin.once('ready-to-show', () => {
    const wa = screen.getPrimaryDisplay().workArea;
    scratchpadWin.setBounds({
      x: Math.round(wa.x + wa.width - SCRATCH_W - 24),
      y: Math.round(wa.y + wa.height - SCRATCH_H - ORB_H - 36),
      width: SCRATCH_W, height: SCRATCH_H,
    });
    scratchpadWin.setAlwaysOnTop(true, 'floating');
    if (settings.showScratchpad !== false) scratchpadWin.showInactive();
  });
  scratchpadWin.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    hideScratchpad();
  });
}

// ---------- recording lifecycle ----------
async function ensureRealtime() {
  if (!vad && (vadStatus.startsWith('downloading') || vadStatus === 'loading')) return; // already in progress
  if (!vad) {
    try {
      vadStatus = 'downloading'; refreshTrayMenu();
      const modelPath = await provision.ensureVadModel({ onProgress: ({ pct }) => { vadStatus = `downloading ${pct}%`; } });
      vadStatus = 'loading'; refreshTrayMenu();
      vad = await new SileroVad(modelPath).load();
      vadStatus = 'ready'; refreshTrayMenu();
      log('Silero VAD loaded');
    } catch (e) {
      vadStatus = 'error: ' + (e && e.message || e); refreshTrayMenu();
      log('VAD load FAILED:', e && e.message || e);
      throw e;
    }
  }
  if (!rt) {
    rt = new RealtimeSession({
      vad,
      getSettings: () => settings,
      transcribe: async (pcm) => {
        let t = await asr.transcribe(pcm);
        // Voice actions mid-session: a command is executed (type nothing); a
        // macro expands to a template that is typed verbatim (skip formatting).
        const act = await runVoiceActions(t);
        if (act && act.handled) return '';
        if (act && act.text != null) return act.text;
        // Voice navigation mid-session: jump the cursor, don't type the phrase.
        if (t && settings.voiceNav) {
          const term = parseNav(t);
          if (term) {
            if (settings.lockFocus) await focus.restoreTarget();
            log('[rt] nav ->', term, JSON.stringify(await navigate(term)));
            return '';
          }
        }
        if (settings.voiceCommands) t = applyCommands(t);
        return t;
      },
      cleanup: async (text) => {
        if (!(settings.cleanupEnabled && llm)) return null;
        setPill('cleaning');                         // show the cleaning cue near the orb
        try { return await cleanupTranscript(llm, text); }
        finally { setPill('idle'); }
      },
      hooks: {
        setState: (s) => setPill(s === 'idle' ? 'idle' : 'recording'), // orb: red during session, black when idle
        typeDelta: async (t) => {
          if (t) appendScratchpad(t);
          if (settings.autoInject) await injectText(t);
        },
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

// ---------- always-on command listener (Vosk) ----------
// A small streaming recognizer runs continuously so commands and "start/stop
// dictation" work hands-free, even when the dictation mic is off. It never
// transcribes the report (MedASR does); it only fires on recognized commands.
function setCmdListen(on) { if (pill && !pill.isDestroyed()) pill.webContents.send('cmd-listen', on); }

async function ensureCommandListener() {
  if (voskCmd || !settings.alwaysOnCommands) return;
  if (cmdStatus.startsWith('downloading') || cmdStatus === 'loading') return; // already in progress
  try {
    cmdStatus = 'downloading'; refreshTrayMenu();
    const dir = await provision.ensureVoskModel({ onProgress: ({ pct }) => { cmdStatus = `downloading ${pct}%`; } });
    cmdStatus = 'loading'; refreshTrayMenu();
    voskCmd = new VoskCommand({ modelDir: dir, onCommand: (t) => handleAlwaysOnCommand(t).catch(() => {}), log: (m) => log('[cmd]', m) });
    voskCmd.load();
    cmdStatus = 'ready'; refreshTrayMenu();
    setCmdListen(true);
    log('always-on command listener ready');
  } catch (e) {
    const raw = String(e && e.message || e);
    const noModule = /Cannot find module 'vosk'/.test(raw);
    cmdStatus = noModule ? 'not installed (run: npm install vosk)' : 'error: ' + raw.split('\n')[0];
    refreshTrayMenu();
    log('command listener unavailable (continuing without it):', noModule ? "vosk module not installed" : raw.split('\n')[0]);
  }
}

function stopCommandListener() {
  setCmdListen(false);
  if (voskCmd) { try { voskCmd.free(); } catch (e) {} voskCmd = null; }
  cmdStatus = 'off'; refreshTrayMenu();
}

// A final utterance from the always-on listener. Internal (mic control) fires in
// any state and is idempotent; app/system commands and macros fire only when
// idle — during dictation the in-session MedASR path owns them so the command
// words are swallowed instead of being typed into the report.
async function handleAlwaysOnCommand(text) {
  if (!settings.alwaysOnCommands || !text) return;
  const cmd = actions.matchCommand(text);
  if (cmd && cmd.type === 'internal') {
    log('always-on command:', cmd.action);
    await actions.executeCommand(cmd, { hooks: {
      startDictation: () => setImmediate(() => { if (!recording) startRecording(); }),
      stopDictation: () => setImmediate(() => { if (recording) stopRecording(); }),
    } });
    return;
  }
  if (recording) return;   // in-session path owns non-internal commands/macros
  if (cmd) {
    log('always-on command:', cmd.triggers[0]);
    await actions.executeCommand(cmd, { pacsCommand: settings.pacsCommand || '' });
    return;
  }
  const macro = actions.matchMacro(text, actions.parseMacros(settings.macros || ''));
  if (macro != null) {
    log('always-on macro');
    appendScratchpad(macro);
    if (settings.autoInject) await injectText(macro);
  }
}

async function startRecording() {
  log('hotkey -> start. modelReady =', modelReady, 'realtime =', !!settings.realtimeMode);
  if (recording || !modelReady) {
    if (!modelReady) notify('MedASR not ready', 'The installer should include google/medasr ONNX under models/. See ATTRIBUTION.md.');
    holdActive = false;
    return;
  }
  recording = true;
  if (settings.lockFocus) { try { await focus.captureTarget(); } catch (e) {} }  // lock the target field
  if (settings.realtimeMode) {
    try {
      await ensureRealtime();
      if (!rt) throw new Error('real-time engine still loading — press again in a moment');
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
  if (holdActive) { holdStop(); return; }
  const now = Date.now();
  if (now - lastToggle < 500) { log('toggle debounced (key repeat?)'); return; } // ignore rapid re-fires
  lastToggle = now;
  log('toggle fired');
  recording ? stopRecording() : startRecording();
}

function holdStart() {
  if (recording) return;
  holdActive = true;
  log('hold -> start');
  startRecording();
}

function holdStop() {
  if (!holdActive && !recording) return;
  holdActive = false;
  log('hold -> stop');
  if (recording) stopRecording();
}

// Voice actions: spoken commands that DO something instead of being typed.
//  - a command (open chrome / show desktop / stop dictation) is EXECUTED and
//    the utterance is swallowed (nothing typed).
//  - a macro ("normal chest") expands into a template that IS typed.
// Returns: { handled:true } if executed (type nothing); { text } if a macro
// expansion should be typed; null if the utterance is ordinary dictation.
async function runVoiceActions(text) {
  if (!text || settings.voiceActions === false) return null;
  const cmd = actions.matchCommand(text);
  if (cmd) {
    log('voice action:', cmd.type, JSON.stringify(cmd.triggers[0]));
    await actions.executeCommand(cmd, {
      pacsCommand: settings.pacsCommand || '',
      // "stop dictation" must run AFTER this transcription returns, or it would
      // re-enter stopRecording() while we're still inside the audio handler.
      hooks: { stopDictation: () => setImmediate(() => { if (recording) stopRecording(); }) },
    });
    return { handled: true };
  }
  const macro = actions.matchMacro(text, actions.parseMacros(settings.macros || ''));
  if (macro != null) { log('macro expand:', JSON.stringify(text)); return { text: macro }; }
  return null;
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

    // Hands-free batch: a spoken "stop dictation" is captured at the tail of the
    // clip; strip it so it isn't typed into the report.
    if (settings.alwaysOnCommands) text = actions.stripTrailingStop(text);

    // Voice actions: run a command (open app / show desktop / stop) or expand a
    // macro. A command is swallowed; a macro is typed verbatim (skip cleanup).
    const act = await runVoiceActions(text);
    if (act && act.handled) { setPill('idle'); return { text: '' }; }
    if (act && act.text != null) {
      setPill('idle');
      appendScratchpad(act.text);
      if (settings.autoInject) await injectText(act.text);
      return { text: act.text };
    }

    // Voice navigation: "go to <term>" / "find <term>" jumps the cursor (no typing).
    if (text && settings.voiceNav) {
      const term = parseNav(text);
      if (term) {
        if (settings.lockFocus) await focus.restoreTarget();
        log('nav ->', term, JSON.stringify(await navigate(term)));
        setPill('idle');
        return { text: '' };
      }
    }

    if (text && settings.cleanupEnabled && llm) {
      // Mic-off cleaning pass: MedASR already produced `text`; the LLM only edits it.
      setPill('cleaning');
      try {
        const c0 = Date.now();
        const cleaned = await cleanupTranscript(llm, text);
        log('cleaned:', JSON.stringify(cleaned), `(${Date.now() - c0}ms)`);
        if (cleaned) text = cleaned;
      } catch (e) { log('cleanup failed, using raw:', e && e.message || e); }
    }

    if (settings.voiceCommands) text = applyCommands(text);   // "period", "new paragraph", …

    setPill('idle');
    if (text) appendScratchpad(text);
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

// Always-on command listener: renderer streams 16k PCM frames here continuously.
ipcMain.on('cmd-frame', (_e, arr) => {
  if (voskCmd && settings.alwaysOnCommands) {
    voskCmd.feed(arr instanceof Float32Array ? arr : new Float32Array(arr));
  }
});

// Renderer forwards its console/errors here so they show in the terminal.
ipcMain.on('renderer-log', (_e, msg) => log('[renderer]', msg));

// Clicking the mic orb or Toggle button starts/stops dictation.
ipcMain.on('toggle-record', () => { log('orb clicked'); toggleRecording(); });
ipcMain.on('hold-start', () => holdStart());
ipcMain.on('hold-stop', () => holdStop());
ipcMain.handle('get-branding', () => branding);
ipcMain.on('scratchpad-show', () => showScratchpad({ focus: true }));
ipcMain.on('scratchpad-hide', () => hideScratchpad());
ipcMain.on('scratchpad-changed', (_e, text) => {
  settings.scratchpadText = String(text || '');
  persistScratchpadSoon();
});
ipcMain.handle('scratchpad-copy', (_e, text) => {
  clipboard.writeText(String(text || ''));
  return true;
});
ipcMain.handle('scratchpad-type', async (_e, text) => {
  const t = String(text || '');
  if (t) await injectText(t);
  return true;
});

// Dragging the orb moves the widget window.
ipcMain.on('move-widget', (_e, { dx, dy }) => {
  if (!pill) return;
  const b = pill.getBounds();
  pill.setBounds({ x: b.x + Math.round(dx), y: b.y + Math.round(dy), width: b.width, height: b.height });
});

ipcMain.handle('get-engines', () => ({
  stt: engines.STT_ENGINES, cleanup: engines.CLEANUP_MODELS,
}));

// Built-in voice commands, for the reference list in Settings.
ipcMain.handle('get-commands', () => actions.DEFAULT_COMMANDS.map((c) => ({
  type: c.type, action: c.action || null, key: c.key || null, combo: c.combo || null, triggers: c.triggers,
})));

// Live status for the settings window (so setup/errors are visible without pop-ups).
ipcMain.handle('get-status', () => {
  // Bulletproof: never let one failing field reject the whole status (that would
  // silently freeze the settings panel).
  let sttInstallable = false, sttInstalled = false, modelsDir = '';
  try { sttInstallable = !!provision.STT_CATALOG[settings.sttEngine]; } catch (e) {}
  try { sttInstalled = provision.isSttInstalled(settings.sttEngine); } catch (e) {}
  try { modelsDir = provision.modelsDir(); } catch (e) {}
  let cleaning = 'off';
  try { cleaning = cleaningStatus(); } catch (e) {}
  // Per-model install state so the UI can show an inline list (each model with
  // its own size, status, and Download button) instead of a shared bar.
  const installed = {};
  try { for (const m of engines.CLEANUP_MODELS) if (m.id !== 'off') installed[m.id] = provision.isInstalled(m.id); } catch (e) {}
  try {
    for (const en of engines.STT_ENGINES) {
      if (en.id === 'medasr') installed[en.id] = provision.isMedasrInstalled() || !!models.resolveModelPath();
      else if (en.runtime === 'llama-server-audio') installed[en.id] = provision.isAudioInstalled(en.id);
      else installed[en.id] = provision.isSttInstalled(en.id);
    }
  } catch (e) {}
  return {
    sttSelected: settings.sttEngine, sttActive, sttNote, modelReady,
    cleaning,
    cleanSelected: settings.cleanupEnabled ? settings.cleanupModel : 'off',
    cleanActive: (settings.cleanupEnabled && llmState === 'ready') ? settings.cleanupModel : null,
    cleanState: llmState,
    cleanBackend: (llm && llmState === 'ready') ? (llm.info ? llm.info().backend : null) : null,
    realtime: !!settings.realtimeMode, vad: vadStatus,
    commands: settings.alwaysOnCommands ? cmdStatus : 'off',
    sttInstallable, sttInstalled, sttDl: sttDlStatus, modelsDir,
    installed, dl,
  };
});

// Download/enable a specific model. Explicit only — nothing downloads on its
// own. `id` (optional) selects which model; else the current setting is used.
ipcMain.handle('setup', async (_e, what, id) => {
  if (dl.id) return { ok: false, error: 'a download is already in progress' };  // one at a time
  try {
    if (what === 'cleanup') {
      const mid = id || settings.cleanupModel || 'qwen3-1.7b';
      settings.cleanupModel = mid; settings.cleanupEnabled = true; models.saveSettings(settings);
      await ensureCleanupLlm();     // downloads settings.cleanupModel if missing, then loads
    } else if (what === 'vad') { await ensureRealtime(); }
    else if (what === 'commands') { settings.alwaysOnCommands = true; models.saveSettings(settings); await ensureCommandListener(); }
    else if (what === 'stt') {
      const eid = id || settings.sttEngine;
      const engDef = engines.sttEngine(eid);
      const isAudio = engDef && engDef.runtime === 'llama-server-audio';
      const isMedasr = eid === 'medasr';
      if (!isMedasr && !isAudio && !provision.STT_CATALOG[eid]) return { ok: false, error: 'no download for this engine' };
      settings.sttEngine = eid; models.saveSettings(settings);
      dl = { id: eid, pct: 0 }; sttDlStatus = 'downloading 0%';
      const onProgress = ({ pct }) => { dl = { id: eid, pct }; sttDlStatus = `downloading ${pct}%`; };
      if (isMedasr) await provision.ensureMedasr(settings.medasrRepo, { hfToken: hfToken(), onProgress });
      else if (isAudio) await provision.ensureAudioModel(eid, engDef.hf, { hfToken: hfToken(), onProgress });
      else await provision.ensureSttModel(eid, { onProgress });
      dl = { id: null, pct: 0 };
      await loadAsr();               // switch to the freshly-downloaded engine
      sttDlStatus = 'installed';     // only after both extract AND load succeed
    }
    return { ok: true };
  } catch (e) {
    dl = { id: null, pct: 0 };
    if (sttDlStatus.startsWith('downloading')) sttDlStatus = 'error: ' + String(e && e.message || e).split('\n')[0];
    return { ok: false, error: String(e && e.message || e) };
  }
});
ipcMain.handle('get-settings', () => settings);
ipcMain.handle('set-settings', (_e, s) => {
  const prevStt = settings.sttEngine;
  const prevDir = settings.modelsDirOverride;
  const prevCleanup = settings.cleanupModel;
  const prevEnabled = settings.cleanupEnabled;
  settings = hotkeys.migrateHotkeys({ ...settings, ...s });
  settings.sttEngine = 'medasr';
  settings.hotkey = settings.toggleHotkey;
  models.saveSettings(settings);
  if (settings.modelsDirOverride !== prevDir) provision.setModelsDir(settings.modelsDirOverride);
  registerHotkey();
  setFocusLock(settings.lockFocus);
  setReplaceMode(settings.replaceWholeField ? 'all' : 'smart');
  refreshTrayMenu();
  if (settings.showScratchpad === false) hideScratchpad();
  else if (scratchpadWin && !scratchpadWin.isDestroyed() && !scratchpadWin.isVisible()) showScratchpad();
  if (settings.sttEngine !== prevStt) loadAsr();
  if (settings.realtimeMode && !vad) ensureRealtime().catch(() => {});
  if (settings.cleanupEnabled) {
    const switched = prevCleanup !== settings.cleanupModel || !prevEnabled;
    if (switched && llm) { try { llm.stop(); } catch (e) {} llm = null; llmState = 'off'; }
    if (!llm && provision.isInstalled(settings.cleanupModel)) ensureCleanupLlm();
  } else if (llm) { llm.stop(); llm = null; llmState = 'off'; refreshTrayMenu(); }
  if (settings.alwaysOnCommands && !voskCmd && provision.isVoskInstalled()) ensureCommandListener();
  if (!settings.alwaysOnCommands && voskCmd) stopCommandListener();
  return settings;
});

// ---------- hotkeys (toggle via globalShortcut; hold via uiohook keyup when available) ----------
function registerHotkey() {
  globalShortcut.unregisterAll();
  if (holdHook && holdHook.stop) { try { holdHook.stop(); } catch (e) {} }
  holdHook = null;

  const toggleAccel = settings.toggleHotkey || settings.hotkey || hotkeys.TOGGLE_DEFAULT;
  const holdAccel = settings.holdHotkey || hotkeys.HOLD_DEFAULT;
  const same = hotkeys.sameCombo(holdAccel, toggleAccel);

  try {
    const ok = globalShortcut.register(toggleAccel, toggleRecording);
    log('toggle hotkey registered:', toggleAccel, '->', ok);
    if (!ok) notify('Toggle hotkey busy', `${toggleAccel} is taken by another app. Change it in Settings.`);
  } catch (e) {
    log('toggle hotkey register error:', e);
    notify('Hotkey error', `Could not register ${toggleAccel}`);
  }

  if (same) {
    log('hold hotkey skipped — same combo as toggle; Hold button still press-and-hold');
    return;
  }

  holdHook = startHoldHook({
    getHoldAccel: () => settings.holdHotkey || hotkeys.HOLD_DEFAULT,
    onDown: () => holdStart(),
    onUp: () => holdStop(),
    log,
  });

  if (!holdHook.ok) {
    // No keyup: tap the hold shortcut to start, tap again to stop.
    // The Hold *button* is still press-and-hold.
    try {
      const ok = globalShortcut.register(holdAccel, () => {
        log('hold hotkey (tap fallback)');
        toggleRecording();
      });
      log('hold hotkey fallback (no keyup):', holdAccel, '->', ok);
      if (!ok) notify('Hold hotkey busy', `${holdAccel} is taken. Change it in Settings.`);
    } catch (e) {
      log('hold hotkey register error:', e);
    }
  }
}

// ---------- tray ----------
function buildTray() {
  const iconPath = path.join(__dirname, '..', '..', 'assets', 'tray.png');
  let icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) icon = nativeImage.createEmpty();
  else if (process.platform === 'darwin') icon = icon.resize({ width: 18, height: 18 });
  tray = new Tray(icon);
  tray.setToolTip(branding.APP_NAME + ' · on-device dictation');
  refreshTrayMenu();
}

function refreshTrayMenu() {
  const holdLabel = hotkeys.formatAccelerator(settings.holdHotkey || hotkeys.HOLD_DEFAULT, process.platform);
  const togLabel = hotkeys.formatAccelerator(settings.toggleHotkey || settings.hotkey || hotkeys.TOGGLE_DEFAULT, process.platform);
  const menu = Menu.buildFromTemplate([
    { label: modelReady ? 'MedASR ready' : 'MedASR not loaded', enabled: false },
    { label: `Toggle dictation  (${togLabel})`, click: toggleRecording, enabled: modelReady },
    { label: `Hold to talk  (${holdLabel})`, enabled: false },
    { type: 'separator' },
    {
      label: 'Scratchpad', type: 'checkbox', checked: settings.showScratchpad !== false,
      click: (i) => { i.checked ? showScratchpad({ focus: true }) : hideScratchpad(); refreshTrayMenu(); },
    },
    {
      label: 'Auto-type into focused app', type: 'checkbox', checked: settings.autoInject,
      click: (i) => { settings.autoInject = i.checked; models.saveSettings(settings); },
    },
    { label: `Cleaning: ${cleaningStatus()}`, enabled: false },
    { type: 'separator' },
    { label: 'Settings…', click: openSettings },
    { label: branding.AUTHOR_CREDIT, enabled: false },
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
    width: 480, height: 680, title: branding.APP_NAME + ' — Settings', resizable: true,
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

  if (!(await acceptLicenses())) {
    app.quit();
    return;
  }

  createPill();
  createScratchpad();
  buildTray();
  registerHotkey();
  setFocusLock(settings.lockFocus);
  setReplaceMode(settings.replaceWholeField ? 'all' : 'smart');
  provision.setModelsDir(settings.modelsDirOverride);

  await loadAsr();
  // Bundled Qwen/Gemma: load the selected cleaner so the mic-off pass is ready.
  if (settings.cleanupEnabled && settings.cleanupModel !== 'off') ensureCleanupLlm();
  if (settings.alwaysOnCommands && provision.isVoskInstalled()) ensureCommandListener();

  refreshTrayMenu();
  initAutoUpdate();
}

async function loadAsr() {
  modelReady = false;
  if (asr && typeof asr.stop === 'function') { try { asr.stop(); } catch (e) {} }
  asr = null;
  sttActive = 'none'; sttNote = '';
  settings.sttEngine = 'medasr';

  const modelPath = models.resolveModelPath();
  const assetsDir = models.resolveAssetsDir();
  log('MedASR modelPath =', modelPath, '| assetsDir =', assetsDir);
  if (!modelPath) {
    sttNote = 'MedASR ONNX missing from the installer (models/medasr*.onnx).';
    notify('MedASR missing', 'Rebuild with app/scripts/bundle-weights.js so the ONNX ships in the app.');
    return;
  }
  try {
    asr = await new Asr({ modelPath, assetsDir }).init();
    modelReady = true; sttActive = 'medasr';
    sttNote = `Google MedASR · ${path.basename(modelPath)} · ${asr.ep || 'cpu'}`;
    log('MedASR loaded OK (', sttNote, '). Hold', settings.holdHotkey, 'or toggle', settings.toggleHotkey, 'to dictate.');
  } catch (e) {
    log('MedASR load FAILED:', e);
    notify('Failed to load MedASR', String(e && e.message || e));
  }
}

// Provision (download-once + cache) the cleanup weights, then load the engine.
async function ensureCleanupLlm() {
  // Don't restart a download/load that's already running (every Save used to
  // re-trigger it, hammering the network and filling the disk with retries).
  if (llmState === 'downloading' || llmState === 'loading') { log('cleanup already in progress; ignoring'); return; }
  const id = settings.cleanupModel && settings.cleanupModel !== 'off'
    ? settings.cleanupModel : 'qwen3-1.7b';
  try {
    let modelPath = settings.llmModelPath;   // explicit override wins
    if (!modelPath || !require('fs').existsSync(modelPath)) {
      if (!provision.isInstalled(id)) {
        // Progress shows in Settings only — NOT under the mic orb.
        llmState = 'downloading'; llmPct = 0; dl = { id, pct: 0 }; refreshTrayMenu();
        let lastPct = -1;
        modelPath = await provision.ensureModel(id, {
          hfToken: hfToken(),
          onProgress: ({ pct }) => {
            llmPct = pct; dl = { id, pct };
            if (pct !== lastPct && pct % 5 === 0) { lastPct = pct; log(`download ${id}: ${pct}%`); }
          },
        });
        dl = { id: null, pct: 0 };
      } else {
        modelPath = provision.localPathFor(id);
      }
    }
    llmState = 'loading'; refreshTrayMenu();
    llm = await new LlmEngine({ modelPath, gpu: settings.gpuAccel, modelId: id }).load();
    llmState = 'ready'; refreshTrayMenu();
    log('cleanup LLM ready:', id);
  } catch (e) {
    dl = { id: null, pct: 0 };
    llmState = 'off'; refreshTrayMenu();
    log('cleanup LLM unavailable (continuing without it):', e && e.message || e);
    notify('Cleaning unavailable', 'Could not load the cleaning model — dictation still works. See docs/MODELS.md.');
    llm = null;
  }
}

app.on('will-quit', () => {
  quitting = true;
  if (holdHook && holdHook.stop) { try { holdHook.stop(); } catch (e) {} }
  if (llm) llm.stop();
  if (voskCmd) { try { voskCmd.free(); } catch (e) {} }
  if (asr && asr.stop) { try { asr.stop(); } catch (e) {} }
});

if (process.platform === 'darwin' && app.dock) app.dock.hide(); // menubar app
if (!app.requestSingleInstanceLock()) app.quit();

app.whenReady().then(boot);
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', (e) => { /* keep running in tray */ });
