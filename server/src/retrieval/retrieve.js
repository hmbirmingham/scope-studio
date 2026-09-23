import { getPool } from '../db/pool.js';
import { embedQuery } from '../lib/embeddings.js';
import { logQueryMetrics, logContextNodes, markFollowUp } from '../models/metricsStore.js';
import {
  DECAY_LAMBDA,
  DENSE_CANDIDATES,
  EXPANSION_DECAY,
  EXPANSION_SEEDS,
  LEXICAL_CANDIDATES,
  LEXICAL_MIN_MATCH,
  RARE_TERM_MAX_DF,
  SUPERSEDE_DEMOTION,
  fuseAndScore,
  resolveConfig,
} from './score.js';
import { inferTask } from './taskInference.js';

const NODE_COLUMNS =
  'id, type, content, source, project, created_at, last_accessed, last_confirmed_useful, ' +
  'access_count, confirmed_useful_count, token_length, privacy';

const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 'her', 'was', 'one',
  'our', 'out', 'has', 'his', 'how', 'its', 'may', 'new', 'now', 'old', 'see', 'way', 'who',
  'did', 'get', 'let', 'say', 'she', 'too', 'use', 'what', 'does', 'this', 'that', 'with',
  'from', 'have', 'they', 'will', 'your', 'when', 'where', 'which', 'there', 'their', 'about',
  'would', 'could', 'should', 'into', 'than', 'then', 'them', 'these', 'those', 'over', 'why',
  'self',
]);

