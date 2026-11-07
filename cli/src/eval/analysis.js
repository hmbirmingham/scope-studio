// In-work analysis: the structured decomposition of an answer, produced while
// the work is done rather than reconstructed afterwards. One representation,
// three consumers — the deterministic gates, the grader, and the corrector —
// so all three argue about the same units instead of about prose.
//
// The unit is a claim with the source text that supports it:
//
//   ### Out-of-Bag Error
//   Those unused rows serve as a pseudo test set.
//   > Bootstrap samples use ~63% of rows per tree, leaving ~37% untouched
//
// A blockquote is a citation. That one convention is what turns grounding from
// something a judge has to weigh into something a string match settles: a quote
// either occurs in the source or it does not. What a judge is still needed for
// is whether the claim follows from the quote, which is a smaller question.

/**
 * Strip quotation marks the model wrapped around the whole citation. It is
 * marking a quotation, not quoting a quotation: on the first live run every
 * one of twelve real quotes was reported ungrounded because of this.
 */
function unwrap(text) {
  const trimmed = text.trim();
  const pairs = [
    ['"', '"'],
    ["'", "'"],
    ['\u201c', '\u201d'],
    ['\u2018', '\u2019'],
  ];
  for (const [open, close] of pairs) {
    if (trimmed.length > 1 && trimmed.startsWith(open) && trimmed.endsWith(close)) {
      return trimmed.slice(open.length, -close.length).trim();
    }
  }
  return trimmed;
}

/** Normalise the characters models substitute silently, and nothing else. */
export function normalizeQuote(text) {
  return unwrap(text)
    // All quote marks fold to one character. A model that wraps a citation in
    // double quotes switches the inner ones to single quotes, which changes
    // presentation, not content — it cost three false positives on the live
    // runs before being folded here.
    .replace(/['"‘’ʼ“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/[≈]/g, '~')
    // Reference markers are furniture, not content: a page carries "[ 1 ]" and
    // nobody quoting it types that.
    .replace(/\[\s*\d+\s*\]/g, ' ')
    .replace(/\s+/g, ' ')
    // Stripping inline tags leaves spaces stranded around punctuation, so a
    // fetched page reads "( DCG )" and "retrieval ." while the model quotes it
    // the way a person would. Spacing around punctuation is presentation.
    .replace(/\s+([.,;:!?%)\]}])/g, '$1')
    .replace(/([(\[{])\s+/g, '$1')
    .trim()
    .toLowerCase();
}

/**
 * Split an answer into claims. A claim is a prose line under a heading; the
 * blockquotes that follow it are its citations.
 * @returns {{sections: Array<{heading: string|null, claims: Array<{text: string, quotes: string[], line: number}>}>}}
 */
export function parseAnalysis(output) {
  const sections = [];
  let section = { heading: null, claims: [] };
  let claim = null;

  const push = () => {
    if (claim) section.claims.push(claim);
    claim = null;
  };

  // Fenced blocks and horizontal rules are furniture, not assertions. Observed
  // live: a model wrapped a formula in a code fence and the three backticks
  // each became a claim, so `cited` reported eight uncited claims and the
  // corrector told the next attempt that "```" needed a supporting quote. A
  // correction note the model cannot act on is worse than none — it spends an
  // attempt and teaches the wrong lesson.
  let inFence = false;

  output.split('\n').forEach((raw, i) => {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) {
      // The fence closes the claim above it rather than extending it: a formula
      // is evidence for the preceding prose, not a new assertion.
      push();
      inFence = !inFence;
      return;
    }
    if (inFence) return;
    // A rule is a separator, so it ends the current claim like a blank line.
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line)) {
      push();
      return;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading) {
      push();
      if (section.heading !== null || section.claims.length) sections.push(section);
      section = { heading: heading[1].trim(), claims: [] };
      return;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      // A quote with no claim above it cites nothing; keep it as a claimless
      // entry so the gates can say so rather than silently ignoring it.
      if (!claim) claim = { text: '', quotes: [], line: i + 1 };
      if (quote[1].trim()) claim.quotes.push(quote[1].trim());
      return;
    }
    if (line === '') {
      push();
      return;
    }
    // Bullets and prose both carry claims; strip the marker, keep the text.
    const text = line.replace(/^[-*+]\s+/, '').replace(/^\d+\.\s+/, '');
    if (claim && claim.quotes.length === 0) claim.text = `${claim.text} ${text}`.trim();
    else {
      push();
      claim = { text, quotes: [], line: i + 1 };
    }
  });
  push();
  if (section.heading !== null || section.claims.length) sections.push(section);
  return { sections };
}

