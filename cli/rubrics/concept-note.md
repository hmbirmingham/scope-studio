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
- <the mechanism, the number, or the condition that makes it true>
```

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
- no-filler: no_placeholder
- no-preamble: must_not_match ^(Here|Sure|Below|In this|The following|I have)
- not-padded: max_words 500
- substantial: min_words 60

## Rubric

1. Every concept in the output appears in the source material; nothing is imported from
   outside knowledge.
2. No numeric detail stated in the source is dropped or rounded away.
3. A qualifier the source attached to a claim is still attached to it.
4. Each entry is one concept, not a merged pair.
5. Nothing in the output is a restatement of the instructions or a comment on the task.
