#!/usr/bin/env python3
"""Phase 2 -- export MedASR (LasrForCTC) to ONNX.

Exports `forward(input_features[B,T,128]) -> logits[B,T/4,vocab]` at opset 17
using the legacy tracer (dynamo=False), with Hub kernels disabled and eager
attention forced (see convert/_load.py for why). Verifies the exported graph
contains no custom/PythonOp nodes.

Usage:
    huggingface-cli login            # gated model
    python convert/export_onnx.py --out models/medasr.onnx
"""

from __future__ import annotations

import argparse
from pathlib import Path

import torch

import _load


def check_graph_is_clean(onnx_path: str) -> list[str]:
    """Return a list of suspicious (non-standard) op types found in the graph."""
    import onnx

    m = onnx.load(onnx_path)
    suspicious = []
    for node in m.graph.node:
        # Standard ops have empty domain or "ai.onnx"; anything else is custom.
        if node.domain not in ("", "ai.onnx", "ai.onnx.ml"):
            suspicious.append(f"{node.op_type} (domain={node.domain})")
        if node.op_type in ("PythonOp", "ATen", "prim::PythonOp"):
            suspicious.append(node.op_type)
    return suspicious


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", type=Path, default=Path("models/medasr.onnx"))
    ap.add_argument("--opset", type=int, default=17)
    ap.add_argument("--dummy-mel-frames", type=int, default=400,
                    help="Dummy time length for tracing (~4s @ 100 frames/s)")
    ap.add_argument("--no-explicit-pad", action="store_true",
                    help="Keep depthwise 'same' padding instead of explicit F.pad")
    args = ap.parse_args()
    args.out.parent.mkdir(parents=True, exist_ok=True)

    print("Loading model (first run downloads gated weights)...", flush=True)
    model, _ = _load.load_model_and_processor()

    if not args.no_explicit_pad:
        n = _load.patch_depthwise_explicit_padding(model)
        print(f"Patched {n} depthwise conv modules to explicit padding.")

    wrapped = _load.LogitsWrapper(model).eval()
    dummy = torch.randn(1, args.dummy_mel_frames, model.config.encoder_config.num_mel_bins)

    print(f"Exporting to {args.out} (opset {args.opset}, dynamo=False)...", flush=True)
    with torch.no_grad():
        torch.onnx.export(
            wrapped,
            (dummy,),
            str(args.out),
            input_names=["input_features"],
            output_names=["logits"],
            dynamic_axes={"input_features": {1: "time"}, "logits": {1: "time_div4"}},
            opset_version=args.opset,
            do_constant_folding=True,
            dynamo=False,
        )

    suspicious = check_graph_is_clean(str(args.out))
    if suspicious:
        print("\n*** WARNING: non-standard ops in graph (Hub kernel likely leaked):")
        for s in sorted(set(suspicious)):
            print(f"    - {s}")
        print("Fix: `pip uninstall kernels`, ensure DISABLE_KERNELS=1, re-export.")
        return 2

    size_mb = args.out.stat().st_size / 1e6
    print(f"\nOK: exported clean graph, {size_mb:.1f} MB -> {args.out}")
    print("Next: convert/quantize.py, then convert/verify_parity.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
