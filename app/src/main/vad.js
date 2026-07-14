'use strict';
// Silero VAD (v5) runner via onnxruntime-node — reuses the ORT runtime MedASR
// already ships. Processes 512-sample windows @ 16kHz and returns a speech
// probability, carrying the recurrent state across windows.
//
// Silero v5 ONNX I/O:
//   inputs : input[1,512] f32, state[2,1,128] f32, sr int64 scalar(16000)
//   outputs: output[1,1] f32 (speech prob), stateN[2,1,128] f32
// We read the actual input/output names at load so minor version differences
// don't break us.

const ort = require('onnxruntime-node');

const WINDOW = 512;   // samples per VAD step @ 16kHz (~32ms)

class SileroVad {
  constructor(modelPath, sr = 16000) {
    this.modelPath = modelPath;
    this.sr = sr;
    this.session = null;
    this.inNames = null;
    this.outNames = null;
    this.state = null;
  }

  async load() {
    this.session = await ort.InferenceSession.create(this.modelPath, {
      executionProviders: ['cpu'], graphOptimizationLevel: 'all',
    });
    this.inNames = this.session.inputNames;
    this.outNames = this.session.outputNames;
    this.reset();
    return this;
  }

  reset() { this.state = new Float32Array(2 * 1 * 128); }

  // frame: Float32Array of exactly WINDOW samples. Returns speech prob 0..1.
  async process(frame) {
    const feeds = {};
    feeds[this._in('input')] = new ort.Tensor('float32', frame, [1, frame.length]);
    feeds[this._in('state')] = new ort.Tensor('float32', this.state, [2, 1, 128]);
    feeds[this._in('sr')] = new ort.Tensor('int64', BigInt64Array.from([BigInt(this.sr)]), []);
    const out = await this.session.run(feeds);
    const stateOut = out[this._out('stateN')] || out[this._out('state')];
    if (stateOut) this.state = stateOut.data;
    const probT = out[this._out('output')];
    return probT ? probT.data[0] : 0;
  }

  _in(want) {
    if (this.inNames.includes(want)) return want;
    // fall back by position: input, state, sr
    const idx = { input: 0, state: 1, sr: 2 }[want];
    return this.inNames[idx] || want;
  }
  _out(want) {
    if (this.outNames.includes(want)) return want;
    const idx = { output: 0, stateN: 1 }[want];
    return this.outNames[idx] || want;
  }
}

module.exports = { SileroVad, WINDOW };
