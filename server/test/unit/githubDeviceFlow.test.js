import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { DeviceFlowError, deviceFlowRouter, pollDeviceFlow, startDeviceFlow } from '../../src/plugins/auth/deviceFlow.js';
import { describeGitHubError, getDeviceFlowConfig } from '../../src/plugins/github/oauth.js';

const URLS = { deviceCodeUrl: 'https://provider.test/device', tokenUrl: 'https://provider.test/token' };

// A stand-in for fetch that answers from a script and remembers each request,
// so the protocol can be checked without any network at all.
function scriptedFetch(...replies) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init, form: Object.fromEntries(new URLSearchParams(init.body)) });
    const reply = replies.shift();
    if (reply instanceof Error) throw reply;
    if (typeof reply === 'string') return new Response(reply, { status: 200 });
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200 });
  };
  fetch.calls = calls;
  return fetch;
}

const poll = (fetch, interval) =>
  pollDeviceFlow({ tokenUrl: URLS.tokenUrl, clientId: 'fake-client', deviceCode: 'fake-device', interval, fetch });

describe('device flow helper', () => {
  test('start sends only the public client id and scope, and returns both codes', async () => {
    const fetch = scriptedFetch({
      body: { device_code: 'fake-device', user_code: 'FAKE-1234', verification_uri: 'https://provider.test/activate', expires_in: 900, interval: 5 },
    });
    const started = await startDeviceFlow({ ...URLS, clientId: 'fake-client', scope: 'repo read:user', fetch });

    assert.deepEqual(started, {
      deviceCode: 'fake-device',
      userCode: 'FAKE-1234',
      verificationUri: 'https://provider.test/activate',
      verificationUriComplete: null,
      expiresIn: 900,
      interval: 5,
    });
    const [call] = fetch.calls;
    assert.equal(call.url, URLS.deviceCodeUrl);
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.headers.Accept, 'application/json');
    assert.deepEqual(call.form, { client_id: 'fake-client', scope: 'repo read:user' });
  });

  test('start defaults the interval to five seconds when the provider leaves it out', async () => {
    const fetch = scriptedFetch({ body: { device_code: 'd', user_code: 'u', verification_uri: 'https://provider.test/a', expires_in: 600 } });
    assert.equal((await startDeviceFlow({ ...URLS, clientId: 'fake-client', fetch })).interval, 5);
  });

  test('start refuses an expires_in that is missing or unusable, rather than expiring at once', async () => {
    const reply = (extra) => ({ body: { device_code: 'd', user_code: 'u', verification_uri: 'https://provider.test/a', interval: 5, ...extra } });
    for (const extra of [{}, { expires_in: null }, { expires_in: 'soon' }, { expires_in: 0 }, { expires_in: -60 }]) {
      const fetch = scriptedFetch(reply(extra));
      await assert.rejects(startDeviceFlow({ ...URLS, clientId: 'fake-client', fetch }), (err) => {
        assert.ok(err instanceof DeviceFlowError, JSON.stringify(extra));
        assert.equal(err.code, 'bad_response');
        assert.match(err.message, /expires_in/);
        return true;
      });
    }
    // A numeric string is still a number of seconds.
    const fetch = scriptedFetch(reply({ expires_in: '900' }));
    assert.equal((await startDeviceFlow({ ...URLS, clientId: 'fake-client', fetch })).expiresIn, 900);
  });

  test('start refuses an interval that is present but unusable', async () => {
    for (const interval of [null, 'fast', 0, -5]) {
      const fetch = scriptedFetch({ body: { device_code: 'd', user_code: 'u', verification_uri: 'https://provider.test/a', expires_in: 600, interval } });
      await assert.rejects(startDeviceFlow({ ...URLS, clientId: 'fake-client', fetch }), (err) => {
        assert.ok(err instanceof DeviceFlowError, String(interval));
        assert.equal(err.code, 'bad_response');
        assert.match(err.message, /interval/);
        return true;
      });
    }
  });

  test('start refuses without a client id and never calls the provider', async () => {
    const fetch = scriptedFetch();
    await assert.rejects(startDeviceFlow({ ...URLS, clientId: '', fetch }), { code: 'missing_client_id' });
    assert.equal(fetch.calls.length, 0);
  });

  test('start surfaces a provider refusal by its code', async () => {
    const fetch = scriptedFetch({ body: { error: 'device_flow_disabled', error_description: 'off' } });
    await assert.rejects(startDeviceFlow({ ...URLS, clientId: 'fake-client', fetch }), (err) => {
      assert.ok(err instanceof DeviceFlowError);
      assert.equal(err.code, 'device_flow_disabled');
      return true;
    });
  });

  test('poll sends the device-code grant', async () => {
    const fetch = scriptedFetch({ body: { error: 'authorization_pending' } });
    assert.deepEqual(await poll(fetch, 5), { status: 'pending', interval: 5 });
    assert.deepEqual(fetch.calls[0].form, {
      client_id: 'fake-client',
      device_code: 'fake-device',
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
  });

  test('slow_down adds five seconds, or more if the provider asks for more', async () => {
    assert.deepEqual(await poll(scriptedFetch({ body: { error: 'slow_down' } }), 5), { status: 'slow_down', interval: 10 });
    assert.deepEqual(await poll(scriptedFetch({ body: { error: 'slow_down', interval: 20 } }), 5), { status: 'slow_down', interval: 20 });
    assert.deepEqual(await poll(scriptedFetch({ body: { error: 'slow_down', interval: 6 } }), 10), { status: 'slow_down', interval: 15 });
  });

  test('expired, denied and connected', async () => {
    assert.deepEqual(await poll(scriptedFetch({ body: { error: 'expired_token' } })), { status: 'expired' });
    assert.deepEqual(await poll(scriptedFetch({ body: { error: 'access_denied' } })), { status: 'denied' });
    assert.deepEqual(
      await poll(scriptedFetch({ body: { access_token: 'fake-token', token_type: 'bearer', scope: 'repo' } })),
      { status: 'connected', accessToken: 'fake-token', tokenType: 'bearer', scope: 'repo' }
    );
  });

  test('reads refusals the RFC way (HTTP 400) as well as the GitHub way (HTTP 200)', async () => {
    assert.deepEqual(await poll(scriptedFetch({ status: 400, body: { error: 'authorization_pending' } }), 5), { status: 'pending', interval: 5 });
  });

  test('anything else is an error, never a silent pending', async () => {
    await assert.rejects(poll(scriptedFetch({ body: { error: 'incorrect_device_code' } })), { code: 'incorrect_device_code' });
    await assert.rejects(poll(scriptedFetch({ body: {} })), { code: 'bad_response' });
    await assert.rejects(poll(scriptedFetch('<html>bad gateway</html>')), { code: 'bad_response' });
    await assert.rejects(poll(scriptedFetch({ status: 502, body: { message: 'down' } })), { code: 'bad_response' });
    await assert.rejects(poll(scriptedFetch(new TypeError('fetch failed'))), { code: 'unreachable' });
  });
});

describe('device flow routes', () => {
  // Just enough of the engine to drive the router: a session object and a
  // provider whose config() fails the way the test says.
  async function serve(provider) {
    const app = express();
    app.use((req, res, next) => {
      req.session = {};
      next();
    });
    app.use('/device', deviceFlowRouter({ provider, tokenKey: 'fakeToken', fetch: scriptedFetch() }));
    const server = await new Promise((resolve) => {
      const listening = app.listen(0, () => resolve(listening));
    });
    const post = async (path) => {
      const response = await fetch(`http://localhost:${server.address().port}/device${path}`, { method: 'POST' });
      return { status: response.status, data: await response.json() };
    };
    return { post, close: () => new Promise((resolve) => server.close(resolve)) };
  }

  test('a DeviceFlowError reaches the browser in its own words, with its status', async () => {
    const provider = {
      config() {
        throw new DeviceFlowError('not_configured', 'set FAKE_CLIENT_ID', { status: 503 });
      },
      describeError: (err) => (err.code === 'not_configured' ? err.description : undefined),
    };
    const app = await serve(provider);
    try {
      assert.deepEqual(await app.post('/start'), { status: 503, data: { error: 'set FAKE_CLIENT_ID' } });
    } finally {
      await app.close();
    }
  });

  test('any other error is logged on the engine and answered with a plain 502', async () => {
    const logged = mock.method(console, 'error', () => {});
    const provider = {
      config() {
        throw new Error('internal detail: /home/someone/.config/engine.json');
      },
    };
    const app = await serve(provider);
    try {
      const { status, data } = await app.post('/start');
      assert.equal(status, 502);
      assert.doesNotMatch(data.error, /internal detail/);
      assert.ok(
        logged.mock.calls.some((call) => String(call.arguments[0]).includes('internal detail')),
        'the real cause is in the engine log'
      );
    } finally {
      logged.mock.restore();
      await app.close();
    }
  });
});

describe('github device-flow configuration', () => {
  const saved = { id: process.env.GITHUB_CLIENT_ID, base: process.env.GITHUB_OAUTH_BASE };
  afterEach(() => {
    for (const [key, value] of [['GITHUB_CLIENT_ID', saved.id], ['GITHUB_OAUTH_BASE', saved.base]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test('refuses cleanly without a client id, with no default', () => {
    delete process.env.GITHUB_CLIENT_ID;
    assert.throws(getDeviceFlowConfig, (err) => {
      assert.ok(err instanceof DeviceFlowError, 'worded for the user, so it may reach the browser');
      assert.equal(err.status, 503);
      assert.match(err.message, /GITHUB_CLIENT_ID/);
      return true;
    });
  });

  test("uses GitHub's device endpoints and scope", () => {
    process.env.GITHUB_CLIENT_ID = 'fake-client';
    delete process.env.GITHUB_OAUTH_BASE;
    assert.deepEqual(getDeviceFlowConfig(), {
      deviceCodeUrl: 'https://github.com/login/device/code',
      tokenUrl: 'https://github.com/login/oauth/access_token',
      clientId: 'fake-client',
      scope: 'repo read:user',
    });
  });

  test('turns the codes a user can act on into advice', () => {
    assert.match(describeGitHubError({ code: 'device_flow_disabled' }), /Enable Device Flow/);
    assert.equal(describeGitHubError({ code: 'something_new' }), undefined);
  });
});

describe('no client secret anywhere', () => {
  const root = fileURLToPath(new URL('../../..', import.meta.url));

  async function* files(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) yield* files(path);
      else if (/\.(js|jsx|md)$/.test(entry.name)) yield path;
    }
  }

  test('the engine, the CLI and the env template never mention one', async () => {
    const offenders = [];
    const paths = [join(root, '.env.example')];
    for (const dir of ['server/src', 'cli/src']) {
      for await (const path of files(join(root, dir))) paths.push(path);
    }
    for (const path of paths) {
      const text = await readFile(path, 'utf8');
      if (/GITHUB_CLIENT_SECRET/i.test(text)) offenders.push(path);
      // Plug-in sign-in in particular must never send one; other features
      // (a payment provider's client-side token, say) may use the same word.
      if (path.includes(join('src', 'plugins')) && /client_secret/i.test(text)) offenders.push(path);
    }
    assert.deepEqual(offenders, []);
  });
});
