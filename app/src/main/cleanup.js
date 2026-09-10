'use strict';
// Cleanup pass: turn a raw ASR transcript into a corrected / formatted one using
// the local LLM sidecar. SAFETY-CRITICAL for medical use: the model is a
// transcription EDITOR, never a clinician. It must not add, remove, or infer
// any clinical content. We enforce this with a strict prompt + temperature 0 +
// a capped output length, and the app surfaces raw vs cleaned as a DIFF the
// user accepts (never a silent rewrite of the record).

const SYSTEM_PROMPT = [
  'You are a transcription editor for RADIOLOGY dictation. Your ONLY job is to fix',
  'speech-to-text errors in the exact text you are given and return it. You are an',
  'EDITOR, not an author. Think of it as spell-check + medical-term-check, nothing more.',
  '',
  'DO:',
  '- Correct misrecognized medical/radiology terms to the intended standard term when',
  '  the intent is clear. Sound out the phonetics and map to the nearest real radiology',
  '  term. Examples of the KIND of fixes expected:',
  '    "supra spin at us" -> "supraspinatus"',
  '    "coronal cruciate" -> "anterior cruciate"',
  '    "medial and iscus" -> "medial meniscus"',
  '    "pvsift" / "pivsift" / "PVSIFT" / "prevort shift" -> "pivot shift"',
  '    "plateu" -> "plateau"',
  '    "condial" -> "condyle"',
  '    "full thickness tare" -> "full-thickness tear"',
  '  Use standard radiology vocabulary and spelling. A garbled all-caps token is almost',
  '  always a misheard term — decode it, do not just re-case it.',
  '- PHONETIC + CONTEXT RULE (important): if a word is not a real clinical term, OR is a',
  '  real everyday word that makes no medical sense in its sentence, treat it as a',
  '  mis-hearing. Say it out loud in your head and pick the radiology term that (a) sounds',
  '  closest AND (b) fits the surrounding anatomy/finding. Prefer a plausible medical term',
  '  over a similar-sounding ordinary word. E.g. in "___ show/shift pattern of bone bruise',
  '  in the femoral condyle", "fever"/"fver" is nonsensical — the sound + knee context point',
  '  to "pivot shift". Use the neighbouring words (modality, anatomy, laterality) as the clue',
  '  to what a garbled word must be.',
  '- SAFETY on that rule: this only fixes the IDENTITY of a word that is already there. If no',
  '  medical term plausibly matches both the sound and the context, leave the original word',
  '  unchanged rather than guessing. Never turn a mis-hearing into a NEW finding.',
  '- Fix punctuation, capitalization, spacing, and obvious grammar.',
  '- Keep the SAME sentences in the SAME order. Output plain running prose exactly as',
  '  dictated, just corrected.',
  '',
  'NEVER (these are hard rules — violating them makes the output unusable):',
  '- Never reorganize the report. No headings, no section titles ("Findings:",',
  '  "Impression:"), no bullet points, no lists, no tables.',
  '- Never use Markdown or any formatting characters: no **bold**, no *italics*,',
  '  no #, no "- " or "* " bullets. Plain text only.',
  '- Never add, remove, infer, summarize, or restate findings, impressions, or',
  '  diagnoses. Do NOT add an impression or conclusion. Do NOT add phrases like',
  '  "there is evidence of" or "consistent with" that were not dictated.',
  '- Never change laterality (left/right), numbers, sizes/measurements, or negations',
  '  ("no", "without", "absent").',
  '- Never output any preamble, explanation, quotes, or a "Note:". Output ONLY the',
  '  corrected report text and nothing else.',
].join('\n');

// Strip any chain-of-thought that reasoning models (e.g. LFM2.5) emit.
function stripThinking(text) {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^\s*<\/?think>\s*/i, '').trim();
}

