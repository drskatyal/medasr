# Third-party notices

This application’s **source code** is Apache License 2.0 (see `/LICENSE`).
The **speech recognition model** is not.

## Speech recognition — Google MedASR

Dictation is performed on-device by **MedASR**, Google’s healthcare-domain
automatic speech recognition model (`google/medasr`).

- Model card: https://developers.google.com/health-ai-developer-foundations/medasr/model-card
- Hugging Face: https://huggingface.co/google/medasr
- License: [Health AI Developer Foundations (HAI-DEF)](https://developers.google.com/health-ai-developer-foundations/terms)

The quantized int8 ONNX shipped in this installer is a **model derivative** of
MedASR and remains under the HAI-DEF license. It is not Apache 2.0. You must
accept HAI-DEF terms on first launch. We ship the **full** MedASR graph, not a
distilled student.

## Transcript cleanup (optional, after the mic stops)

| Model | Role | License |
|-------|------|---------|
| Qwen3-1.7B (Qwen/Alibaba) | Default editor | Apache 2.0 |
| Gemma 4 E4B (Google DeepMind) | Optional editor | [Gemma Terms of Use](https://ai.google.dev/gemma/terms) |

Cleanup is **text-in / text-out**. It never sees the waveform. MedASR remains
the only speech-to-text engine.

## Other

- ONNX Runtime — MIT (Microsoft)
- Silero VAD — MIT (optional real-time pause detection, not transcription)
