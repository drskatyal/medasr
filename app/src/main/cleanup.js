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
  '  the intent is clear, e.g. "supra spin at us"->"supraspinatus", "coronal cruciate"->',
  '  "anterior cruciate", "medial and iscus"->"medial meniscus", "arpitental"->"a complex".',
  '  Use standard radiology vocabulary and spelling.',
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

async function cleanupTranscript(llm, rawText, { maxTokens } = {}) {
  if (!rawText || !rawText.trim()) return rawText;
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    // Keep the user turn minimal — extra scaffolding (delimiters) tempted the
    // model to echo it into the report.
    { role: 'user', content: 'Correct and format this radiology dictation:\n\n' + rawText },
  ];
  // Editor output is ~ input length; budget generously so a long report is not
  // truncated mid-sentence (partial clinical text is worse than raw ASR).
  const cap = maxTokens || Math.min(4096, Math.ceil((rawText.length / 3) * 1.4) + 256);
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
