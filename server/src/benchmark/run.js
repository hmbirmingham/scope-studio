import 'dotenv/config';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getPool } from '../db/pool.js';
import { gatherCandidates, packForTier, summarizeRetrieval } from '../retrieval/retrieve.js';
import { DEFAULT_FEATURES } from '../retrieval/score.js';
import { judge } from './judge.js';

const here = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_QUERY_SET = join(here, '../../benchmarks/queries.json');

const allOff = Object.fromEntries(Object.keys(DEFAULT_FEATURES).map((key) => [key, false]));

// ADR §8 ablation ladder. A (paste everything) is the efficiency denominator,
// not a configuration; B–F add one component at a time so each effect is
// isolated. Sweeps layer numeric overrides on top of `full`.
export const ABLATIONS = {
  v0: { features: allOff },
  recency: { features: { ...allOff, recency_decay: true } },
  recency_task: { features: { ...allOff, recency_decay: true, task_inference: true } },
  recency_task_demotion: {
    features: { ...allOff, recency_decay: true, task_inference: true, supersede_demotion: true },
  },
  full: {},
};

export function loadQuerySet(path = DEFAULT_QUERY_SET) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// Scores and packs without recording: the benchmark must not bump
// access_count or log metrics, or it would teach the recency signal its own
// questions.
export async function runQuery({ ownerId, entry, tier, overrides }) {
  const gathered = await gatherCandidates({ ownerId, query: entry.query, project: entry.project ?? undefined, tier, overrides });
  const packed = packForTier(gathered.candidates, tier, overrides);
  const metrics = await summarizeRetrieval({ ownerId, tier, gathered, packed });
  const verdict = judge({ selected: packed.selected, candidates: gathered.candidates, expectations: entry.relevant });
  return {
    id: entry.id,
    category: entry.category,
    expectedTask: entry.task ?? null,
    inferredTask: gathered.task?.task ?? null,
    ...verdict,
    tokensInjected: metrics.tokensInjected,
    tokensAvailable: metrics.tokensAvailable,
    efficiencyRatio: metrics.efficiencyRatio,
    retrievalMs: metrics.retrievalLatencyMs,
    nodes: packed.selected.map(({ node, score }) => ({ id: node.id, project: node.project, path: node.external_id?.replace(/^[^|]*\|[^|]*\|/, '') ?? null, score })),
  };
}

const mean = (values) => (values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null);
const rate = (values) => mean(values.map((v) => (v ? 1 : 0)));

export function aggregate(rows) {
  const byCategory = {};
  for (const row of rows) (byCategory[row.category] ??= []).push(row);
  const summary = (group) => ({
    queries: group.length,
    hitRate: rate(group.map((r) => r.hit)),
    candidateHitRate: rate(group.map((r) => r.candidateHit)),
    meanRecall: mean(group.map((r) => r.recall)),
    meanMrr: mean(group.map((r) => r.mrr)),
    taskAccuracy: rate(group.filter((r) => r.expectedTask).map((r) => r.inferredTask === r.expectedTask)),
    meanEfficiencyRatio: mean(group.map((r) => r.efficiencyRatio).filter((v) => v != null)),
    meanTokensInjected: mean(group.map((r) => r.tokensInjected)),
    meanRetrievalMs: mean(group.map((r) => r.retrievalMs)),
  });
  return {
    ...summary(rows),
    byCategory: Object.fromEntries(Object.entries(byCategory).map(([category, group]) => [category, summary(group)])),
  };
}

export async function runBenchmark({ ownerId, querySet, tier = 'local_7b', configs, log = () => {} }) {
  const runs = [];
  for (const [label, overrides] of Object.entries(configs)) {
    const rows = [];
    for (const entry of querySet.queries) {
      const row = await runQuery({ ownerId, entry, tier, overrides });
      rows.push(row);
      log(`${label} ${entry.id} ${row.hit ? 'hit' : row.candidateHit ? 'ranked-out' : 'MISS'} recall=${row.recall.toFixed(2)} tokens=${row.tokensInjected}`);
    }
    runs.push({ label, tier, overrides, rows, summary: aggregate(rows) });
  }
  return runs;
}

