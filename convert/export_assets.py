#!/usr/bin/env python3
"""Export the non-weight assets the Node app needs to run without Python:

  - mel_filterbank.json : the [257 x 128] linear->mel matrix (kaldi scale,
    125-7500 Hz) so JS log-mel exactly matches LasrFeatureExtractor.
  - feature_config.json  : STFT params (sr, hop, n_fft, win, hann non-periodic).
  - vocab.json           : id -> token piece (for greedy CTC decode in JS).
  - model_meta.json      : blank id, subsample factor, encoder frame rate, etc.

Writes into app/assets/ by default.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import _load


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", type=Path, default=Path("app/assets"))
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    _, processor = _load.load_model_and_processor()
    fe = processor.feature_extractor
    tok = processor.tokenizer

    # 1. mel filterbank (torch tensor [num_spectrogram_bins, num_mel_bins])
    mel = fe.mel_filters.cpu().numpy().astype("float64")
    (args.out / "mel_filterbank.json").write_text(json.dumps({
        "shape": list(mel.shape),
        "data": mel.flatten().tolist(),
    }))

    # 2. feature extractor params
    (args.out / "feature_config.json").write_text(json.dumps({
        "sampling_rate": fe.sampling_rate,
        "hop_length": fe.hop_length,
        "n_fft": fe.n_fft,
        "win_length": fe.win_length,
        "num_mel_bins": fe.feature_size,
        "window": "hann",
        "periodic": False,
        "power": 2.0,
        "log_clamp_min": 1e-5,
        "note": "frames = unfold(win_length, hop_length); rfft(n=n_fft); |.|^2; @mel; log(clamp).",
    }, indent=2))

    # 3. vocab id -> piece (ordered by id)
    vocab = tok.get_vocab()  # piece -> id
    id_to_piece = [None] * (max(vocab.values()) + 1)
    for piece, idx in vocab.items():
        id_to_piece[idx] = piece
    (args.out / "vocab.json").write_text(json.dumps({
        "id_to_piece": id_to_piece,
        "space_piece": "▁",
        "blank_id": _load.BLANK_ID,
    }))

    # 4. model meta
    (args.out / "model_meta.json").write_text(json.dumps({
        "model_id": _load.MODEL_ID,
        "blank_id": _load.BLANK_ID,
        "subsample_factor": _load.SUBSAMPLE_FACTOR,
        "encoder_frames_per_s": _load.ENCODER_FRAMES_PER_S,
        "mel_frames_per_s": _load.MEL_FRAMES_PER_S,
        "vocab_size": len(id_to_piece),
    }, indent=2))

    print(f"Wrote assets to {args.out}:")
    for f in sorted(args.out.glob("*.json")):
        print(f"  {f.name}  ({f.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
