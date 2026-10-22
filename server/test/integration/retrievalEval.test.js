import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { EVAL_OWNER_EMAIL, loadEvalSet, runEval } from '../../src/benchmark/retrievalEval.js';
import { ollamaAvailable, startServer } from '../helpers.js';

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
    assert.equal(byId['kc-c2']['recall@5'], 1, 'a reference designator alone finds its symbol');

    const after = await counts();
    assert.equal(after.metrics, before.metrics, 'no metrics rows recorded');
    assert.equal(after.nodes, before.nodes, 'the eval corpus is removed with its owner');
    assert.equal(after.owners, 0);
  });

  test('nomic-embed-text is reported separately', { skip: ollama ? false : 'Ollama not reachable' }, async () => {
    const results = await runEval({ pool: server.pool, set, modes: ['lexical', 'nomic'] });
    assert.ok(results.lexical && results.nomic);
    assert.equal(results.nomic.rows.length, set.queries.length);
    assert.ok(results.nomic.rows.some((row) => row.inferredTask !== null), 'task inference runs with embeddings');
  });
});
