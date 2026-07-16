'use strict';
// Greedy CTC decode, matching LasrTokenizer._decode:
//   1. argmax each frame -> ids
//   2. collapse consecutive duplicate ids (itertools.groupby)
//   3. drop blank id (== pad id == 0)
//   4. map id -> piece, join, Metaspace '▁' -> space, trim.

const fs = require('fs');
const path = require('path');

function loadVocab(assetsDir) {
  const v = JSON.parse(fs.readFileSync(path.join(assetsDir, 'vocab.json'), 'utf8'));
  return v; // {id_to_piece, space_piece, blank_id}
}

// logits: Float32Array flattened [T*V]; T frames, V vocab.
function greedyCTC(logits, T, V, vocab) {
  const blank = vocab.blank_id;
  const pieces = vocab.id_to_piece;
  const space = vocab.space_piece || '▁';
  let prev = -1;
  let text = '';
  for (let t = 0; t < T; t++) {
    let best = 0, bestVal = -Infinity;
    const base = t * V;
    for (let v = 0; v < V; v++) {
      const val = logits[base + v];
      if (val > bestVal) { bestVal = val; best = v; }
    }
    if (best === prev) continue;      // collapse repeats
    prev = best;
    if (best === blank) continue;     // drop blank
    const piece = pieces[best];
    if (piece == null) continue;
    if (piece.startsWith('<') && piece.endsWith('>')) continue; // special tokens
    text += piece;
  }
  // Metaspace: '▁' marks a word start -> convert to space.
  return text.split(space).join(' ').replace(/\s+/g, ' ').trim();
}

module.exports = { loadVocab, greedyCTC };
