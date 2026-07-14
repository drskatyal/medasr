'use strict';
// Local LLM runtime for the cleanup model, using node-llama-cpp — the inference
// engine ships WITH the app (bundled native binary via npm/electron-builder),
// so the only thing fetched at runtime is the GGUF weights (see provision.js).
//
// Exposes chat(messages, opts) -> string, matching what cleanup.js expects.
// node-llama-cpp v3 is ESM, so we load it with dynamic import() from CJS.

function log(...a) { console.log('[llm]', ...a); }

class LlmEngine {
  constructor({ modelPath, ctxSize } = {}) {
    this.modelPath = modelPath;
    this.ctxSize = ctxSize || 4096;
    this._llama = null;
    this._model = null;
    this._LlamaChatSession = null;
  }

  async load() {
    const mod = await import('node-llama-cpp');
    this._LlamaChatSession = mod.LlamaChatSession;
    this._llama = await mod.getLlama();
    log('loading model', this.modelPath);
    this._model = await this._llama.loadModel({ modelPath: this.modelPath });
    log('model loaded');
    return this;
  }

  // messages: [{role:'system'|'user', content}]. Stateless: fresh context per call.
  async chat(messages, { temperature = 0, maxTokens = 1024 } = {}) {
    if (!this._model) throw new Error('LLM not loaded');
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    const user = messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
    const context = await this._model.createContext({ contextSize: this.ctxSize });
    try {
      const session = new this._LlamaChatSession({
        contextSequence: context.getSequence(),
        systemPrompt: system || undefined,
      });
      return await session.prompt(user, { temperature, maxTokens });
    } finally {
      try { await context.dispose(); } catch (e) {}
    }
  }

  async stop() {
    try { if (this._model) await this._model.dispose(); } catch (e) {}
    this._model = null;
  }
}

module.exports = { LlmEngine };
