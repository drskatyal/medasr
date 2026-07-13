'use strict';
// Registry of selectable engines shown in the settings window.
//
// `implemented` = the runtime is wired in the app today.
// The others are selectable and documented; selecting one that isn't installed
// yet falls back to MedASR with a notification (see index.js). Adding them is a
// download-a-file step (GGUF) or a one-time export — see docs/MODELS.md.

const STT_ENGINES = [
  { id: 'medasr', label: 'MedASR — medical (default)', runtime: 'onnx', implemented: true,
    note: 'On-device, medically tuned. Shipping.' },
  { id: 'parakeet-medical', label: 'Parakeet TDT 0.6B — Medical (fast, EN)', runtime: 'onnx', implemented: false,
    note: 'Needs a one-time ONNX export (sherpa-onnx / onnx-asr).' },
  { id: 'whisper-medical', label: 'Whisper small — Medical', runtime: 'whisper', implemented: false,
    note: 'Runs via faster-whisper / whisper.cpp (int8).' },
  { id: 'voxtral-mini-3b', label: 'Voxtral Mini 3B — multilingual', runtime: 'llama-audio', implemented: false,
    note: 'Download GGUF + audio mmproj; runs in the llama.cpp sidecar.' },
  { id: 'gemma4-audio', label: 'Gemma 4 E4B — audio (single-call)', runtime: 'llama-audio', implemented: false,
    note: 'Transcribes + formats in one call. GGUF + BF16 mmproj.' },
];

const CLEANUP_MODELS = [
  { id: 'off', label: 'Off — fastest, raw transcript', gguf: null },
  { id: 'lfm2.5-8b-a1b', label: 'LFM2.5-8B-A1B — recommended', gguf: 'LFM2.5-8B-A1B-Q4_K_M.gguf',
    note: 'MoE 1.5B active; fast + strong instruction following.' },
  { id: 'gemma4-e4b', label: 'Gemma 4 E4B — Apache 2.0', gguf: 'gemma-4-E4B-it-Q4_K_M.gguf' },
  { id: 'qwen3-0.6b', label: 'Qwen3-0.6B — ultra-light', gguf: 'Qwen3-0.6B-Q4_K_M.gguf' },
  { id: 'medgemma-4b', label: 'MedGemma 1.5 4B — medical (gated)', gguf: 'medgemma-1.5-4b-it-Q4_K_M.gguf' },
];

function sttEngine(id) { return STT_ENGINES.find((e) => e.id === id); }
function cleanupModel(id) { return CLEANUP_MODELS.find((e) => e.id === id); }

module.exports = { STT_ENGINES, CLEANUP_MODELS, sttEngine, cleanupModel };
