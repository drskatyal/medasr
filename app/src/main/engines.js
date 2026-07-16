'use strict';
// Registry of selectable engines shown in the settings window.
//
// `implemented` = the runtime is wired in the app today.
// The others are selectable and documented; selecting one that isn't installed
// yet falls back to MedASR with a notification (see index.js). Adding them is a
// download-a-file step (GGUF) or a one-time export — see docs/MODELS.md.

// Curated shipping set. Dictation = MedASR (default, bundled/first-run) + one
// experimental single-call audio-LLM. Everything else was trimmed for the public
// release to keep the UI simple and the choices meaningful.
const STT_ENGINES = [
  { id: 'medasr', label: 'MedASR — medical (default)', runtime: 'onnx', implemented: true,
    note: 'On-device, medically tuned, fast. Runs on any laptop (CPU). Recommended.' },
  // Single-call audio-LLM via a llama-server sidecar (transcribe + format in one
  // model). EXPERIMENTAL: needs a llama-server binary set in Settings → Advanced.
  { id: 'gemma4-e4b-audio', label: 'Gemma 4 E4B — audio, single-call (experimental, slow)', runtime: 'llama-server-audio', implemented: true,
    audio: true, hf: 'ggml-org/gemma-4-E4B-it-GGUF',
    note: 'Transcribes + formats in one call. ~4B. Much slower than MedASR (~30-45s), not streaming. Needs a llama-server binary. For tinkerers.' },
];

// Curated cleaning set: Off + a fast default + a medical model + a general model.
// Qwen3-1.7B is the default (fast, disciplined, Apache-2.0 so it can ship offline).
const CLEANUP_MODELS = [
  { id: 'off', label: 'Off — fastest, raw transcript', gguf: null },
  { id: 'qwen3-1.7b', label: 'Qwen3-1.7B — fast (default)', gguf: 'Qwen3-1.7B-Q4_K_M.gguf',
    note: '~1.1 GB. Fast (~1.5-2s) and stays in its lane. Apache-2.0 — ships with the app.' },
  { id: 'medgemma-4b', label: 'MedGemma 4B — most accurate (medical)', gguf: 'medgemma-1.5-4b-it-Q4_K_M.gguf',
    note: 'Best medical-term correction (~3s). Gated license — downloads on first use.' },
  { id: 'gemma4-e4b', label: 'Gemma 4 E4B — general', gguf: 'gemma-4-E4B-it-Q4_K_M.gguf',
    note: 'General-purpose editor. Gemma license — downloads on first use.' },
];

function sttEngine(id) { return STT_ENGINES.find((e) => e.id === id); }
function cleanupModel(id) { return CLEANUP_MODELS.find((e) => e.id === id); }

module.exports = { STT_ENGINES, CLEANUP_MODELS, sttEngine, cleanupModel };
