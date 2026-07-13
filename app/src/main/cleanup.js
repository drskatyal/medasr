'use strict';
// Cleanup pass: turn a raw ASR transcript into a corrected / formatted one using
// the local LLM sidecar. SAFETY-CRITICAL for medical use: the model is a
// transcription EDITOR, never a clinician. It must not add, remove, or infer
// any clinical content. We enforce this with a strict prompt + temperature 0 +
// a capped output length, and the app surfaces raw vs cleaned as a DIFF the
// user accepts (never a silent rewrite of the record).

const SYSTEM_PROMPT = [
  'You are a medical transcription EDITOR, not a clinician.',
  'Your only job is to correct speech-to-text errors and format dictation.',
  'STRICT RULES:',
  '- Preserve clinical meaning EXACTLY. Never add, remove, or infer findings,',
  '  measurements, laterality (left/right), negations, medications, or diagnoses.',
  '- Fix obvious ASR spelling errors of medical terms only when you are confident',
  '  (e.g. "supra spin at us" -> "supraspinatus"). If unsure, leave it as heard.',
  '- Collapse stutters/repeats the speaker clearly did not intend.',
  '- Expand spoken punctuation ONLY when explicitly said ("period", "comma",',
  '  "new paragraph", "colon").',
  '- Do NOT invent section headers or content that was not dictated.',
  '- Output ONLY the edited transcript. No preamble, no commentary.',
].join('\n');

// Strip any chain-of-thought that reasoning models (e.g. LFM2.5) emit.
function stripThinking(text) {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^\s*<\/?think>\s*/i, '').trim();
}

async function cleanupTranscript(llm, rawText, { maxTokens } = {}) {
  if (!rawText) return rawText;
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Edit this dictation transcript:\n\n${rawText}` },
  ];
  // Cap output near the input length so the model can't run away and generate.
  const cap = maxTokens || Math.min(2048, Math.ceil(rawText.length / 3) + 128);
  const out = await llm.chat(messages, { temperature: 0, maxTokens: cap });
  return stripThinking(out) || rawText;
}

module.exports = { cleanupTranscript, SYSTEM_PROMPT, stripThinking };
