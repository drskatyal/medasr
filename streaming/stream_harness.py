#!/usr/bin/env python3
"""Phase 3 -- streaming/latency tuning harness for MedASR.

Simulates live audio by feeding a file through the ONNX model in fixed windows
(body + left/right overlap), stitches the per-window logits (dropping edge
encoder frames), greedy-decodes once, and reports WER vs a reference plus the
average per-chunk inference latency. Sweeps a grid of (chunk_body, overlap)
so you can pick the accuracy/latency tradeoff.

Reuses baseline/metrics.py so WER is comparable to the Phase 0 baseline.

Usage:
    python streaming/stream_harness.py \
        --onnx models/medasr.int8.onnx --assets app/assets \
        --audio sample.wav --reference "ground truth ..." \
        --bodies 1 2 3 --overlaps 0.2 0.5 0.8
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "baseline"))
import metrics  # noqa: E402

SR = 16000
ENC_FPS = 25  # encoder frames per second (mel hop 10ms, subsample /4)


def load_assets(assets: Path):
    fc = json.loads((assets / "feature_config.json").read_text())
    mf = json.loads((assets / "mel_filterbank.json").read_text())
    vocab = json.loads((assets / "vocab.json").read_text())
    mel = np.array(mf["data"], dtype=np.float64).reshape(mf["shape"])
    return fc, mel, vocab


def log_mel(pcm: np.ndarray, fc: dict, mel: np.ndarray) -> np.ndarray:
    win, hop, nfft = fc["win_length"], fc["hop_length"], fc["n_fft"]
    if len(pcm) < win:
        return np.zeros((0, mel.shape[1]), dtype=np.float32)
    window = np.hanning(win) if False else _hann_nonperiodic(win)
    n = 1 + (len(pcm) - win) // hop
    frames = np.stack([pcm[i * hop:i * hop + win] * window for i in range(n)])
    spec = np.fft.rfft(frames, n=nfft)
    power = np.abs(spec) ** 2
    m = np.log(np.clip(power @ mel, 1e-5, None))
    return m.astype(np.float32)


def _hann_nonperiodic(N: int) -> np.ndarray:
    n = np.arange(N)
    return 0.5 - 0.5 * np.cos(2 * np.pi * n / (N - 1))


def greedy_ctc(logits: np.ndarray, vocab: dict) -> str:
    ids = logits.argmax(-1)
    pieces, blank, space = vocab["id_to_piece"], vocab["blank_id"], vocab["space_piece"]
    out, prev = [], -1
    for i in ids:
        if i == prev:
            continue
        prev = i
        if i == blank:
            continue
        p = pieces[i]
        if p is None or (p.startswith("<") and p.endswith(">")):
            continue
        out.append(p)
    return "".join(out).replace(space, " ").strip()


def run_stream(sess, pcm, fc, mel, vocab, body_s, overlap_s, discard_frames):
    body, ctx = int(body_s * SR), int(overlap_s * SR)
    stitched, latencies = [], []
    for start in range(0, len(pcm), body):
        frm, to = max(0, start - ctx), min(len(pcm), start + body + ctx)
        feats = log_mel(pcm[frm:to], fc, mel)
        if feats.shape[0] == 0:
            continue
        t0 = time.perf_counter()
        logits = sess.run(["logits"], {"input_features": feats[None]})[0][0]
        latencies.append(time.perf_counter() - t0)
        d_left = 0 if start == 0 else discard_frames
        d_right = 0 if to >= len(pcm) else discard_frames
        stitched.append(logits[d_left: logits.shape[0] - d_right])
    if not stitched:
        return "", 0.0
    return greedy_ctc(np.concatenate(stitched, axis=0), vocab), float(np.mean(latencies))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--onnx", type=Path, required=True)
    ap.add_argument("--assets", type=Path, default=Path("app/assets"))
    ap.add_argument("--audio", type=Path, required=True)
    ap.add_argument("--reference", type=str, required=True)
    ap.add_argument("--bodies", type=float, nargs="+", default=[1.0, 2.0, 3.0])
    ap.add_argument("--overlaps", type=float, nargs="+", default=[0.2, 0.5, 0.8])
    ap.add_argument("--discard-frames", type=int, default=14)
    args = ap.parse_args()

    import librosa
    import onnxruntime as ort

    fc, mel, vocab = load_assets(args.assets)
    pcm, _ = librosa.load(str(args.audio), sr=SR)
    sess = ort.InferenceSession(str(args.onnx), providers=["CPUExecutionProvider"])

    print(f"{'body(s)':>8} {'ovlp(s)':>8} {'WER%':>8} {'chunk_ms':>10}")
    rows = []
    for b in args.bodies:
        for o in args.overlaps:
            hyp, lat = run_stream(sess, pcm, fc, mel, vocab, b, o, args.discard_frames)
            wer = metrics.score_one(args.reference, hyp).wer_pct
            rows.append({"body_s": b, "overlap_s": o, "wer_pct": round(wer, 2),
                         "chunk_latency_ms": round(lat * 1000, 1)})
            print(f"{b:>8.1f} {o:>8.2f} {wer:>8.2f} {lat * 1000:>10.1f}")

    out = Path("streaming/grid_results.json")
    out.write_text(json.dumps(rows, indent=2))
    print(f"\nWrote {out}. Pick the lowest overlap whose WER stays near baseline.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
