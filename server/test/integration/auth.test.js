import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { session, startServer } from '../helpers.js';

describe('auth', () => {
  let server;
  before(async () => {
    server = await startServer();
  });
  after(() => server.close());

  test('register, session, logout, and rejection after logout', async () => {
    const api = session(server.base);
    const email = `auth-${Date.now()}@example.com`;

    const registered = await api('POST', '/api/auth/register', { email, password: 'hunter2!' });
    assert.equal(registered.status, 201);
    assert.equal(registered.data.email, email);

    const { rows: users } = await server.pool.query('SELECT id FROM users WHERE email = $1', [email]);
    assert.equal(users[0]?.id, registered.data.id, 'user row is persisted');
    const { rows: sessions } = await server.pool.query('SELECT count(*)::int AS count FROM session');
    assert.ok(sessions[0].count >= 1, 'session is stored in Postgres, not memory');

    const active = await api('GET', '/api/auth/session');
    assert.equal(active.status, 200);
    assert.equal(active.data.userId, registered.data.id);

    assert.equal((await api('POST', '/api/auth/logout')).status, 204);
    assert.equal((await api('GET', '/api/auth/session')).status, 401);

    const login = await api('POST', '/api/auth/login', { email, password: 'hunter2!' });
    assert.equal(login.status, 200);
    assert.equal((await api('POST', '/api/auth/login', { email, password: 'wrong' })).status, 401);
  });

  test('validation and duplicate registration', async () => {
    const api = session(server.base);
    assert.equal((await api('POST', '/api/auth/register', { email: 'x@example.com' })).status, 400);
    const email = `dup-${Date.now()}@example.com`;
    await api('POST', '/api/auth/register', { email, password: 'hunter2!' });
    assert.equal((await api('POST', '/api/auth/register', { email, password: 'hunter2!' })).status, 409);
  });
});
