import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildCentroids } from '../db/build-centroids.js';
import { getPool } from '../db/pool.js';
import { embedDocuments } from '../lib/embeddings.js';
import { gatherCandidates, packForTier } from '../retrieval/retrieve.js';
import { TASK_EXAMPLES } from '../retrieval/taskExamples.js';

// A small, deterministic retrieval eval. The live benchmark (run.js) needs a
// real ingested corpus; this one seeds a fixed corpus that covers every node
// type and relationship the verticals write, asks labelled questions against
// it, and reports recall@k and coverage. It runs twice when it can: once with
// no query embedding (lexical-only, which is how the test suite and a machine
// without Ollama retrieve) and once with nomic-embed-text, reported apart.

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_EVAL_SET = join(here, '../../benchmarks/retrieval-eval.json');
export const EVAL_OWNER_EMAIL = 'retrieval-eval@example.invalid';
export const RECALL_KS = [1, 5, 10];

export function loadEvalSet(path = DEFAULT_EVAL_SET) {
  const set = JSON.parse(readFileSync(path, 'utf8'));
  const keys = new Set(set.nodes.map((node) => node.key));
  if (keys.size !== set.nodes.length) throw new Error('retrieval eval: duplicate node keys');
  for (const edge of set.edges) {
    if (!keys.has(edge.from) || !keys.has(edge.to)) throw new Error(`retrieval eval: edge ${edge.from} → ${edge.to} names an unknown node`);
  }
  for (const query of set.queries) {
    for (const key of query.relevant) {
      if (!keys.has(key)) throw new Error(`retrieval eval: query ${query.id} expects unknown node ${key}`);
    }
  }
  return set;
}

// File nodes carry the chunked external id the GitHub ingester writes, so
// path-based tooling reads them the same way; everything else gets a stable
// id of its own.
function externalIdFor(node) {
  return node.path ? `eval|0|${node.path}` : `eval|${node.key}`;
}

// A throwaway owner: deleting it cascades to its nodes and edges, so the eval
// never touches anyone else's graph.
export async function createEvalOwner(pool, email = EVAL_OWNER_EMAIL) {
  await pool.query('DELETE FROM users WHERE email = $1', [email]);
  const { rows } = await pool.query(
    "INSERT INTO users (email, password_hash) VALUES ($1, '!no-login') RETURNING id",
    [email]
  );
  return rows[0].id;
}

export async function dropEvalOwner(pool, ownerId) {
  await pool.query('DELETE FROM users WHERE id = $1', [ownerId]);
}

// Returns key → node id. `vectors`, when given, holds one document embedding
// per node in corpus order.
export async function seedCorpus(pool, ownerId, set, { vectors = null } = {}) {
  const ids = new Map();
  for (const [i, node] of set.nodes.entries()) {
    const vector = vectors?.[i];
    const { rows } = await pool.query(
      `INSERT INTO nodes (owner_id, type, content, embedding, source, external_id, project, privacy)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'cloud') RETURNING id`,
      [ownerId, node.type, node.content, vector ? `[${vector.join(',')}]` : null, node.source, externalIdFor(node), node.project]
    );
    ids.set(node.key, rows[0].id);
  }
  for (const edge of set.edges) {
    await pool.query(
      'INSERT INTO node_relationships (source_id, target_id, type, weight) VALUES ($1, $2, $3, $4)',
      [ids.get(edge.from), ids.get(edge.to), edge.type, edge.weight ?? 1.0]
    );
  }
  return ids;
}

// Scores one query from ranked node ids. Recall@k counts how many of the
// labelled nodes sit in the top k; coverage counts them anywhere in the
// candidate list (retrieved at all, whatever the rank).
export function scoreRanking({ ranked, packed, relevant }) {
  const wanted = new Set(relevant);
  const within = (ids) => ids.filter((id) => wanted.has(id)).length / wanted.size;
  const first = ranked.findIndex((id) => wanted.has(id));
  return {
    ...Object.fromEntries(RECALL_KS.map((k) => [`recall@${k}`, within(ranked.slice(0, k))])),
    mrr: first >= 0 ? 1 / (first + 1) : 0,
    coverage: within(ranked),
    packed: within(packed),
  };
}

const METRICS = [...RECALL_KS.map((k) => `recall@${k}`), 'mrr', 'coverage', 'packed'];
const mean = (values) => (values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : 0);

export function summarise(rows) {
  const summary = (group) => ({
    queries: group.length,
    ...Object.fromEntries(METRICS.map((metric) => [metric, mean(group.map((row) => row[metric]))])),
    unscored: group.reduce((sum, row) => sum + row.unscored, 0),
  });
  const groups = {};
  for (const row of rows) (groups[row.group] ??= []).push(row);
  return {
    ...summary(rows),
    byGroup: Object.fromEntries(Object.entries(groups).map(([name, group]) => [name, summary(group)])),
  };
}