// Edge semantics per ADR §2.3: traversal is forward only (seed is the source).
const EDGE_WEIGHTS = { depends_on: 1.0, references: 0.7, part_of: 0.7, caused_by: 1.0, supersedes: 1.0 };
const WHY_PATTERN = /^\s*(why|how come|what('s| is| was) the reason)\b/i;
const WHY_CAUSED_BY_BOOST = 1.5;

const EMBED_CACHE_MAX = 256;
const embedCache = new Map();

function columns(alias) {
  return NODE_COLUMNS.split(', ').map((col) => `${alias}.${col}`).join(', ');
}

function supersededSql(alias) {
  return `EXISTS (SELECT 1 FROM node_relationships s
                  WHERE s.target_id = ${alias}.id AND s.type = 'supersedes') AS superseded`;
}

// Iterative workflows re-ask near-identical queries; skipping the embedding
// pass is the cheapest TTFT win available (ADR §6.4).
async function cachedEmbedQuery(query) {
  const key = query.toLowerCase().replace(/\s+/g, ' ').trim();
  const hit = embedCache.get(key);
  if (hit) {
    embedCache.delete(key);
    embedCache.set(key, hit);
    return { vector: hit, cached: true };
  }
  const vector = await embedQuery(query);
  embedCache.set(key, vector);
  if (embedCache.size > EMBED_CACHE_MAX) embedCache.delete(embedCache.keys().next().value);
  return { vector, cached: false };
}

// Mirrors the index side (migration 008): identifiers split on non-alphanumerics.
function toLexicalTerms(query) {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length >= 3 && !STOPWORDS.has(term));
  return [...new Set(terms)];
}

async function denseCandidates(pool, ownerId, vector) {
  const { rows } = await pool.query(
    `SELECT ${columns('nodes')}, ${supersededSql('nodes')},
            1 - (embedding <=> $1::vector) AS similarity
     FROM nodes
     WHERE embedding IS NOT NULL AND owner_id = $3
     ORDER BY embedding <=> $1::vector
     LIMIT $2`,
    [`[${vector.join(',')}]`, DENSE_CANDIDATES, ownerId]
  );
  return rows.map(({ similarity, ...node }) => ({ node, similarity: Number(similarity) }));
}

// A lexical hit needs several matched terms — a single shared common word is
// noise RRF would otherwise reward — unless the matched term is rare across
// this owner's nodes: "flask" in 3 of 900 files is the answer, not noise.
async function lexicalCandidates(pool, ownerId, query) {
  const terms = toLexicalTerms(query);
  if (terms.length === 0) return [];
  const minMatch = Math.min(LEXICAL_MIN_MATCH, terms.length);
  const { rows } = await pool.query(
    `WITH df AS (
       SELECT t.term, count(n.id)::int AS docs
       FROM unnest($3::text[]) AS t(term)
       LEFT JOIN nodes n ON n.owner_id = $5 AND n.content_tsv @@ to_tsquery('simple', t.term)
       GROUP BY t.term
     ),
     rare AS (
       SELECT string_agg(term, ' | ') AS tsquery
       FROM df
       WHERE docs > 0
         AND docs <= GREATEST(1, floor((SELECT count(*) FROM nodes WHERE owner_id = $5) * $6::float8))
     )
     SELECT ${columns('nodes')}, ${supersededSql('nodes')},
            ts_rank_cd(content_tsv, to_tsquery('simple', $1)) AS rank
     FROM nodes
     WHERE owner_id = $5
       AND content_tsv @@ to_tsquery('simple', $1)
       AND (
         (SELECT count(*) FROM unnest($3::text[]) AS t(term)
          WHERE content_tsv @@ to_tsquery('simple', t.term)) >= $4
         OR ((SELECT tsquery FROM rare) IS NOT NULL
             AND content_tsv @@ to_tsquery('simple', (SELECT tsquery FROM rare)))
       )
     ORDER BY rank DESC
     LIMIT $2`,
    [terms.join(' | '), LEXICAL_CANDIDATES, terms, minMatch, ownerId, RARE_TERM_MAX_DF]
  );
  return rows.map(({ rank, ...node }) => ({ node, rank: Number(rank) }));
}

// One forward hop from the strongest seeds only — the "minimum connected
// subgraph". Superseded targets are pulled in near-zero, not dropped (ADR §2.3).
async function expandFromSeeds(pool, ownerId, scored, { query, config }) {
  const seeds = scored.slice(0, EXPANSION_SEEDS);
  if (seeds.length === 0) return scored;

  const seedIds = seeds.map((entry) => entry.node.id);
  const seedScore = new Map(seeds.map((entry) => [entry.node.id, entry.score]));
  const { rows } = await pool.query(
    `SELECT r.source_id, r.weight, r.type AS relationship, ${columns('n')}, ${supersededSql('n')}
     FROM node_relationships r
     JOIN nodes n ON n.id = r.target_id AND n.owner_id = $2
     WHERE r.source_id = ANY($1)`,
    [seedIds, ownerId]
  );

  const whyQuery = WHY_PATTERN.test(query);
  const byId = new Map(scored.map((entry) => [entry.node.id, entry]));
  for (const { source_id, weight, relationship, ...node } of rows) {
    let edge = EDGE_WEIGHTS[relationship];
    if (relationship === 'caused_by' && whyQuery) edge *= WHY_CAUSED_BY_BOOST;
    const demotion = config.features.supersede_demotion && node.superseded ? SUPERSEDE_DEMOTION : 1;
    const score = seedScore.get(source_id) * Number(weight) * edge * EXPANSION_DECAY * demotion;

    const existing = byId.get(node.id);
    if (!existing) {
      byId.set(node.id, { node, score, via: { from: source_id, relationship } });
    } else if (score > existing.score) {
      existing.score = score;
      existing.via = { from: source_id, relationship };
    }
  }
  return [...byId.values()].sort((a, b) => b.score - a.score);
}

function packIntoBudget(candidates, config) {
  const selected = [];
  let tokens = 0;
  for (const entry of candidates) {
    if (selected.length >= config.max_nodes) break;
    const cost = entry.node.token_length;
    if (tokens + cost > config.max_context_tokens) continue;
    selected.push(entry);
    tokens += cost;
  }
  return { selected, tokens };
}

// Lets the router re-pack under a stricter tier after privacy flags are known,
// without re-querying (provisional tier, then re-pack).
export function packForTier(candidates, tier, overrides) {
  return packIntoBudget(candidates, resolveConfig(tier, overrides));
}

// Baseline for the efficiency claim: what the user would otherwise have pasted —
// the full context of the project(s) the answer actually drew from. Summing the
// whole database would make the ratio look better with every unrelated ingest.
async function tokensBaseline(pool, ownerId, selected) {
  if (selected.length === 0) return 0;
  const projects = [...new Set(selected.map((entry) => entry.node.project).filter(Boolean))];
  const includeUnassigned = selected.some((entry) => entry.node.project == null);
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(token_length), 0) AS tokens
     FROM nodes
     WHERE owner_id = $1 AND (project = ANY($2::text[]) OR ($3 AND project IS NULL))`,
    [ownerId, projects, includeUnassigned]
  );
  return Number(rows[0].tokens);
}

function buildContext(selected) {
  return selected
    .map(({ node }) => `[${node.type}${node.project ? ` · ${node.project}` : ''}]\n${node.content}`)
    .join('\n\n');
}

export async function retrieve({ ownerId, query, project, tier = 'local_7b', overrides, sessionId }) {
  const pool = getPool();
  const config = resolveConfig(tier, overrides);
  const now = new Date();

  const embedStart = performance.now();
  const { vector, cached } = await cachedEmbedQuery(query);
  const embeddingLatencyMs = Math.round(performance.now() - embedStart);

  const retrievalStart = performance.now();
  const [dense, lexical, task] = await Promise.all([
    denseCandidates(pool, ownerId, vector),
    lexicalCandidates(pool, ownerId, query),
    config.features.task_inference ? inferTask(pool, vector) : null,
  ]);
  const scored = fuseAndScore({ dense, lexical, project, task, now, config });
  const candidates = config.features.expansion
    ? await expandFromSeeds(pool, ownerId, scored, { query, config })
    : scored;
  const { selected, tokens } = packIntoBudget(candidates, config);
  const available = await tokensBaseline(pool, ownerId, selected);

  if (selected.length > 0) {
    await pool.query(
      'UPDATE nodes SET last_accessed = now(), access_count = access_count + 1 WHERE id = ANY($1)',
      [selected.map((entry) => entry.node.id)]
    );
  }
  const retrievalLatencyMs = Math.round(performance.now() - retrievalStart);

  const metrics = {
    tier,
    embeddingLatencyMs,
    embeddingCached: cached,
    retrievalLatencyMs,
    nodesRetrieved: selected.length,
    tokensInjected: tokens,
    tokensAvailable: available,
    efficiencyRatio: available > 0 ? tokens / available : null,
    inferredTaskType: task?.task ?? null,
    taskConfidence: task?.confidence ?? null,
    supersededNodesDemoted: selected.filter((entry) => entry.node.superseded).length,
    sourceTypeBoostApplied: selected.filter((entry) => entry.boosts?.source > 0).length,
  };
  const queryId = await logQueryMetrics({ queryText: query, sessionId, ownerId, ...metrics });
  await Promise.all([
    logContextNodes(
      queryId,
      selected.map((entry, position) => ({
        nodeId: entry.node.id,
        position,
        score: entry.score,
        decayLambda: DECAY_LAMBDA[entry.node.type],
      }))
    ),
    sessionId ? markFollowUp(sessionId, queryId) : null,
  ]);

  return {
    queryId,
    tier,
    task,
    context: buildContext(selected),
    nodes: selected.map(({ node, score, similarity, lexicalRank, boosts, via }) => ({
      ...node,
      score,
      similarity: similarity ?? null,
      lexicalRank: lexicalRank ?? null,
      boosts: boosts ?? null,
      via: via ?? null,
    })),
    candidates,
    metrics,
  };
}
