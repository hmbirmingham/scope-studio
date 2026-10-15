import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { freesUpNext, recordUsage, usageSince } from '../../src/models/ledger.js';
import { createAccount, startServer, truncateAll } from '../helpers.js';

let server;
let account;
before(async () => {
  server = await startServer();
});
beforeEach(async () => {
  await truncateAll(server.pool);
  account = await createAccount(server.pool, { plan: 'student' });
});
after(() => server.close());

const answer = (overrides = {}) => ({
  accountId: account.id,
  requestId: 'req-1',
  model: 'claude-sonnet-5',
  inputTokens: 1200,
  outputTokens: 400,
  costUsd: 0.02,
  ...overrides,
});

test('a retried request is charged once', async () => {
  assert.equal(await recordUsage(answer(), server.pool), true);
  assert.equal(await recordUsage(answer(), server.pool), false);
  const usage = await usageSince(account.id, new Date(0), server.pool);
  assert.deepEqual(usage, { spentUsd: 0.02, answers: 1 });
});

test('usage counts only answers since the given moment, for that account', async () => {
  const other = await createAccount(server.pool, { email: 'other@scope.local', plan: 'engineer' });
  await recordUsage(answer({ requestId: 'old', costUsd: 0.05 }), server.pool);
  await server.pool.query(`UPDATE usage_ledger SET created_at = now() - interval '8 days' WHERE request_id = 'old'`);
  await recordUsage(answer({ requestId: 'new', costUsd: 0.02 }), server.pool);
  await recordUsage(answer({ accountId: other.id, requestId: 'theirs', costUsd: 0.4 }), server.pool);

  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  assert.deepEqual(await usageSince(account.id, weekAgo, server.pool), { spentUsd: 0.02, answers: 1 });
});

test('an answer records which plug-ins supplied its context', async () => {
  await recordUsage(answer({ requestId: 'kicad-1', sources: ['kicad', 'github'] }), server.pool);
  const { rows } = await server.pool.query(`SELECT sources FROM usage_ledger WHERE request_id = 'kicad-1'`);
  assert.deepEqual(rows[0].sources, ['kicad', 'github']);
});

test('the ledger has no column that could hold a prompt or an answer', async () => {
  const { rows } = await server.pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'usage_ledger'`
  );
  const columns = rows.map((row) => row.column_name).sort();
  assert.deepEqual(columns, [
    'account_id', 'cost_usd', 'created_at', 'hard', 'id', 'input_tokens',
    'model', 'output_tokens', 'request_id', 'sources', 'web_searches',
  ]);
});

test('the next spend to free up is the oldest answer in the week, a week after it was made', async () => {
  assert.equal(await freesUpNext(account.id, new Date(), server.pool), null);
  await recordUsage(answer({ requestId: 'gone', costUsd: 0.5 }), server.pool);
  await recordUsage(answer({ requestId: 'oldest', costUsd: 0.03 }), server.pool);
  await recordUsage(answer({ requestId: 'newer', costUsd: 0.07 }), server.pool);
  await server.pool.query(`UPDATE usage_ledger SET created_at = now() - interval '9 days' WHERE request_id = 'gone'`);
  await server.pool.query(`UPDATE usage_ledger SET created_at = now() - interval '3 days' WHERE request_id = 'oldest'`);

  const { rows } = await server.pool.query(`SELECT created_at FROM usage_ledger WHERE request_id = 'oldest'`);
  const next = await freesUpNext(account.id, new Date(), server.pool);
  assert.equal(next.amountUsd, 0.03);
  assert.equal(next.at.getTime(), rows[0].created_at.getTime() + 7 * 24 * 60 * 60 * 1000);
});
