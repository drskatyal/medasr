'use strict';
// Resolves model + asset paths and a tiny JSON settings store.
//
// Model weights are NOT bundled in the public repo (HAI-DEF gated license --
// see LICENSING_NOTES.md). They are produced by the conversion pipeline
// (convert/*.py) and placed in the repo's ../models dir for `npm start`, or
// packaged via electron-builder extraResources for a build. If the model is
// missing, the app shows setup instructions instead of crashing.

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

function firstExisting(paths) {
  for (const p of paths) if (p && fs.existsSync(p)) return p;
  return null;
}

function resolveModelPath() {
  const names = ['medasr.int8.onnx', 'medasr.onnx'];
  const dirs = [
    process.resourcesPath && path.join(process.resourcesPath, 'models'), // packaged
    path.join(__dirname, '..', '..', '..', 'models'),                    // dev (repo/models)
    path.join(app.getPath('userData'), 'models'),                        // user-provided
  ].filter(Boolean);
  const candidates = [];
  for (const d of dirs) for (const n of names) candidates.push(path.join(d, n));
  return firstExisting(candidates);
}

function resolveAssetsDir() {
  return firstExisting([
    path.join(__dirname, '..', '..', 'assets'),            // dev + packaged (files)
    path.join(process.resourcesPath || '', 'app', 'assets'),
  ]) || path.join(__dirname, '..', '..', 'assets');
}

// --- settings store ---
function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

const DEFAULTS = {
  hotkey: 'Alt+Q',    // simple two-key toggle
  autoInject: true,   // type into focused app after transcribing
  playSounds: true,
  notifications: false,  // OS pop-up notifications — off by default (quiet app)
  // --- cleanup LLM (OFF by default for latency; when enabled, the weights
  //     auto-download once and cache — no manual setup) ---
  cleanupEnabled: false,       // run the local cleanup LLM on the transcript
  cleanupModel: 'lfm2.5-8b-a1b', // default model (auto-downloaded on first enable)
  llmModelPath: '',            // optional explicit GGUF override; else auto-provisioned
  sttEngine: 'medasr',         // 'medasr' | 'gemma4-audio' (future) | ...
  // --- real-time (VAD) dictation: hands-free, auto-segment on pauses ---
  realtimeMode: false,         // press hotkey once, speak; pauses end each utterance
  vadThreshold: 0.012,         // RMS speech/silence cutoff (higher = needs louder speech)
  vadSilenceMs: 700,           // pause length (ms) that finalizes an utterance
  vadMinSpeechMs: 300,         // ignore speech blips shorter than this
};

function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) };
  } catch (e) {
    return { ...DEFAULTS };
  }
}

function saveSettings(s) {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(s, null, 2));
}

module.exports = { resolveModelPath, resolveAssetsDir, loadSettings, saveSettings, DEFAULTS };
