'use strict';
// Phase 2 gate: confirm the exported ONNX loads AND runs in onnxruntime-node
// (plain Node, before touching Electron). Feeds a random [1,T,128] tensor and
// checks the output logits shape is [1, ~T/4, vocab].
//
// Usage:
//   cd app && npm install
//   node ../convert/verify_onnx_node.js ../models/medasr.onnx
//   node ../convert/verify_onnx_node.js ../models/medasr.int8.onnx

const path = require('path');

async function main() {
  const modelPath = process.argv[2] || path.join(__dirname, '..', 'models', 'medasr.onnx');
  let ort;
  try {
    ort = require(path.join(__dirname, '..', 'app', 'node_modules', 'onnxruntime-node'));
  } catch (e) {
    ort = require('onnxruntime-node'); // fall back to ambient install
  }

  console.log('Loading', modelPath);
  const t0 = Date.now();
  const session = await ort.InferenceSession.create(modelPath, {
    executionProviders: ['cpu'],
    graphOptimizationLevel: 'all',
  });
  console.log(`Loaded in ${Date.now() - t0} ms`);
  console.log('inputs :', session.inputNames);
  console.log('outputs:', session.outputNames);

  const T = 400, MELS = 128;
  const data = Float32Array.from({ length: T * MELS }, () => Math.random() * 2 - 1);
  const input = new ort.Tensor('float32', data, [1, T, MELS]);
  const t1 = Date.now();
  const out = await session.run({ input_features: input });
  const logits = out.logits;
  console.log(`Ran in ${Date.now() - t1} ms`);
  console.log('logits dims:', logits.dims, '(expect [1, ~T/4, vocab])');

  const ok = logits.dims.length === 3 && logits.dims[1] > 0 && logits.dims[2] > 1;
  console.log(ok ? 'PASS: onnxruntime-node can load + run MedASR.' : 'FAIL: unexpected output.');
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
