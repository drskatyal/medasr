#!/usr/bin/env node
'use strict';
// Copy / fetch weights into ../models so electron-builder extraResources
// can ship MedASR + Qwen + Gemma + Silero VAD inside the installer.
//
// End users never download. Maintainers run this on the build machine:
//   HF_TOKEN=... node app/scripts/bundle-weights.js
//
// Never commits weights. HAI-DEF / Gemma terms still apply — see ATTRIBUTION.md.

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '..', '..');
const MODELS = path.join(ROOT, 'models');
const TOKEN = process.env.HF_TOKEN || process.env.HUGGING_FACE_HUB_TOKEN || '';

const FILES = [
  {
    dest: 'medasr.int8.onnx',
    repo: process.env.MEDASR_ONNX_REPO || 'drskatyal/medasr-onnx',
    file: 'medasr.int8.onnx',
    gated: true,
    required: true,
    note: 'Google MedASR derivative (HAI-DEF)',
  },
  {
    dest: 'Qwen3-1.7B-Q4_K_M.gguf',
    repo: 'Qwen/Qwen3-1.7B-GGUF',
    file: 'Qwen3-1.7B-Q4_K_M.gguf',
  },
    {
      dest: 'gemma-4-E4B-it-Q4_K_M.gguf',
      repo: 'unsloth/gemma-4-E4B-it-GGUF',
      file: 'gemma-4-E4B-it-Q4_K_M.gguf',
      skipEnv: 'SKIP_GEMMA',
    },
  {
    dest: 'silero_vad.onnx',
    url: 'https://github.com/snakers4/silero-vad/raw/master/src/silero_vad/data/silero_vad.onnx',
  },
];

function download(url, dest, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'FlowRadVR-bundle', ...headers } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return download(res.headers.location, dest, headers).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`${url} -> HTTP ${res.statusCode}`));
      }
      const tmp = dest + '.part';
      const out = fs.createWriteStream(tmp);
      res.pipe(out);
      out.on('finish', () => { out.close(() => { fs.renameSync(tmp, dest); resolve(); }); });
      out.on('error', reject);
    });
    req.on('error', reject);
  });
}

function hfUrl(repo, file) {
  return `https://huggingface.co/${repo}/resolve/main/${encodeURIComponent(file)}`;
}

async function main() {
  fs.mkdirSync(MODELS, { recursive: true });
  const notice = path.join(MODELS, 'NOTICE.txt');
  fs.writeFileSync(notice, [
    'Speech recognition: Google MedASR (google/medasr), Health AI Developer Foundations license.',
    'https://developers.google.com/health-ai-developer-foundations/terms',
    'Cleanup: Qwen3-1.7B (Apache 2.0), Gemma 4 E4B (Gemma Terms of Use).',
    '',
  ].join('\n'));

  for (const item of FILES) {
    const dest = path.join(MODELS, item.dest);
    if (item.skipEnv && process.env[item.skipEnv]) {
      console.log('skip', item.dest, `(${item.skipEnv}=1)`);
      continue;
    }
    if (fs.existsSync(dest) && fs.statSync(dest).size > 1000) {
      console.log('have', item.dest);
      continue;
    }
    if (item.optional && !item.repo && !item.url) {
      console.log('skip optional', item.dest, '-', item.note || '');
      continue;
    }
    try {
      if (item.url) {
        console.log('fetch', item.dest);
        await download(item.url, dest);
      } else if (item.repo) {
        const headers = {};
        if (item.gated && TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
        console.log('fetch', item.repo + '/' + item.file);
        await download(hfUrl(item.repo, item.file), dest, headers);
      }
    } catch (e) {
      console.warn('WARN', item.dest, e.message);
      if (item.required && !fs.existsSync(dest)) {
        console.warn('MedASR ONNX is required to ship. Convert locally:');
        console.warn('  python convert/export_onnx.py && python convert/quantize.py');
      }
    }
  }
  console.log('bundle dir', MODELS);
}

main().catch((e) => { console.error(e); process.exit(1); });
