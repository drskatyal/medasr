'use strict';
// Silero VAD (v5) runner via onnxruntime-node — reuses the ORT runtime MedASR
// already ships. Returns a speech probability per 512-sample step @16kHz.
//
// IMPORTANT (per GPT audit): Silero v5 expects each inference to receive the
// 512 NEW samples PREPENDED with the previous 64 samples of context, i.e. a
// [1, 576] input at 16kHz — plus the recurrent state [2,1,128] and sr int64.
// We maintain the 64-sample context + state across steps and reset both at the
// start of each session. Output: output[1,1] (prob) + stateN[2,1,128].

const ort = require('onnxruntime-node');

const WINDOW = 512;     // NEW samples per step (~32ms @16k)
const CONTEXT = 64;     // samples of previous audio prepended (Silero v5)

class SileroVad {
  constructor(modelPath, sr = 16000) {
    this.modelPath = modelPath;
    this.sr = sr;
    this.session = null;
    this.inNames = null;
    this.outNames = null;
    this.state = null;
    this.context = null;
  }

  async load() {
    this.session = await ort.InferenceSession.create(this.modelPath, {
      executionProviders: ['cpu'], graphOptimizationLevel: 'all',
    });
    this.inNames = this.session.inputNames;
    this.outNames = this.session.outputNames;
    this.reset();
    // Dry run to validate the graph I/O before we trust it (fails loudly).
    await this.process(new Float32Array(WINDOW));
    this.reset();
    return this;
  }

  reset() {
    this.state = new Float32Array(2 * 1 * 128);
    this.context = new Float32Array(CONTEXT);
  }

  // frame: Float32Array of exactly WINDOW (512) NEW samples. Returns speech prob.
  async process(frame) {
    // input = [context(64), frame(512)] -> length 576
    const input = new Float32Array(CONTEXT + frame.length);
    input.set(this.context, 0);
    input.set(frame, CONTEXT);

    const feeds = {};
    feeds[this._in('input')] = new ort.Tensor('float32', input, [1, input.length]);
    feeds[this._in('state')] = new ort.Tensor('float32', this.state, [2, 1, 128]);
    feeds[this._in('sr')] = new ort.Tensor('int64', BigInt64Array.from([BigInt(this.sr)]), [1]);
    const out = await this.session.run(feeds);

    const stateOut = out[this._out('stateN')] || out[this._out('state')];
    if (stateOut) this.state = stateOut.data;
    // next context = last 64 samples of the new frame
    this.context = frame.slice(frame.length - CONTEXT);
    const probT = out[this._out('output')];
    return probT ? probT.data[0] : 0;
  }

  _in(want) {
    if (this.inNames.includes(want)) return want;
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
