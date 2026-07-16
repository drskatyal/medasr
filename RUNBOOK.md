# RUNBOOK — the simple version (what YOU do)

I (Claude) write and fix the code. **You run 3 commands on your own Mac/PC** at
each stage and paste me the output. That's the whole loop. Everything here runs
**locally** because the model is gated and needs your Hugging Face login — the
cloud container I work in can't do that part.

> One-time: install [Python 3.11] and [Node 20], and accept the model license
> once at <https://huggingface.co/google/medasr> ("Agree and access").

---

## Stage A — Convert the model (do once) ⏱️ ~20 min

Copy-paste this whole block into a terminal in the repo folder:

```bash
python -m venv .venv && source .venv/bin/activate      # Windows: .venv\Scripts\activate
pip install -r convert/requirements.txt
huggingface-cli login                                   # paste your HF token

python convert/export_onnx.py     --out models/medasr.onnx
python convert/quantize.py        --in models/medasr.onnx --out models/medasr.int8.onnx
python convert/export_assets.py                          # writes app/assets/*.json
python convert/verify_parity.py   --onnx models/medasr.int8.onnx
```

**What you paste me:** the output of the last two commands (sizes + the
`PASS/CHECK` line). If anything errors, paste the red text — that's my job to fix.

✅ Success looks like: a `models/medasr.int8.onnx` file, `app/assets/*.json`
files, and `verify_parity.py` printing `PASS` (or a small int8 diff).

---

## Stage B — Prove it runs in plain Node ⏱️ ~3 min

```bash
cd app && npm install && cd ..
node convert/verify_onnx_node.js models/medasr.int8.onnx
```

**What you paste me:** the `logits dims:` line and `PASS/FAIL`.

✅ Success: `PASS: onnxruntime-node can load + run MedASR.`

---

## Stage C — Run the dictation app ⏱️ ~2 min

```bash
cd app && npm start
```

- A small pill appears; a tray/menubar icon shows up.
- Press the hotkey (**Cmd+Shift+Space** on Mac, **Ctrl+Shift+Space** on Win/Linux),
  speak, press it again. The text types into whatever app your cursor is in.
- **Mac only, one-time:** System Settings → Privacy & Security → **Accessibility**
  and **Microphone** → enable the app (needed to type into other apps).
- **Linux only:** `sudo apt install xdotool` (X11) so it can paste.

**What you paste me:** whether the text appeared, and roughly how fast. If it's
slow or the text is off, that's Stage D (tuning) — tell me and I'll adjust.

---

## Stage D — Tune speed/accuracy (optional) ⏱️ later

```bash
python streaming/stream_harness.py \
  --onnx models/medasr.int8.onnx --assets app/assets \
  --audio your_sample.wav --reference "the exact words spoken"
```

Paste me the printed grid; I'll pick the best chunk/overlap and wire it in.

---

## Stage E — Ship installers (when you're happy) ⏱️ ~10 min/platform

On a **Mac** build the Mac app; on a **Windows** PC build the Windows app
(you can only build each OS's installer on that OS):

```bash
cd app
export MEDASR_UPDATE_URL="https://<your-railway-url>"   # from the Railway step
npm run dist            # writes installers into app/dist/
```

Then upload the installer + the `.yml` files to your Railway server:

```bash
# example for a mac build:
curl -T dist/*.dmg      -H "x-upload-token: $UPLOAD_TOKEN" "$MEDASR_UPDATE_URL/releases/<name>.dmg"
curl -T dist/latest-mac.yml -H "x-upload-token: $UPLOAD_TOKEN" "$MEDASR_UPDATE_URL/releases/latest-mac.yml"
```

Now `https://<your-railway-url>` is your download page, and installed apps
auto-update from it.

---

### TL;DR of the loop
1. You run the commands for the current stage.
2. You paste me the output (or the error).
3. I fix/advance and give you the next block.

You never have to reason about ONNX, quantization, or streaming — just run &
paste. Full technical detail is in `ROADMAP.md` and each folder's comments.
