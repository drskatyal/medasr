# Model options — MedASR + mic-off cleanup

Speech-to-text is **only** [Google MedASR](https://huggingface.co/google/medasr)
(`google/medasr`). No other ASR engine is used for the report.

Cleanup models run **after the microphone stops** (push-to-talk) or at the end
of a real-time session. They see **text**, not audio.

> Score ASR with `baseline/metrics.py` (Google’s `normalize()`).

## Speech-to-text

| Model | Notes | License | In the installer |
|-------|-------|---------|------------------|
| **MedASR** | Full healthcare CTC Conformer, int8 ONNX (`medasr.int8.onnx`). Not distilled. | HAI-DEF | **Yes** |

Attribution is required: see `/ATTRIBUTION.md` and `app/NOTICE.md`.

## Cleanup (mic-off)

| Model | Default | License | In the installer |
|-------|---------|---------|------------------|
| **Off** | — | — | — |
| **Qwen3-1.7B** | **Yes** | Apache 2.0 | **Yes** (~1.1 GB) |
| **Gemma 4 E4B** | Optional | [Gemma Terms](https://ai.google.dev/gemma/terms) | **Yes** (~5 GB) |

Pipeline:

```
audio → MedASR (verbatim) → [Qwen or Gemma editor] → type into the focused field
```

The editor prompt is a transcription editor (temperature 0). It must not add
clinical findings. The length-ratio gate in `cleanup.js` drops runaway rewrites.

## What we do not ship as transcription

Vosk, Parakeet, Whisper, Gemma-4-audio-ASR, and distilled MedASR students are
**not** used to write the medical record. Vosk remains an optional always-on
**command** listener only.
