#!/usr/bin/env python3
"""Phase 0 -- MedASR baseline harness.

Runs the *stock* ``google/medasr`` model exactly as Google ships it (the HF
``pipeline`` path from the model card) over a set of audio files, then records
two numbers that every later optimization step is compared against:

  1. WER (via jiwer, using Google's own normalization -- see metrics.py)
  2. Wall-clock inference speed, expressed as real-time factor (RTF) and as
     seconds of compute per minute of audio.

Results are written to ``baseline/results.json``.

Usage
-----
    # 1. Authenticate with Hugging Face (the model is GATED -- you must have
    #    accepted the license at https://huggingface.co/google/medasr):
    huggingface-cli login          # or: export HF_TOKEN=hf_...

    # 2. Run against the single bundled sample (auto-downloaded):
    python baseline/run_baseline.py --download-sample

    # 3. Run against your own 5-file test set via a manifest:
    python baseline/run_baseline.py --manifest baseline/manifest.json

Manifest format (JSON): a list of {"audio": <path>, "reference": <text>}.
See manifest.example.json.
"""

from __future__ import annotations

import argparse
import json
import platform
import sys
import time
from pathlib import Path

import metrics

MODEL_ID = "google/medasr"

# Batch-file defaults from Google's model card. Phase 3 will tune these down
# for live/streaming use; the baseline deliberately uses the shipped values.
DEFAULT_CHUNK_LENGTH_S = 20
DEFAULT_STRIDE_LENGTH_S = 2

# The one sample audio + its ground-truth transcript that ship inside the
# gated model repo (from quick_start_with_hugging_face.ipynb).
SAMPLE_FILENAME = "test_audio.wav"
SAMPLE_TRANSCRIPT = (
    "Exam type CT chest PE protocol period. Indication 54 year old female, "
    "shortness of breath, evaluate for PE period. Technique standard protocol "
    "period. Findings colon. Pulmonary vasculature colon. The main PA is patent "
    "period. There are filling defects in the segmental branches of the right "
    "lower lobe comma compatible with acute PE period. No saddle embolus period. "
    "Lungs colon. No pneumothorax period. Small bilateral effusions comma right "
    "greater than left period. New paragraph. Impression colon Acute segmental "
    "PE right lower lobe period."
)


def load_manifest(path: Path) -> list[dict]:
    entries = json.loads(path.read_text())
    if not isinstance(entries, list):
        raise ValueError("Manifest must be a JSON list of {audio, reference} objects")
    for e in entries:
        if "audio" not in e or "reference" not in e:
            raise ValueError(f"Manifest entry missing 'audio' or 'reference': {e}")
    return entries


def download_sample_manifest() -> list[dict]:
    """Download google/medasr's bundled test_audio.wav and return a manifest."""
    import huggingface_hub

    audio_path = huggingface_hub.hf_hub_download(MODEL_ID, SAMPLE_FILENAME)
    return [{"audio": audio_path, "reference": SAMPLE_TRANSCRIPT}]


def audio_duration_seconds(path: str) -> float:
    import librosa

    return float(librosa.get_duration(path=path))


