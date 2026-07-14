# Parakeet-TDT STT engines (Omi Med STT v1 / Parakeet-medical)

These are NVIDIA **NeMo transducer (TDT)** models — a different decode scheme
than MedASR's CTC — so the app runs them through **sherpa-onnx** (bundled via
`sherpa-onnx-node`), which handles the encoder/decoder/joiner and its own
80-dim log-mel features. The app auto-selects this path when you pick
**Omi Med STT v1** or **Parakeet-medical** in Settings.

## Where the model files go

The app looks for sherpa-onnx transducer files here:

```
<userData>/models/<engineId>/
    encoder.onnx
    decoder.onnx
    joiner.onnx
    tokens.txt
```

- `<userData>` on Windows: `%APPDATA%\MedASR Dictate`
- `<engineId>`: `omi-med-stt` or `parakeet-medical`

If the files are missing, the app notifies you and falls back to MedASR — so
dictation always works.

## Getting the files

### Option 1 — Parakeet base (quickest, to validate the pipeline)
sherpa-onnx publishes ready-to-use Parakeet-TDT models. Download one, unzip,
and drop the four files into `<userData>/models/parakeet-medical/`. This proves
the sherpa-onnx path works end-to-end before you convert the medical model.

### Option 2 — Omi Med STT v1 (the goal: medical + CC-BY-4.0)
Omi ships its own runtime, not sherpa-onnx format, so convert once:

```bash
# 1. Get the model (HF): omi-health Omi Med STT v1 (Parakeet TDT 0.6B v2 base)
# 2. Export the NeMo transducer to ONNX (encoder/decoder/joiner):
pip install nemo_toolkit sherpa-onnx
python -m sherpa_onnx.nemo.export_onnx_transducer \
    --model omi-med-stt.nemo \
    --out-dir omi-med-stt-onnx
#    (or use NeMo's model.export("model.onnx") + sherpa-onnx's conversion script;
#     see the sherpa-onnx NeMo transducer docs for the exact current entrypoint)
# 3. Copy encoder.onnx decoder.onnx joiner.onnx tokens.txt into:
#    <userData>/models/omi-med-stt/
```

Then pick **Omi Med STT v1** in Settings → it loads via sherpa-onnx.

## Why this is worth it

Omi Med STT v1 is medically tuned, **#1 open by medical WER**, **fast +
streaming** (fixing MedASR's non-streaming weakness), and **CC-BY-4.0** — a
licensing and latency upgrade over MedASR. Once validated on your audio (use the
STT bake-off / `baseline/metrics.py`), it's a strong candidate to become the
default engine.

## Notes
- sherpa-onnx does its own feature extraction + TDT decoding, so this engine
  does **not** use `features.js` / `decode.js` (those are MedASR-CTC specific).
- No chunk-stitching here — sherpa-onnx handles arbitrary-length audio, so the
  boundary word-doubling that affected long CTC clips doesn't apply.
