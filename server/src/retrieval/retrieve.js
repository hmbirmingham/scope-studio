import { getPool } from '../db/pool.js';
import { embedQuery } from '../lib/embeddings.js';
import { logQueryMetrics } from '../models/metricsStore.js';
import {
  CONTEXT_TOKEN_BUDGET,
  DENSE_CANDIDATES,
  EXPANSION_DECAY,
  EXPANSION_SEEDS,
  LEXICAL_CANDIDATES,
  LEXICAL_MIN_MATCH,
  MAX_CONTEXT_NODES,
  fuseAndScore,
} from './score.js';

const NODE_COLUMNS = 'id, type, content, source, project, last_accessed, access_count, privacy';

const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 'her', 'was', 'one',
  'our', 'out', 'has', 'his', 'how', 'its', 'may', 'new', 'now', 'old', 'see', 'way', 'who',
  'did', 'get', 'let', 'say', 'she', 'too', 'use', 'what', 'does', 'this', 'that', 'with',
  'from', 'have', 'they', 'will', 'your', 'when', 'where', 'which', 'there', 'their', 'about',
  'would', 'could', 'should', 'into', 'than', 'then', 'them', 'these', 'those', 'over', 'why',
]);

export function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

// Mirrors the index side (migration 008): identifiers split on non-alphanumerics.
function toLexicalTerms(query) {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length >= 3 && !STOPWORDS.has(term));
  return [...new Set(terms)];
}

async function denseCandidates(pool, vector) {
  const { rows } = await pool.query(
    `SELECT ${NODE_COLUMNS}, 1 - (embedding <=> $1::vector) AS similarity
     FROM nodes
     WHERE embedding IS NOT NULL
     ORDER BY embedding <=> $1::vector
     LIMIT $2`,
    [`[${vector.join(',')}]`, DENSE_CANDIDATES]
  );
  return rows.map(({ similarity, ...node }) => ({ node, similarity: Number(similarity) }));
}

// A node must match several query terms to count as a lexical hit; a single
// shared common word is noise that RRF would otherwise reward.
async function lexicalCandidates(pool, query) {
  const terms = toLexicalTerms(query);
  if (terms.length === 0) return [];
  const minMatch = Math.min(LEXICAL_MIN_MATCH, terms.length);
  const { rows } = await pool.query(
    `SELECT ${NODE_COLUMNS}, ts_rank_cd(content_tsv, to_tsquery('simple', $1)) AS rank
     FROM nodes
     WHERE content_tsv @@ to_tsquery('simple', $1)
       AND (SELECT count(*) FROM unnest($3::text[]) AS t(term)
            WHERE content_tsv @@ to_tsquery('simple', t.term)) >= $4
     ORDER BY rank DESC
     LIMIT $2`,
    [terms.join(' | '), LEXICAL_CANDIDATES, terms, minMatch]
  );
  return rows.map(({ rank, ...node }) => ({ node, rank: Number(rank) }));
}

// One-hop expansion from the strongest seeds only: this is the "minimum
// connected subgraph" — relationships pull in decision/spec context that
// embeddings alone would miss, without flooding the budget.
async function expandFromSeeds(pool, scored) {
  const seeds = scored.slice(0, EXPANSION_SEEDS);
  if (seeds.length === 0) return scored;

  const seedIds = seeds.map((entry) => entry.node.id);
  const seedScore = new Map(seeds.map((entry) => [entry.node.id, entry.score]));
  const { rows } = await pool.query(
    `SELECT r.source_id, r.target_id, r.weight, r.type AS relationship,
            ${NODE_COLUMNS.split(', ').map((col) => `n.${col}`).join(', ')}
     FROM node_relationships r
     JOIN nodes n ON n.id = CASE WHEN r.source_id = ANY($1) THEN r.target_id ELSE r.source_id END
     WHERE r.source_id = ANY($1) OR r.target_id = ANY($1)`,
    [seedIds]
  );

  const byId = new Map(scored.map((entry) => [entry.node.id, entry]));
  for (const { source_id, target_id, weight, relationship, ...node } of rows) {
    const from = seedIds.includes(source_id) ? source_id : target_id;
    const score = seedScore.get(from) * Number(weight) * EXPANSION_DECAY;
    const existing = byId.get(node.id);
    if (existing) {
      existing.score = Math.max(existing.score, score);
    } else {
      byId.set(node.id, { node, score, via: { from, relationship } });
    }
  }
  return [...byId.values()].sort((a, b) => b.score - a.score);
}

function packIntoBudget(scored) {
  const selected = [];
  let tokens = 0;
  for (const entry of scored) {
    if (selected.length >= MAX_CONTEXT_NODES) break;
    const cost = estimateTokens(entry.node.content);
    if (tokens + cost > CONTEXT_TOKEN_BUDGET) continue;
    selected.push({ ...entry, tokens: cost });
    tokens += cost;
  }
  return { selected, tokens };
}

// Baseline for the efficiency claim: everything the user would otherwise
// paste. Retrieval draws from all nodes, so the baseline is all nodes too.
async function tokensAvailable(pool) {
  const { rows } = await pool.query(
    'SELECT COALESCE(SUM(CEIL(LENGTH(content) / 4.0)), 0) AS tokens FROM nodes'
  );
  return Number(rows[0].tokens);
}

function buildContext(selected) {
  return selected
    .map(({ node }) => `[${node.type}${node.project ? ` · ${node.project}` : ''}]\n${node.content}`)
    .join('\n\n');
}

export async function retrieve({ query, project, taskType }) {
  const pool = getPool();

  const embedStart = performance.now();
  const vector = await embedQuery(query);
  const embeddingLatencyMs = Math.round(performance.now() - embedStart);

  const retrievalStart = performance.now();
  const [dense, lexical, available] = await Promise.all([
    denseCandidates(pool, vector),
    lexicalCandidates(pool, query),
    tokensAvailable(pool),
  ]);
  const scored = fuseAndScore({ dense, lexical, project, taskType, now: new Date() });
  const expanded = await expandFromSeeds(pool, scored);
  const { selected, tokens } = packIntoBudget(expanded);

  if (selected.length > 0) {
    await pool.query(
      'UPDATE nodes SET last_accessed = now(), access_count = access_count + 1 WHERE id = ANY($1)',
      [selected.map((entry) => entry.node.id)]
    );
  }
  const retrievalLatencyMs = Math.round(performance.now() - retrievalStart);

  const metrics = {
    embeddingLatencyMs,
    retrievalLatencyMs,
    nodesRetrieved: selected.length,
    tokensInjected: tokens,
    tokensAvailable: available,
    efficiencyRatio: available > 0 ? tokens / available : null,
  };
  const queryId = await logQueryMetrics({ queryText: query, ...metrics });

  return {
    queryId,
    context: buildContext(selected),
    nodes: selected.map(({ node, score, similarity, lexicalRank, via, tokens }) => ({
      ...node,
      score,
      similarity,
      lexicalRank,
      via,
      tokens,
    })),
    metrics,
  };
}
