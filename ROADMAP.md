# MedASR → local/Electron: roadmap & status

Tracks the phased build plan plus corrections discovered while inspecting the
actual model and repo. See `LICENSING_NOTES.md` for the Phase 5 blocker.

## Status

| Phase | State | Notes |
|-------|-------|-------|
| 0 — Baseline | **Harness built** (`baseline/`) | Code complete & WER math validated. *Execution requires HF-gated weights + torch/CPU on your machine* — cannot run in the CI/web container (no GPU, no HF token). Run locally and commit `baseline/results.json`. |
| 1 — Quantization | Not started | See correction #2 below. |
| 2 — ONNX conversion | Not started | See correction #1 below — this is the real risk area. |
| 3 — Streaming tuning | Not started | Reuse chunk/stride knobs surfaced in `run_baseline.py`. |
| 4 — Electron app | Not started | — |
| 5 — Open source | **Blocked / re-scope** | Model weights are HAI-DEF, not Apache 2.0. See `LICENSING_NOTES.md`. |

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
