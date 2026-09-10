'use strict';
// Log-mel feature extraction that reproduces transformers LasrFeatureExtractor
// exactly, in pure JS, so the Electron app needs no Python at runtime.
//
// Pipeline (from feature_extraction_lasr.py):
//   frames = unfold(win_length=400, hop=160)
//   stft   = rfft(hann(400, periodic=False) * frame, n=512)  -> 257 bins
//   power  = |stft|^2
//   mel    = log(clamp(power @ melFilter[257x128], min=1e-5))
//
// The [257x128] kaldi-mel filterbank is loaded from assets (export_assets.py),
// guaranteeing it matches Google's matrix bit-for-bit.

const fs = require('fs');
const path = require('path');

function loadAssets(assetsDir) {
  const fc = JSON.parse(fs.readFileSync(path.join(assetsDir, 'feature_config.json'), 'utf8'));
  const mf = JSON.parse(fs.readFileSync(path.join(assetsDir, 'mel_filterbank.json'), 'utf8'));
  const nBins = mf.shape[0];
  const nMels = mf.shape[1];
  const src = mf.data;
  // Store [nMels][nBins] so the inner product streams contiguously.
  const melT = new Float32Array(nMels * nBins);
  for (let b = 0; b < nBins; b++) {
    for (let m = 0; m < nMels; m++) melT[m * nBins + b] = src[b * nMels + m];
  }
  return { fc, nBins, nMels, melT };
}

function hannNonPeriodic(N) {
  // matches torch.hann_window(N, periodic=False): 0.5 - 0.5*cos(2*pi*n/(N-1))
  const w = new Float32Array(N);
  for (let n = 0; n < N; n++) w[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (N - 1));
  return w;
}

// Iterative radix-2 FFT (in-place), size must be a power of two.
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1, cwi = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = i + k + len / 2;
        const tr = re[b] * cwr - im[b] * cwi;
        const ti = re[b] * cwi + im[b] * cwr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const ncwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr; cwr = ncwr;
      }
    }
  }
}

class FeatureExtractor {
  constructor(assetsDir) {
    const { fc, nBins, nMels, melT } = loadAssets(assetsDir);
    this.fc = fc;
    this.window = hannNonPeriodic(fc.win_length);
    this.melT = melT;             // [nMels * nBins]
    this.nBins = nBins;           // 257
    this.nMels = nMels;           // 128
    this._re = new Float32Array(fc.n_fft);
    this._im = new Float32Array(fc.n_fft);
    this._power = new Float32Array(nBins);
  }

  // pcm: Float32Array mono @ 16kHz. Returns {data: Float32Array[T*128], frames, mels}.
  extract(pcm) {
    const { hop_length: hop, win_length: win } = this.fc;
    if (pcm.length < win) return { data: new Float32Array(0), frames: 0, mels: this.nMels };
    const frames = 1 + Math.floor((pcm.length - win) / hop);
    const out = new Float32Array(frames * this.nMels);
    const re = this._re, im = this._im, power = this._power;
    const nBins = this.nBins, nMels = this.nMels, melT = this.melT, window = this.window;

    for (let f = 0; f < frames; f++) {
      const start = f * hop;
      re.fill(0); im.fill(0);
      for (let i = 0; i < win; i++) re[i] = pcm[start + i] * window[i];
      fft(re, im);
      for (let b = 0; b < nBins; b++) power[b] = re[b] * re[b] + im[b] * im[b];
      const base = f * nMels;
      for (let m = 0; m < nMels; m++) {
        let acc = 0;
        const row = m * nBins;
        for (let b = 0; b < nBins; b++) acc += power[b] * melT[row + b];
        out[base + m] = Math.log(Math.max(acc, 1e-5));
      }
    }
    return { data: out, frames, mels: this.nMels };
  }
}

module.exports = { FeatureExtractor };
