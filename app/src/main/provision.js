'use strict';
// Auto-provision cleanup-model weights: download the GGUF on first use and cache
// it in the app's data dir, so the user never sets a path manually. The engine
// itself ships with the app (node-llama-cpp), so only the weights are fetched.

const fs = require('fs');
const path = require('path');
const https = require('https');
const { app } = require('electron');
const { downloadFile } = require('./download');

function httpsGetJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'FlowRadVR', ...headers } }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) {
        r.resume(); return resolve(httpsGetJson(r.headers.location, headers));
      }
      let d = ''; r.on('data', (c) => (d += c));
      r.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

// Resolve the actual GGUF filename in a repo (self-correcting if our guessed
// filename is wrong): prefer the exact name, then a Q4_K_M, then any Q4, then
// any gguf. Falls back to the guess if the API can't be reached.
async function resolveGgufFile(repo, preferred, hfToken) {
  try {
    const headers = hfToken ? { Authorization: `Bearer ${hfToken}` } : {};
    const info = await httpsGetJson(`https://huggingface.co/api/models/${repo}`, headers);
    let ggufs = (info.siblings || []).map((s) => s.rfilename).filter((f) => /\.gguf$/i.test(f));
    if (!ggufs.length) return preferred;
    // Exclude giant full-precision / multi-part files (F16/BF16/F32, "-of-").
    const small = ggufs.filter((f) => !/(f16|bf16|f32|fp16)/i.test(f) && !/-\d{5}-of-\d{5}/i.test(f));
    if (small.length) ggufs = small;
    return ggufs.find((f) => f === preferred)
      || ggufs.find((f) => /q4_k_m/i.test(f))
      || ggufs.find((f) => /q4/i.test(f))
      || ggufs.find((f) => /q5_k_m/i.test(f))
      || ggufs.find((f) => /q3/i.test(f))
      || ggufs.sort((a, b) => a.length - b.length)[0];
  } catch (e) { return preferred; }
}

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

// Directory holding a transducer STT engine's sherpa-onnx files (Parakeet/Omi).
function sttModelDir(engineId) {
  const d = path.join(modelsDir(), engineId);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// Silero VAD ONNX (~2MB, MIT) for real-time dictation. Auto-downloaded + cached.
const SILERO_URL = 'https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx';
async function ensureVadModel({ onProgress } = {}) {
  const dest = path.join(modelsDir(), 'silero_vad.onnx');
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1e5) return dest;
  await downloadFile(SILERO_URL, dest, { onProgress });
  return dest;
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

  // Self-correct the filename against the repo's real file list.
  const file = await resolveGgufFile(entry.repo, entry.file, hfToken);
  console.log(`[provision] ${id}: downloading ${entry.repo}/${file}`);
  const url = `https://huggingface.co/${entry.repo}/resolve/main/${encodeURIComponent(file)}`;
  const headers = {};
  if (entry.gated && hfToken) headers.Authorization = `Bearer ${hfToken}`;
  await downloadFile(url, dest, { headers, onProgress });
  return dest;
}

module.exports = { CATALOG, modelsDir, sttModelDir, ensureVadModel, localPathFor, isInstalled, ensureModel };