// Never records anything: no metrics rows, no access counts, so re-running
// the eval cannot teach the recency signal its own questions.
export async function evaluate({ ownerId, set, ids, tier = 'local_7b', embed }) {
  const keyOf = new Map([...ids].map(([key, id]) => [id, key]));
  const rows = [];
  for (const query of set.queries) {
    const gathered = await gatherCandidates({ ownerId, query: query.query, tier, embed });
    const packed = packForTier(gathered.candidates, tier);
    const ranked = gathered.candidates.map((entry) => keyOf.get(entry.node.id));
    rows.push({
      id: query.id,
      group: query.group,
      ...scoreRanking({ ranked, packed: packed.selected.map((entry) => keyOf.get(entry.node.id)), relevant: query.relevant }),
      // A candidate whose score is not a number cannot be ranked: the sort
      // leaves it wherever the comparator happened to put it.
      unscored: gathered.candidates.filter((entry) => !Number.isFinite(entry.score)).length,
      inferredTask: gathered.task?.task ?? null,
      top: ranked.slice(0, 5),
    });
  }
  return { rows, summary: summarise(rows) };
}

async function embedCorpus(set) {
  try {
    return await embedDocuments(set.nodes.map((node) => node.content));
  } catch {
    return null;
  }
}

async function ensureCentroids(pool) {
  const { rows } = await pool.query('SELECT count(*)::int AS count FROM task_centroids');
  if (rows[0].count !== Object.keys(TASK_EXAMPLES).length) await buildCentroids(pool, { log: () => {} });
}

// Lexical-only runs first: the query-embedding cache is per process, and a
// lexical run after a nomic one would find every query's vector cached.
export async function runEval({ pool = getPool(), set = loadEvalSet(), tier = 'local_7b', modes = ['lexical', 'nomic'], log = () => {} } = {}) {
  const ownerId = await createEvalOwner(pool);
  try {
    const vectors = modes.includes('nomic') ? await embedCorpus(set) : null;
    const ids = await seedCorpus(pool, ownerId, set, { vectors });
    const results = {};
    if (modes.includes('lexical')) {
      log('lexical-only…');
      results.lexical = await evaluate({ ownerId, set, ids, tier, embed: false });
    }
    if (modes.includes('nomic')) {
      if (vectors) {
        await ensureCentroids(pool);
        log('nomic-embed-text…');
        results.nomic = await evaluate({ ownerId, set, ids, tier, embed: true });
      } else {
        log('nomic-embed-text unavailable: skipped');
        results.nomic = null;
      }
    }
    return results;
  } finally {
    await dropEvalOwner(pool, ownerId);
  }
}

const pct = (value) => `${(value * 100).toFixed(1)}%`.padStart(6);

export function formatReport(results) {
  const lines = [];
  for (const [mode, result] of Object.entries(results)) {
    if (!result) {
      lines.push(`${mode}: not run (embedder unavailable)`);
      continue;
    }
    lines.push(`${mode}`);
    lines.push(`  ${'group'.padEnd(10)} ${'n'.padStart(3)}  ${METRICS.map((m) => m.padStart(8)).join(' ')}  unscored`);
    const row = (name, s) =>
      `  ${name.padEnd(10)} ${String(s.queries).padStart(3)}  ${METRICS.map((m) => (m === 'mrr' ? s[m].toFixed(3).padStart(8) : pct(s[m]).padStart(8))).join(' ')}  ${String(s.unscored).padStart(8)}`;
    lines.push(row('all', result.summary));
    for (const [name, s] of Object.entries(result.summary.byGroup)) lines.push(row(name, s));
    const misses = result.rows.filter((r) => r['recall@5'] < 1).map((r) => `${r.id}(${pct(r['recall@5']).trim()})`);
    if (misses.length) lines.push(`  below full recall@5: ${misses.join(', ')}`);
  }
  return lines.join('\n');
}

function parseArgs(argv) {
  const args = { tier: 'local_7b', set: DEFAULT_EVAL_SET, modes: ['lexical', 'nomic'], json: null };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split('=');
    const value = inline ?? argv[++i];
    switch (flag) {
      case '--tier': args.tier = value; break;
      case '--set': args.set = resolve(value); break;
      case '--modes': args.modes = value.split(','); break;
      case '--json': args.json = resolve(value); break;
      default: throw new Error(`unknown flag: ${flag}`);
    }
  }
  return args;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pool = getPool();
  const args = parseArgs(process.argv.slice(2));
  runEval({ pool, set: loadEvalSet(args.set), tier: args.tier, modes: args.modes, log: (line) => console.error(line) })
    .then(async (results) => {
      console.log(`tier ${args.tier}`);
      console.log(formatReport(results));
      if (args.json) {
        const { writeFileSync } = await import('node:fs');
        writeFileSync(args.json, JSON.stringify(results, null, 2));
      }
    })
    .then(() => pool.end())
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
