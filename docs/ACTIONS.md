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
| "stop dictation" / "stop listening" / "stop recording" / "finish dictation" | End the current dictation |

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

## Ordering

Per utterance, the pipeline is: **command?** → **macro?** → voice navigation →
cleanup → voice formatting → type. The first thing that matches wins, so a
command or macro short-circuits the rest.
