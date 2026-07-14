'use strict';
// Auto-provision cleanup-model weights: download the GGUF on first use and cache
// it in the app's data dir, so the user never sets a path manually. The engine
// itself ships with the app (node-llama-cpp), so only the weights are fetched.

const fs = require('fs');
const path = require('path');
const https = require('https');
const { app } = require('electron');
const { downloadFileWithRetry } = require('./download');
const downloadFile = downloadFileWithRetry;   // all model downloads auto-resume on transient failures

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

// Where models are stored. Defaults to the app's userData dir, but the user can
// override it (e.g. to a drive with more space) via Settings → Advanced. If the
// override isn't writable we fall back to the default rather than crashing.
let overrideDir = null;
function setModelsDir(p) { overrideDir = (p && String(p).trim()) || null; }
function defaultModelsDir() { return path.join(app.getPath('userData'), 'models'); }
function modelsDir() {
  let d = overrideDir || defaultModelsDir();
  try { fs.mkdirSync(d, { recursive: true }); }
  catch (e) { d = defaultModelsDir(); fs.mkdirSync(d, { recursive: true }); }
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

// Vosk small English model (~40MB, Apache-2.0) for the always-on command
// listener. Downloaded as a .zip and extracted into models/vosk-small/ (the
// directory Vosk's Model() wants). Cross-platform extraction: adm-zip if
// available, else the platform's unzip/Expand-Archive.
const VOSK_ZIP_URL = 'https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip';
const VOSK_DIR_NAME = 'vosk-model-small-en-us-0.15';

function isVoskDir(d) {
  return !!d && (fs.existsSync(path.join(d, 'conf', 'model.conf')) || fs.existsSync(path.join(d, 'am', 'final.mdl')));
}

// A copy bundled with the app (electron-builder extraResources) — lets us ship
// the model in the installer so there's no first-run download.
function bundledVoskDir() {
  return process.resourcesPath ? path.join(process.resourcesPath, 'models', VOSK_DIR_NAME) : null;
}

function voskModelDir() {
  // Prefer the bundled copy; else the user-data dir (downloaded on first use).
  const b = bundledVoskDir();
  if (isVoskDir(b)) return b;
  return path.join(modelsDir(), VOSK_DIR_NAME);
}

function isVoskInstalled() {
  return isVoskDir(bundledVoskDir()) || isVoskDir(path.join(modelsDir(), VOSK_DIR_NAME));
}

function extractZip(zipPath, destDir) {
  // Prefer adm-zip (pure JS, cross-platform) if present; fall back to the OS.
  try {
    const AdmZip = require('adm-zip');
    new AdmZip(zipPath).extractAllTo(destDir, true);
    return;
  } catch (e) { /* fall through to system tools */ }
  const { execFileSync } = require('child_process');
  if (process.platform === 'win32') {
    execFileSync('powershell', ['-NoProfile', '-Command',
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`], { windowsHide: true });
  } else {
    execFileSync('unzip', ['-o', zipPath, '-d', destDir]);
  }
}

async function ensureVoskModel({ onProgress } = {}) {
  if (isVoskInstalled()) return voskModelDir();
  const zip = path.join(modelsDir(), 'vosk-small.zip');
  console.log('[provision] vosk: downloading small command model');
  await downloadFile(VOSK_ZIP_URL, zip, { onProgress });
  console.log('[provision] vosk: extracting');
  extractZip(zip, modelsDir());
  try { fs.unlinkSync(zip); } catch (e) {}
  if (!isVoskInstalled()) throw new Error('Vosk model extraction failed');
  return voskModelDir();
}

// ---- STT engine models (sherpa-onnx transducer: Parakeet) ----
// Real, one-click downloads. Archive is a .tar.bz2 from the sherpa-onnx model
// zoo; we extract it (system `tar`, present on Win10+/mac/linux) and copy the
// int8 files into the per-engine dir under the names ParakeetAsr expects.
const STT_CATALOG = {
  'parakeet-medical': {
    url: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2',
    dir: 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8',
    map: { 'encoder.int8.onnx': 'encoder.onnx', 'decoder.int8.onnx': 'decoder.onnx', 'joiner.int8.onnx': 'joiner.onnx', 'tokens.txt': 'tokens.txt' },
    approxBytes: 6.5e8,
  },
};
// Omi Med STT isn't published in sherpa-onnx format, so it uses the same fast
// Parakeet-TDT base for now (swap when an Omi sherpa export exists).
STT_CATALOG['omi-med-stt'] = STT_CATALOG['parakeet-medical'];

const STT_FILES = ['encoder.onnx', 'decoder.onnx', 'joiner.onnx', 'tokens.txt'];

// A file counts as installed only if it exists AND is non-empty (a killed
// extract / AV quarantine can leave zero-byte files that would fail at load).
function isSttInstalled(engineId) {
  const dir = path.join(modelsDir(), engineId);
  return STT_FILES.every((f) => { try { return fs.statSync(path.join(dir, f)).size > 0; } catch (e) { return false; } });
}

// Async so a large (~650 MB) extract doesn't block the Electron main thread.
function extractTarBz2(archive, destDir) {
  return new Promise((resolve, reject) => {
    const { execFile } = require('child_process');
    execFile('tar', ['-xf', archive, '-C', destDir], { windowsHide: true, maxBuffer: 1 << 24 },
      (err) => (err ? reject(new Error('extract failed (need `tar`, built into Windows 10+/macOS/Linux): ' + err.message)) : resolve()));
  });
}

// Single-flight: share one in-progress install per engine so concurrent Download
// clicks (and aliased catalog entries) don't race on the same files.
const _sttInflight = {};
function ensureSttModel(engineId, { onProgress } = {}) {
  if (_sttInflight[engineId]) return _sttInflight[engineId];
  const p = _doEnsureSttModel(engineId, { onProgress }).finally(() => { delete _sttInflight[engineId]; });
  _sttInflight[engineId] = p;
  return p;
}

async function _doEnsureSttModel(engineId, { onProgress } = {}) {
  const entry = STT_CATALOG[engineId];
  if (!entry) throw new Error(`no download available for '${engineId}'`);
  const dir = sttModelDir(engineId);   // sttModelDir() mkdirs this
  if (isSttInstalled(engineId)) return dir;
  const md = modelsDir();
  const archive = path.join(md, engineId.replace(/[^\w.-]/g, '_') + '.tar.bz2');
  console.log(`[provision] stt ${engineId}: downloading ${entry.url}`);
  await downloadFile(entry.url, archive, { onProgress });
  console.log(`[provision] stt ${engineId}: extracting`);
  await extractTarBz2(archive, md);
  const src = path.join(md, entry.dir);
  if (!fs.existsSync(src)) throw new Error(`archive did not contain '${entry.dir}'`);
  for (const [from, to] of Object.entries(entry.map)) {
    const s = path.join(src, from);
    if (!fs.existsSync(s)) throw new Error(`expected '${from}' missing in archive`);   // fail fast with the name
    fs.copyFileSync(s, path.join(dir, to));
  }
  try { fs.rmSync(src, { recursive: true, force: true }); } catch (e) {}
  try { fs.unlinkSync(archive); } catch (e) {}
  if (!isSttInstalled(engineId)) throw new Error('STT model files missing/empty after extract');
  return dir;
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

module.exports = {
  CATALOG, modelsDir, sttModelDir, ensureVadModel, localPathFor, isInstalled, ensureModel,
  ensureVoskModel, voskModelDir, isVoskInstalled,
  setModelsDir, defaultModelsDir, STT_CATALOG, ensureSttModel, isSttInstalled,
};
