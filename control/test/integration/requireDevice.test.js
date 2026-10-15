import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { hashToken, newDeviceToken } from '../../src/auth/tokens.js';
import { requireDevice } from '../../src/middleware/requireDevice.js';
import { createAccount, startServer, truncateAll } from '../helpers.js';

let server;
let probe;
let account;

before(async () => {
  server = await startServer();
  const app = express();
  app.get('/probe', requireDevice({ pool: server.pool }), (req, res) =>
    res.json({ account: req.account, deviceId: req.deviceId })
  );
  probe = await new Promise((resolve) => {
    const instance = app.listen(0, () => resolve(instance));
  });
});
beforeEach(async () => {
  await truncateAll(server.pool);
  account = await createAccount(server.pool, { plan: 'engineer' });
});
after(async () => {
  await new Promise((resolve) => probe.close(resolve));
  await server.close();
});

async function issue(accountId, { revoked = false } = {}) {
  const token = newDeviceToken();
  const { rows } = await server.pool.query(
    `INSERT INTO device_tokens (account_id, token_hash, label, revoked_at)
     VALUES ($1, $2, 'test device', CASE WHEN $3 THEN now() END) RETURNING id`,
    [accountId, hashToken(token), revoked]
  );
  return { token, id: rows[0].id };
}

const call = (headers = {}) => fetch(`http://localhost:${probe.address().port}/probe`, { headers });

test('a valid token resolves to its account and device, and marks it used', async () => {
  const { token, id } = await issue(account.id);
  const response = await call({ authorization: `Bearer ${token}` });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body, { account: { id: account.id, email: 'test@scope.local', plan: 'engineer', devMode: false }, deviceId: id });
  const { rows } = await server.pool.query('SELECT last_used_at FROM device_tokens WHERE id = $1', [id]);
  assert.ok(rows[0].last_used_at);
});

test('missing, malformed, unknown and revoked tokens get one identical 401', async () => {
  const revoked = await issue(account.id, { revoked: true });
  const cases = [{}, { authorization: 'Basic abc' }, { authorization: 'Bearer nope' },
    { authorization: `Bearer ${newDeviceToken()}` }, { authorization: `Bearer ${revoked.token}` }];
  const bodies = new Set();
  for (const headers of cases) {
    const response = await call(headers);
    assert.equal(response.status, 401, JSON.stringify(headers));
    bodies.add(await response.text());
  }
  assert.equal(bodies.size, 1, 'no case is distinguishable from another');
  assert.equal(JSON.parse([...bodies][0]).code, 'unauthenticated');
});

test('only the hash is stored', async () => {
  const { token } = await issue(account.id);
  const { rows } = await server.pool.query('SELECT token_hash FROM device_tokens');
  assert.equal(rows[0].token_hash, hashToken(token));
  assert.notEqual(rows[0].token_hash, token);
});
