# Voice formatting commands

Say these while dictating; they're converted to punctuation/layout automatically
(toggle in Settings → "Voice formatting commands"). Applied as the final pass,
after transcription and optional cleanup.

| Say… | You get |
|------|---------|
| "period" / "full stop" | `.` |
| "comma" | `,` |
| "colon" | `:`  (but *not* when it's the organ — "the colon", "sigmoid colon" stay as words) |
| "semicolon" | `;` |
| "question mark" | `?` |
| "exclamation mark" / "exclamation point" | `!` |
| "new line" / "next line" | line break |
| "new paragraph" / "next paragraph" | blank line |
| "open paren" / "open bracket" | `(` |
| "close paren" / "close bracket" | `)` |
| "open quote" / "close quote" | `"` |
| "slash" / "forward slash" | `/` |
| "hyphen" | `-` |
| "percent" / "percent sign" | `%` |
| "plus sign" | `+` |
| "capital <word>" | Capitalises that word |

Automatic formatting:
- Sentences are capitalised (after `.` `!` `?` and line breaks, and at the start).
- Spacing around punctuation is fixed (no space before `.`/`,`, one space after).

Example:
> spoken: *"findings colon new paragraph pulmonary vasculature colon the main PA is patent period no saddle embolus period"*
>
> typed:
> ```
> Findings:
>
> Pulmonary vasculature: the main PA is patent. No saddle embolus.
> ```

**Note on collisions:** "colon" is guarded (organ vs punctuation). "period"/"comma"
as literal words are rare in reports; if one is misconverted, you can turn the
feature off in Settings. Number/unit normalisation ("five millimetres" → "5 mm")
is a planned follow-up.
