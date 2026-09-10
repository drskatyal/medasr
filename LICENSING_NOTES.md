# Licensing — read before open-sourcing (Phase 5 blocker)

**Short version: the MedASR *model weights* are NOT Apache 2.0. Phase 5's
assumption that you can "confirm MedASR's Apache 2.0 license and carry it
forward" is incorrect, and it changes what you can legally publish.**

## The two licenses in play

| Artifact | License |
|----------|---------|
| This repo's **code** (notebooks, scripts) | Apache 2.0 (see `LICENSE`) |
| The **MedASR model weights** (`google/medasr`) | **Health AI Developer Foundations (HAI-DEF) license** — see the repo `README.md` and <https://developers.google.com/health-ai-developer-foundations/terms> |

The HAI-DEF license is **not** an OSI-approved open-source license. The model
is also **gated** on Hugging Face (you must accept terms + authenticate).

## Why this matters for this project

Your quantized `.onnx` / int8 / GGUF file is a **Model Derivative** of the
gated weights. Publishing it (committing it to a public repo, attaching it to a
GitHub Release, pushing it to a HF Space, or bundling it inside the Electron
installer) is **redistribution of a derivative of HAI-DEF-licensed weights** —
which the code's Apache 2.0 license does **not** authorize. HAI-DEF-family
terms typically require, at minimum, that redistribution pass along the same
license + use restrictions and not present the artifact as unrestricted OSS.

So the plan's framing — *"ship it fully open source"* — cannot apply to the
converted weights the way it applies to your conversion code.

## What this installer does

FlowRad **bundles** converted MedASR ONNX (and optional distill) plus Qwen/Gemma
GGUFs in the desktop installer so clinicians do not download weights. That is
**redistribution of HAI-DEF model derivatives**. We:

- keep HAI-DEF / Gemma notices in the app (`app/NOTICE.md`, first-run accept)
- never commit `.onnx` / `.gguf` to git
- never label MedASR weights as Apache 2.0
- attribute speech recognition as **Google MedASR** in the UI

Code remains Apache 2.0. Confirm the current HAI-DEF redistribution clause
before a public download page.

## What you almost certainly CAN do (verify against the exact terms)

- **Open-source conversion / Electron _code_** under Apache 2.0.
- Ship a **clinical installer** that includes HAI-DEF derivatives **with**
  the license, attribution, and a first-run acceptance screen.
- Keep a gated HF copy of the ONNX for rebuilds (`MEDASR_ONNX_REPO`).

## What to NOT do until you've confirmed the terms

- ❌ Commit `.onnx` / quantized weight files to a public repo.
- ❌ Bundle weights inside the `electron-builder` installer for public download.
- ❌ Relabel the derivative as Apache 2.0 / MIT.

## Concrete action items

1. Re-read the exact HAI-DEF terms and the `google/medasr` model-card "Prohibited
   uses" / distribution section. Confirm the redistribution clause verbatim.
2. Decide the distribution model: **recommended = code-only OSS + runtime
   weight download** under the user's own HF auth.
3. Carry Google's `LICENSE` + any `NOTICE` forward and clearly separate
   "code (Apache 2.0)" from "model weights (HAI-DEF, downloaded separately)" in
   your README.
4. Consider legal review before the repo goes public — this is a medical model
   with use restrictions, not a permissively licensed one.

*(This note is engineering guidance, not legal advice. The gating + HAI-DEF
license are facts from the repo README and model card; the redistribution
consequences follow from them but should be confirmed against the current
license text.)*
