// v1 scoring per ARCHITECTURE.md §4–5. Boosts multiply the fused rank score:
// nomic similarities cluster in a narrow band, so additive bumps on cosine
// would re-order across relevance tiers. All constants are benchmark-tunable.

export const DENSE_CANDIDATES = 20;
export const LEXICAL_CANDIDATES = 20;
export const LEXICAL_MIN_MATCH = 2;
// A term matching at most this fraction of the owner's nodes is discriminative
// enough to count as a lexical hit on its own. Calibrated on a live 871-chunk
// corpus: identifiers worth matching sat at 2–7% (flask 6.5%, watershed 3.8%),
// noise at 15%+ (return 38%, import 27%, def 26%, model 15%).
export const RARE_TERM_MAX_DF = 0.1;
export const EXPANSION_SEEDS = 3;
export const EXPANSION_DECAY = 0.5;
export const SUPERSEDE_DEMOTION = 0.1;
export const PROJECT_BOOST = 0.3;
export const TASK_TYPE_BOOST = 0.3;

// Retrieval parameters are functions of the routing tier (ADR §5).
export const TIER_CONFIGS = {
  local_7b: {
    relevance_floor: 0.65,
    max_context_tokens: 1500,
    rrf_k: 60,
    max_nodes: 5,
    enable_multi_hop: false,
    node_order: 'relevance_desc',
    prompt_structure: 'strict_xml',
  },
  cloud_frontier: {
    relevance_floor: 0.5,
    max_context_tokens: 4000,
    rrf_k: 40,
    max_nodes: 10,
    enable_multi_hop: true,
    node_order: 'relevance_desc',
    prompt_structure: 'markdown',
  },
};

// Ablation switches for the benchmark (ADR §8); all on by default.
export const DEFAULT_FEATURES = {
  recency_decay: true,
  task_inference: true,
  supersede_demotion: true,
  source_type_boost: true,
  expansion: true,
};

export function resolveConfig(tier = 'local_7b', overrides = {}) {
  const base = TIER_CONFIGS[tier];
  if (!base) throw new Error(`unknown tier: ${tier}`);
  const { features, ...params } = overrides;
  return { tier, ...base, ...params, features: { ...DEFAULT_FEATURES, ...(features ?? {}) } };
}

// Recency decay rate per node type (ADR §4); half-life = ln 2 / λ hours.
export const DECAY_LAMBDA = {
  conversation: 0.15,
  file: 0.08,
  decision: 0.03,
  spec: 0.03,
  datasheet: 0.01,
  paper: 0.01,
  repo: 0.005,
};

export const TASK_NODE_TYPES = {
  codebase: ['file', 'repo'],
  firmware: ['file', 'datasheet'],
  hardware: ['datasheet', 'spec'],
  data_pipeline: ['file', 'repo'],
  research: ['paper', 'decision', 'spec'],
  cross_project: ['repo'],
};

const SOURCE_TYPE_BOOSTS = [
  { task: 'hardware', sources: ['kicad'], boost: 0.2 },
  { task: 'research', sources: ['zotero', 'overleaf'], boost: 0.1 },
];

// Anchors on created_at until confirmations exist (Sprint 6 feedback UI) —
// never last_accessed, which would reopen the rich-get-richer loop.
export function recencyBoost(node, now) {
  const anchor = node.last_confirmed_useful ?? node.created_at;
  const hours = Math.max(0, (now - new Date(anchor)) / 3_600_000);
  return Math.exp(-DECAY_LAMBDA[node.type] * hours);
}

function taskTypeBoost(node, task) {
  if (!task || !TASK_NODE_TYPES[task.task]?.includes(node.type)) return 0;
  return TASK_TYPE_BOOST * task.confidence;
}

function sourceTypeBoost(node, task) {
  if (!task) return 0;
  const rule = SOURCE_TYPE_BOOSTS.find(
    (entry) => entry.task === task.task && entry.sources.includes(node.source)
  );
  return rule ? rule.boost : 0;
}

export function boostMultiplier(node, { project, task, now, features }) {
  const applied = {
    recency: features.recency_decay ? recencyBoost(node, now) : 0,
    project: project && node.project === project ? PROJECT_BOOST : 0,
    task: features.task_inference ? taskTypeBoost(node, task) : 0,
    source: features.source_type_boost ? sourceTypeBoost(node, task) : 0,
    demotion: features.supersede_demotion && node.superseded ? SUPERSEDE_DEMOTION : 1,
  };
  const multiplier =
    (1 + applied.recency + applied.project + applied.task + applied.source) * applied.demotion;
  return { multiplier, applied };
}

export function fuseAndScore({ dense, lexical, project, task, now, config }) {
  const byId = new Map();
  const k = config.rrf_k;

  dense.forEach(({ node, similarity }, index) => {
    byId.set(node.id, { node, similarity, rrf: 1 / (k + index + 1) });
  });
  lexical.forEach(({ node }, index) => {
    const entry = byId.get(node.id) ?? { node, similarity: null, rrf: 0 };
    entry.lexicalRank = index + 1;
    entry.rrf += 1 / (k + index + 1);
    byId.set(node.id, entry);
  });

  const scored = [];
  for (const entry of byId.values()) {
    // Relevance floor: boosts may re-rank relevant nodes, never promote irrelevant ones.
    const relevant =
      entry.lexicalRank !== undefined || entry.similarity >= config.relevance_floor;
    if (!relevant) continue;

    const { multiplier, applied } = boostMultiplier(entry.node, {
      project,
      task,
      now,
      features: config.features,
    });
    scored.push({ ...entry, boosts: applied, score: entry.rrf * multiplier });
  }
  return scored.sort((a, b) => b.score - a.score);
}
