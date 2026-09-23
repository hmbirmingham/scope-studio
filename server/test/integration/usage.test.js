import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { registeredSession, session, startServer } from '../helpers.js';

describe('usage and spend', () => {
  let server;
  let api;
  let other;

  const record = (ownerId, { model, cost, decision = 'cloud', ageDays = 0 }) =>
    server.pool.query(
      `INSERT INTO query_metrics (query_text, owner_id, tier, routing_decision, model_used, cost_usd, output_tokens, created_at)
       VALUES ('q', $1, 'cloud_frontier', $2, $3, $4, 100, now() - ($5::text || ' days')::interval)`,
      [ownerId, decision, model, cost, ageDays]
    );

  before(async () => {
    server = await startServer();
    api = await registeredSession(server.base);
    other = await registeredSession(server.base);
    const mine = (await api('GET', '/api/auth/session')).data.userId;
    const theirs = (await other('GET', '/api/auth/session')).data.userId;

    await record(mine, { model: 'anthropic/claude-sonnet-5', cost: 0.005 });
    await record(mine, { model: 'anthropic/claude-sonnet-5', cost: 0.003 });
    await record(mine, { model: 'ollama/qwen3:8b', cost: null, decision: 'local' });
    await record(mine, { model: 'anthropic/claude-opus-5', cost: 0.9, ageDays: 30 });
    await record(theirs, { model: 'anthropic/claude-opus-5', cost: 5 });
  });
  after(() => server.close());

  test('summarises the window: spend, cloud share, and a monthly projection', async () => {
    const { status, data } = await api('GET', '/api/usage?days=7');
    assert.equal(status, 200);
    assert.equal(data.queries, 3, 'the 30-day-old query is outside the window');
    assert.equal(data.cloudQueries, 2);
    assert.ok(Math.abs(data.spendUsd - 0.008) < 1e-9);
    assert.ok(Math.abs(data.averageCloudCostUsd - 0.004) < 1e-9);
    assert.ok(Math.abs(data.projectedMonthlyUsd - (0.008 / 7) * 30) < 1e-9, 'what this user costs per month at this rate');
    assert.deepEqual(data.byModel.map((row) => row.model), ['anthropic/claude-sonnet-5', 'ollama/qwen3:8b']);
    assert.equal(data.byModel[1].spend, 0, 'local answers cost nothing');
  });

  test('a longer window picks up the older query', async () => {
    const { data } = await api('GET', '/api/usage?days=60');
    assert.equal(data.queries, 4);
    assert.ok(data.spendUsd > 0.9);
  });

  test('spend is per owner', async () => {
    const { data } = await other('GET', '/api/usage');
    assert.equal(data.queries, 1);
    assert.equal(data.spendUsd, 5);
  });

  test('validation and authentication', async () => {
    assert.equal((await api('GET', '/api/usage?days=0')).status, 400);
    assert.equal((await api('GET', '/api/usage?days=abc')).status, 400);
    assert.equal((await session(server.base)('GET', '/api/usage')).status, 401);
  });
});
