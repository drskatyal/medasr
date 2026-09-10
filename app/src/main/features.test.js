'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { FeatureExtractor } = require('./features');

function writeAssets(dir) {
  const nBins = 257, nMels = 128;
  const data = [];
  for (let b = 0; b < nBins; b++) {
    for (let m = 0; m < nMels; m++) data.push(m === 0 && b < 40 ? 0.01 : 0);
  }
  fs.writeFileSync(path.join(dir, 'feature_config.json'), JSON.stringify({
    hop_length: 160, win_length: 400, n_fft: 512,
  }));
  fs.writeFileSync(path.join(dir, 'mel_filterbank.json'), JSON.stringify({
    shape: [nBins, nMels], data,
  }));
}

test('log-mel extract returns T x 128 and is finite', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mel-'));
  writeAssets(dir);
  const fe = new FeatureExtractor(dir);
  const pcm = new Float32Array(16000);
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.sin(2 * Math.PI * 440 * i / 16000);
  const { data, frames, mels } = fe.extract(pcm);
  assert.equal(mels, 128);
  assert.ok(frames > 10);
  assert.equal(data.length, frames * 128);
  for (let i = 0; i < data.length; i++) assert.ok(Number.isFinite(data[i]));
});
