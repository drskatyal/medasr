# Bundled on-device weights (not committed)

Release installers copy this folder into the app (`electron-builder extraResources`).

| File | What |
|------|------|
| `medasr.int8.onnx` | Full Google MedASR int8 |
| `Qwen3-1.7B-Q4_K_M.gguf` | Mic-off cleanup (default) |
| `gemma-4-E4B-it-Q4_K_M.gguf` | Mic-off cleanup (optional) |
| `silero_vad.onnx` | Pause detection only — not transcription |
| `NOTICE.txt` | License pointer |

Populate with:

```bash
python convert/export_onnx.py && python convert/quantize.py
HF_TOKEN=… node app/scripts/bundle-weights.js
```

Never commit the binaries. They are HAI-DEF / Gemma / Apache derivatives — see `/ATTRIBUTION.md`.
