'use strict';
// Auto-provision cleanup-model weights: download the GGUF on first use and cache
// it in the app's data dir, so the user never sets a path manually. The engine
// itself ships with the app (node-llama-cpp), so only the weights are fetched.

const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { downloadFile } = require('./download');

// GGUF catalog. Built from the HF repo + filename -> a `resolve` URL that the
// downloader follows to the CDN. Sizes are approximate (Q4_K_M).
// NOTE: verify exact repo/filenames against Hugging Face before shipping.
const CATALOG = {
  'lfm2.5-8b-a1b': {
    repo: 'LiquidAI/LFM2.5-8B-A1B-GGUF',
    file: 'LFM2.5-8B-A1B-Q4_K_M.gguf',
    approxBytes: 5.0e9,
    label: 'LFM2.5-8B-A1B (Q4_K_M)',
  },
  'gemma4-e4b': {
    repo: 'unsloth/gemma-4-E4B-it-GGUF',
    file: 'gemma-4-E4B-it-Q4_K_M.gguf',
    approxBytes: 4.8e9,
    label: 'Gemma 4 E4B (Q4_K_M)',
  },
  'qwen3-0.6b': {
    repo: 'Qwen/Qwen3-0.6B-GGUF',
    file: 'Qwen3-0.6B-Q4_K_M.gguf',
    approxBytes: 0.5e9,
    label: 'Qwen3-0.6B (Q4_K_M)',
  },
  'omi-sum-3b': {
    repo: 'bartowski/sum-small-GGUF',   // Omi-Sum (sum-small), Phi-3-mini fine-tune, MIT
    file: 'sum-small-Q4_K_M.gguf',
    approxBytes: 2.4e9,
    label: 'Omi-Sum (sum-small) — clinical SOAP',
  },
  'medgemma-4b': {
    repo: 'unsloth/medgemma-1.5-4b-it-GGUF',
    file: 'medgemma-1.5-4b-it-Q4_K_M.gguf',
    approxBytes: 2.5e9,
    label: 'MedGemma 1.5 4B (Q4_K_M)',
    gated: true, // HAI-DEF: needs the user's HF token
  },
};

function modelsDir() {
  const d = path.join(app.getPath('userData'), 'models');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function localPathFor(id) {
  const entry = CATALOG[id];
  if (!entry) return null;
  return path.join(modelsDir(), entry.file);
}

function isInstalled(id) {
  const p = localPathFor(id);
  return p && fs.existsSync(p) && fs.statSync(p).size > 1e6;
}

// Ensure the GGUF for `id` is present, downloading it if needed. `hfToken` is
// only needed for gated models (MedGemma). onProgress -> ({received,total,pct}).
async function ensureModel(id, { hfToken, onProgress } = {}) {
  const entry = CATALOG[id];
  if (!entry) throw new Error(`unknown cleanup model: ${id}`);
  const dest = localPathFor(id);
  if (isInstalled(id)) return dest;

  const url = `https://huggingface.co/${entry.repo}/resolve/main/${entry.file}`;
  const headers = {};
  if (entry.gated && hfToken) headers.Authorization = `Bearer ${hfToken}`;
  await downloadFile(url, dest, { headers, onProgress });
  return dest;
}

module.exports = { CATALOG, modelsDir, localPathFor, isInstalled, ensureModel };
