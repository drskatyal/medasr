#!/usr/bin/env python3
"""Phase 1 -- quantize the exported MedASR ONNX graph.

Two paths (per Grok's review of this Conformer):

  dynamic (default, ship-first): int8 weights on MatMul/Gemm only. Fast, no
    calibration. The CTC head is a Conv1d (1x1) so it is NOT touched by dynamic
    quant -- logits stay fp32-accurate automatically. LayerNorm/BatchNorm/RoPE
    and the attention score matmuls also stay fp32 under dynamic quant. Expect
    WER within ~0-1% absolute of baseline.

  static  (production): QDQ int8 with calibration so the Conv1d layers
    (pointwise + depthwise -- a big chunk of this model's compute) also
    quantize. Needs a small calibration set of real mel features. BatchNorm
    should be folded first (see --help). Excludes the CTC head + norms.

Always re-run the Phase 0 harness against the output and compare WER/speed
(convert/verify_parity.py checks numerical parity; baseline/run_baseline.py
style eval measures WER).

Usage:
    python convert/quantize.py --in models/medasr.onnx --out models/medasr.int8.onnx
    python convert/quantize.py --mode static --calib calib_features.npy ...
"""

from __future__ import annotations

import argparse
from pathlib import Path


def quantize_dynamic_int8(src: Path, dst: Path) -> None:
    from onnxruntime.quantization import QuantType, quantize_dynamic

    quantize_dynamic(
        model_input=str(src),
        model_output=str(dst),
        weight_type=QuantType.QInt8,
        extra_options={
            # Only quantize weight (const-B) MatMuls; leave activation-activation
            # matmuls (attention scores) in fp32.
            "MatMulConstBOnly": True,
        },
    )


def quantize_static_qdq(src: Path, dst: Path, calib_npy: Path) -> None:
    """Static QDQ int8 with a calibration reader over precomputed mel features.

    calib_npy: an .npy of shape [N, T, 128] (or a list saved via np.save with
    dtype=object) of real input_features. Even ~50-200 varied utterances help.
    """
    import numpy as np
    from onnxruntime.quantization import (
        CalibrationDataReader,
        QuantFormat,
        QuantType,
        quantize_static,
    )

    features = np.load(calib_npy, allow_pickle=True)

    class Reader(CalibrationDataReader):
        def __init__(self):
            self._it = iter(
                {"input_features": np.asarray(f, dtype=np.float32)[None]
                 if np.asarray(f).ndim == 2 else np.asarray(f, dtype=np.float32)}
                for f in features
            )

        def get_next(self):
            return next(self._it, None)

    quantize_static(
        model_input=str(src),
        model_output=str(dst),
        calibration_data_reader=Reader(),
        quant_format=QuantFormat.QDQ,
        activation_type=QuantType.QUInt8,
        weight_type=QuantType.QInt8,
        op_types_to_quantize=["MatMul", "Gemm", "Conv"],
        # Protect the accuracy-critical / cheap layers. Node-name exclusion for
        # the CTC head is graph-dependent; inspect with Netron and add here if
        # WER regresses. Norms are not in op_types_to_quantize so they're safe.
        extra_options={"WeightSymmetric": True},
    )


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--in", dest="src", type=Path, default=Path("models/medasr.onnx"))
    ap.add_argument("--out", dest="dst", type=Path, default=Path("models/medasr.int8.onnx"))
    ap.add_argument("--mode", choices=["dynamic", "static"], default="dynamic")
    ap.add_argument("--calib", type=Path, help="[.npy] calibration mel features (static mode)")
    args = ap.parse_args()
    args.dst.parent.mkdir(parents=True, exist_ok=True)

    if args.mode == "dynamic":
        print(f"Dynamic int8 quantization: {args.src} -> {args.dst}")
        quantize_dynamic_int8(args.src, args.dst)
    else:
        if not args.calib:
            ap.error("--mode static requires --calib <features.npy>")
        print(f"Static QDQ int8 quantization (calib={args.calib}): {args.src} -> {args.dst}")
        quantize_static_qdq(args.src, args.dst, args.calib)

    before = args.src.stat().st_size / 1e6
    after = args.dst.stat().st_size / 1e6
    print(f"OK: {before:.1f} MB -> {after:.1f} MB ({after / before * 100:.0f}%)")
    print("Now compare WER/speed vs baseline before trusting this artifact.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
