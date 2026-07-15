'use strict';
// Local LLM runtime for the cleanup model, using node-llama-cpp — the inference
// engine ships WITH the app (bundled native binary via npm/electron-builder),
// so the only thing fetched at runtime is the GGUF weights (see provision.js).
//
// Exposes chat(messages, opts) -> string, matching what cleanup.js expects.
// node-llama-cpp v3 is ESM, so we load it with dynamic import() from CJS.

function log(...a) { console.log('[llm]', ...a); }

class LlmEngine {
  constructor({ modelPath, ctxSize, gpu, modelId } = {}) {
    this.modelPath = modelPath;
    this.modelId = modelId || '';     // catalog id (e.g. 'qwen3-1.7b') — lets callers adapt per model family
    this.ctxSize = ctxSize || 4096;   // enough for a dictation report; smaller = faster KV alloc
    this.gpu = gpu;                   // 'auto' (default) | 'vulkan' | 'cuda' | 'metal' | 'off'
    this._llama = null;
    this._model = null;
    this._context = null;             // persistent context (KV cache) — reused across calls
    this._LlamaChatSession = null;
    this.backend = 'cpu';             // resolved GPU backend actually in use (or 'cpu')
    this.gpuLayers = 0;
  }

  async load() {
    const mod = await import('node-llama-cpp');
    this._LlamaChatSession = mod.LlamaChatSession;
    // Pick the GPU backend: 'off' -> CPU; else let node-llama-cpp auto-detect
    // (Vulkan on Intel Arc / AMD, CUDA on NVIDIA, Metal on macOS). Falls back to
    // CPU cleanly if no usable GPU / the binary lacks that backend.
    const pref = this.gpu === 'off' || this.gpu === false ? false : (this.gpu && this.gpu !== 'auto' ? this.gpu : 'auto');
    try {
      this._llama = await mod.getLlama({ gpu: pref });
    } catch (e) {
      log('GPU init failed, using CPU:', e && e.message || e);
      this._llama = await mod.getLlama({ gpu: false });
    }
    this.backend = this._llama.gpu || 'cpu';
    log('backend =', this.backend, this.backend === 'cpu' ? '(no GPU — cleaning will be slower; run: npx node-llama-cpp download --gpu vulkan)' : '(GPU acceleration on)');
    // With a GPU present, offload the whole small model; node-llama-cpp clamps to
    // what fits and spills the rest to CPU.
    this._model = await this._llama.loadModel({
      modelPath: this.modelPath,
      gpuLayers: this._llama.gpu ? undefined : 0,   // undefined = auto-offload-max
    });
    try { this.gpuLayers = this._model.gpuLayers ?? 0; } catch (e) {}
    log('model loaded on', this.backend, '(gpuLayers:', this.gpuLayers, ')');
    // Create the context (KV cache) ONCE and reuse it — allocating it per call
    // was a big chunk of the correction latency. Then warm up so the FIRST real
    // cleanup isn't a cold start (kernels compiled, weights paged to the GPU).
    this._context = await this._model.createContext({ contextSize: this.ctxSize });
    try {
      const t0 = Date.now();
      const seq = this._context.getSequence();
      const warm = new this._LlamaChatSession({ contextSequence: seq });
      await warm.prompt('Ready.', { maxTokens: 1, temperature: 0 });
      try { seq.dispose(); } catch (e) {}
      log('cleanup engine warmed up in', Date.now() - t0, 'ms');
    } catch (e) { log('warm-up skipped:', e && e.message || e); }
    return this;
  }

  info() { return { backend: this.backend, gpuLayers: this.gpuLayers }; }

  // messages: [{role:'system'|'user', content}]. Stateless per call, but reuses
  // the persistent context — only a lightweight sequence is created/freed.
  async chat(messages, { temperature = 0, maxTokens = 1024 } = {}) {
    if (!this._context) throw new Error('LLM not loaded');
    const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    const user = messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
    const seq = this._context.getSequence();
    try {
      const session = new this._LlamaChatSession({
        contextSequence: seq,
        systemPrompt: system || undefined,
      });
      return await session.prompt(user, { temperature, maxTokens });
    } finally {
      try { seq.dispose(); } catch (e) {}   // free the slot; keep the context
    }
  }

  async stop() {
    try { if (this._context) await this._context.dispose(); } catch (e) {}
    try { if (this._model) await this._model.dispose(); } catch (e) {}
    this._context = null; this._model = null;
  }
}

module.exports = { LlmEngine };