def build_pipeline(device: str):
    from transformers import pipeline

    # device=-1 -> CPU for the HF pipeline convention.
    device_arg = 0 if device == "cuda" else -1
    return pipeline("automatic-speech-recognition", model=MODEL_ID, device=device_arg)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    src = parser.add_mutually_exclusive_group(required=True)
    src.add_argument("--manifest", type=Path, help="Path to a JSON manifest")
    src.add_argument(
        "--download-sample",
        action="store_true",
        help="Use the single test_audio.wav bundled in the gated model repo",
    )
    parser.add_argument(
        "--chunk-length-s", type=float, default=DEFAULT_CHUNK_LENGTH_S
    )
    parser.add_argument(
        "--stride-length-s", type=float, default=DEFAULT_STRIDE_LENGTH_S
    )
    parser.add_argument(
        "--out", type=Path, default=Path(__file__).parent / "results.json"
    )
    parser.add_argument(
        "--warmup",
        action="store_true",
        help="Run one throwaway inference first so timing excludes lazy init",
    )
    args = parser.parse_args()

    import torch

    device = "cuda" if torch.cuda.is_available() else "cpu"

    if args.download_sample:
        entries = download_sample_manifest()
    else:
        entries = load_manifest(args.manifest)

    print(f"Model:  {MODEL_ID}")
    print(f"Device: {device}")
    print(f"Chunk:  chunk_length_s={args.chunk_length_s} "
          f"stride_length_s={args.stride_length_s}")
    print(f"Files:  {len(entries)}")
    print("Loading pipeline (first run downloads weights)...", flush=True)

    pipe = build_pipeline(device)

    if args.warmup:
        print("Warmup inference...", flush=True)
        pipe(entries[0]["audio"],
             chunk_length_s=args.chunk_length_s,
             stride_length_s=args.stride_length_s)

    per_file = []
    references, hypotheses = [], []
    total_audio_s = 0.0
    total_infer_s = 0.0

    for i, e in enumerate(entries, 1):
        audio, reference = e["audio"], e["reference"]
        dur = audio_duration_seconds(audio)

        t0 = time.perf_counter()
        result = pipe(audio,
                      chunk_length_s=args.chunk_length_s,
                      stride_length_s=args.stride_length_s)
        infer_s = time.perf_counter() - t0
        hyp = result["text"]

        wer = metrics.score_one(reference, hyp)
        rtf = infer_s / dur if dur > 0 else float("nan")
        sec_per_min = infer_s / (dur / 60.0) if dur > 0 else float("nan")

        references.append(reference)
        hypotheses.append(hyp)
        total_audio_s += dur
        total_infer_s += infer_s

        print(f"[{i}/{len(entries)}] {Path(audio).name}: "
              f"WER {wer.wer_pct:.2f}%  audio {dur:.1f}s  "
              f"infer {infer_s:.2f}s  RTF {rtf:.3f}")

        per_file.append({
            "audio": str(audio),
            "audio_duration_s": round(dur, 3),
            "inference_s": round(infer_s, 4),
            "rtf": round(rtf, 4),
            "sec_per_min_audio": round(sec_per_min, 4),
            "hypothesis": hyp,
            "reference": reference,
            "wer": wer.as_dict(),
        })

    corpus = metrics.score(references, hypotheses)
    overall_rtf = total_infer_s / total_audio_s if total_audio_s > 0 else float("nan")
    overall_spm = (total_infer_s / (total_audio_s / 60.0)
                   if total_audio_s > 0 else float("nan"))

    try:
        import transformers
        tfm_version = transformers.__version__
    except Exception:
        tfm_version = None

    output = {
        "phase": "0-baseline",
        "model_id": MODEL_ID,
        "device": device,
        "python": platform.python_version(),
        "transformers_version": tfm_version,
        "platform": platform.platform(),
        "backend": "hf-pipeline",
        "chunk_length_s": args.chunk_length_s,
        "stride_length_s": args.stride_length_s,
        "num_files": len(entries),
        "aggregate": {
            "corpus_wer": corpus.as_dict(),
            "total_audio_s": round(total_audio_s, 3),
            "total_inference_s": round(total_infer_s, 4),
            "overall_rtf": round(overall_rtf, 4),
            "overall_sec_per_min_audio": round(overall_spm, 4),
        },
        "per_file": per_file,
    }

    args.out.write_text(json.dumps(output, indent=2))
    print("\n=== BASELINE ===")
    print(f"Corpus WER:         {corpus.wer_pct:.2f}%  "
          f"({corpus.ref_tokens} ref tokens)")
    print(f"Overall RTF:        {overall_rtf:.3f}  "
          f"(< 1.0 means faster than real-time)")
    print(f"Sec / min of audio: {overall_spm:.2f}")
    print(f"Written to:         {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
