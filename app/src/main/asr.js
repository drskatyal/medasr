'use strict';
// ONNX Runtime (node) MedASR runner: PCM -> log-mel -> logits -> CTC text.
// Runs entirely in the Electron main process; no Python at runtime.

const path = require('path');
const ort = require('onnxruntime-node');
const { FeatureExtractor } = require('./features');
const { loadVocab, greedyCTC } = require('./decode');

const SR = 16000;
const ENC_FPS = 25;            // encoder frames per second (mel /4)
// Long-audio chunking (per Grok's review of this bidirectional CTC Conformer):
const CHUNK_BODY_S = 2.0;
const CHUNK_OVERLAP_S = 0.8;
const DISCARD_ENC_FRAMES = 14; // drop this many encoder frames each stitched edge
const SINGLE_PASS_MAX_S = 24;  // below this, one pass; above, chunk+stitch

class Asr {
  constructor({ modelPath, assetsDir, threads }) {
    this.modelPath = modelPath;
    this.assetsDir = assetsDir;
    this.threads = threads || Math.max(1, (require('os').cpus().length || 4) - 1);
    this.fe = new FeatureExtractor(assetsDir);
    this.vocab = loadVocab(assetsDir);
    this.session = null;
  }

  async init() {
    this.session = await ort.InferenceSession.create(this.modelPath, {
      executionProviders: ['cpu'],
      intraOpNumThreads: this.threads,
      graphOptimizationLevel: 'all',
    });
    return this;
  }

  async _logits(pcm) {
    const { data, frames, mels } = this.fe.extract(pcm);
    if (frames === 0) return { logits: new Float32Array(0), T: 0, V: this.vocab.id_to_piece.length };
    const input = new ort.Tensor('float32', data, [1, frames, mels]);
    const out = await this.session.run({ input_features: input });
    const logits = out.logits;
    const [, T, V] = logits.dims;
    return { logits: logits.data, T, V };
  }

  async transcribe(pcm) {
    if (pcm.length <= SINGLE_PASS_MAX_S * SR) {
      const { logits, T, V } = await this._logits(pcm);
      return T === 0 ? '' : greedyCTC(logits, T, V, this.vocab);
    }
    return this._transcribeChunked(pcm);
  }

  // Chunk + overlap + logit-stitch, then a single CTC decode over the stitched
  // logits (stitching logits, not text, avoids broken words at boundaries).
  async _transcribeChunked(pcm) {
    const body = Math.round(CHUNK_BODY_S * SR);
    const ctx = Math.round(CHUNK_OVERLAP_S * SR);
    const stitched = [];
    let V = this.vocab.id_to_piece.length;
    for (let start = 0; start < pcm.length; start += body) {
      const from = Math.max(0, start - ctx);
      const to = Math.min(pcm.length, start + body + ctx);
      const win = pcm.subarray(from, to);
      const { logits, T, V: v } = await this._logits(win);
      if (T === 0) continue;
      V = v;
      const dLeft = start === 0 ? 0 : DISCARD_ENC_FRAMES;
      const dRight = to >= pcm.length ? 0 : DISCARD_ENC_FRAMES;
      for (let t = dLeft; t < T - dRight; t++) {
        for (let k = 0; k < V; k++) stitched.push(logits[t * V + k]);
      }
    }
    const T = stitched.length / V;
    return greedyCTC(Float32Array.from(stitched), T, V, this.vocab);
  }
}

module.exports = { Asr, SR };
