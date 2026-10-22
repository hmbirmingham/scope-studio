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
  /^\s*(please\s+)?(fix|add|make|change|update|rename|remove|convert)\b/i,
  // Writing: a drafted paragraph, section or function is judged on quality a
  // small model rarely reaches, whatever the topic.
  /^\s*(please\s+)?(draft|write|compose)\b/i,
  // Judging whether something is safe, sufficient or right, and what a change
  // would do: yes/no in form, but the answer is an analysis.
  /^\s*(is|are|does|do|will|would|can|could)\b.*\b(safe|unsafe|enough|sufficient|race-?free|thread-?safe|hold up|hold a|withstand)\b/i,
  /^\s*should (we|i)\b/i,
  /\bwhat (would|will|could) (break|happen|go wrong)\b/i,
  // Asking for a proposal, a derivation or a check run over the whole design.
  /^\s*(please\s+)?(suggest|propose|derive|explain)\b/i,
  // Only a check run as a task: "check the BOM for the part number of the
  // MOSFET" is a lookup, so a bare leading "check" does not count.
  /^\s*(please\s+)?(run|do) an? .*\bcheck\b/i,
  // Reviewing and planning.
  /\b(review|audit|evaluate|assess|critique|plan for|design (a|an|the))\b/i,
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
