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
// A chunk that defines the identifiers the question names is the strongest
// signal code search has; usages outnumber the definition and win on term
// frequency otherwise (benchmark: `def quantify_colonies` sat at candidate #8
// behind two test files, tied by RRF with lexical-only noise). Triples the
// fused score; 1.0 measured too small to clear that gap. Applies to code-shaped
// tasks only — for a research or decision question the code that defines a term
// is rarely the answer.
export const DEFINITION_BOOST = 2.0;
export const DEFINITION_TASKS = ['codebase', 'firmware', 'data_pipeline'];

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
  definition_boost: true,
};

// Boost magnitudes live in the config so a benchmark sweep can vary them.
const DEFAULT_WEIGHTS = { definition_boost: DEFINITION_BOOST };

export function resolveConfig(tier = 'local_7b', overrides = {}) {
  const base = TIER_CONFIGS[tier];
  if (!base) throw new Error(`unknown tier: ${tier}`);
  const { features, ...params } = overrides;
  return { tier, ...DEFAULT_WEIGHTS, ...base, ...params, features: { ...DEFAULT_FEATURES, ...(features ?? {}) } };
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
  // Run working memory (migration 020): a plan or step is stale once the run
  // moves on; a finding is a conclusion and ages like a decision.
  plan: 0.08,
  step: 0.08,
  artifact: 0.08,
  question: 0.08,
  finding: 0.03,
  // The verticals (migration 039). Design files change like source files;
  // notes like decisions; excerpts and derivations like papers.
  schematic: 0.08,
  board: 0.08,
  symbol: 0.08,
  net: 0.08,
  footprint: 0.08,
  bom_row: 0.08,
  part: 0.08,
  assembly: 0.08,
  note: 0.03,
  computation: 0.03,
  excerpt: 0.01,
  derivation: 0.01,
};

// A node type added after this table would otherwise decay by NaN, and a NaN
// score sorts anywhere: the node lands at an arbitrary rank. Age it like a file.
export const DEFAULT_DECAY_LAMBDA = DECAY_LAMBDA.file;

export function decayLambda(type) {
  return DECAY_LAMBDA[type] ?? DEFAULT_DECAY_LAMBDA;
}

// The vertical types sit with the task whose questions they answer: KiCad and
// CAD nodes are hardware; notes, excerpts, derivations and a run's findings
// are the research record. Without them a hardware question boosted the
// datasheet over the schematic that answers it.
export const TASK_NODE_TYPES = {
  codebase: ['file', 'repo'],
  firmware: ['file', 'datasheet'],
  hardware: ['datasheet', 'spec', 'schematic', 'board', 'symbol', 'net', 'footprint', 'bom_row', 'part', 'assembly'],
  data_pipeline: ['file', 'repo'],
  research: ['paper', 'decision', 'spec', 'note', 'excerpt', 'derivation', 'computation', 'finding', 'question'],
  cross_project: ['repo'],
};

// Definition sites across the languages in the corpus: keyword-led forms, and
// C-style `type name(...) {`. Identifiers are split the way the lexical index
// splits them (underscores and camelCase), so `quantify_colonies` is defined
// when the query supplied both `quantify` and `colonies`.
const KEYWORD_DEFINITION =
  /\b(?:def|class|function|func|fn|struct|enum|interface|type|trait|impl|module|const|let|var|export\s+(?:default\s+)?(?:function|class|const|let|var))\s+([A-Za-z_$][\w$]*)/g;
const C_DEFINITION = /^[ \t]*(?:[A-Za-z_]\w*[\s*]+)+([A-Za-z_]\w*)\s*\([^;{}]*\)\s*\{/gm;

function identifierParts(identifier) {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((part) => part.length >= 3);
}

export function definitionMatch(node, terms) {
  if (!terms?.length || typeof node.content !== 'string') return null;
  const wanted = new Set(terms);
  for (const pattern of [KEYWORD_DEFINITION, C_DEFINITION]) {
    for (const match of node.content.matchAll(pattern)) {
      const parts = identifierParts(match[1]);
      if (parts.length && parts.every((part) => wanted.has(part))) return match[1];
    }
  }
  return null;
}

const SOURCE_TYPE_BOOSTS = [
  { task: 'hardware', sources: ['kicad', 'cad'], boost: 0.2 },
  { task: 'research', sources: ['zotero', 'overleaf'], boost: 0.1 },
];

// Anchors on created_at until confirmations exist (Sprint 6 feedback UI) —
// never last_accessed, which would reopen the rich-get-richer loop.
export function recencyBoost(node, now) {
  const anchor = node.last_confirmed_useful ?? node.created_at;
  const hours = Math.max(0, (now - new Date(anchor)) / 3_600_000);
  return Math.exp(-decayLambda(node.type) * hours);
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

function definitionBoost(node, task, terms, weight) {
  if (task && !DEFINITION_TASKS.includes(task.task)) return 0;
  return definitionMatch(node, terms) ? weight : 0;
}

export function boostMultiplier(node, { project, task, now, features, terms = [], weights = {} }) {
  const applied = {
    recency: features.recency_decay ? recencyBoost(node, now) : 0,
    project: project && node.project === project ? PROJECT_BOOST : 0,
    task: features.task_inference ? taskTypeBoost(node, task) : 0,
    source: features.source_type_boost ? sourceTypeBoost(node, task) : 0,
    definition: features.definition_boost
      ? definitionBoost(node, task, terms, weights.definition_boost ?? DEFINITION_BOOST)
      : 0,
    demotion: features.supersede_demotion && node.superseded ? SUPERSEDE_DEMOTION : 1,
  };
  const multiplier =
    (1 + applied.recency + applied.project + applied.task + applied.source + applied.definition) *
    applied.demotion;
  return { multiplier, applied };
}

// Highest score first; equal scores fall back to node id, so the same corpus
// and query always rank the same way. Without it, ties (and the candidate
// lists Postgres cuts at LIMIT) came back in whatever order the engine chose.
export function byScore(a, b) {
  return b.score - a.score || (a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0);
}

export function fuseAndScore({ dense, lexical, project, task, now, config, terms = [] }) {
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
      terms,
      weights: { definition_boost: config.definition_boost },
    });
    scored.push({ ...entry, boosts: applied, score: entry.rrf * multiplier });
  }
  return scored.sort(byScore);
}
