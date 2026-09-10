# Whole-app flow audit (Grok 4.5) — findings & status

Audited all flows across model combinations {MedASR | Omi/Parakeet | LFM-audio}
× {cleanup: off | LFM2.5-8B | Omi-Sum} × {push-to-talk | real-time}.

## P0 — correctness / races

| # | Finding | Status |
|---|---------|--------|
| 1 | **`finish()` race** — in-flight `_process` could enqueue an utterance after cleanup/replace (extra text typed post-cleanup). | ✅ **Fixed** — window loop gated on `active`+`epoch`; `finish()` awaits the in-flight drain, then a *stable* queue drain, before cleanup. Unit-tested (late frames after finish are ignored). |
| 2 | **Clipboard restore races** — fire-and-forget restore could clobber the clipboard mid-paste / restore wrong value into an EHR field. | ✅ **Fixed** — single clipboard mutex (`serialClip`); inject/replace don't resolve until restore completes inside the lock. |
| 3 | **`replaceText` select+paste timing** — paste could land before selection registered → duplicated text. | ✅ **Improved** — `selectLeft` is awaited (selection complete before paste) + settle delay; cap lowered to 3000 graphemes; **fail-open to clipboard, never silent no-op / never delete on doubt.** |
| 4 | **`transcribe` throw kills the real-time queue.** | ✅ Already `.catch`-guarded on the chain; verified. |
| 5 | Push-to-talk drops a chunk while `transcribing`. | ⚠️ **Accepted** — the re-entrancy guard prevents the earlier loop bug; with the 500ms debounce an overlap is rare. Backlog: queue instead of drop. |
| 7 | **Per-chunk resample phase reset** (real-time) aliased glitches into the speech band. | ✅ **Fixed** — stateful streaming resampler carries phase + last sample across chunks. (PTT already resamples the whole utterance once.) |
| 8 | VAD `subarray` view aliasing before `await`. | ✅ **Fixed** — copy the window (`slice`) before VAD; preroll stores copies. |

## P1 — quality (backlog, prioritized)
- Anti-alias low-pass before 48→16k downsample (Speex/polyphase) — reduces MedASR fricative/drug-name errors.
- MedASR chunk **overlap-stitch by longest agreement** (not naive concat) for >5min audio.
- Prefer **cleanup once per session** everywhere (real-time already does; add a PTT "session bag" so multi-sentence dictation gets one editorial pass with full context).
- Dose/unit post-normalization (mg/µg, "once daily").
- VAD preroll ≥300ms + trailing pad (already: 300ms preroll + full silence tail included).

## P2 — latency (backlog)
- Direct key-insertion for short deltas (<~80 chars) instead of clipboard paste.
- Split ASR queue from inject queue so transcription overlaps paste latency.
- Run Silero VAD in a worker / batch windows.
- Push-to-talk: inject raw immediately, then replace when cleanup returns (like real-time), instead of blocking on the LLM.

## Recommended default combo (16GB Windows clinician)
**MedASR + LFM2.5-8B-A1B cleanup + push-to-talk** today (smallest correctness
surface). Switch default to **MedASR + cleanup + real-time** now that the P0
race/clipboard/replace fixes have landed. Avoid **LFM-audio + text-cleanup**
(double-editing, memory pressure). Keep Omi/Parakeet as the "fast" option once
their sherpa-onnx files are installed.

> Ship note: real-time + cleanup was a data-corruption risk before the P0 fixes
> above (could type extra text / clobber an EHR clipboard). Those are now fixed;
> real-time stays **off by default** until validated on-device.
