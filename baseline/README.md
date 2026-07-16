# Phase 0 — Baseline

Establishes the two reference numbers every later optimization (quantization,
ONNX conversion, streaming) is compared against:

1. **WER** — via `jiwer`, using Google's exact normalization (`metrics.py`), so
   numbers are directly comparable to the upstream notebook's eval cells.
2. **Speed** — wall-clock inference expressed as **RTF** (real-time factor;
   `< 1.0` = faster than real-time) and **seconds of compute per minute of
   audio**, measured on *your* dev machine's CPU.

> Without this baseline you cannot tell whether a later step (e.g. int8
> quantization) traded away accuracy. Run it first, commit `results.json`.

## Prerequisites

The `google/medasr` model is **gated** and its weights are under the **Health
AI Developer Foundations (HAI-DEF) license — not Apache 2.0** (only this
repo's *code* is Apache 2.0). You must:

1. Accept the license at <https://huggingface.co/google/medasr>.
2. Authenticate: `huggingface-cli login` (or `export HF_TOKEN=hf_...`).

See `../LICENSING_NOTES.md` before packaging or redistributing any converted
or quantized derivative.

## Install

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r baseline/requirements.txt
```

`transformers` is pinned to the commit the model card requires (custom `Lasr*`
classes); do not bump it blindly.

## Run

```bash
# Quick check against the single sample bundled in the gated repo:
python baseline/run_baseline.py --download-sample --warmup

# Real baseline against your own 5-file test set:
cp baseline/manifest.example.json baseline/manifest.json
# edit manifest.json: absolute audio paths + verbatim ground-truth transcripts
python baseline/run_baseline.py --manifest baseline/manifest.json --warmup
```

Output goes to `baseline/results.json` and is also printed to the terminal.

## What it measures / knobs

- Uses the HF `pipeline` path from the model card with the shipped batch
  defaults `chunk_length_s=20`, `stride_length_s=2`. These are deliberately the
  *file* defaults — Phase 3 tunes them down for live dictation. Override with
  `--chunk-length-s` / `--stride-length-s` if you want to sanity-check.
- `--warmup` runs one throwaway inference so timing excludes lazy CUDA/graph
  init. Recommended for a fair speed number.

## Files

| File | Purpose |
|------|---------|
| `run_baseline.py` | Harness: runs the pipeline, times it, scores WER, writes `results.json`. |
| `metrics.py` | Google's exact `normalize()` + corpus/per-utterance WER via `jiwer`. Reused by all later phases so comparisons stay apples-to-apples. |
| `manifest.example.json` | Template for your test set. |
| `results.json` | Produced by a run (git-ignored by default — commit intentionally once you have a real baseline). |
