'use strict';
// Single-call audio-LLM STT (Gemma 4 E4B/12B audio) via a llama.cpp `llama-server`
// SIDECAR. node-llama-cpp doesn't expose audio input yet, but llama.cpp's mtmd
// does — through llama-server's OpenAI-compatible /v1/chat/completions with an
// `input_audio` content block. So we launch llama-server as a subprocess and
// POST the captured audio to it; it transcribes AND formats in one call.
//
// EXPERIMENTAL: needs a recent audio-capable `llama-server` binary (from a
// llama.cpp release), plus the model GGUF + audio mmproj. Slower than MedASR and
// not streaming — best for push-to-talk. If anything is missing, init() throws
// and the app falls back to MedASR.

const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');

const SR = 16000;

// The instruction the audio-LLM follows for each clip.
const PROMPT = 'Transcribe this radiology dictation verbatim, then lightly format it '
  + '(punctuation, capitalization, standard radiology spelling). Preserve laterality, '
  + 'numbers, and negations exactly. Output only the report text.';

function pcmToWav(float32, sampleRate = SR) {
  const n = float32.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    let s = float32[i]; if (s > 1) s = 1; else if (s < -1) s = -1;
    buf.writeInt16LE((s < 0 ? s * 0x8000 : s * 0x7fff) | 0, 44 + i * 2);
  }
  return buf;
}

function httpJson(port, path, body, method = 'POST') {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({ host: '127.0.0.1', port, path, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {} },
      (res) => {
        let d = ''; res.on('data', (c) => (d += c));
        res.on('end', () => {
          if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${d.slice(0, 200)}`));
          try { resolve(d ? JSON.parse(d) : {}); } catch (e) { resolve({ raw: d }); }
        });
      });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

class LlamaAudioAsr {
  // { serverBin, modelPath, mmprojPath, port, gpu, threads }
  constructor(opts) {
    this.o = opts;
    this.port = opts.port || 8199;
    this.proc = null;
  }

  static isInstalled(serverBin, modelPath, mmprojPath) {
    return !!serverBin && fs.existsSync(serverBin) && fs.existsSync(modelPath) && fs.existsSync(mmprojPath);
  }

  async init() {
    const { serverBin, modelPath, mmprojPath, gpu } = this.o;
    if (!serverBin || !fs.existsSync(serverBin)) throw new Error('llama-server binary not found (set its path in Settings)');
    if (!fs.existsSync(modelPath)) throw new Error('audio model GGUF not found — download it first');
    if (!fs.existsSync(mmprojPath)) throw new Error('audio mmproj not found — download it first');
    const args = ['-m', modelPath, '--mmproj', mmprojPath, '--host', '127.0.0.1', '--port', String(this.port),
      '-c', '4096', '--no-webui'];
    if (gpu !== 'off') args.push('-ngl', '99');   // offload to GPU (Vulkan on Arc etc.)
    this.proc = spawn(serverBin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.proc.stdout.on('data', (b) => process.stdout.write('[llama-server] ' + b));
    this.proc.stderr.on('data', (b) => process.stdout.write('[llama-server] ' + b));
    this.proc.on('exit', (code) => { console.log('[llama-server] exited', code); this.proc = null; });
    await this._waitReady(90000);
    return this;
  }

  async _waitReady(timeoutMs) {
    const deadline = Date.now() + timeoutMs;   // note: Date.now allowed in main process
    while (Date.now() < deadline) {
      try { const h = await httpJson(this.port, '/health', null, 'GET'); if (h && (h.status === 'ok' || h.status === undefined)) return; }
      catch (e) { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('llama-server did not become ready in time');
  }

  // pcm: Float32Array @16k mono. Returns transcribed+formatted text.
  async transcribe(pcm) {
    const b64 = pcmToWav(pcm).toString('base64');
    const body = {
      messages: [{ role: 'user', content: [
        { type: 'text', text: PROMPT },
        { type: 'input_audio', input_audio: { data: b64, format: 'wav' } },
      ] }],
      temperature: 0, max_tokens: 1024, stream: false,
    };
    const r = await httpJson(this.port, '/v1/chat/completions', body);
    const txt = r && r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content;
    return (txt || '').trim();
  }

  stop() { try { if (this.proc) this.proc.kill(); } catch (e) {} this.proc = null; }
}

module.exports = { LlamaAudioAsr, pcmToWav };