// Remove scaffolding the model may echo despite instructions: code fences,
// "Here is…:" preambles, delimiter markers (<<<TRANSCRIPT / TRANSCRIPT>>> /
// <EDITED TRANSCRIPT>), stray angle-bracket runs, and a trailing "Note: …".
function stripWrappers(s) {
  let t = (s || '').trim();
  t = t.replace(/^```[\w-]*\n?/, '').replace(/\n?```$/, '').trim();
  // delimiter/marker lines the model copies from the prompt
  t = t.replace(/^<+[^\n]*transcript[^\n]*>*\s*\n?/i, '');   // leading  <EDITED TRANSCRIPT / <<<TRANSCRIPT
  t = t.replace(/^\s*here(?:'s| is)\b[^\n]*:\s*\n+/i, '');   // "Here is the corrected report:"
  t = t.replace(/^\s*output\s*:\s*/i, '');                   // echoed "Output:" label from the one-shot prompt
  t = t.replace(/^\s*input\s*:\s*/i, '');                    // echoed "Input:" label
  // Remove the trailing "Note: …" FIRST (it sits after the stray >>>), then the
  // marker/bracket run that's now at the end.
  t = t.replace(/\n+\s*note\s*:\s*[\s\S]*$/i, '');           // trailing "Note: …"
  t = t.replace(/\s*[^\n]*transcript\s*>+\s*$/i, '');        // trailing  TRANSCRIPT>>>
  t = t.replace(/^[<>]{2,}\s*/, '').replace(/\s*[<>]{2,}\s*$/, '');   // stray >>> / <<<
  t = stripMarkdown(t);
  return t.trim();
}

// SAFETY NET: some models (e.g. MedGemma) format the report into Markdown — bold
// headings, bullet lists — despite instructions. Those literal *, **, # characters
// would be typed straight into the PACS/EHR field. Strip formatting syntax while
// preserving the words. This does NOT undo re-structuring (that's the prompt's job);
// it just guarantees no markup reaches the field.
function stripMarkdown(s) {
  return String(s || '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')          // ATX headings:  ### Findings
    .replace(/^\s*[-*+]\s+/gm, '')               // bullet markers: "* ", "- ", "+ "
    .replace(/\*\*([^*]+)\*\*/g, '$1')           // **bold**
    .replace(/__([^_]+)__/g, '$1')               // __bold__
    .replace(/\*([^*\n]+)\*/g, '$1')             // *italic*
    .replace(/(^|\s)_([^_\n]+)_(?=\s|$)/g, '$1$2') // _italic_ (word-bounded, spares snake_case)
    .replace(/`([^`]+)`/g, '$1');                // `code`
}

function log(...a) { console.log('[cleanup]', ...a); }
function preview(s, n = 200) { s = String(s || ''); return s.length > n ? s.slice(0, n) + `… (+${s.length - n} chars)` : s; }

// Reasoning models (Qwen3, LFM2.5) emit a <think> block before the answer. For a
// mechanical "correct this text" task we do NOT want chain-of-thought: it burns
// the token budget so the actual report never gets written (node-llama-cpp strips
// the think block → empty answer → gate keeps raw → "cleaning did nothing"). Qwen3
// honors a `/no_think` soft switch; disable thinking for those families.
const THINKING_MODELS = /qwen3|lfm2\.5|lfm2_5|lfm25/i;

// One-shot demonstration of the EXACT desired shape. This is the strongest lever
// against MedGemma's "write a formatted report" reflex: instructions fight the
// model's template prior weakly, but a concrete input→output example that stays as
// plain running prose (no headings, no sections) gets copied. Note the wording:
// we say "text", never "report"/"format" — those words trigger template mode.
const EXAMPLE_IN = 'mri lt shoulder the supra spin at us tendon shows full thickness tare '
  + 'moderate joint effusion no pvsift';
const EXAMPLE_OUT = 'MRI left shoulder. The supraspinatus tendon shows a full-thickness tear. '
  + 'Moderate joint effusion. No pivot shift.';

async function cleanupTranscript(llm, rawText, { maxTokens } = {}) {
  if (!rawText || !rawText.trim()) return rawText;
  const isThinker = THINKING_MODELS.test((llm && llm.modelId) || '');
  const system = isThinker ? SYSTEM_PROMPT + '\n\n/no_think' : SYSTEM_PROMPT;
  // Embed the one-shot inside the user turn (llm.chat collapses to one system +
  // one user message, so a separate assistant example turn wouldn't survive).
  const userContent =
    (isThinker ? '/no_think\n' : '')
    + 'Correct the speech-to-text errors in the text below and return only the corrected '
    + 'text. Keep the same words and sentence order — do not reformat.\n\n'
    + 'Example\nInput: ' + EXAMPLE_IN + '\nOutput: ' + EXAMPLE_OUT + '\n\n'
    + 'Now correct this text:\nInput: ' + rawText + '\nOutput:';
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: userContent },
  ];
  // Editor output is ~ input length. Budget generously so (a) a long report is
  // not truncated mid-sentence and (b) if a reasoning model still thinks, it has
  // room to finish thinking AND emit the report rather than returning empty.
  const cap = maxTokens || Math.min(4096, Math.ceil((rawText.length / 3) * 1.4) + 768);
  const generated = await llm.chat(messages, { temperature: 0, maxTokens: cap });
  const out = stripWrappers(stripThinking(generated));
  // Diagnostics: show what the model actually produced vs. what the gate decides.
  log('raw model output:', preview(generated));
  if (out !== generated.trim()) log('after strip:', preview(out));
  // MEDICAL SAFETY GATE: reject an edit that dropped or exploded the text
  // (truncation, hallucinated deletion, runaway generation) — keep the raw
  // transcript instead. The caller only replaces when cleaned != raw.
  if (!out) { log('gate: empty after strip -> keeping raw'); return rawText; }
  const ratio = out.length / rawText.length;
  if (ratio < 0.6 || ratio > 2.2) {
    log(`gate: length ratio ${ratio.toFixed(2)} out of [0.6, 2.2] -> keeping raw (model ${ratio > 2.2 ? 'over-generated' : 'dropped text'})`);
    return rawText;
  }
  if (out === rawText) log('note: model returned text identical to input (no corrections made)');
  else log('accepted cleaned output (ratio', ratio.toFixed(2) + ')');
  return out;
}

module.exports = { cleanupTranscript, SYSTEM_PROMPT, stripThinking, stripWrappers };
