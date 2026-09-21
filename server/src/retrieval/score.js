// Boosts multiply the fused rank score instead of adding to cosine similarity:
// nomic similarities cluster in a narrow band, so additive bumps would let a
// recent irrelevant node outrank the best match. Constants are benchmark-tuned.

export const DENSE_CANDIDATES = 20;
export const LEXICAL_CANDIDATES = 20;
export const LEXICAL_MIN_MATCH = 2;
export const RRF_K = 60;
export const MIN_SIMILARITY = 0.55;
export const EXPANSION_SEEDS = 3;
export const EXPANSION_DECAY = 0.5;
export const MAX_CONTEXT_NODES = 10;
export const CONTEXT_TOKEN_BUDGET = 1500;

const DAY_MS = 24 * 60 * 60 * 1000;
const RECENCY_BOOST_24H = 0.4;
const RECENCY_BOOST_7D = 0.2;
const PROJECT_BOOST = 0.3;
const TASK_TYPE_BOOST = 0.3;

// Intentionally empty: the static task-type → node-type mapping is being
// replaced by a dynamic boost design (see dev-notes/research/).
export const TASK_TYPE_BOOSTS = {};

function recencyBoost(lastAccessed, now) {
  const age = now - new Date(lastAccessed);
  if (age < DAY_MS) return RECENCY_BOOST_24H;
  if (age < 7 * DAY_MS) return RECENCY_BOOST_7D;
  return 0;
}

export function fuseAndScore({ dense, lexical, project, taskType, now }) {
  const byId = new Map();

  dense.forEach(({ node, similarity }, index) => {
    byId.set(node.id, { node, similarity, rrf: 1 / (RRF_K + index + 1) });
  });
  lexical.forEach(({ node }, index) => {
    const entry = byId.get(node.id) ?? { node, similarity: null, rrf: 0 };
    entry.lexicalRank = index + 1;
    entry.rrf += 1 / (RRF_K + index + 1);
    byId.set(node.id, entry);
  });

  const boostedTypes = TASK_TYPE_BOOSTS[taskType] ?? [];
  const scored = [];
  for (const entry of byId.values()) {
    // Relevance floor: boosts may re-rank relevant nodes, never promote irrelevant ones.
    const relevant = entry.lexicalRank !== undefined || entry.similarity >= MIN_SIMILARITY;
    if (!relevant) continue;

    const multiplier =
      1 +
      recencyBoost(entry.node.last_accessed, now) +
      (project && entry.node.project === project ? PROJECT_BOOST : 0) +
      (boostedTypes.includes(entry.node.type) ? TASK_TYPE_BOOST : 0);
    scored.push({ ...entry, score: entry.rrf * multiplier });
  }
  return scored.sort((a, b) => b.score - a.score);
}
