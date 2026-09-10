'use strict';
// ONNX Runtime (node) MedASR runner: PCM -> log-mel -> logits -> CTC text.
// Runs entirely in the Electron main process; no Python at runtime.

const path = require('path');
const ort = require('onnxruntime-node');
const { FeatureExtractor } = require('./features');
const { loadVocab, greedyCTC } = require('./decode');
const { createOnnxSession, threadCount } = require('./runtime');

const SR = 16000;
const ENC_FPS = 25;            // encoder frames per second (mel /4)
// Long-audio chunking (only for very long recordings). Dictation clips are
// short, so we default to SINGLE-PASS well past a normal utterance: one forward
// pass has no chunk seams, hence no boundary word-doubling. The model handles
// minutes of audio in one pass fine (RoPE max_position_embeddings=10000 frames
// = ~6.5 min). Chunking is a fallback for recordings longer than that.
const CHUNK_BODY_S = 8.0;
const CHUNK_OVERLAP_S = 1.0;
const SINGLE_PASS_MAX_S = 300; // 5 min single-pass; only longer clips chunk

class Asr {
  constructor({ modelPath, assetsDir, threads }) {
    this.modelPath = modelPath;
    this.assetsDir = assetsDir;
    this.threads = threads || threadCount();
    this.fe = new FeatureExtractor(assetsDir);
    this.vocab = loadVocab(assetsDir);
    this.session = null;
    this.ep = 'cpu';
  }

  async init() {
    this.session = await createOnnxSession(ort, this.modelPath, { threads: this.threads });
    this.ep = this.session.executionProvider || 'cpu';
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
    // Discard exactly the encoder frames that correspond to the context we
    // prepended/appended, so the kept region aligns to the body with no overlap
    // (this is what prevents boundary word-doubling).
    const discard = Math.round(CHUNK_OVERLAP_S * ENC_FPS);
    // Collect kept logit ranges as typed-array copies (not millions of boxed
    // JS numbers) so long recordings don't blow up memory.
    const parts = [];
    let V = this.vocab.id_to_piece.length;
    for (let start = 0; start < pcm.length; start += body) {
      const from = Math.max(0, start - ctx);
      const to = Math.min(pcm.length, start + body + ctx);
      const win = pcm.subarray(from, to);
      const { logits, T, V: v } = await this._logits(win);
      if (T === 0) continue;
      V = v;
      const dLeft = from === 0 ? 0 : discard;
      const dRight = to >= pcm.length ? 0 : discard;
      const a = dLeft * V, b = Math.max(dLeft, T - dRight) * V;
      if (b > a) parts.push(logits.slice(a, b));   // copy this chunk's kept frames
    }
    if (!parts.length) return '';
    let total = 0; for (const p of parts) total += p.length;
    const stitched = new Float32Array(total);
    let o = 0; for (const p of parts) { stitched.set(p, o); o += p.length; }
    const T = stitched.length / V;
    return greedyCTC(stitched, T, V, this.vocab);
  }
}

module.exports = { Asr, SR };
