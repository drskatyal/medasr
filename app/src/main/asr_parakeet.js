'use strict';
// Parakeet-TDT STT engine (Omi Med STT v1 / parakeet-medical) via sherpa-onnx.
//
// These are NVIDIA NeMo transducer (TDT) models — a different decoding scheme
// than MedASR's CTC — so we use sherpa-onnx's OfflineRecognizer, which handles
// the encoder/decoder/joiner + its own 80-dim log-mel feature extraction. That
// means this engine does NOT use our features.js/decode.js (those are CTC).
//
// Model files (sherpa-onnx transducer format) live in a per-engine dir:
//   <userData>/models/<engineId>/{encoder,decoder,joiner}.onnx  +  tokens.txt
// Omi ships its own runtime, not sherpa format, so a one-time conversion is
// needed — see docs/PARAKEET.md. Same interface as Asr: init() + transcribe().

const fs = require('fs');
const path = require('path');

const SR = 16000;

function files(modelDir) {
  return {
    encoder: path.join(modelDir, 'encoder.onnx'),
    decoder: path.join(modelDir, 'decoder.onnx'),
    joiner: path.join(modelDir, 'joiner.onnx'),
    tokens: path.join(modelDir, 'tokens.txt'),
  };
}

class ParakeetAsr {
  constructor({ modelDir, threads }) {
    this.modelDir = modelDir;
    this.threads = threads || Math.max(1, (require('os').cpus().length || 4) - 1);
    this.recognizer = null;
  }

  static isInstalled(modelDir) {
    if (!modelDir) return false;
    const f = files(modelDir);
    return ['encoder', 'decoder', 'joiner', 'tokens'].every((k) => fs.existsSync(f[k]));
  }

  async init() {
    const sherpa = require('sherpa-onnx-node'); // native module; ships with the app
    const f = files(this.modelDir);
    this.recognizer = new sherpa.OfflineRecognizer({
      featConfig: { sampleRate: SR, featureDim: 80 },
      modelConfig: {
        transducer: { encoder: f.encoder, decoder: f.decoder, joiner: f.joiner },
        tokens: f.tokens,
        modelType: 'nemo_transducer',
        numThreads: this.threads,
        provider: 'cpu',
        debug: 0,
      },
      decodingMethod: 'greedy_search',
    });
    return this;
  }

  // pcm: Float32Array mono @ 16kHz. sherpa-onnx handles arbitrary length + its
  // own features, so there's no chunk-stitching (and no boundary doubling).
  async transcribe(pcm) {
    if (!this.recognizer) throw new Error('ParakeetAsr not initialized');
    const stream = this.recognizer.createStream();
    stream.acceptWaveform({ sampleRate: SR, samples: pcm });
    this.recognizer.decode(stream);
    const res = this.recognizer.getResult(stream);
    return (res && res.text ? res.text : '').trim();
  }
}

module.exports = { ParakeetAsr, files };
