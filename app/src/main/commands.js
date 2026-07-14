'use strict';
// Spoken formatting/punctuation commands for dictation (radiology-oriented).
// Converts said words like "period", "comma", "new paragraph" into punctuation
// and layout, then fixes spacing and sentence capitalization. Deterministic and
// fast; applied as the final formatting pass before the text is typed.
//
// CAVEAT (medical): some command words are also anatomy — most importantly
// "colon". We DON'T convert "colon" when it's clearly the organ (preceded by an
// article/segment adjective, e.g. "the colon", "sigmoid colon"). Other
// collisions ("period", "comma") are rare in reports. Toggleable via
// settings.voiceCommands.

// Control-char placeholders for newlines (survive space-normalization).
const NL = '';   // single newline
const PP = '';   // paragraph (blank line)
const NLC = '[\\u0001\\u0002]';

// Applied in order (longest / most specific first).
const RULES = [
  [/\bnew\s+paragraph\b/gi, PP],
  [/\bnext\s+paragraph\b/gi, PP],
  [/\bnew\s+line\b/gi, NL],
  [/\bnext\s+line\b/gi, NL],
  [/\bfull\s+stop\b/gi, '.'],
  [/\bperiod\b/gi, '.'],
  [/\bcomma\b/gi, ','],
  [/\bsemi[-\s]?colon\b/gi, ';'],
  [/\bquestion\s+mark\b/gi, '?'],
  [/\bexclamation\s+(mark|point)\b/gi, '!'],
  [/\b(open|left)\s+(parenthes[ei]s|paren|bracket)\b/gi, '('],
  [/\b(close|right)\s+(parenthes[ei]s|paren|bracket)\b/gi, ')'],
  [/\bopen\s+quote\b/gi, '"'],
  [/\bclose\s+quote\b/gi, '"'],
  [/\bforward\s+slash\b/gi, '/'],
  [/\bslash\b/gi, '/'],
  [/\bhyphen\b/gi, '-'],
  [/\bpercent(\s+sign)?\b/gi, '%'],
  [/\bplus\s+sign\b/gi, '+'],
];

const COLON_ORGAN_BEFORE = /(the|a|an|sigmoid|transverse|ascending|descending|proximal|distal|entire|whole|redundant|colonic)$/i;
function applyColon(text) {
  return text.replace(/\bcolon\b/gi, (m, offset, str) => {
    const before = str.slice(0, offset).replace(/\s+$/, '');
    const lastWord = before.split(/\s+/).pop() || '';
    return COLON_ORGAN_BEFORE.test(lastWord) ? m : ':';
  });
}

function applyCapital(text) {
  return text.replace(/\bcapital\s+([a-z])/gi, (_m, c) => c.toUpperCase());
}

function normalizeSpacing(s) {
  s = s.replace(/\s+([,.;:!?%)])/g, '$1');            // no space before these
  s = s.replace(/([(])\s+/g, '$1');                   // no space after (
  s = s.replace(/([,.;:!?])(?=[A-Za-z0-9])/g, '$1 '); // one space after punctuation
  s = s.replace(/[ \t]{2,}/g, ' ');                   // collapse runs of spaces
  s = s.replace(new RegExp('[ \\t]+(' + NLC + ')', 'g'), '$1');
  s = s.replace(new RegExp('(' + NLC + ')[ \\t]+', 'g'), '$1');
  return s;
}

function capitalizeSentences(s) {
  return s.replace(new RegExp('(^\\s*|[.!?]\\s+|' + NLC + '+)([a-z])', 'g'),
    (_m, pre, c) => pre + c.toUpperCase());
}

function applyCommands(text) {
  if (!text) return text;
  let s = ' ' + text + ' ';
  for (const [re, rep] of RULES) s = s.replace(re, ` ${rep} `);
  s = applyColon(s);
  s = applyCapital(s);
  s = normalizeSpacing(s);
  s = capitalizeSentences(s);
  s = s.replace(new RegExp(PP, 'g'), '\n\n').replace(new RegExp(NL, 'g'), '\n');
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').trim();
}

module.exports = { applyCommands };
