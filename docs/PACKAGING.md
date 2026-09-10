# Packaging & distribution

End users never run `npm` and **never download models**. The installer contains:

- native engines (`onnxruntime-node`, `node-llama-cpp`)
- **Google MedASR** full int8 ONNX (`medasr.int8.onnx`) — HAI-DEF
- **Qwen3-1.7B** and **Gemma 4 E4B** GGUFs for mic-off cleanup
- Silero VAD ONNX (pause detection only)

First launch shows a license screen (HAI-DEF + Gemma + Qwen). Accepting is
required; it is not a download.

## Build

```bash
python convert/export_onnx.py --out models/medasr.onnx
python convert/quantize.py --in models/medasr.onnx --out models/medasr.int8.onnx
python convert/export_assets.py

HF_TOKEN=… node app/scripts/bundle-weights.js   # MedASR + Qwen + Gemma + Silero
cd app && npm install && npm test && npm run dist
```

`SKIP_GEMMA=1` skips the ~5 GB Gemma file for a slimmer CI artifact.

Weights stay out of git (`models/` is gitignored except `README.md`). Bundling
redistributes HAI-DEF **derivatives** inside a private/clinical installer —
keep the notices. Do not relabel MedASR as Apache 2.0. See `LICENSING_NOTES.md`.

## CI

`.github/workflows/build.yml` runs `bundle-weights.js` when `HF_TOKEN` is set,
then electron-builder. Native modules compile on the runner.
