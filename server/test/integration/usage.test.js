import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { deleteLink } from '../../src/control/linkStore.js';
import { linkUser, meFor, startFakeControl } from '../fakeControl.js';
import { registeredSession, session, startServer } from '../helpers.js';

describe('usage and spend', () => {
  let server;
  let control;
  let api;
  let other;

  const record = (ownerId, { model, cost, decision = 'cloud', ageDays = 0, billedTo = 'platform' }) =>
    server.pool.query(
      `INSERT INTO query_metrics (query_text, owner_id, tier, routing_decision, model_used, cost_usd, output_tokens, billed_to, created_at)
       VALUES ('q', $1, 'cloud_frontier', $2, $3, $4, 100, $5, now() - ($6::text || ' days')::interval)`,
      [ownerId, decision, model, cost, decision === 'cloud' ? billedTo : null, ageDays]
    );

  before(async () => {
    // A cached plan only counts while a control plane is configured; the
    // plans below are cached fresh, so the stand-in is never asked.
    control = await startFakeControl();
    process.env.CONTROL_URL = control.url;
    server = await startServer();
    api = await registeredSession(server.base);
    other = await registeredSession(server.base);
    const mine = (await api('GET', '/api/auth/session')).data.userId;
    const theirs = (await other('GET', '/api/auth/session')).data.userId;

    await record(mine, { model: 'anthropic/claude-sonnet-5', cost: 0.005 });
    await record(mine, { model: 'anthropic/claude-sonnet-5', cost: 0.003, billedTo: 'user_key' });
    await record(mine, { model: 'ollama/qwen3:8b', cost: null, decision: 'local' });
    await record(mine, { model: 'anthropic/claude-opus-5', cost: 0.9, ageDays: 30 });
    await record(theirs, { model: 'anthropic/claude-opus-5', cost: 5 });
  });
  after(async () => {
    delete process.env.CONTROL_URL;
    await server.close();
    await control.close();
  });

  test('summarises the window: spend, cloud share, and a monthly projection', async () => {
    const { status, data } = await api('GET', '/api/usage?days=7');
    assert.equal(status, 200);
    assert.equal(data.queries, 3, 'the 30-day-old query is outside the window');
    assert.equal(data.cloudQueries, 2);
    assert.ok(Math.abs(data.spendUsd - 0.008) < 1e-9);
    assert.ok(Math.abs(data.platformSpendUsd - 0.005) < 1e-9, 'only the platform-paid answer is margin');
    assert.ok(Math.abs(data.userKeySpendUsd - 0.003) < 1e-9, "the rest ran on the user's own key");
    assert.ok(Math.abs(data.averageCloudCostUsd - 0.004) < 1e-9);
    assert.ok(
      Math.abs(data.projectedMonthlyUsd - (0.005 / 7) * 30) < 1e-9,
      'the projection counts what the platform pays, not what the user pays'
    );
    assert.equal(data.plan, 'free');
    assert.deepEqual(data.byModel.map((row) => row.model), ['anthropic/claude-sonnet-5', 'ollama/qwen3:8b']);
    assert.equal(data.byModel[1].spend, 0, 'local answers cost nothing');
  });

  test('weekly allowance is reported against the plan, and is absent on a own-key plan', async () => {
    const mine = (await api('GET', '/api/auth/session')).data.userId;
    // The plan comes from the control plane; with no limits in its answer the
    // engine's own records stand in.
    await linkUser(server.pool, mine, 'student', { me: { ...meFor('student'), limits: null } });
    const student = (await api('GET', '/api/usage')).data;
    assert.equal(student.plan, 'student');
    assert.ok(Math.abs(student.weekly.allowanceUsd - (12 * 0.936 - 0.3) * 0.4 / (30 / 7)) < 1e-9, '40% of what $12 keeps, per week');
    assert.ok(Math.abs(student.weekly.spentUsd - 0.005) < 1e-9, 'only platform spend counts against it');
    assert.equal(student.weekly.exhausted, false);
    assert.equal(student.chooseCloud, false, 'Student cannot pick the cloud');
    assert.equal(student.autoCloud, true, 'but Auto may reach it');
    assert.deepEqual(student.weekly.nextModel, { default: 'claude-sonnet-5', hard: 'claude-sonnet-5' }, 'well under half the allowance');
    assert.equal(student.priceUsd, 12);
    const { rows: [platform] } = await server.pool.query(
      "SELECT count(*)::int AS n FROM query_metrics WHERE owner_id = $1 AND billed_to = 'platform' AND created_at > now() - interval '30 days'",
      [mine]
    );
    assert.ok(platform.n > 0, 'the fixture includes a platform-paid answer');
    assert.deepEqual(student.monthlyAnswers, { limit: 200, used: platform.n }, 'only platform-paid answers in the last 30 days count');

    await linkUser(server.pool, mine, 'key_pro');
    const keyPro = (await api('GET', '/api/usage')).data;
    assert.equal(keyPro.weekly.allowanceUsd, null);
    assert.match(keyPro.weekly.note, /own key/);
    assert.equal(keyPro.chooseCloud, true);

    await linkUser(server.pool, mine, 'free');
    const free = (await api('GET', '/api/usage')).data;
    assert.deepEqual([free.chooseCloud, free.autoCloud, free.weekly.note], [false, false, 'local only']);

    await deleteLink(mine, server.pool);
  });

  test("on a platform plan the control plane's ledger figures are shown, not this engine's", async () => {
    const mine = (await api('GET', '/api/auth/session')).data.userId;
    await linkUser(server.pool, mine, 'engineer', {
      me: meFor('engineer', { limits: { answersUsed: 17, weeklySpentUsd: 0.75, weeklyAllowanceUsd: 1.95 } }),
    });
    const data = (await api('GET', '/api/usage')).data;
    assert.equal(data.plan, 'engineer');
    assert.deepEqual(data.monthlyAnswers, { limit: 340, used: 17 });
    assert.equal(data.weekly.allowanceUsd, 1.95);
    assert.equal(data.weekly.spentUsd, 0.75);
    assert.ok(Math.abs(data.weekly.remainingUsd - 1.2) < 1e-9);
    await deleteLink(mine, server.pool);
  });

  test('signed out, or with a plan the control plane has not confirmed lately, usage reports Free', async () => {
    const mine = (await api('GET', '/api/auth/session')).data.userId;
    assert.equal((await api('GET', '/api/usage')).data.plan, 'free', 'signed out');
    // Confirmed an hour ago, and no control plane to ask again: offline.
    const saved = process.env.CONTROL_URL;
    delete process.env.CONTROL_URL;
    try {
      await linkUser(server.pool, mine, 'engineer', { fetchedAt: new Date(Date.now() - 60 * 60 * 1000) });
      const offline = (await api('GET', '/api/usage')).data;
      assert.equal(offline.plan, 'free');
      assert.equal(offline.autoCloud, false);
    } finally {
      if (saved !== undefined) process.env.CONTROL_URL = saved;
      await deleteLink(mine, server.pool);
    }
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
