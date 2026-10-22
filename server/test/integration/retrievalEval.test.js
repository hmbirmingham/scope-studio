import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { EVAL_LOCK_KEY, EVAL_OWNER_EMAIL, loadEvalSet, runEval } from '../../src/benchmark/retrievalEval.js';
import { ensureCentroids, ollamaAvailable, startServer } from '../helpers.js';

const evalScript = join(dirname(fileURLToPath(import.meta.url)), '../../src/benchmark/retrievalEval.js');

const ollama = await ollamaAvailable();

describe('retrieval eval', () => {
  let server;
  const set = loadEvalSet();

  before(async () => {
    server = await startServer();
  });
  after(() => server.close());

  const counts = async () => {
    const { rows } = await server.pool.query(
      `SELECT (SELECT count(*)::int FROM query_metrics) AS metrics,
              (SELECT count(*)::int FROM nodes) AS nodes,
              (SELECT count(*)::int FROM users WHERE email = $1) AS owners`,
      [EVAL_OWNER_EMAIL]
    );
    return rows[0];
  };

  test('lexical-only: scores every labelled query and leaves nothing behind', async () => {
    const before = await counts();
    const results = await runEval({ pool: server.pool, set, modes: ['lexical'] });
    const { summary, rows } = results.lexical;
    assert.equal(rows.length, set.queries.length);
    assert.equal(summary.queries, set.queries.length);
    for (const metric of ['recall@1', 'recall@5', 'recall@10', 'mrr', 'coverage', 'packed']) {
      assert.ok(summary[metric] >= 0 && summary[metric] <= 1, metric);
    }
    assert.ok(summary['recall@1'] <= summary['recall@5'] && summary['recall@5'] <= summary['recall@10']);
    assert.ok(rows.every((row) => row.inferredTask === null), 'no embedding, so no task inference');
    assert.deepEqual(Object.keys(summary.byGroup).sort(), ['cad', 'code', 'cross', 'kicad', 'physics', 'research', 'workspace']);
    assert.equal(results.nomic, undefined);
    const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
    assert.equal(byId['kc-c2']['recall@1'], 1, 'a reference designator alone finds its symbol');

    const after = await counts();
    assert.equal(after.metrics, before.metrics, 'no metrics rows recorded');
    assert.equal(after.nodes, before.nodes, 'the eval corpus is removed with its owner');
    assert.equal(after.owners, 0);
  });

  test('the ranking is identical across runs, reseeded corpus and all', async () => {
    const first = await runEval({ pool: server.pool, set, modes: ['lexical'] });
    const second = await runEval({ pool: server.pool, set, modes: ['lexical'] });
    const ranking = (result) => result.lexical.rows.map((row) => [row.id, row.top]);
    assert.deepEqual(ranking(second), ranking(first));
    assert.deepEqual(second.lexical.summary, first.lexical.summary);
    assert.equal(first.lexical.summary.unscored, 0, 'every candidate has a numeric score');
  });

  test('a run refuses while another holds the eval lock', async () => {
    const holder = await server.pool.connect();
    try {
      await holder.query('SELECT pg_advisory_lock($1)', [EVAL_LOCK_KEY]);
      await assert.rejects(runEval({ pool: server.pool, set, modes: ['lexical'] }), /another run holds the eval lock/);
      assert.equal((await counts()).owners, 0, 'the refused run seeded nothing');
    } finally {
      await holder.query('SELECT pg_advisory_unlock($1)', [EVAL_LOCK_KEY]);
      holder.release();
    }
  });

  test('SIGTERM mid-run drops the eval owner and its corpus', async () => {
    // Many repeats of the queries, so the run is certainly still going when the
    // signal arrives.
    const dir = mkdtempSync(join(tmpdir(), 'eval-'));
    const path = join(dir, 'long.json');
    writeFileSync(path, JSON.stringify({ ...set, queries: Array.from({ length: 40 }, () => set.queries).flat() }));
    try {
      const child = execFile(process.execPath, [evalScript, '--modes', 'lexical', '--set', path], {
        env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL },
      });
      const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
      for (let i = 0; i < 500 && (await counts()).owners === 0; i++) await sleep(20);
      assert.equal((await counts()).owners, 1, 'the run seeded its owner');
      child.kill('SIGTERM');
      const { code } = await exited;
      assert.equal(code, 143, 'exited from the signal handler');
      assert.equal((await counts()).owners, 0, 'the owner, and with it the corpus, is gone');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('nomic-embed-text is reported separately and never rewrites the task centroids', { skip: ollama ? false : 'Ollama not reachable' }, async () => {
    await ensureCentroids(server.pool);
    const before = await server.pool.query('SELECT task, updated_at FROM task_centroids ORDER BY task');
    const results = await runEval({ pool: server.pool, set, modes: ['lexical', 'nomic'] });
    assert.ok(results.lexical && results.nomic);
    assert.equal(results.nomic.taskInference, true);
    assert.equal(results.nomic.rows.length, set.queries.length);
    assert.ok(results.nomic.rows.some((row) => row.inferredTask !== null), 'task inference runs with embeddings');
    const after = await server.pool.query('SELECT task, updated_at FROM task_centroids ORDER BY task');
    assert.deepEqual(after.rows, before.rows);
  });

  test('without task centroids the nomic run turns task inference off instead of building them', { skip: ollama ? false : 'Ollama not reachable' }, async () => {
    await server.pool.query('DELETE FROM task_centroids');
    try {
      const results = await runEval({ pool: server.pool, set, modes: ['nomic'] });
      assert.equal(results.nomic.taskInference, false);
      assert.ok(results.nomic.rows.every((row) => row.inferredTask === null));
      const { rows } = await server.pool.query('SELECT count(*)::int AS c FROM task_centroids');
      assert.equal(rows[0].c, 0, 'the shared centroids were left alone');
    } finally {
      await ensureCentroids(server.pool);
    }
  });
});
