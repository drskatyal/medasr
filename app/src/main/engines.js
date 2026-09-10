'use strict';
// Shipping set: MedASR is the only speech-to-text engine.
// Cleanup is text-in / text-out after the mic stops (Qwen default, Gemma optional).

const STT_ENGINES = [
  {
    id: 'medasr',
    label: 'MedASR (Google) — medical speech-to-text',
    runtime: 'onnx',
    implemented: true,
    bundled: true,
    note: 'On-device Google MedASR (HAI-DEF). Ships in the installer — no download. Distilled int8 when present.',
  },
];

const CLEANUP_MODELS = [
  { id: 'off', label: 'Off — raw MedASR transcript only', gguf: null, bundled: true },
  {
    id: 'qwen3-1.7b',
    label: 'Qwen3-1.7B — fast cleanup (default)',
    gguf: 'Qwen3-1.7B-Q4_K_M.gguf',
    bundled: true,
    note: 'Ships in the installer (~1.1 GB). Runs when you stop the mic. Apache 2.0.',
  },
  {
    id: 'gemma4-e4b',
    label: 'Gemma 4 E4B — stronger cleanup',
    gguf: 'gemma-4-E4B-it-Q4_K_M.gguf',
    bundled: true,
    note: 'Ships in the installer (~5 GB). Slower, better editor. Gemma Terms of Use.',
  },
];

function sttEngine(id) { return STT_ENGINES.find((e) => e.id === id); }
function cleanupModel(id) { return CLEANUP_MODELS.find((e) => e.id === id); }

module.exports = { STT_ENGINES, CLEANUP_MODELS, sttEngine, cleanupModel };
