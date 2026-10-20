import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import {
  FAKE_ACCESS_TOKEN,
  FAKE_DEVICE_CODE,
  FAKE_USER_CODE,
  startFakeGitHubOAuth,
} from '../fakeGitHub.js';
import { registeredSession, session, startServer } from '../helpers.js';

const START = '/api/plugins/github/device/start';
const POLL = '/api/plugins/github/device/poll';

describe('github device-flow sign-in', () => {
  let server;
  let fake;
  let api;
  const saved = { id: process.env.GITHUB_CLIENT_ID, base: process.env.GITHUB_OAUTH_BASE };

  // Every call goes through here, so every response body in this file is
  // checked for the device code, which must only ever live on the engine.
  async function call(method, path, body) {
    const result = await api(method, path, body);
    assert.ok(!JSON.stringify(result.data ?? '').includes(FAKE_DEVICE_CODE), `${path} leaked the device code`);
    return result;
  }

  // The engine holds the provider's pace itself; tests skip the wait by
  // moving the next allowed poll into the past instead of sleeping.
  async function releasePollGate() {
    await server.pool.query(
      `UPDATE session SET sess = jsonb_set(sess::jsonb, '{githubTokenDevice,nextPollAt}', '0')::json`
    );
  }

  const tokenPolls = () => fake.state.requests.filter((request) => request.url === '/login/oauth/access_token');

  before(async () => {
    server = await startServer();
    fake = await startFakeGitHubOAuth();
  });

  beforeEach(async () => {
    process.env.GITHUB_CLIENT_ID = 'fake-client-id';
    process.env.GITHUB_OAUTH_BASE = fake.url;
    fake.state.requests = [];
    fake.state.tokenReplies = [];
    fake.state.startError = null;
    fake.state.interval = 5;
    api = await registeredSession(server.base);
  });

  afterEach(() => {
    for (const [key, value] of [['GITHUB_CLIENT_ID', saved.id], ['GITHUB_OAUTH_BASE', saved.base]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  after(async () => {
    await fake.close();
    await server.close();
  });

  test('pending, then slow_down, then connected', async () => {
    fake.state.tokenReplies = ['authorization_pending', 'slow_down', 'connected'];

    const started = await call('POST', START);
    assert.equal(started.status, 200);
    assert.deepEqual(started.data, {
      userCode: FAKE_USER_CODE,
      verificationUri: 'https://github.test/login/device',
      expiresIn: 900,
      interval: 5,
    });
    const [deviceRequest] = fake.state.requests;
    assert.deepEqual(deviceRequest.form, { client_id: 'fake-client-id', scope: 'repo read:user' });

    // Too early: answered by the engine without asking GitHub.
    assert.deepEqual((await call('POST', POLL)).data, { status: 'pending', interval: 5 });
    assert.equal(tokenPolls().length, 0, 'an early poll costs GitHub nothing');

    await releasePollGate();
    assert.deepEqual((await call('POST', POLL)).data, { status: 'pending', interval: 5 });

    await releasePollGate();
    assert.deepEqual((await call('POST', POLL)).data, { status: 'pending', interval: 10 }, 'slow_down widens the pace');

    // The slower pace is enforced, not just reported.
    assert.deepEqual((await call('POST', POLL)).data, { status: 'pending', interval: 10 });
    assert.equal(tokenPolls().length, 2);

    await releasePollGate();
    assert.deepEqual((await call('POST', POLL)).data, { status: 'connected' });
    assert.equal(tokenPolls().length, 3);
    for (const request of tokenPolls()) {
      assert.deepEqual(request.form, {
        client_id: 'fake-client-id',
        device_code: FAKE_DEVICE_CODE,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      });
    }

    assert.equal((await call('GET', '/api/plugins/github/status')).data.connected, true);
    const { rows } = await server.pool.query(
      `SELECT sess->>'githubToken' AS token, sess->'githubTokenDevice' AS pending FROM session WHERE sess->>'githubToken' IS NOT NULL`
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].token, FAKE_ACCESS_TOKEN, 'the token is kept in the session');
    assert.equal(rows[0].pending, null, 'the device code is dropped once used');

    // A late poll from a second tab is told the truth, not an error.
    assert.deepEqual((await call('POST', POLL)).data, { status: 'connected' });
  });

  test('a code that ran out on the engine is expired without asking GitHub', async () => {
    await call('POST', START);
    await server.pool.query(
      `UPDATE session SET sess = jsonb_set(sess::jsonb, '{githubTokenDevice,expiresAt}', '0')::json`
    );
    assert.deepEqual((await call('POST', POLL)).data, { status: 'expired' });
    assert.equal(tokenPolls().length, 0);
    assert.equal((await call('POST', POLL)).status, 400, 'nothing left in progress');
  });

  test('a code GitHub says has expired', async () => {
    fake.state.tokenReplies = ['expired_token'];
    await call('POST', START);
    await releasePollGate();
    assert.deepEqual((await call('POST', POLL)).data, { status: 'expired' });
    assert.equal((await call('GET', '/api/plugins/github/status')).data.connected, false);
  });

  test('the user declining on GitHub', async () => {
    fake.state.tokenReplies = ['access_denied'];
    await call('POST', START);
    await releasePollGate();
    assert.deepEqual((await call('POST', POLL)).data, { status: 'denied' });
    assert.equal((await call('GET', '/api/plugins/github/status')).data.connected, false);
    assert.equal((await call('POST', POLL)).status, 400, 'a declined sign-in is not retried');
  });

  test('a GitHub app without device flow enabled says how to fix it', async () => {
    fake.state.startError = 'device_flow_disabled';
    const { status, data } = await call('POST', START);
    assert.equal(status, 502);
    assert.match(data.error, /Enable Device Flow/);
  });

  test('refuses cleanly without GITHUB_CLIENT_ID, and never calls GitHub', async () => {
    delete process.env.GITHUB_CLIENT_ID;
    const status = await call('GET', '/api/plugins/github/status');
    assert.deepEqual(status.data, { connected: false, configured: false });

    const { status: code, data } = await call('POST', START);
    assert.equal(code, 503);
    assert.match(data.error, /GITHUB_CLIENT_ID/);
    assert.equal(fake.state.requests.length, 0);
  });

  test('the old redirect routes are gone, and sign-in needs an account', async () => {
    assert.equal((await api.raw('GET', '/api/plugins/github/authorize', undefined, { redirect: 'manual' })).status, 404);
    assert.equal((await api.raw('GET', '/api/plugins/github/callback?code=x&state=y')).status, 404);

    const anonymous = session(server.base);
    assert.equal((await anonymous('POST', START)).status, 401);
    assert.equal((await anonymous('POST', POLL)).status, 401);
    assert.equal(fake.state.requests.length, 0);
  });
});
