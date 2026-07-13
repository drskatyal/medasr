'use strict';
// Local LLM runtime for the cleanup model (and, later, Gemma 4 audio STT).
//
// Runs a bundled `llama.cpp` server (`llama-server`) as a SIDECAR process and
// talks to it over its OpenAI-compatible HTTP API on 127.0.0.1. This is
// deliberately decoupled from onnxruntime-node (which runs MedASR in-process):
// a sidecar survives Electron ABI upgrades, is crash-isolated, and supports
// GGUF + optional GPU without rebuilding native modules.
//
// Nothing here runs unless the user enables cleanup AND a llama-server binary
// and GGUF model are present (see docs/MODELS.md). If not, the app behaves
// exactly as before.

const { spawn } = require('child_process');
const http = require('http');

function log(...a) { console.log('[llm]', ...a); }

class LlmSidecar {
  constructor({ serverPath, modelPath, mmprojPath, port, threads, ctxSize }) {
    this.serverPath = serverPath;      // path to llama-server binary
    this.modelPath = modelPath;        // path to the GGUF
    this.mmprojPath = mmprojPath;      // optional (audio/vision projector)
    this.port = port || 8091;
    this.threads = threads || Math.max(1, (require('os').cpus().length || 4) - 1);
    this.ctxSize = ctxSize || 4096;
    this.proc = null;
  }

  async start(timeoutMs = 60000) {
    const args = [
      '-m', this.modelPath,
      '--port', String(this.port),
      '--host', '127.0.0.1',
      '-c', String(this.ctxSize),
      '-t', String(this.threads),
      '--no-webui',
    ];
    if (this.mmprojPath) args.push('--mmproj', this.mmprojPath);
    log('spawn', this.serverPath, args.join(' '));
    this.proc = spawn(this.serverPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc.stdout.on('data', (d) => log(String(d).trim()));
    this.proc.stderr.on('data', (d) => log(String(d).trim()));
    this.proc.on('exit', (code) => log('sidecar exited', code));
    await this._waitHealthy(timeoutMs);
    log('sidecar healthy on', this.port);
  }

  async _waitHealthy(timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const ok = await this._health().catch(() => false);
      if (ok) return;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error('llama-server did not become healthy in time');
  }

  _health() {
    return new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port: this.port, path: '/health', timeout: 1000 },
        (res) => { res.resume(); resolve(res.statusCode === 200); });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
  }

  // OpenAI-compatible chat completion. messages: [{role, content}].
  chat(messages, { temperature = 0, maxTokens = 1024 } = {}) {
    const body = JSON.stringify({
      messages, temperature, max_tokens: maxTokens, stream: false,
    });
    return new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: this.port, path: '/v1/chat/completions',
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            const j = JSON.parse(data);
            resolve(j.choices?.[0]?.message?.content ?? '');
          } catch (e) { reject(e); }
        });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  stop() { if (this.proc) { try { this.proc.kill(); } catch (e) {} this.proc = null; } }
}

module.exports = { LlmSidecar };
