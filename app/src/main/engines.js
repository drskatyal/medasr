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
  { id: 'parakeet-medical', label: 'Parakeet TDT 0.6B — fast streaming (EN)', runtime: 'parakeet-tdt', implemented: true,
    note: 'NVIDIA Parakeet-TDT via sherpa-onnx. One-click download (~650 MB). High accuracy, low latency.' },
  { id: 'omi-med-stt', label: 'Omi Med STT — (uses Parakeet-TDT base)', runtime: 'parakeet-tdt', implemented: true,
    note: 'Downloads the fast Parakeet-TDT base (~650 MB). One-click.' },
  { id: 'whisper-medical', label: 'Whisper small — Medical', runtime: 'whisper', implemented: false,
    note: 'Runs via faster-whisper / whisper.cpp (int8).' },
  { id: 'voxtral-mini-3b', label: 'Voxtral Mini 3B — multilingual', runtime: 'llama-audio', implemented: false,
    note: 'Download GGUF + audio mmproj; runs in the llama.cpp sidecar.' },
  { id: 'gemma4-audio', label: 'Gemma 4 E4B — audio (single-call)', runtime: 'llama-audio', implemented: false,
    note: 'Transcribes + formats in one call. GGUF + BF16 mmproj.' },
  { id: 'lfm-audio', label: 'LFM2.5-Audio 1.5B — audio (single-call, punctuated)', runtime: 'llama-audio', implemented: false,
    note: 'One model: audio → punctuated text, ~Whisper-v3 WER, <100ms. GGUF via llama.cpp; audio-input support in llama.cpp/node-llama-cpp still maturing.' },
];

const CLEANUP_MODELS = [
  { id: 'off', label: 'Off — fastest, raw transcript', gguf: null },
  { id: 'lfm2.5-8b-a1b', label: 'LFM2.5-8B-A1B — recommended', gguf: 'LFM2.5-8B-A1B-Q4_K_M.gguf',
    note: 'MoE 1.5B active; fast + strong instruction following.' },
  { id: 'omi-sum-3b', label: 'Omi-Sum (sum-small) — clinical SOAP (MIT)', gguf: 'sum-small-Q4_K_M.gguf',
    note: 'Phi-3-mini fine-tuned for medical dialogue → SOAP notes. MIT license.' },
  { id: 'gemma4-e4b', label: 'Gemma 4 E4B — Apache 2.0', gguf: 'gemma-4-E4B-it-Q4_K_M.gguf' },
  { id: 'qwen3-0.6b', label: 'Qwen3-0.6B — ultra-light', gguf: 'Qwen3-0.6B-Q4_K_M.gguf' },
  { id: 'medgemma-4b', label: 'MedGemma 1.5 4B — medical (gated)', gguf: 'medgemma-1.5-4b-it-Q4_K_M.gguf' },
];

function sttEngine(id) { return STT_ENGINES.find((e) => e.id === id); }
function cleanupModel(id) { return CLEANUP_MODELS.find((e) => e.id === id); }

module.exports = { STT_ENGINES, CLEANUP_MODELS, sttEngine, cleanupModel };
