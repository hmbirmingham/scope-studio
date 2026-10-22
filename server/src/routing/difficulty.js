// Which questions are worth a cloud answer even when the local model is up.
// A local 8B model handles lookups well ("what does quantify_colonies return")
// and gets the rest wrong in ways that read as right: comparisons, causes,
// code changes and multi-part asks. Measured on the live corpus: the cloud
// answer to a comparison question caught a caveat the smaller models missed.
// The rule is deliberately plain words, so it can be read and tuned.
//
// Not a criterion: "the evidence did not fit the local budget". Tried and
// removed — a file split into many near-identical chunks always leaves strong
// chunks out, so it sent 9 of the 20 benchmark lookups to the cloud (one live
// lookup went to Opus for $0.055), while the benchmark shows a bigger budget
// barely moves the local hit rate.

const HARD_PATTERNS = [
  // Comparing and judging.
  /\b(compare|comparison|versus|vs\.?|better than|worse than|trade-?offs?|pros and cons|alternatives?|competitors?|competitive|benchmark against)\b/i,
  // Causes and reasons.
  /^\s*(why|how come)\b/i,
  /\b(explain why|root cause|what caused|reason for)\b/i,
  // Changing or building code.
  /\b(refactor|rewrite|implement|redesign|architect|migrate|optimi[sz]e|debug|fix (the|this|a)|add (a|an) (feature|test|endpoint))\b/i,
  // A request that opens on a change verb asks for work, not a lookup: "fix
  // solve_2cmt so…", "add a unit test that…", "make the limit per coach".
  // Some phrasings only borrow the verb: "update me on…", "add up…", "make a
  // list of…" ask for a lookup.
  /^\s*(please\s+)?(fix|add(?! up\b)|make(?! a list\b)|change|update(?! me\b)|rename|remove|convert)\b/i,
  // Writing: a drafted paragraph, section or function is judged on quality a
  // small model rarely reaches, whatever the topic. "Write down…" copies a
  // value out, which is a lookup.
  /^\s*(please\s+)?(draft|write(?! down\b)|compose)\b/i,
  // Judging whether something is safe, sufficient or right, and what a change
  // would do: yes/no in form, but the answer is an analysis.
  // "safe" and "hold" also name things ("the safe mode flag", "hold a lock"),
  // so they count only in a judgement form: safe to/under/for…, holding up
  // or holding a quantity.
  /^\s*(is|are|does|do|will|would|can|could)\b.*\b(unsafe|enough|sufficient|race-?free|thread-?safe|safe (to|under|for|when|if|with)|hold up|hold a \d+|withstand)\b/i,
  /\bis (it|this|that) safe\b/i,
  /^\s*should (we|i)\b/i,
  /\bwhat (would|will|could) (break|happen|go wrong)\b/i,
  // Asking for a proposal, a derivation or a check run over the whole design.
  /^\s*(please\s+)?(suggest|propose|derive)\b/i,
  // "Explain what X does" is a lookup; explaining a difference or a
  // trade-off is not ("explain why" is a cause, above).
  /^\s*(please\s+)?explain (the difference|the trade-?offs?|how come)\b/i,
  // Only a check run as a task: "check the BOM for the part number of the
  // MOSFET" is a lookup, so a bare leading "check" does not count.
  /^\s*(please\s+)?(run|do) an? .*\bcheck\b/i,
  // Reviewing and planning, as something asked for. The words also name
  // things — "open peer review", "the review queue page", "show me the plan
  // for…" — so they count only leading the request or acting on an object.
  /^\s*(please\s+)?(review|audit|evaluate|assess|critique|plan)\b/i,
  /\b(review|audit|evaluate|assess|critique) (the|this|that|my|our|whether|how)\b/i,
  /\bdesign (a|an|the)\b/i,
];

const LONG_QUESTION_WORDS = 35;

export function hardWording(query) {
  const text = query.trim();
  if (HARD_PATTERNS.some((pattern) => pattern.test(text))) return 'wording';
  if (text.split(/\s+/).length > LONG_QUESTION_WORDS) return 'length';
  if ((text.match(/\?/g) ?? []).length >= 2) return 'multi_part';
  return null;
}

// Null for a question the local model should answer, or why it is hard.
export function questionDifficulty(query) {
  return hardWording(query);
}
