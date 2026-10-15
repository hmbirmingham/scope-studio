import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import createApp from '../../src/app.js';
import { startServer } from '../helpers.js';

let server;
before(async () => {
  server = await startServer();
});
after(() => server.close());

test('health answers ok when the database is reachable', async () => {
  const response = await fetch(`${server.base}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok', env: 'test' });
});

test('health answers 503 when the database is not', async () => {
  const deadPool = { query: () => Promise.reject(new Error('connection refused')) };
  const app = createApp({ nodeEnv: 'test' }, { pool: deadPool });
  const instance = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  try {
    const response = await fetch(`http://localhost:${instance.address().port}/health`);
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.equal(body.status, 'unavailable');
    assert.doesNotMatch(JSON.stringify(body), /connection refused/, 'driver errors stay server-side');
  } finally {
    await new Promise((resolve) => instance.close(resolve));
  }
});

test('unknown paths are a JSON 404', async () => {
  const response = await fetch(`${server.base}/api/billing/webhook`, { method: 'POST' });
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: 'not found' });
});
