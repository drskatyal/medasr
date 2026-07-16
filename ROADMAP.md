# MedASR → local/Electron: roadmap & status

Tracks the phased build plan plus corrections discovered while inspecting the
actual model and repo. See `LICENSING_NOTES.md` for the Phase 5 blocker.

## Status

All code below is **written, syntax-checked, and unit-tested where runnable
without the gated weights** (FFT/log-mel, CTC decode, and WER math all pass).
Anything that needs the actual model runs on your machine — see `RUNBOOK.md`.

| Phase | State | Notes |
|-------|-------|-------|
| 0 — Baseline | **Harness built** (`baseline/`) | WER math validated. Run locally, commit `baseline/results.json`. |
| 1 — Quantization | **Scripts built** (`convert/quantize.py`) | Dynamic int8 (ship) + static QDQ (production) paths, per Grok's Conformer review. |
| 2 — ONNX conversion | **Scripts built** (`convert/export_onnx.py`, `_load.py`, `verify_*`) | Export informed by reading the real `Lasr*` source: RoPE/depthwise-conv/BN/LN — all ONNX-friendly. Hub-kernel disable + eager + explicit-pad handled. |
| 3 — Streaming tuning | **Harness built** (`streaming/stream_harness.py`) | Chunk+overlap+logit-stitch grid; Grok's 2.0s body / 0.8s overlap / discard-14 defaults. |
| 4 — Electron app | **Scaffold built** (`app/`) | Wispr-Flow-style: global hotkey → mic → on-device ONNX → type-anywhere. Pure-JS log-mel + CTC decode (unit-tested). Not yet run in a real Electron process (needs local `npm install`). |
| — Distribution | **Server built** (`server/`) | Railway release + `electron-updater` feed server; token-protected uploads. |
| 5 — Open source | **Blocked / re-scope** | Model weights are HAI-DEF, not Apache 2.0. See `LICENSING_NOTES.md`. |

### What's verified in-container vs. needs your machine
- ✅ Verified here: JS syntax (all files), FFT/log-mel correctness (tone lands in
  right mel band), CTC decode (collapse/blank/space), WER math.
- 🖥️ Needs local run (gated weights + torch + Electron): ONNX export, quantization,
  parity, onnxruntime-node load, the Electron app end-to-end, installer builds.

## Corrections to the original plan (important)

**1. MedASR is a CTC Conformer, not a seq2seq/Whisper-style model.**
It loads via `AutoModelForCTC` with custom `Lasr*` classes (`LasrTokenizer`,
`LasrCtcBeamSearchDecoder`) from a *pinned* `transformers` commit
(`65dc261...`). Consequences:
- Decoding is CTC argmax (+ optional pyctcdecode/KenLM beam search), **not**
  autoregressive `generate()`. Streaming is simpler than Whisper (no decoder
  loop) — good news for Phase 3.
- Phase 2 ONNX export is about the **encoder + CTC head**, not an
  encoder-decoder pair. `optimum`'s generic ASR export assumes Whisper-like
  seq2seq; expect to export with `torch.onnx.export` directly and handle
  Conformer ops (relative positional attention, depthwise conv) yourself, as
  the plan's Phase 2 warning anticipates. The custom `Lasr*` classes are the
  part most likely to fight the exporter.

**2. Quantization path.** Because it's CTC, `optimum`'s `ORTQuantizer`
dynamic-int8 flow still applies once you have a clean ONNX graph, but the
`optimum-cli export onnx` convenience path may not recognize the custom
architecture — budget for the manual `torch.onnx.export` route from the start.
Keep the final CTC projection in higher precision first if WER regresses
(that's the layer most sensitive to quantization for CTC).

**3. Environment.** The gated download + heavyweight torch install means Phase 0
and later phases run on your dev machine, not in the web/CI container.

## The `metrics.py` contract

Every phase must score with `baseline/metrics.py` (`normalize` + `score`) so
WER deltas across quantization/ONNX/streaming are apples-to-apples with the
Phase 0 number and with Google's upstream eval. Do not fork the normalizer.
