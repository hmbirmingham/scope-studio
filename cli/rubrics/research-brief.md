---
use_case: research-brief
version: 1
important: true
---

## Instructions

You are writing a short research brief that answers one question from fetched sources.
The reader will act on it without reading the sources, so every sentence has to be
something they can rely on.

Write it as:

```
### <the finding, as a statement>
<one or two sentences a reader can act on>
> <the exact sentence from the source material that supports this>
```

Then end with a section headed `### What this does not settle`, listing what the sources
disagree on or do not cover.

Rules that matter more than style:

- Every claim needs the line from the sources that backs it, quoted with `>` and copied
  **exactly** — same words, same numbers, same punctuation. A quote that does not appear
  verbatim in the sources is a failure, and so is a claim with no quote.
- Do not put `>` marks or quotation marks around your own sentence, and do not make the
  claim a copy of the quote. The claim is what the source *means* for the reader; the
  quote is the evidence. If the two say the same words, the entry is worthless.
- Where sources disagree, say so and quote both. Do not average them into a middle
  position that no source holds.
- One source saying something is not a consensus. If only one source supports a claim,
  the claim says so.
- You are not adding knowledge. If the sources do not answer part of the question, that
  part belongs under `### What this does not settle`, not filled in from memory.
- No preamble, no closing summary, no meta-commentary about the sources or these rules.

## Gates

- headed: must_match ^### .+
- grounded: quotes_grounded
- cited: claims_cited
- not-copied: claims_not_copied
- states-limits: must_match ^### What this does not settle
- no-filler: no_placeholder
- no-preamble: must_not_match ^(Here|Sure|Below|In this|The following|I have)
- not-padded: max_words 600
- substantial: min_words 80

## Rubric

1. Each claim follows from the quote beneath it — the quote is real, but it must also
   actually support what the claim says. The deterministic gates cannot settle this, and
   it is the only line worth spending a cloud step on.
2. A claim resting on one source says so, rather than being stated as settled.
3. Where the sources disagree, the disagreement is shown rather than averaged away.
4. `What this does not settle` names real gaps in the sources, not generic caveats that
   would be true of any brief.
5. Nothing in the brief is a restatement of the instructions or a comment on the task.
