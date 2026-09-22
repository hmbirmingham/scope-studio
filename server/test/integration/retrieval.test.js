import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { ensureCentroids, ollamaAvailable, registeredSession, startServer } from '../helpers.js';

const ollama = await ollamaAvailable();

describe('retrieval', { skip: ollama ? false : 'Ollama not reachable — embedding-dependent tests skipped' }, () => {
  let server;
  let api;
  let other;
  let ids;

  const find = (result, id) => result.data.nodes.find((node) => node.id === id);
  const index = (result, id) => result.data.nodes.findIndex((node) => node.id === id);
  const query = (text, extra = {}) => api('POST', '/api/query', { query: text, ...extra });

  before(async () => {
    server = await startServer();
    await ensureCentroids(server.pool);
    api = await registeredSession(server.base);
    other = await registeredSession(server.base);

    const create = async (body) => (await api('POST', '/api/nodes', body)).data;
    const relate = (source, target, type, weight = 1) =>
      api('POST', `/api/nodes/${source}/relationships`, { targetId: target, type, weight });

    const repo = await create({
      type: 'repo',
      content: 'hmbirmingham/scope-studio\nScope Studio — persistent, token-efficient engineering context layer',
      project: 'hmbirmingham/scope-studio',
    });
    const huskybook = await create({
      type: 'repo',
      content: 'hmbirmingham/huskybook\nCampus marketplace for students',
      project: 'hmbirmingham/huskybook',
    });
    const focusGuard = await create({
      type: 'repo',
      content: 'hmbirmingham/focus-guard\nA focus timer that blocks distracting sites',
      project: 'hmbirmingham/focus-guard',
    });
    const d1 = await create({
      type: 'decision',
      content: 'Chose pgvector over Pinecone for the neural map: one Railway Postgres keeps the graph, embeddings, and metrics in a single deployable database.',
      project: 'hmbirmingham/scope-studio',
    });
    const d2 = await create({
      type: 'decision',
      content: 'Superseding the pgvector decision: neural map embeddings move to a dedicated vector store once the corpus passes ten million nodes; pgvector stays for the graph and metrics.',
      project: 'hmbirmingham/scope-studio',
    });
    const d3 = await create({
      type: 'decision',
      content: 'Team decision, March: standardize on database extensions instead of sidecar services so the Railway deployment stays a single container.',
      project: 'hmbirmingham/scope-studio',
    });
    const file = await create({
      type: 'file',
      content: 'server/src/db/migrations/001_extensions.sql — enables the pgvector and pgcrypto extensions on first migration.',
      project: 'hmbirmingham/scope-studio',
    });
    await relate(d2.id, d1.id, 'supersedes');
    await relate(file.id, d1.id, 'caused_by', 0.9);
    await relate(file.id, d3.id, 'caused_by', 0.9);
    await relate(repo.id, d1.id, 'references', 0.9);
    ids = { repo: repo.id, huskybook: huskybook.id, focusGuard: focusGuard.id, d1: d1.id, d2: d2.id, d3: d3.id, file: file.id };
  });
  after(() => server.close());

  test('rejects blank queries, unknown tiers, and unauthenticated calls', async () => {
    assert.equal((await query('   ')).status, 400);
    assert.equal((await query('x', { tier: 'gpu_cluster' })).status, 400);
    const anonymous = await fetch(`${server.base}/api/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'x' }),
    });
    assert.equal(anonymous.status, 401);
  });

  test('infers task type on held-out phrasings', async () => {
    const probes = [
      ['why does the UART interrupt handler lose bytes at high baud rates', 'firmware'],
      ['which repositories still use Flask', 'cross_project'],
      ['what anomaly threshold did the paper settle on', 'research'],
      ['where is the dataframe merged with the metadata table', 'data_pipeline'],
      ['what is the maximum input voltage of the buck regulator', 'hardware'],
    ];
    let hits = 0;
    for (const [text, expected] of probes) {
      const result = await query(text);
      if (result.data.task?.task === expected) hits++;
      assert.ok(result.data.task.confidence > 0 && result.data.task.confidence <= 1);
    }
    assert.ok(hits >= 4, `task inference accuracy ${hits}/5`);
  });

  test('bare identifiers resolve through the lexical path', async () => {
    const result = await query('huskybook');
    assert.ok(find(result, ids.huskybook), 'huskybook found via lexical hit');
    assert.equal(find(result, ids.huskybook).lexicalRank, 1);
  });

  test('superseded decisions are demoted ×0.1 and never traversed backwards', async () => {
    const text = 'why did we pick pgvector for the neural map';
    const on = await query(text, { tier: 'cloud_frontier' });
    const off = await query(text, { tier: 'cloud_frontier', overrides: { features: { supersede_demotion: false } } });

    assert.ok(find(on, ids.d1) && find(on, ids.d2), 'both decisions retrieved on cloud tier');
    assert.ok(index(on, ids.d2) < index(on, ids.d1), 'current decision outranks superseded one');
    assert.equal(find(on, ids.d1).boosts.demotion, 0.1);
    assert.ok(Math.abs(find(off, ids.d1).score / find(on, ids.d1).score - 10) < 0.5);
    assert.ok(on.data.metrics.supersededNodesDemoted >= 1);
    assert.ok(!on.data.nodes.some((node) => node.via?.from === ids.d1), 'no reverse traversal from a decision seed');
  });

  test('why-questions follow caused_by from the file seed on the local tier', async () => {
    const text = 'why does the first migration enable pgvector';
    const result = await query(text);
    const d3 = find(result, ids.d3);
    assert.equal(d3?.via?.relationship, 'caused_by');
    assert.equal(d3.via.from, ids.file);
    assert.equal(d3.similarity, null, 'reachable only through expansion, not as a direct candidate');

    const ablated = await query(text, { overrides: { features: { expansion: false } } });
    assert.ok(!find(ablated, ids.d3), 'disappears when expansion is ablated');
  });

  test('recency decays exponentially and feedback re-anchors it', async () => {
    await server.pool.query("UPDATE nodes SET created_at = now() - interval '200 hours' WHERE id = $1", [ids.d2]);
    const text = 'why did we pick pgvector for the neural map';
    const aged = await query(text, { tier: 'cloud_frontier' });
    assert.ok(find(aged, ids.d2).boosts.recency < 0.01);
    assert.ok(find(aged, ids.d1).boosts.recency > 0.9);

    assert.equal((await api('POST', `/api/query/${aged.data.queryId}/feedback`, { useful: true })).status, 204);
    assert.equal((await other('POST', `/api/query/${aged.data.queryId}/feedback`, { useful: true })).status, 404);

    const d2 = (await api('GET', `/api/nodes/${ids.d2}`)).data;
    assert.equal(d2.confirmed_useful_count, 1);
    assert.ok(d2.last_confirmed_useful);

    const after = await query(text, { tier: 'cloud_frontier' });
    assert.ok(find(after, ids.d2).boosts.recency > 0.9, 'confirmation re-anchors recency');
    assert.equal(after.data.metrics.embeddingCached, true, 'repeated query hits the embedding cache');

    const { rows } = await server.pool.query(
      'SELECT user_confirmed_useful, follow_up_within_60s FROM query_metrics WHERE query_id = $1',
      [aged.data.queryId]
    );
    assert.equal(rows[0].user_confirmed_useful, true);
    assert.equal(rows[0].follow_up_within_60s, true);
  });

  test('tier caps, token accounting, and per-node context logging', async () => {
    const result = await query('persistent context layer that routes queries to local or cloud models');
    assert.equal(result.data.tier, 'local_7b');
    assert.ok(result.data.nodes.length <= 5);
    assert.ok(result.data.metrics.efficiencyRatio <= 1);

    const projects = [...new Set(result.data.nodes.map((node) => node.project))];
    const { rows: tokens } = await server.pool.query(
      'SELECT SUM(token_length)::int AS total FROM nodes WHERE project = ANY($1::text[])',
      [projects]
    );
    assert.equal(
      result.data.metrics.tokensAvailable,
      tokens[0].total,
      "baseline is the injected nodes' projects, not the whole database"
    );

    const { rows: context } = await server.pool.query(
      'SELECT count(*)::int AS count FROM query_context_nodes WHERE query_id = $1',
      [result.data.queryId]
    );
    assert.equal(context[0].count, result.data.nodes.length);
  });

  test('nonsense queries retrieve nothing', async () => {
    const result = await query('zxqv plorth wibblesnatch');
    assert.equal(result.data.nodes.length, 0);
    assert.equal(result.data.metrics.tokensInjected, 0);
  });

  test("never retrieves another user's nodes", async () => {
    const result = await other('POST', '/api/query', {
      query: 'why did we pick pgvector for the neural map',
      tier: 'cloud_frontier',
    });
    assert.equal(result.status, 200);
    assert.equal(result.data.nodes.length, 0);
    assert.equal(result.data.metrics.tokensAvailable, 0);
  });
});
