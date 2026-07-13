#!/usr/bin/env python3
"""Verify the ONNX (and/or int8) graph matches the PyTorch model numerically.

Runs the same random/real input through HF PyTorch and ONNX Runtime and reports
max-abs and cosine similarity on logits, plus whether the greedy CTC argmax
sequences agree. Run this right after export/quantize, before touching Electron.

Usage:
    python convert/verify_parity.py --onnx models/medasr.onnx
    python convert/verify_parity.py --onnx models/medasr.int8.onnx --audio sample.wav
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import torch

import _load


def cosine(a: np.ndarray, b: np.ndarray) -> float:
    a, b = a.flatten(), b.flatten()
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-12))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--onnx", type=Path, required=True)
    ap.add_argument("--audio", type=Path, help="16kHz wav; else uses random features")
    args = ap.parse_args()

    model, processor = _load.load_model_and_processor()
    _load.patch_depthwise_explicit_padding(model)
    wrapped = _load.LogitsWrapper(model).eval()

    if args.audio:
        import librosa

        speech, _ = librosa.load(str(args.audio), sr=processor.feature_extractor.sampling_rate)
        feats = processor.feature_extractor(
            speech, sampling_rate=processor.feature_extractor.sampling_rate, return_tensors="pt"
        ).input_features
    else:
        feats = torch.randn(1, 400, model.config.encoder_config.num_mel_bins)

    with torch.no_grad():
        torch_logits = wrapped(feats).cpu().numpy()

    import onnxruntime as ort

    sess = ort.InferenceSession(str(args.onnx), providers=["CPUExecutionProvider"])
    onnx_logits = sess.run(["logits"], {"input_features": feats.cpu().numpy().astype(np.float32)})[0]

    max_abs = float(np.max(np.abs(torch_logits - onnx_logits)))
    cos = cosine(torch_logits, onnx_logits)
    torch_ids = torch_logits.argmax(-1).flatten()
    onnx_ids = onnx_logits.argmax(-1).flatten()
    argmax_agree = float((torch_ids == onnx_ids).mean())

    print(f"logits shape: torch {torch_logits.shape}  onnx {onnx_logits.shape}")
    print(f"max abs diff: {max_abs:.4e}")
    print(f"cosine sim:   {cos:.6f}")
    print(f"argmax agree: {argmax_agree * 100:.2f}% of frames")
    ok = cos > 0.999 and argmax_agree > 0.99
    print("PASS" if ok else "CHECK: parity lower than expected (int8 loosens this; verify WER)")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
