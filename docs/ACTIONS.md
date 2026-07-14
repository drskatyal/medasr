# Voice actions & macros

Two kinds of spoken input that *do* something instead of being typed as words.
Toggle in Settings → "Voice commands & macros" (`voiceActions`, on by default).
Both work in push-to-talk and in real-time (VAD) mode.

Matching is **strict**: an utterance only triggers an action when the *whole*
utterance equals a trigger (after lowercasing, trimming, and stripping trailing
punctuation). Because real-time utterances are pause-delimited, saying "open
chrome" alone fires the command, while "open chrome and read the study" is typed
as ordinary dictation. Nothing misfires inside a report.

## Commands (executed — nothing is typed)

Cross-platform (Windows / macOS / Linux). The built-in set:

| Say… | Does |
|------|------|
| "open chrome" / "launch chrome" / "open google chrome" | Launch Chrome |
| "open edge" / "open microsoft edge" | Launch Edge |
| "open firefox" | Launch Firefox |
| "open explorer" / "open file explorer" / "open finder" / "open files" | File manager |
| "open notepad" / "open text editor" | Notepad / TextEdit / gedit |
| "open word" / "open microsoft word" | Word |
| "open outlook" / "open email" / "open mail" | Outlook |
| "open calculator" | Calculator |
| "open pacs" / "launch pacs" | Your configured PACS/app (see below) |
| "show desktop" / "minimize all" / "minimise all" | Minimize all windows |
| "start dictation" / "begin dictation" / "start listening" | Begin a dictation session (hands-free) |
| "stop dictation" / "stop listening" / "stop recording" / "finish dictation" | End the current dictation |

### Editing (keyboard actions)

Sent to the focused app. "mod" = **Ctrl** on Windows/Linux, **Cmd** on macOS.

| Say… | Key |
|------|-----|
| "copy" / "copy that" / "copy this" | mod+C |
| "paste" / "paste here" / "paste that" | mod+V |
| "cut" / "cut that" | mod+X |
| "select all" / "select everything" | mod+A |
| "undo" / "scratch that" / "delete that" / "strike that" | mod+Z |
| "redo" / "redo that" | mod+Y (Win/Linux) · mod+Shift+Z (mac) |
| "save" / "save report" / "save document" | mod+S |
| "bold" / "italic" / "underline" | mod+B / mod+I / mod+U |
| "next field" / "next box" / "press tab" | Tab |
| "press enter" / "submit" | Enter |
| "escape" / "cancel that" | Esc |
| "backspace" | Backspace |
| "delete word" / "delete last word" | mod+Backspace |
| "forward delete" | Delete |

Tip: because each dictated utterance is one paste, **"scratch that" / "undo"** cleanly removes the last thing you dictated.

### "Open PACS" target

Set **Settings → "Open PACS" target** to whatever the "open pacs" command should
launch:

- **Windows** — full path to the executable, e.g. `C:\Program Files\Viewer\viewer.exe`.
- **macOS** — the app name (e.g. `Horos`) or a full `/Applications/...app` path.
- **Linux** — a shell command.

Leave it blank if you don't use it.

## Macros (expanded — the template is typed)

User-defined `trigger = expansion` lines, one per line, in
**Settings → Macros**. Say the trigger alone to type its expansion verbatim
(cleanup/formatting is skipped so the template lands exactly as written). Use
`\n` in the expansion for line breaks.

```
normal chest = No acute cardiopulmonary process. The heart size is normal. The lungs are clear. No pleural effusion or pneumothorax.
normal abdomen = No acute abdominal abnormality. The visualized bowel is unremarkable. No free air or free fluid.
```

You can also prefix a trigger with "insert" or "template" ("insert normal
chest") if that's more natural to say.

## Always-on listening (Vosk)

By default a tiny streaming recognizer (**Vosk small en-US, ~40 MB, Apache-2.0**)
runs continuously in the background so commands — and especially **"start
dictation"** / **"stop dictation"** — work hands-free, *without* pressing the
hotkey and *without* being gated by mic on/off. Toggle in **Settings → "Always
listen for commands"** (`alwaysOnCommands`).

- It is **not** used for the report text. MedASR (far more accurate for medical
  dictation) still does all transcription. Vosk only ever fires on a recognized
  command from the fixed list; matching is strict (whole utterance == trigger),
  so ordinary speech never launches anything.
- **Division of labour:** while you're dictating, in-session commands and macros
  are handled by MedASR (so the command words are swallowed, not typed into the
  report). Mic control ("start/stop dictation") is handled by the always-on
  listener in every state and is idempotent. When the mic is idle, the always-on
  listener also runs app/system commands and types macros into the focused field.
- **Privacy/CPU:** the mic stays *warm* whenever this is on (that's what makes
  "start dictation" instant). It's a small model with low CPU cost. Turn the
  setting off to disable background listening entirely — then commands only work
  during an active dictation session, and you start with the hotkey/orb.
- **Works in every dictation mode**, independent of VAD/real-time. In **batch
  (push-to-talk)** mode you can go fully hands-free: say "start dictation",
  speak your report, say "stop dictation" — MedASR transcribes the clip. (The
  trailing "stop dictation" is stripped so it doesn't land in the report.)
  Vosk is *only* the command listener here; MedASR still does the transcription,
  because Vosk's general model isn't accurate enough for medical text.
- **Shipping the model:** by default it auto-downloads on first enable (a
  **Download** button in the Models status panel shows progress) and is cached.
  To ship it *inside* the installer instead (no first-run download), run
  `npm run prepare:vosk` before `npm run dist` — that fetches the model into
  `../models/` where electron-builder bundles it, and the app prefers the
  bundled copy over downloading.
- Requires the optional `vosk` native module; if it isn't available the app runs
  exactly as before, just without hands-free start.

## Ordering

Per utterance, the pipeline is: **command?** → **macro?** → voice navigation →
cleanup → voice formatting → type. The first thing that matches wins, so a
command or macro short-circuits the rest.
