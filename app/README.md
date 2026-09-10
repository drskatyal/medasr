# FlowRad Dictate (Electron)

Local, private, Wispr-Flow-style medical dictation: hold or toggle a global
hotkey (or the orb buttons), speak, and the transcript is typed into whatever
app you're in — and into a floating scratchpad. Inference runs fully on-device
via `onnxruntime-node` — **no Python and no server at runtime**.

## Architecture

```
 global hotkey (main)  ──toggle──►  renderer captures mic (getUserMedia)
                                          │  Float32 PCM @ 16kHz (resampled)
                                          ▼  IPC: audio-chunk
 main process:  features.js (log-mel) ─► asr.js (onnxruntime-node) ─► decode.js (CTC)
                                          │  transcript text
                                          ▼
                          inject.js  ── clipboard + OS paste keystroke ──►  focused app
```

- `src/main/index.js` — tray, hold/toggle hotkeys, scratchpad, IPC, auto-update
- `src/renderer/*` — floating bar (Hold / orb / Toggle / Pad) + scratchpad + mic capture
- `src/main/asr.js` — ONNX session, single-pass + chunk/stitch long-audio
- `src/main/features.js` — pure-JS log-mel matching `LasrFeatureExtractor`
- `src/main/decode.js` — greedy CTC matching `LasrTokenizer._decode`
- `src/main/inject.js` — type-anywhere via clipboard + `osascript`/`SendKeys`/`xdotool`

## Run (dev)

Requires `models/medasr.int8.onnx` and `app/assets/*.json` from the conversion
pipeline (`../convert`). See the repo `RUNBOOK.md`.

```bash
npm install
npm start
```

## Permissions

- **macOS:** grant **Microphone** and **Accessibility** (to type into other apps).
- **Linux:** install `xdotool` (X11) or `wtype` (Wayland) for paste injection.
- **Windows:** works out of the box.

## Build

```bash
export MEDASR_UPDATE_URL="https://<railway-host>"   # for auto-updates
npm run dist
```

Model weights are **not** bundled in the public repo (HAI-DEF gated license —
see `../LICENSING_NOTES.md`).