/** Every claim across every section, flattened, as the grader sees them. */
export function claimsOf(analysis) {
  return analysis.sections.flatMap((section) =>
    section.claims.map((claim) => ({ ...claim, heading: section.heading }))
  );
}

/**
 * Which citations are real. A quote is grounded when it occurs in the source
 * material; this is the check that catches a true-sounding sentence the source
 * never contained.
 */
export function groundQuotes(analysis, sourceText) {
  const haystack = normalizeQuote(sourceText);
  const grounded = [];
  const ungrounded = [];
  for (const claim of claimsOf(analysis)) {
    for (const quote of claim.quotes) {
      const entry = { quote, heading: claim.heading, line: claim.line };
      if (haystack.includes(normalizeQuote(quote))) grounded.push(entry);
      else ungrounded.push(entry);
    }
  }
  return { grounded, ungrounded };
}

/**
 * Claims that are just a copy of source text. The grounding gate can be
 * satisfied by pairing two source lines against each other, which passes every
 * deterministic check and produces incoherent output — observed on the second
 * live run. A claim is meant to compress the source, so one that reproduces it
 * verbatim, or merely restates its own quote, is not a claim.
 */
export function copiedClaims(analysis, sourceText) {
  const haystack = normalizeQuote(sourceText);
  return claimsOf(analysis).filter((claim) => {
    if (claim.text === '') return false;
    const text = normalizeQuote(claim.text);
    // Too short to judge: a handful of words may coincide innocently.
    if (text.split(' ').length < 6) return false;
    if (haystack.includes(text)) return true;
    return claim.quotes.some((quote) => normalizeQuote(quote) === text);
  });
}

/** Claims asserting something with nothing to support them. */
export function uncitedClaims(analysis) {
  return claimsOf(analysis).filter((claim) => claim.text !== '' && claim.quotes.length === 0);
}

/**
 * What the corrector is told. Per-claim and specific: the failing claims are
 * named so the next attempt repairs those and leaves the rest untouched, which
 * is the whole reason the analysis is structured.
 */
export function correctionNotes(analysis, sourceText, { minClaims = null } = {}) {
  const { ungrounded } = groundQuotes(analysis, sourceText);
  const uncited = uncitedClaims(analysis);
  const notes = [];
  // Deletion used to be offered as an equal option — "quote it exactly, or
  // delete the claim" — and the model took it every time, because deleting is
  // cheaper than re-reading the source. Measured over four attempts: the second
  // was the best of the run (four grounded quotes, every claim cited) and the
  // third and fourth collapsed to a single claim each, failing the coverage
  // gate they had been passing. The corrector and the coverage gate were giving
  // contradictory instructions and the model took the cheap branch.
  //
  // The gate-gaming rule applies to the corrector too, and this is its version:
  // whatever the cheapest way to satisfy a correction note is, that is what
  // happens. So the floor is stated first, before any note that could be read
  // as permission to cut.
  if (minClaims !== null) {
    notes.push(
      `Keep at least ${minClaims} claims. Repair the claims named below by fixing their ` +
        `quotes — deleting a claim to avoid a bad quote fails the coverage check and is not a fix.`
    );
  }
  for (const claim of copiedClaims(analysis, sourceText)) {
    notes.push(
      `Under "${claim.heading ?? 'untitled'}", the claim is copied from the source instead of ` +
        `explaining it: "${claim.text.slice(0, 120)}". Say in your own words what it means, and ` +
        `keep the source line in the quote.`
    );
  }
  for (const { heading, quote } of ungrounded) {
    notes.push(
      `Under "${heading ?? 'untitled'}", this quote is not in the source material: "${quote}". ` +
        // Named explicitly because it is now the dominant failure, twice over:
        // the model joins two sentences that the page separates with a formula
        // or another sentence, producing a quote that reads right and does not
        // exist. "Quote exactly" did not convey that; "one continuous passage"
        // does.
        `Replace it with ONE continuous passage copied from the source — a single unbroken run of ` +
        `text, not two sentences joined together. If the sentences you want are separated in the ` +
        `source by anything at all, quote only one of them.`
    );
  }
  for (const claim of uncited) {
    notes.push(
      `Under "${claim.heading ?? 'untitled'}", this claim has no supporting quote: "${claim.text.slice(0, 120)}". ` +
        `Add one exact, continuous sentence from the source beneath it.`
    );
  }
  return notes;
}
