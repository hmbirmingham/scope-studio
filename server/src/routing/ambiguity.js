// A free clarifying question: when the strongest candidates are spread across
// projects, the query is ambiguous and the UI can offer a one-tap narrowing
// while the model prefills. Derived from retrieval scores, so it costs no
// model call and never delays the answer.

const TOP_CANDIDATES = 8;
// One project holding this much of the score is a clear winner — asking would
// be noise.
const DOMINANT_SHARE = 0.7;
const MAX_SUGGESTIONS = 3;

export function projectAmbiguity(candidates) {
  const totals = new Map();
  for (const entry of candidates.slice(0, TOP_CANDIDATES)) {
    const { project } = entry.node;
    if (!project) continue;
    totals.set(project, (totals.get(project) ?? 0) + entry.score);
  }
  if (totals.size < 2) return null;

  const sum = [...totals.values()].reduce((a, b) => a + b, 0);
  const ranked = [...totals]
    .map(([project, score]) => ({ project, share: score / sum }))
    .sort((a, b) => b.share - a.share);
  if (ranked[0].share >= DOMINANT_SHARE) return null;
  return ranked.slice(0, MAX_SUGGESTIONS);
}
