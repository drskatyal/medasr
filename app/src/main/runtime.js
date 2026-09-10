'use strict';
// ONNX Runtime session helpers: pick a hardware EP when the local
// onnxruntime-node build actually contains it, else CPU. Cap threads so the
// Electron UI and (optional) cleanup LLM are not starved.

const os = require('os');

function threadCount() {
  const n = os.cpus().length || 4;
  return Math.max(1, Math.min(4, n - 2));
}

function providerChains() {
  const plat = process.platform;
  const chains = [];
  // Official npm `onnxruntime-node` is CPU-only; extra EPs succeed only when a
  // custom/ORT-GPU build is swapped in. Always fall back to CPU.
  if (plat === 'darwin') chains.push(['coreml', 'cpu']);
  if (plat === 'win32') chains.push(['dml', 'cpu']);
  chains.push(['cpu']);
  return chains;
}

async function createOnnxSession(ort, modelPath, extra = {}) {
  const threads = extra.threads || threadCount();
  let lastErr;
  for (const eps of providerChains()) {
    try {
      const session = await ort.InferenceSession.create(modelPath, {
        executionProviders: eps,
        intraOpNumThreads: threads,
        interOpNumThreads: 1,
        graphOptimizationLevel: 'all',
        enableCpuMemArena: true,
        enableMemPattern: true,
      });
      session.executionProvider = eps[0];
      session.intraOpNumThreads = threads;
      return session;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('failed to create ONNX session');
}

module.exports = { threadCount, providerChains, createOnnxSession };
