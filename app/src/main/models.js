'use strict';
// Resolves model + asset paths and a tiny JSON settings store.
//
// Weights are not committed to git (HAI-DEF). The installer bundles full
// MedASR int8 via extraResources (app/scripts/bundle-weights.js). First launch
// still requires HAI-DEF license acceptance.

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

function firstExisting(paths) {
  for (const p of paths) if (p && fs.existsSync(p)) return p;
  return null;
}

function modelSearchDirs() {
  const dirs = [
    process.resourcesPath && path.join(process.resourcesPath, 'models'),
    path.join(__dirname, '..', '..', '..', 'models'),
  ];
  try { dirs.push(path.join(app.getPath('userData'), 'models')); } catch (e) { /* app not ready */ }
  return dirs.filter(Boolean);
}

function resolveModelPath() {
  // Full MedASR only (int8, then fp32). No distilled student.
  const names = ['medasr.int8.onnx', 'medasr.onnx'];
  const candidates = [];
  for (const d of modelSearchDirs()) for (const n of names) candidates.push(path.join(d, n));
  return firstExisting(candidates);
}

function resolveBundledFile(name) {
  const candidates = [];
  for (const d of modelSearchDirs()) candidates.push(path.join(d, name));
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
  hotkey: 'Alt+Z',           // legacy alias of toggleHotkey
  holdHotkey: 'Alt+X',       // press-and-hold (Windows Alt / macOS Option)
  toggleHotkey: 'Alt+Z',     // tap to start/stop
  showScratchpad: true,      // floating notepad that collects transcripts
  scratchpadText: '',
  widgetBounds: null,
  autoInject: true,   // type into focused app after transcribing
  playSounds: true,
  notifications: false,  // OS pop-up notifications — off by default (quiet app)
  lockFocus: true,       // remember the target field at dictation start; type back into it
  voiceCommands: true,   // spoken punctuation/formatting ("period", "new paragraph", …)
  voiceNav: true,        // spoken navigation ("go to liver", "find <term>") via Find
  voiceActions: true,    // spoken commands ("open chrome", "show desktop", "stop dictation") + macros
  alwaysOnCommands: false, // optional Vosk command listener only — never used for medical transcription
  macros: [              // user-editable "trigger = expansion" templates (typed on match)
    'normal chest = No acute cardiopulmonary process. The heart size is normal. The lungs are clear. No pleural effusion or pneumothorax.',
    'normal abdomen = No acute abdominal abnormality. The visualized bowel is unremarkable. No free air or free fluid.',
  ].join('\n'),
  pacsCommand: '',       // custom app/command launched by "open pacs" (exe path on Windows, .app name on macOS)
  // Cleanup runs when the mic stops (push-to-talk) or when a real-time session
  // ends. Models ship in the installer (Qwen default, Gemma optional).
  cleanupEnabled: true,
  cleanupModel: 'qwen3-1.7b',
  licenseAccepted: false,      // first-run HAI-DEF + Gemma + Qwen acceptance
  llmModelPath: '',            // optional explicit GGUF override; else auto-provisioned
  modelsDirOverride: '',       // custom folder to store downloaded models (e.g. a drive with space)
  hfToken: '',                 // Hugging Face token — authorizes downloads of gated weights (MedASR, MedGemma) under the user's own license acceptance
  medasrRepo: 'drskatyal/medasr-onnx', // gated HF repo hosting the converted MedASR int8 ONNX (maintainer-controlled)
  gpuAccel: 'auto',            // cleaning-model GPU offload: 'auto' (use GPU if available) | 'off' (force CPU)
  llamaServerPath: '',
  sttEngine: 'medasr',         // MedASR only
  // --- real-time (VAD, Silero) dictation: hands-free, auto-segment on pauses ---
  realtimeMode: false,         // press hotkey once, speak; pauses end each utterance
  vadProbThreshold: 0.5,       // Silero speech-probability cutoff (0.35–0.6 typical)
  vadSilenceMs: 700,           // pause length (ms) that finalizes an utterance
  vadMinSpeechMs: 250,         // ignore speech blips shorter than this
  realtimeReplace: true,       // clean once at end and replace typed text (else clipboard-only)
  replaceWholeField: false,    // replace via Ctrl+A (instant, no sweep) — only if the field holds just your dictation
};

function loadSettings() {
  const { migrateHotkeys } = require('./hotkeys');
  try {
    return migrateHotkeys({ ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) });
  } catch (e) {
    return migrateHotkeys({ ...DEFAULTS });
  }
}

function saveSettings(s) {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(s, null, 2));
}

module.exports = {
  resolveModelPath, resolveAssetsDir, resolveBundledFile, modelSearchDirs,
  loadSettings, saveSettings, DEFAULTS, firstExisting,
};
