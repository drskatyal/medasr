'use strict';
// Cleanup pass: turn a raw ASR transcript into a corrected / formatted one using
// the local LLM sidecar. SAFETY-CRITICAL for medical use: the model is a
// transcription EDITOR, never a clinician. It must not add, remove, or infer
// any clinical content. We enforce this with a strict prompt + temperature 0 +
// a capped output length, and the app surfaces raw vs cleaned as a DIFF the
// user accepts (never a silent rewrite of the record).

const SYSTEM_PROMPT = [
  'You are a transcription editor for RADIOLOGY dictation. You fix speech-to-text',
  'errors and format the report. You output ONLY the corrected report text.',
  '',
  'DO:',
  '- Correct misrecognized medical/radiology terms to the intended standard term when',
  '  the intent is clear. Sound out the phonetics and map to the nearest real radiology',
  '  term. Examples of the KIND of fixes expected:',
  '    "supra spin at us" -> "supraspinatus"',
  '    "coronal cruciate" -> "anterior cruciate"',
  '    "medial and iscus" -> "medial meniscus"',
  '    "pvsift" / "pivsift" / "PVSIFT" -> "pivot shift"',
  '    "plateu" -> "plateau"',
  '    "condial" -> "condyle"',
  '    "full thickness tare" -> "full-thickness tear"',
  '  Use standard radiology vocabulary and spelling. A garbled all-caps token is almost',
  '  always a misheard term — decode it, do not just re-case it.',
  '- Fix punctuation, capitalization, spacing, and obvious grammar.',
  '',
  'NEVER:',
  '- Never change laterality (left/right), numbers, sizes/measurements, or negations',
  '  ("no", "without", "absent").',
  '- Never add, remove, or infer findings, impressions, or diagnoses.',
  '- Never output any preamble, explanation, quotes, markdown, delimiter markers,',
  '  or a "Note:". Output ONLY the corrected report and nothing else.',
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
  // Remove the trailing "Note: …" FIRST (it sits after the stray >>>), then the
  // marker/bracket run that's now at the end.
  t = t.replace(/\n+\s*note\s*:\s*[\s\S]*$/i, '');           // trailing "Note: …"
  t = t.replace(/\s*[^\n]*transcript\s*>+\s*$/i, '');        // trailing  TRANSCRIPT>>>
  t = t.replace(/^[<>]{2,}\s*/, '').replace(/\s*[<>]{2,}\s*$/, '');   // stray >>> / <<<
  return t.trim();
}

function log(...a) { console.log('[cleanup]', ...a); }
function preview(s, n = 200) { s = String(s || ''); return s.length > n ? s.slice(0, n) + `… (+${s.length - n} chars)` : s; }

// Reasoning models (Qwen3, LFM2.5) emit a <think> block before the answer. For a
// mechanical "correct this text" task we do NOT want chain-of-thought: it burns
// the token budget so the actual report never gets written (node-llama-cpp strips
// the think block → empty answer → gate keeps raw → "cleaning did nothing"). Qwen3
// honors a `/no_think` soft switch; disable thinking for those families.
const THINKING_MODELS = /qwen3|lfm2\.5|lfm2_5|lfm25/i;

async function cleanupTranscript(llm, rawText, { maxTokens } = {}) {
  if (!rawText || !rawText.trim()) return rawText;
  const isThinker = THINKING_MODELS.test((llm && llm.modelId) || '');
  const system = isThinker ? SYSTEM_PROMPT + '\n\n/no_think' : SYSTEM_PROMPT;
  const messages = [
    { role: 'system', content: system },
    // Keep the user turn minimal — extra scaffolding (delimiters) tempted the
    // model to echo it into the report. `/no_think` also here so Qwen3 sees it
    // regardless of how the chat template orders system vs. user turns.
    { role: 'user', content: (isThinker ? '/no_think\n' : '') + 'Correct and format this radiology dictation:\n\n' + rawText },
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
