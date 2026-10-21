import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { deviceToken } from '../../src/control/plan.js';
import { parseNdjson } from '../../src/lib/ollama.js';
import { resetConversations } from '../../src/routing/conversation.js';
import { resetWarmState } from '../../src/routing/warm.js';
import { startFakeStripe } from '../../../control/test/fakeStripe.js';
import { startFakeAnthropic } from '../fakeAnthropic.js';
import { controlAccount, linkUser, startControlPlane } from '../fakeControl.js';
import { deadUrl, startFakeOllama } from '../fakeOllama.js';
import { ensureCentroids, registeredSession, startServer } from '../helpers.js';

// The engine against the real control plane (control/), in this process, on
// its own test database: browser sign-in over loopback + PKCE, the plan read
// from /v1/me, platform answers streamed from /v1/cloud/messages, billing
// forwarded to /v1/billing*, and sign-out revoking the device.

const realOllama = process.env.OLLAMA_URL || 'http://localhost:11434';
// Distinctive text that must never reach the control plane's ledger.
const SECRET_QUESTION = 'how does the zebra-quokka ingestion pipeline chunk and prune files';
const SECRET_CONTENT = 'The zebra-quokka ingestion pipeline chunks files, embeds each chunk, and prunes deleted paths.';

describe('engine and control plane', () => {
  let server;
  let control;
  let anthropic;
  let ollama;
  let api;
  let ownerId;

  const chat = (body) => api.raw('POST', '/api/chat', body);
  async function readLines(response) {
    const lines = [];
    for await (const line of parseNdjson(response.body)) lines.push(line);
    return lines;
  }
  async function withLocalDown(fn) {
    const previous = process.env.OLLAMA_URL;
    process.env.OLLAMA_URL = await deadUrl();
    try {
      return await fn();
    } finally {
      process.env.OLLAMA_URL = previous;
    }
  }
  async function metricsRow(queryId) {
    for (let i = 0; i < 100; i++) {
      const { rows } = await server.pool.query('SELECT * FROM query_metrics WHERE query_id = $1', [queryId]);
      if (rows[0]) return rows[0];
      await sleep(20);
    }
    throw new Error('no metrics row');
  }

  // What a person does in the browser: open the sign-in page the engine gave
  // them, register on the control plane, and let the page hand the code back
  // to the engine's loopback port.
  async function browserSignIn(signinUrl, { email, password = 'correct horse battery' }) {
    const page = await fetch(signinUrl);
    assert.equal(page.status, 200, 'the control plane accepts the link the engine made');
    const params = new URL(signinUrl).searchParams;
    const register = await fetch(`${control.url}/v1/accounts`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }),
    });
    assert.equal(register.status, 201);
    const cookie = register.headers.get('set-cookie').split(';')[0];
    const authorize = await fetch(`${control.url}/v1/auth/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({
        redirect_uri: params.get('redirect_uri'),
        state: params.get('state'),
        code_challenge: params.get('code_challenge'),
        code_challenge_method: params.get('code_challenge_method'),
        label: params.get('label'),
      }),
    });
    assert.equal(authorize.status, 200);
    const { redirect } = await authorize.json();
    return fetch(redirect);
  }

  before(async () => {
    ollama = await startFakeOllama({ embedUrl: realOllama });
    anthropic = await startFakeAnthropic();
    process.env.OLLAMA_URL = ollama.url;
    process.env.ANTHROPIC_BASE_URL = anthropic.url;
    server = await startServer();
    await ensureCentroids(server.pool);
    control = await startControlPlane();
    process.env.CONTROL_URL = control.url;
    api = await registeredSession(server.base);
    ownerId = (await api('GET', '/api/auth/session')).data.userId;
    await api('POST', '/api/nodes', { type: 'file', content: `docs/pipeline.md\n\n${SECRET_CONTENT}`, project: 'hmb/docs', privacy: 'cloud' });
  });

  beforeEach(() => {
    resetConversations();
    resetWarmState();
    anthropic.state.requests = [];
    anthropic.state.authHeaders = [];
  });

  after(async () => {
    process.env.OLLAMA_URL = realOllama;
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.CONTROL_URL;
    await control.close();
    await server.close();
    await ollama.close();
    await anthropic.close();
  });

  test('signed out, the engine is Free and says so, and sign-in needs a control plane to be configured', async () => {
    const { data } = await api('GET', '/api/control/status');
    assert.deepEqual([data.configured, data.signedIn, data.plan], [true, false, 'free']);

    const saved = process.env.CONTROL_URL;
    delete process.env.CONTROL_URL;
    try {
      const refused = await api('POST', '/api/control/signin');
      assert.equal(refused.status, 503);
      assert.equal(refused.data.code, 'control_not_configured');
      assert.equal((await api('GET', '/api/control/status')).data.configured, false);
    } finally {
      process.env.CONTROL_URL = saved;
    }
  });

  test('signs in through the browser with loopback and PKCE, and the plan comes from /v1/me', async () => {
    const started = await api('POST', '/api/control/signin');
    assert.equal(started.status, 200);
    assert.ok(started.data.url.startsWith(`${control.url}/signin?`));
    assert.equal((await api('GET', '/api/control/status')).data.pending.url, started.data.url);

    const landing = await browserSignIn(started.data.url, { email: 'student@scope.test' });
    assert.equal(landing.status, 200);
    assert.match(await landing.text(), /Signed in to Scope Studio/);

    const signedIn = (await api('GET', '/api/control/status')).data;
    assert.deepEqual([signedIn.signedIn, signedIn.online, signedIn.plan, signedIn.account.email], [true, true, 'free', 'student@scope.test']);
    assert.equal(signedIn.pending, null);

    // The token is stored sealed, and never handed to the client.
    const { rows: [link] } = await server.pool.query('SELECT token_sealed FROM control_links WHERE owner_id = $1', [ownerId]);
    const token = await deviceToken(ownerId);
    assert.match(token, /^sst_/);
    assert.ok(!link.token_sealed.includes(token));
    assert.ok(!JSON.stringify(signedIn).includes(token));
    const { rows: devices } = await control.pool.query('SELECT label FROM device_tokens');
    assert.equal(devices.length, 1);
    assert.match(devices[0].label, /^Scope Studio on /);

    // The plan changes on the control plane (a purchase); a refresh picks it up.
    await control.pool.query(`UPDATE accounts SET plan = 'student' WHERE email = 'student@scope.test'`);
    const refreshed = (await api('GET', '/api/control/status?refresh=1')).data;
    assert.equal(refreshed.plan, 'student');
    assert.equal(refreshed.limits.monthlyAnswers, 200);
    assert.equal((await api('GET', '/api/usage')).data.plan, 'student');
  });

  test('a Student answer streams from the platform, and the ledger holds no prompt or answer text', async () => {
    const lines = await withLocalDown(async () => readLines(await chat({ query: SECRET_QUESTION })));
    const [context] = lines;
    assert.equal(context.routing.decision, 'cloud');
    assert.equal(context.routing.model, 'anthropic/claude-sonnet-5');
    assert.equal(lines.filter((line) => line.type === 'token').map((line) => line.text).join(''), 'Cloud answer.');
    const done = lines.at(-1);
    assert.equal(done.type, 'done');
    assert.ok(done.metrics.costUsd > 0);

    // The control plane called Anthropic on the platform's key; the engine never did.
    assert.equal(anthropic.state.requests.length, 1);
    assert.deepEqual(anthropic.state.authHeaders, ['sk-ant-test-not-a-real-key']);
    assert.match(JSON.stringify(anthropic.state.requests[0].messages), /zebra-quokka/, 'the packed context was sent');

    const { rows: ledger } = await control.pool.query('SELECT row_to_json(l)::text AS row, request_id FROM usage_ledger l');
    assert.equal(ledger.length, 1);
    assert.ok(!/zebra|quokka|Cloud answer|ingestion/.test(ledger[0].row), 'no prompt or answer text in the ledger');
    assert.equal((await metricsRow(done.queryId)).billed_to, 'platform');

    // An id names one attempt: sending it again is refused.
    const again = await fetch(`${control.url}/v1/cloud/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await deviceToken(ownerId)}` },
      body: JSON.stringify({ requestId: ledger[0].request_id, messages: [{ role: 'user', content: 'again' }] }),
    });
    assert.equal(again.status, 409);
    assert.equal((await again.json()).code, 'duplicate_request');
  });

  test('a platform answer that fails upstream before any text is retried on a fresh requestId', async () => {
    const before = (await control.pool.query('SELECT count(*)::int AS n FROM usage_ledger')).rows[0].n;
    // The first request to Anthropic fails with a status the SDK does not
    // retry itself; the next one answers.
    let failures = 1;
    Object.defineProperty(anthropic.state, 'failAfter', { configurable: true, get: () => (failures-- > 0 ? 0 : null), set() {} });
    anthropic.state.failStatus = 400;
    try {
      const lines = await withLocalDown(async () => readLines(await chat({ query: SECRET_QUESTION })));
      assert.equal(lines.at(-1).type, 'done');
      assert.equal(anthropic.state.requests.length, 2, 'the control plane was asked twice');
    } finally {
      delete anthropic.state.failAfter;
      anthropic.state.failAfter = null;
      anthropic.state.failStatus = 529;
    }
    const { rows } = await control.pool.query('SELECT request_id FROM usage_ledger ORDER BY created_at');
    assert.equal(rows.length, before + 1, 'the answer that finished is charged once');
    assert.equal(new Set(rows.map((r) => r.request_id)).size, rows.length);
  });

  test('billing is forwarded to the control plane with the device token', async () => {
    const stripe = await startFakeStripe();
    const env = {
      STRIPE_MODE: 'test', STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_WEBHOOK_SECRET: 'whsec_test_fake',
      STRIPE_PRICE_KEY_PRO: 'price_keypro', STRIPE_PRICE_STUDENT: 'price_student', STRIPE_PRICE_ENGINEER: 'price_engineer',
      STRIPE_API_BASE: stripe.url,
    };
    const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
    try {
      const unconfigured = (await api('GET', '/api/billing')).data;
      assert.deepEqual([unconfigured.signedIn, unconfigured.configured, unconfigured.plan], [true, false, 'student']);
      const refused = await api('POST', '/api/billing/checkout', { plan: 'engineer' });
      assert.equal(refused.status, 503);
      assert.equal(refused.data.code, 'billing_not_configured');

      Object.assign(process.env, env);
      const billing = (await api('GET', '/api/billing')).data;
      assert.deepEqual([billing.configured, billing.plan, billing.hasSubscription], [true, 'student', false]);
      assert.deepEqual(billing.prices, { key_pro: 5, student: 12, engineer: 25 });

      const checkout = await api('POST', '/api/billing/checkout', { plan: 'engineer' });
      assert.equal(checkout.status, 200);
      assert.equal(checkout.data.url, 'https://checkout.stripe.test/c/pay/cs_test_1');
      assert.ok(stripe.state.requests.some((r) => r.url === '/v1/checkout/sessions' && r.form['line_items[0][price]'] === 'price_engineer'));

      const portal = await api('POST', '/api/billing/portal', {});
      assert.equal(portal.status, 200);
      assert.match(portal.data.url, /^https:\/\/billing\.stripe\.test\/p\/cus_/);

      assert.equal((await api('POST', '/api/billing/checkout', { plan: 'gold' })).status, 400);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await stripe.close();
    }
  });

  test('signing out revokes the device on the control plane, and the engine is Free again', async () => {
    const token = await deviceToken(ownerId);
    const { data } = await api('POST', '/api/control/signout');
    assert.deepEqual(data, { signedOut: true, revoked: true });
    const { rows: [device] } = await control.pool.query('SELECT revoked_at FROM device_tokens');
    assert.ok(device.revoked_at, 'revoked on the control plane');
    assert.equal(await deviceToken(ownerId), null);
    assert.deepEqual(
      [(await api('GET', '/api/control/status')).data.signedIn, (await api('GET', '/api/control/status')).data.plan],
      [false, 'free']
    );
    const me = await fetch(`${control.url}/v1/me`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(me.status, 401, 'the old token no longer works anywhere');

    // Free: a question the local model cannot answer is refused, never sent.
    const response = await withLocalDown(() => chat({ query: SECRET_QUESTION }));
    assert.equal(response.status, 503);
    assert.equal(anthropic.state.requests.length, 0);
    const billing = (await api('GET', '/api/billing')).data;
    assert.deepEqual([billing.signedIn, billing.plan], [false, 'free']);
    assert.equal((await api('POST', '/api/billing/checkout', { plan: 'student' })).data.code, 'signed_out');
  });

  test('a device removed from another machine signs this engine out at the next plan check', async () => {
    const account = await controlAccount(control, { email: 'engineer@scope.test', plan: 'engineer' });
    await linkUser(server.pool, ownerId, 'engineer', { token: account.token, fetchedAt: new Date(0) });
    assert.equal((await api('GET', '/api/control/status')).data.plan, 'engineer');
    await control.pool.query('UPDATE device_tokens SET revoked_at = now() WHERE account_id = $1', [account.id]);
    const status = (await api('GET', '/api/control/status?refresh=1')).data;
    assert.deepEqual([status.signedIn, status.plan], [false, 'free']);
  });
});
