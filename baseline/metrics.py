"""Word Error Rate metrics for MedASR, matching Google's evaluation method.

The ``normalize`` function is copied verbatim from the official
``quick_start_with_hugging_face.ipynb`` notebook so that WER numbers produced
by this baseline harness are directly comparable to the ones reported in
Google's own eval cells. Do not "improve" it -- changing normalization changes
the WER and breaks comparability against upstream.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

import jiwer


def normalize(s: str) -> str:
    """Normalize text exactly as Google's notebook does before scoring.

    Lowercases, strips the ``</s>`` end token, removes any character that is
    not a space/letter/digit/apostrophe, and collapses whitespace.
    """
    s = s.lower()
    s = s.replace("</s>", "")
    s = re.sub(r"[^ a-z0-9']", " ", s)
    s = " ".join(s.split())
    return s


@dataclass
class WerResult:
    wer: float          # fraction, e.g. 0.0423
    insertions: int
    deletions: int
    substitutions: int
    hits: int
    ref_tokens: int

    @property
    def wer_pct(self) -> float:
        return self.wer * 100.0

    def as_dict(self) -> dict:
        return {
            "wer": self.wer,
            "wer_pct": round(self.wer_pct, 4),
            "insertions": self.insertions,
            "deletions": self.deletions,
            "substitutions": self.substitutions,
            "hits": self.hits,
            "ref_tokens": self.ref_tokens,
        }


def score(references: list[str], hypotheses: list[str]) -> WerResult:
    """Compute corpus-level WER over parallel reference/hypothesis lists.

    Both lists are normalized with ``normalize`` first. Passing the full lists
    to ``jiwer.process_words`` yields a micro-averaged (corpus) WER -- errors
    and reference tokens are pooled across all utterances, which is the correct
    way to aggregate WER over a test set.
    """
    if len(references) != len(hypotheses):
        raise ValueError(
            f"references ({len(references)}) and hypotheses "
            f"({len(hypotheses)}) must be the same length"
        )
    norm_refs = [normalize(r) for r in references]
    norm_hyps = [normalize(h) for h in hypotheses]
    m = jiwer.process_words(norm_refs, norm_hyps)
    return WerResult(
        wer=m.wer,
        insertions=m.insertions,
        deletions=m.deletions,
        substitutions=m.substitutions,
        hits=m.hits,
        ref_tokens=m.hits + m.deletions + m.substitutions,
    )


def score_one(reference: str, hypothesis: str) -> WerResult:
    """Convenience wrapper to score a single utterance."""
    return score([reference], [hypothesis])
