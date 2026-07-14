# Packaging & distribution — how native modules reach non-technical users

**End users must never run `npm install` or install build tools.** They download a
double-click installer where everything is already inside. This is how the native
modules — `vosk` (always-on commands), `sherpa-onnx-node` (Parakeet STT),
`node-llama-cpp` (cleaning LLM), `onnxruntime-node` (MedASR) — are served.

## How it works

1. **Compile once, on the build machine.** electron-builder rebuilds every native
   module against Electron's ABI (`npmRebuild: true`) and bundles the compiled
   `.node` binaries (+ their shared libs, e.g. `libvosk`) into the app. The
   `asarUnpack` list keeps them outside the asar archive so they load at runtime.
2. **Ship the installer.** The user runs `FlowRad-Setup.exe` / `.dmg` /
   `.AppImage`. No terminal, no toolchain, no npm.

The build machine needs the compilers — but you don't have to set them up: **CI
runners already have them** (Visual Studio on Windows, Xcode on macOS, gcc on
Linux). See `.github/workflows/build.yml`.

## Releasing (recommended: CI)

```bash
git tag v0.1.0
git push origin v0.1.0
```

GitHub Actions then builds all three installers and attaches them to a GitHub
Release. Users download from the Releases page. To build without tagging, run the
**Build installers** workflow manually (Actions tab → Run workflow) and grab the
artifacts.

## Building locally (optional)

You can only build a given OS's installer on that OS. You need that platform's
build tools once (Windows: "Visual Studio Build Tools" with the C++ workload;
macOS: Xcode CLT; Linux: `build-essential`). Then:

```bash
cd app
node scripts/fetch-vosk.js   # optional: bundle the ~40MB command model
npm install                  # compiles the native modules
npm run dist                 # writes installers into app/dist/
```

## Model weights (separate from native code)

The native *engines* are bundled; the *weights* download on first run and cache:

| Weight | Bundled? | License |
|--------|----------|---------|
| Vosk command model (~40 MB) | optional (`fetch-vosk.js`) or first-run download | Apache-2.0 |
| Parakeet STT (~650 MB) | first-run download (one click) | non-gated |
| Cleaning GGUF (LFM/Qwen/…) | first-run download | model-specific |
| **MedASR** | **not shippable** | **HAI-DEF gated** |

**Note for open-source distribution:** MedASR weights are gated (HAI-DEF) and
cannot be bundled or auto-downloaded without the user's own Hugging Face
acceptance. For a zero-friction non-technical experience, make **Parakeet the
default engine** — it's non-gated and auto-downloads on first run — so a fresh
install goes: run installer → app fetches Parakeet → dictate. MedASR remains an
opt-in for users who accept its license. (See `LICENSING_NOTES.md`.)

## Code signing (optional, later)

CI builds **unsigned** by default (`CSC_IDENTITY_AUTO_DISCOVERY=false`). Unsigned
apps install fine; Windows SmartScreen / macOS Gatekeeper show a one-time
"run anyway" prompt. To ship signed/notarized builds, add the signing certs as
repo secrets and wire `CSC_LINK` / `CSC_KEY_PASSWORD` (Windows) and the Apple
notarization vars (macOS) into the workflow.
