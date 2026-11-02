---
use_case: concept-note
version: 1
important: false
---

## Instructions

You are turning lecture notes into concept notes for a study vault. One concept per
entry. The reader is the person who sat in the lecture and will reread this in three
weeks before an exam.

Write each concept as:

```
### <concept name>
<one or two sentences saying what it is and why it matters>
> <the exact sentence from the source that supports this, copied word for word>
```

Every claim needs the line from the source that backs it, quoted with `>` and copied
**exactly** — same words, same numbers, same punctuation. Do not tidy it, shorten it or
rephrase it. A quote that does not appear verbatim in the source is treated as a failure,
and so is a claim with no quote at all. If you cannot find a line in the source that
supports something you want to say, that is the signal to not say it.

Do not put the `>` marks or quotation marks around your own sentence, and do not make the
claim a copy of the quote. The claim is what the line *means*; the quote is the evidence.
If the claim and the quote say the same words, the entry is worthless.

Rules that matter more than style:

- Every claim must come from the source material. If the lecture did not say it, it does
  not go in, however true it is. You are not adding knowledge; you are compressing what
  was said.
- Keep the specifics. "√P predictors" and "~63% of rows" and "K=5 is the default" are the
  whole value. A concept note that drops the numbers is worthless.
- Keep a stated uncertainty as an uncertainty. If the lecture said "empirically validated,
  no clean mathematical proof known", that qualifier survives into the note.
- Prefer the lecturer's framing over the textbook's. "Out-of-bag error is cross-validation
  error in disguise" is the sentence worth keeping.
- No preamble, no closing summary, no meta-commentary about the lecture or these rules.

## Gates

- headed: must_match ^### .+
- specific: must_match [0-9]
- grounded: quotes_grounded
- cited: claims_cited
- not-copied: claims_not_copied
- no-filler: no_placeholder
- no-preamble: must_not_match ^(Here|Sure|Below|In this|The following|I have)
- not-padded: max_words 700
- substantial: min_words 60

## Rubric

1. Each claim follows from the quote beneath it — the quote is real, but it must also
   actually support what the claim says. This is the one line the deterministic gates
   cannot settle, and the only one worth spending a cloud step on.
2. No numeric detail stated in the source is dropped or rounded away.
3. A qualifier the source attached to a claim is still attached to it.
4. Each entry is one concept, not a merged pair.
5. Nothing in the output is a restatement of the instructions or a comment on the task.
