// Relevance judgements for the retrieval benchmark. An expectation names a
// node a correct answer needs: its project, optionally the end of its path,
// and optionally a pattern the chunk's content must contain (case-insensitive).
// A ten-chunk file usually has one chunk that answers the question; a
// cross-project question ("which repos use Flask") is answered by any chunk
// of the project that shows it, so those expectations give no path.

const CHUNK_PREFIX = /^[^|]*\|[^|]*\|/;

// Chunked nodes carry `<repoId>|<index>|<path>`; repository nodes carry only
// the repository id, so they have no path and never satisfy a path expectation.
export function nodePath(node) {
  if (!node.external_id || !CHUNK_PREFIX.test(node.external_id)) return null;
  return node.external_id.replace(CHUNK_PREFIX, '');
}

export function isRelevant(node, expectation) {
  if (node.project !== expectation.project) return false;
  if (expectation.path) {
    const path = nodePath(node);
    if (path == null) return false;
    if (path !== expectation.path && !path.endsWith(`/${expectation.path}`)) return false;
  }
  if (!expectation.content) return true;
  return new RegExp(expectation.content, 'i').test(node.content ?? '');
}

// Judges one query. `selected` is the packed context in rank order, and
// `candidates` everything that cleared the relevance floor, so a miss can be
// told apart by cause: never retrieved, or retrieved and ranked below the budget.
export function judge({ selected, candidates, expectations }) {
  const satisfiedBy = (nodes) =>
    expectations.map((expectation) => nodes.findIndex(({ node }) => isRelevant(node, expectation)));

  const packRanks = satisfiedBy(selected);
  const candidateRanks = satisfiedBy(candidates);
  const packHits = packRanks.filter((rank) => rank >= 0);

  return {
    hit: packHits.length > 0,
    candidateHit: candidateRanks.some((rank) => rank >= 0),
    recall: expectations.length ? packHits.length / expectations.length : 0,
    mrr: packHits.length ? 1 / (Math.min(...packHits) + 1) : 0,
    satisfied: expectations.map((expectation, i) => ({
      ...expectation,
      packRank: packRanks[i] >= 0 ? packRanks[i] + 1 : null,
      candidateRank: candidateRanks[i] >= 0 ? candidateRanks[i] + 1 : null,
    })),
  };
}
