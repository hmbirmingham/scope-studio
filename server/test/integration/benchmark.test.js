import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { embedDocument } from '../../src/lib/embeddings.js';
import { upsertNodeByExternalId } from '../../src/models/nodeStore.js';
import { aggregate, runBenchmark, saveRun } from '../../src/benchmark/run.js';
import { ensureCentroids, ollamaAvailable, registeredSession, startServer } from '../helpers.js';

const ollama = await ollamaAvailable();

describe('benchmark runner', { skip: ollama ? false : 'Ollama not reachable — embedding-dependent tests skipped' }, () => {
  let server;
  let ownerId;

  const querySet = {
    name: 'fixture',
    queries: [
      { id: 'def', category: 'codebase_lookup', task: 'codebase', query: 'what does normalize_plate return',
        relevant: [{ project: 'acme/imaging', path: 'quantify.py', content: 'def normalize_plate' }] },
      { id: 'doc', category: 'decision_context', task: 'research', query: 'why was the plate normalised before counting',
        relevant: [{ project: 'acme/imaging', path: 'NOTES.md' }] },
      { id: 'cross', category: 'cross_project', task: 'cross_project', query: 'which repositories use Flask',
        relevant: [{ project: 'acme/imaging', content: 'flask' }, { project: 'acme/timer', content: 'flask' }] },
      { id: 'none', category: 'research_context', task: 'research', query: 'zxqv plorth wibblesnatch',
        relevant: [{ project: 'acme/timer', path: 'nowhere.py' }] },
    ],
  };

  before(async () => {
    server = await startServer();
    await ensureCentroids(server.pool);
    const api = await registeredSession(server.base);
    ownerId = (await api('GET', '/api/auth/session')).data.userId;

    const seed = async (repoId, project, index, path, content) =>
      upsertNodeByExternalId({
        ownerId, type: 'file', source: 'github', project, privacy: 'cloud',
        externalId: `${repoId}|${index}|${path}`, content: `${path}\n\n${content}`,
        embedding: await embedDocument(`${path}\n\n${content}`),
      });

    // The usage chunk names the function ten times; the definition names it once.
    await seed(1, 'acme/imaging', 0, 'quantify.py',
      'def normalize_plate(img):\n    """Return the plate image with illumination flattened."""\n    return img / illumination_field(img)');
    await seed(1, 'acme/imaging', 0, 'tests/test_quantify.py',
      Array.from({ length: 10 }, (_, i) => `def test_normalize_plate_${i}():\n    assert normalize_plate(img${i}) is not None`).join('\n'));
    await seed(1, 'acme/imaging', 0, 'NOTES.md',
      'Decision: normalise every plate before counting colonies, because uneven illumination inflated counts at the rim.');
    await seed(1, 'acme/imaging', 0, 'server.py', 'from flask import Flask\napp = Flask(__name__)');
    await seed(2, 'acme/timer', 0, 'app.py', 'from flask import Flask, jsonify\napp = Flask(__name__)');
    await seed(2, 'acme/timer', 0, 'timer.py', 'import time\n\ndef tick():\n    return time.monotonic()');
  });
  after(() => server.close());

  test('scores every query without recording anything', async () => {
    const before = await server.pool.query('SELECT count(*)::int AS c FROM query_metrics');
    const accessBefore = await server.pool.query('SELECT sum(access_count)::int AS a FROM nodes');

    const runs = await runBenchmark({ ownerId, querySet, tier: 'cloud_frontier', configs: { full: {} } });
    const [run] = runs;
    assert.equal(run.rows.length, 4);
    assert.equal(run.summary.queries, 4);

    const byId = Object.fromEntries(run.rows.map((row) => [row.id, row]));
    assert.equal(byId.def.hit, true);
    assert.equal(byId.def.satisfied[0].packRank, 1, 'the definition outranks the test file that names the function ten times');
    assert.equal(byId.doc.hit, true);
    assert.equal(byId.cross.recall, 1, 'both Flask projects, matched on content without a path');
    assert.equal(byId.none.hit, false);
    assert.equal(byId.none.candidateHit, false);
    assert.ok(byId.def.nodes.every((node) => typeof node.path === 'string'));
    assert.equal(run.summary.hitRate, 0.75);
    assert.equal(run.summary.byCategory.cross_project.meanRecall, 1);

    const after = await server.pool.query('SELECT count(*)::int AS c FROM query_metrics');
    const accessAfter = await server.pool.query('SELECT sum(access_count)::int AS a FROM nodes');
    assert.equal(after.rows[0].c, before.rows[0].c, 'no metrics rows');
    assert.equal(accessAfter.rows[0].a, accessBefore.rows[0].a, 'no access counts bumped');
  });

  test('the definition boost is what lifts the definition above its usages', async () => {
    const runs = await runBenchmark({
      ownerId, querySet: { ...querySet, queries: querySet.queries.filter((q) => q.id === 'def') }, tier: 'cloud_frontier',
      configs: { off: { features: { definition_boost: false } }, on: {} },
    });
    const [off, on] = runs.map((run) => run.rows[0]);
    assert.ok(on.mrr >= off.mrr);
    assert.equal(on.satisfied[0].packRank, 1);
  });

  test('saveRun records the summary and per-query detail against the commit', async () => {
    const [run] = await runBenchmark({ ownerId, querySet, tier: 'local_7b', configs: { full: {} } });
    const id = await saveRun(server.pool, { run, ownerId, querySetName: querySet.name, commitHash: 'abc123' });
    const { rows } = await server.pool.query('SELECT * FROM benchmark_runs WHERE id = $1', [id]);
    assert.equal(rows[0].commit_hash, 'abc123');
    assert.equal(rows[0].label, 'full');
    assert.equal(rows[0].tier, 'local_7b');
    assert.equal(rows[0].query_count, 4);
    assert.equal(rows[0].results.length, 4);
    assert.ok(Math.abs(rows[0].hit_rate - run.summary.hitRate) < 1e-6);
    assert.equal(rows[0].owner_id, ownerId);
  });

  test('aggregate matches what the runner stored', async () => {
    const [run] = await runBenchmark({ ownerId, querySet, tier: 'local_7b', configs: { full: {} } });
    assert.deepEqual(aggregate(run.rows), run.summary);
  });
});
