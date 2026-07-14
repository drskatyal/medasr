# Model options — STT engines & cleanup LLMs

The app is designed around **pluggable engines**: a speech-to-text engine +
an optional local **cleanup LLM**. This doc records the candidates, their
on-device feasibility (as of mid-2026), licenses, and how to choose.

> **How we decide, not guess:** run the candidates through `baseline/metrics.py`
> on your own medical audio and compare WER. The Phase-0 harness already does
> exactly this — same normalization Google uses, so the numbers are comparable.

## Speech-to-text (STT) engines

| Model | Params | Medical? | Streaming | On-device runtime | License | Status here |
|-------|--------|----------|-----------|-------------------|---------|-------------|
| **MedASR** (`google/medasr`) | ~120M CTC | ✅ tuned | ❌ (bidirectional) | onnxruntime-node ✅ | HAI-DEF (gated) | **Shipping** |
| **Parakeet-TDT-0.6B-EN-Medical** (`yuriyvnv/…`) | 0.6B | ✅ tuned | ✅ fast | NeMo / ONNX | Apache-lineage | **Top eval candidate** — fast + medical + open |
| **Whisper-small-medical** (`oegbo/…`) | 244M | ✅ tuned | ~chunked | whisper.cpp / ONNX ✅ | MIT (Whisper) | Eval candidate (watch silence-hallucination) |
| **Gemma 4 E4B/12B (audio)** | 4B/12B | general | ~30s calls | llama.cpp (mmproj, BF16) ✅ (since Jun 2026) | Apache 2.0 | Alt "single-call" engine (audio→formatted text) |
| **Voxtral Mini 3B** (`mistralai/Voxtral-Mini-3B-2507`) | 3B | general | ❌ batch | llama.cpp (GGUF + audio) ✅ | Apache 2.0 | Feasible alt engine (multilingual, on-device) |
| **Voxtral Realtime 4B** | 4B | general | ✅ <200ms | **vLLM only** (not llama.cpp yet) | Apache 2.0 | **Deferred** — no desktop-friendly runtime yet |

Notes:
- **Parakeet-medical** is the most promising *alternative* to MedASR: NVIDIA
  Parakeet TDT is among the fastest ASR models, and this variant is
  medically fine-tuned + English. If its medical WER matches MedASR, its
  speed/streaming/license make it a strong default.
- **Gemma 4 audio** can transcribe *and* format in one call. Good for a general
  dictation mode; for the **medical record** keep transcription (faithful STT)
  separate from formatting (constrained editor) to bound hallucination risk.
- **Voxtral Realtime** is genuinely great for streaming but is vLLM-only today;
  revisit when llama.cpp support lands (tracking issues open upstream).

## Cleanup LLMs (text → corrected/formatted text)

| Model | Active/Total | Why | RAM (Q4) | CPU speed | License | Pick |
|-------|--------------|-----|----------|-----------|---------|------|
| **LFM2.5-8B-A1B** (`LiquidAI/…`) | 1.5B / 8.3B MoE | IFEval 91.84, non-halluc 63.47, ~6GB, very fast | ~6 GB | 146–253 tok/s | LFM 1.0 (commercial ok) | **Default** |
| **Gemma 4 E4B** | 4.5B eff | Strong general editor, fully open | ~4–5 GB | 8–25 tok/s (x64) | Apache 2.0 | Open-source default |
| **MedGemma 1.5 4B** | 4B | Best medical surface-form repair | ~3.5–5 GB | 8–25 tok/s | HAI-DEF (gated) | Opt-in "medical mode" |
| **Qwen3-0.6B** | 0.6B | Ultra-fast, light tidy only (weak) | ~1 GB | very fast | Apache 2.0 | Ultra-light mode |

**Recommendation:** default **LFM2.5-8B-A1B** (best quality/latency/RAM +
commercial license + strong non-hallucination). Offer **Gemma 4 E4B** for a
fully-Apache build and **MedGemma** as opt-in for users who accept its license.
Qwen3-0.6B only for very low-power machines.

## How to enable cleanup in the app

**Now fully automatic** — no manual downloads or paths:

1. The inference engine (`node-llama-cpp`) **ships with the app**, so there's no
   `llama-server` binary to install.
2. In the settings window, pick a **Cleaning pipeline** (default **LFM2.5-8B-A1B**)
   and Save. The first time cleaning runs, the app **downloads the GGUF weights
   once (~a few GB) and caches** them in the app's data dir
   (`userData/models/`). The orb shows `downloading… %`, then it's ready forever.
3. Default is **off** (for latency); turning it on triggers the one-time download.

Weight sources are in `app/src/main/provision.js` (Hugging Face repos). MedGemma
is gated — set `HF_TOKEN` in the environment for that one. Advanced users can
point `llmModelPath` at their own GGUF to skip the download.

> Why download-on-first-use instead of bundling weights in the installer? A 5 GB
> installer is painful to ship/update; caching after one download gives the same
> "just works" feel with a small installer. A fully-bundled offline build is
> possible later for air-gapped/enterprise deployments.

## Safety (medical)

The cleanup prompt (`app/src/main/cleanup.js`) is a **strict transcription
editor**, temperature 0, output-length capped — it must never add/remove
clinical content. **Next step:** surface raw-vs-cleaned as a **diff the user
accepts**, and add a fabrication-rate eval gate, before any silent auto-commit.

## Sources
- Gemma 4 audio in llama.cpp: PR #24118 / #21421 (ggml-org/llama.cpp)
- Voxtral Realtime = vLLM-only: llama.cpp issues #19696, #20914
- LFM2.5-8B-A1B: liquid.ai/blog/lfm2-5-8b-a1b ; artificialanalysis.ai
- Qwen3-0.6B: huggingface.co/Qwen/Qwen3-0.6B
- Parakeet-medical: huggingface.co/yuriyvnv/parakeet-tdt-0.6b-EN-Medical
- Whisper-small-medical: huggingface.co/oegbo/whisper-small-medical
