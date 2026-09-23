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
// How long a query waits for its embedding before retrieving lexical-only.
// Warm, embedding takes ~25 ms; this only bites on a cold load under pressure.
const EMBED_WAIT_MS = 5_000;
const embedCache = new Map();

function columns(alias) {
  return NODE_COLUMNS.split(', ').map((col) => `${alias}.${col}`).join(', ');
}

function supersededSql(alias) {
  return `EXISTS (SELECT 1 FROM node_relationships s
                  WHERE s.target_id = ${alias}.id AND s.type = 'supersedes') AS superseded`;
}

function remember(key, vector) {
  embedCache.set(key, vector);
  if (embedCache.size > EMBED_CACHE_MAX) embedCache.delete(embedCache.keys().next().value);
}

function within(promise, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, ms, null);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Iterative workflows re-ask near-identical queries; skipping the embedding
// pass is the cheapest TTFT win available (ADR §6.4). Returns null when the
// embedding is unavailable or slower than the wait budget: retrieval then runs
// lexical-only rather than failing, which is what lets the router answer
// "no_ollama" at all. A slow request is left running, so the model finishes
// loading and the vector is cached for the next ask.
async function cachedEmbedQuery(query, { compute = true } = {}) {
  const key = query.toLowerCase().replace(/\s+/g, ' ').trim();
  const hit = embedCache.get(key);
  if (hit) {
    embedCache.delete(key);
    embedCache.set(key, hit);
    return { vector: hit, cached: true };
  }
  if (!compute) return null;

  const pending = embedQuery(query).then((vector) => {
    remember(key, vector);
    return vector;
  });
  pending.catch(() => {});
  try {
    const vector = await within(pending, EMBED_WAIT_MS);
    if (vector) return { vector, cached: false };
    console.warn(`query embedding exceeded ${EMBED_WAIT_MS} ms; retrieving lexical-only while it finishes`);
  } catch (err) {
    console.warn(`query embedding unavailable, retrieving lexical-only: ${err.message}`);
  }
  return null;
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

export function presentNode({ node, score, similarity, lexicalRank, boosts, via }) {
  return {
    ...node,
    score,
    similarity: similarity ?? null,
    lexicalRank: lexicalRank ?? null,
    boosts: boosts ?? null,
    via: via ?? null,
  };
}

// Scores candidates without side effects, so a router can pack them under more
// than one tier before anything is recorded. `embed: false` skips the model
// call when the caller already knows Ollama is down.
export async function gatherCandidates({ ownerId, query, project, tier = 'local_7b', overrides, embed = true }) {
  const pool = getPool();
  const config = resolveConfig(tier, overrides);

  const embedStart = performance.now();
  const embedding = await cachedEmbedQuery(query, { compute: embed });
  const embeddingLatencyMs = embedding ? Math.round(performance.now() - embedStart) : null;

  const retrievalStart = performance.now();
  const [dense, lexical, task] = await Promise.all([
    embedding ? denseCandidates(pool, ownerId, embedding.vector) : [],
    lexicalCandidates(pool, ownerId, query),
    embedding && config.features.task_inference ? inferTask(pool, embedding.vector) : null,
  ]);
  const scored = fuseAndScore({ dense, lexical, project, task, now: new Date(), config });
  const candidates = config.features.expansion
    ? await expandFromSeeds(pool, ownerId, scored, { query, config })
    : scored;

  return {
    config,
    task,
    candidates,
    embeddingLatencyMs,
    embeddingCached: embedding?.cached ?? false,
    retrievalLatencyMs: performance.now() - retrievalStart,
  };
}

export async function summarizeRetrieval({ ownerId, tier, gathered, packed }) {
  const baselineStart = performance.now();
  const available = await tokensBaseline(getPool(), ownerId, packed.selected);
  const { selected, tokens } = packed;
  return {
    tier,
    embeddingLatencyMs: gathered.embeddingLatencyMs,
    embeddingCached: gathered.embeddingCached,
    retrievalLatencyMs: Math.round(gathered.retrievalLatencyMs + performance.now() - baselineStart),
    nodesRetrieved: selected.length,
    tokensInjected: tokens,
    tokensAvailable: available,
    efficiencyRatio: available > 0 ? tokens / available : null,
    inferredTaskType: gathered.task?.task ?? null,
    taskConfidence: gathered.task?.confidence ?? null,
    supersededNodesDemoted: selected.filter((entry) => entry.node.superseded).length,
    sourceTypeBoostApplied: selected.filter((entry) => entry.boosts?.source > 0).length,
  };
}

// `served: false` logs a query the router refused: its context is recorded for
// analysis, but the nodes were never used, so their access counts stay put.
export async function recordRetrieval({ queryId, ownerId, sessionId, query, metrics, selected, routing, served = true }) {
  if (served && selected.length > 0) {
    await getPool().query(
      'UPDATE nodes SET last_accessed = now(), access_count = access_count + 1 WHERE id = ANY($1)',
      [selected.map((entry) => entry.node.id)]
    );
  }
  // One transaction: feedback marks nodes useful through query_context_nodes,
  // so a metrics row must never be visible without its context rows.
  const client = await getPool().connect();
  let id;
  try {
    await client.query('BEGIN');
    id = await logQueryMetrics({ queryId, queryText: query, sessionId, ownerId, ...metrics, ...routing }, client);
    await logContextNodes(
      id,
      selected.map((entry, position) => ({
        nodeId: entry.node.id,
        position,
        score: entry.score,
        decayLambda: DECAY_LAMBDA[entry.node.type],
      })),
      client
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  if (sessionId) await markFollowUp(sessionId, id);
  return id;
}

export async function retrieve({ ownerId, query, project, tier = 'local_7b', overrides, sessionId }) {
  const gathered = await gatherCandidates({ ownerId, query, project, tier, overrides });
  const packed = packIntoBudget(gathered.candidates, gathered.config);
  const metrics = await summarizeRetrieval({ ownerId, tier, gathered, packed });
  const queryId = await recordRetrieval({ ownerId, sessionId, query, metrics, selected: packed.selected });

  return {
    queryId,
    tier,
    task: gathered.task,
    context: buildContext(packed.selected),
    nodes: packed.selected.map(presentNode),
    candidates: gathered.candidates,
    metrics,
  };
}