export async function saveRun(pool, { run, ownerId, querySetName, commitHash }) {
  const { summary } = run;
  const { rows } = await pool.query(
    `INSERT INTO benchmark_runs
       (commit_hash, query_count, label, owner_id, tier, config, query_set, hit_rate, candidate_hit_rate,
        mean_recall, mean_mrr, mean_retrieval_ms, mean_tokens_injected, mean_efficiency_ratio, results)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     RETURNING id`,
    [
      commitHash, summary.queries, run.label, ownerId, run.tier, JSON.stringify(run.overrides), querySetName,
      summary.hitRate, summary.candidateHitRate, summary.meanRecall, summary.meanMrr, summary.meanRetrievalMs,
      summary.meanTokensInjected, summary.meanEfficiencyRatio, JSON.stringify(run.rows),
    ]
  );
  return rows[0].id;
}

// --sweep relevance_floor=0.5,0.6,0.7 → one config per value, layered on `full`.
export function parseArgs(argv) {
  const args = { tier: 'local_7b', configs: ABLATIONS, save: false, queries: DEFAULT_QUERY_SET, label: null, owner: null, json: null };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split('=');
    const value = inline ?? argv[++i];
    switch (flag) {
      case '--tier': args.tier = value; break;
      case '--owner': args.owner = value; break;
      case '--queries': args.queries = resolve(value); break;
      case '--label': args.label = value; break;
      case '--json': args.json = resolve(value); break;
      case '--save': args.save = true; i--; break;
      case '--only': args.configs = Object.fromEntries(value.split(',').map((name) => {
        if (!ABLATIONS[name]) throw new Error(`unknown ablation: ${name}`);
        return [name, ABLATIONS[name]];
      })); break;
      case '--sweep': {
        const [key, list] = value.split(/[=:]/);
        if (!list) throw new Error('--sweep expects key=v1,v2,…');
        args.configs = Object.fromEntries(list.split(',').map((raw) => [`${key}=${raw}`, { [key]: Number(raw) }]));
        break;
      }
      default: throw new Error(`unknown flag: ${flag}`);
    }
  }
  return args;
}

const pct = (v) => (v == null ? '   –' : `${Math.round(v * 100)}%`.padStart(4));
const num = (v, digits = 0) => (v == null ? '–' : v.toFixed(digits));

export function formatTable(runs) {
  const header = `${'config'.padEnd(28)} hit  cand recall  mrr  task  tokens  eff   ms`;
  const lines = runs.map(({ label, summary: s }) =>
    `${label.padEnd(28)} ${pct(s.hitRate)} ${pct(s.candidateHitRate)} ${pct(s.meanRecall)}  ${num(s.meanMrr, 2)}  ${pct(s.taskAccuracy)}  ${num(s.meanTokensInjected).padStart(6)}  ${num(s.meanEfficiencyRatio, 3)} ${num(s.meanRetrievalMs).padStart(4)}`
  );
  return [header, ...lines].join('\n');
}

async function resolveOwner(pool, email) {
  const { rows } = email
    ? await pool.query('SELECT id, email FROM users WHERE email = $1', [email])
    : await pool.query(
        `SELECT u.id, u.email FROM users u JOIN nodes n ON n.owner_id = u.id
         GROUP BY u.id ORDER BY count(*) DESC LIMIT 1`
      );
  if (!rows[0]) throw new Error(email ? `no user ${email}` : 'no nodes in the database');
  return rows[0];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const pool = getPool();
  const args = parseArgs(process.argv.slice(2));
  const querySet = loadQuerySet(args.queries);
  const commitHash = execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  resolveOwner(pool, args.owner)
    .then(async (owner) => {
      console.error(`owner ${owner.email} · tier ${args.tier} · ${querySet.queries.length} queries · ${Object.keys(args.configs).length} configs`);
      const runs = await runBenchmark({ ownerId: owner.id, querySet, tier: args.tier, configs: args.configs, log: (line) => console.error(line) });
      console.log(formatTable(runs));
      for (const run of runs) {
        const misses = run.rows.filter((r) => !r.hit).map((r) => `${r.id}${r.candidateHit ? '(ranked out)' : ''}`);
        if (misses.length) console.log(`  ${run.label}: missed ${misses.join(', ')}`);
      }
      if (args.json) {
        const { writeFileSync } = await import('node:fs');
        writeFileSync(args.json, JSON.stringify({ commitHash, tier: args.tier, runs }, null, 2));
      }
      if (args.save) {
        for (const run of runs) {
          const id = await saveRun(pool, { run: { ...run, label: args.label ? `${args.label}:${run.label}` : run.label }, ownerId: owner.id, querySetName: querySet.name, commitHash });
          console.error(`saved ${run.label} → benchmark_runs ${id}`);
        }
      }
    })
    .then(() => pool.end())
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
