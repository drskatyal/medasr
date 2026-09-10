#!/usr/bin/env python3
"""Distill Google MedASR (LasrForCTC teacher) into a smaller student.

The student keeps the same tokenizer, CTC blank, and mel frontend, so the
Electron app still attributes output to MedASR. Training matches teacher
logits (KL) plus CTC on transcripts when labels exist.

Requires the gated teacher (`huggingface-cli login`) and a GPU for a real run.

    python convert/distill.py --train-jsonl data/train.jsonl --out models/medasr.distill.pt
    python convert/export_onnx.py --from models/medasr.distill.pt --out models/medasr.distill.onnx
    python convert/quantize.py --in models/medasr.distill.onnx --out models/medasr.distill.int8.onnx

JSONL rows: {"audio": "path.wav", "text": "optional transcript"}
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import torch
import torch.nn.functional as F

import _load


def _layer_count(model) -> int:
    enc = model.config.encoder_config
    for attr in ("num_hidden_layers", "num_layers", "n_layers"):
        if hasattr(enc, attr):
            return int(getattr(enc, attr))
    layers = getattr(model, "encoder", None) or getattr(model, "model", None)
    if layers is not None and hasattr(layers, "layers"):
        return len(layers.layers)
    raise RuntimeError("cannot read encoder layer count from MedASR config")


def _set_layer_count(config, n: int) -> None:
    enc = config.encoder_config
    for attr in ("num_hidden_layers", "num_layers", "n_layers"):
        if hasattr(enc, attr):
            setattr(enc, attr, n)


def _encoder_layers(model):
    for obj in (getattr(model, "encoder", None), getattr(model, "model", None), model):
        if obj is None:
            continue
        layers = getattr(obj, "layers", None)
        if layers is not None:
            return layers
        inner = getattr(obj, "encoder", None)
        if inner is not None and hasattr(inner, "layers"):
            return inner.layers
    raise RuntimeError("cannot find encoder.layers on MedASR")


def build_student(teacher, student_layers: int):
    """Same architecture, fewer encoder blocks; copy every Nth teacher layer."""
    from transformers import AutoModelForCTC

    n_t = _layer_count(teacher)
    n_s = student_layers if student_layers > 0 else max(4, n_t // 2)
    n_s = min(n_s, n_t)
    cfg = teacher.config
    _set_layer_count(cfg, n_s)
    cfg._attn_implementation = "eager"
    student = AutoModelForCTC.from_config(cfg)
    student.eval()
    student.config._attn_implementation = "eager"

    t_layers = _encoder_layers(teacher)
    s_layers = _encoder_layers(student)
    # Evenly spaced teacher layers → student (layer-drop distillation).
    src_idx = [
        int(round(i * (n_t - 1) / max(n_s - 1, 1))) if n_s > 1 else 0
        for i in range(n_s)
    ]
    with torch.no_grad():
        missing, unexpected = student.load_state_dict(teacher.state_dict(), strict=False)
        for s, t in zip(s_layers, (t_layers[i] for i in src_idx)):
            s.load_state_dict(t.state_dict())
    print(
        f"Student: {n_s}/{n_t} encoder layers (from teacher indices {src_idx}). "
        f"non-strict load missing={len(missing)} unexpected={len(unexpected)}",
        flush=True,
    )
    return student


def load_rows(jsonl: Path) -> list[dict]:
    rows = []
    with jsonl.open() as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    if not rows:
        raise SystemExit(f"no rows in {jsonl}")
    return rows


def collate(batch, processor, device):
    wavs, texts = [], []
    for row in batch:
        import librosa

        y, _ = librosa.load(row["audio"], sr=16000)
        wavs.append(y)
        texts.append(row.get("text") or "")
    feats = processor(wavs, sampling_rate=16000, return_tensors="pt", padding=True)
    input_features = feats.input_features.to(device)
    labels = None
    if any(texts):
        tok = processor.tokenizer(
            [t or processor.tokenizer.pad_token or "" for t in texts],
            return_tensors="pt",
            padding=True,
        )
        labels = tok.input_ids.to(device)
        labels[labels == processor.tokenizer.pad_token_id] = -100
    return input_features, labels


def kd_loss(student_logits, teacher_logits, temperature: float) -> torch.Tensor:
    t = temperature
    s = F.log_softmax(student_logits / t, dim=-1)
    q = F.softmax(teacher_logits / t, dim=-1)
    # Teacher/student time axes match (same subsample).
    return F.kl_div(s, q, reduction="batchmean") * (t * t)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--train-jsonl", type=Path, required=True)
    ap.add_argument("--out", type=Path, default=Path("models/medasr.distill.pt"))
    ap.add_argument("--student-layers", type=int, default=0,
                    help="0 = half of teacher encoder layers")
    ap.add_argument("--epochs", type=int, default=1)
    ap.add_argument("--batch-size", type=int, default=1)
    ap.add_argument("--lr", type=float, default=2e-5)
    ap.add_argument("--kd-temp", type=float, default=2.0)
    ap.add_argument("--kd-weight", type=float, default=0.7)
    ap.add_argument("--ctc-weight", type=float, default=0.3)
    ap.add_argument("--max-steps", type=int, default=0, help="0 = full epoch(s)")
    ap.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    args = ap.parse_args()
    args.out.parent.mkdir(parents=True, exist_ok=True)

    print("Loading MedASR teacher (google/medasr)…", flush=True)
    teacher, processor = _load.load_model_and_processor()
    teacher.to(args.device)
    for p in teacher.parameters():
        p.requires_grad_(False)
    teacher.eval()

    student = build_student(teacher, args.student_layers)
    student.to(args.device)
    student.train()

    rows = load_rows(args.train_jsonl)
    opt = torch.optim.AdamW((p for p in student.parameters() if p.requires_grad), lr=args.lr)

    step = 0
    for epoch in range(args.epochs):
        for i in range(0, len(rows), args.batch_size):
            batch = rows[i : i + args.batch_size]
            try:
                feats, labels = collate(batch, processor, args.device)
            except Exception as e:
                print(f"skip batch: {e}", flush=True)
                continue
            with torch.no_grad():
                t_out = teacher(input_features=feats).logits
            s_out = student(input_features=feats).logits
            # Match time if one side padded differently.
            t_len = min(t_out.size(1), s_out.size(1))
            loss = args.kd_weight * kd_loss(s_out[:, :t_len], t_out[:, :t_len], args.kd_temp)
            if labels is not None and args.ctc_weight > 0:
                ctc = student(input_features=feats, labels=labels).loss
                if ctc is not None and torch.isfinite(ctc):
                    loss = loss + args.ctc_weight * ctc
            if not torch.isfinite(loss):
                print("non-finite loss, skip", flush=True)
                continue
            opt.zero_grad(set_to_none=True)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(student.parameters(), 1.0)
            opt.step()
            step += 1
            if step % 10 == 0 or step == 1:
                print(f"epoch {epoch+1} step {step} loss {float(loss):.4f}", flush=True)
            if args.max_steps and step >= args.max_steps:
                break
        if args.max_steps and step >= args.max_steps:
            break

    payload = {
        "state_dict": student.state_dict(),
        "config": student.config.to_dict(),
        "teacher": _load.MODEL_ID,
        "student_layers": _layer_count(student),
        "attribution": "Distilled from Google MedASR (google/medasr), HAI-DEF.",
    }
    torch.save(payload, args.out)
    print(f"Wrote {args.out} ({args.out.stat().st_size / 1e6:.1f} MB)")
    print("Next: convert/export_onnx.py --from this checkpoint, then quantize.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
