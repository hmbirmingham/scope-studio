import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { recordUsage, usageSince } from '../../src/models/ledger.js';
import { createAccount, startServer } from '../helpers.js';

let server;
let account;
before(async () => {
  server = await startServer();
});
beforeEach(async () => {
  await server.pool.query('TRUNCATE accounts, device_tokens, usage_ledger CASCADE');
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

test('the ledger has no column that could hold a prompt or an answer', async () => {
  const { rows } = await server.pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'usage_ledger'`
  );
  const columns = rows.map((row) => row.column_name).sort();
  assert.deepEqual(columns, [
    'account_id', 'cost_usd', 'created_at', 'hard', 'id', 'input_tokens',
    'model', 'output_tokens', 'request_id', 'web_searches',
  ]);
});
