import { after, afterEach, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { hashToken } from '../../src/auth/tokens.js';
import { PLANS } from '../../src/billing/plans.js';
import { recordUsage } from '../../src/models/ledger.js';
import { setNotifyProvider } from '../../src/notify/index.js';
import { startServer, truncateAll } from '../helpers.js';

const PASSWORD = 'a long enough password';
const DEV_EMAIL = 'dev@example.test';
const NOTIFY_VARS = ['DEV_MODE_EMAILS', 'DEV_LOGIN_NOTIFY_EMAIL', 'RESEND_API_KEY', 'NOTIFY_FROM_EMAIL'];
const savedEnv = Object.fromEntries(NOTIFY_VARS.map((key) => [key, process.env[key]]));

let server;
before(async () => {
  server = await startServer();
});
beforeEach(async () => {
  await truncateAll(server.pool);
  for (const key of NOTIFY_VARS) delete process.env[key];
  setNotifyProvider(null);
});
afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  setNotifyProvider(null);
});
after(() => server.close());

// A browser with a cookie jar: it keeps whatever cookies the control plane
// sets and sends them back, the way the sign-in page's fetches do.
class Browser {
  constructor() {
    this.cookies = new Map();
  }

  async fetch(path, init = {}) {
    const headers = { ...init.headers };
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    const response = await fetch(`${server.base}${path}`, { ...init, headers, redirect: 'manual' });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const name = pair.slice(0, pair.indexOf('='));
      const value = pair.slice(pair.indexOf('=') + 1);
      if (!value || /expires=Thu, 01 Jan 1970/i.test(cookie)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return response;
  }

  post(path, body) {
    return this.fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }
}

// What a local engine does before opening /signin: a loopback port, a state
// and a PKCE verifier it keeps to itself.
function newEngine({ label = 'Test Mac' } = {}) {
  const verifier = randomBytes(32).toString('base64url');
  return {
    verifier,
    challenge: createHash('sha256').update(verifier).digest('base64url'),
    redirectUri: 'http://127.0.0.1:53682/callback',
    state: randomBytes(8).toString('hex'),
    label,
  };
}

const authorizeBody = (engine) => ({
  redirect_uri: engine.redirectUri,
  state: engine.state,
  code_challenge: engine.challenge,
  code_challenge_method: 'S256',
  label: engine.label,
});

const exchange = (code, verifier) =>
  fetch(`${server.base}/v1/auth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, code_verifier: verifier }),
  });

const api = (path, token, init = {}) =>
  fetch(`${server.base}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers } });

// Everything up to the redirect back to the engine: open the page, sign in
// or register, authorize. Returns the code the engine would receive.
async function authorizeInBrowser({ email, register = true, devMode = false, engine = newEngine(), browser = new Browser() }) {
  const query = new URLSearchParams({ ...authorizeBody(engine) });
  const page = await browser.fetch(`/signin?${query}`);
  assert.equal(page.status, 200);

  const login = await browser.post(register ? '/v1/accounts' : '/v1/auth/login', { email, password: PASSWORD, dev_mode: devMode });
  assert.equal(login.status, register ? 201 : 200, await login.clone().text());

  const authorized = await browser.post('/v1/auth/authorize', authorizeBody(engine));
  assert.equal(authorized.status, 200, await authorized.clone().text());
  const redirect = new URL((await authorized.json()).redirect);
  assert.equal(`${redirect.origin}${redirect.pathname}`, engine.redirectUri);
  assert.equal(redirect.searchParams.get('state'), engine.state);
  return { code: redirect.searchParams.get('code'), engine, browser };
}

async function signIn(options) {
  const { code, engine, browser } = await authorizeInBrowser(options);
  const response = await exchange(code, engine.verifier);
  assert.equal(response.status, 200, await response.clone().text());
  return { ...(await response.json()), browser, engine };
}

async function setPlan(accountId, plan) {
  await server.pool.query('UPDATE accounts SET plan = $1 WHERE id = $2', [plan, accountId]);
}

test('a full sign-in: page, register, authorize, token exchange, then /v1/me and the device list', async () => {
  const browser = new Browser();
  const engine = newEngine();
  const page = await browser.fetch(`/signin?${new URLSearchParams(authorizeBody(engine))}`);
  assert.match(page.headers.get('content-security-policy'), /script-src 'nonce-/);
  assert.match(await page.text(), /id="register"/);

  const register = await browser.post('/v1/accounts', { email: 'New@Example.test', password: PASSWORD });
  assert.equal(register.status, 201);
  const cookie = register.headers.getSetCookie().join('\n');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  const created = await register.json();
  assert.equal(created.email, 'new@example.test', 'emails are stored lowercased');

  const { code } = await authorizeInBrowser({ email: 'new@example.test', register: false, engine, browser });
  const { rows: codes } = await server.pool.query('SELECT code_hash, label, expires_at FROM auth_codes');
  assert.equal(codes[0].code_hash, hashToken(code), 'only the hash of the code is stored');
  assert.equal(codes[0].label, 'Test Mac');
  assert.ok(codes[0].expires_at - Date.now() <= 5 * 60 * 1000);

  const response = await exchange(code, engine.verifier);
  assert.equal(response.status, 200);
  const { token, account } = await response.json();
  assert.match(token, /^sst_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(account, { id: created.id, email: 'new@example.test', plan: 'free', devMode: false });

  const me = await api('/v1/me', token);
  assert.equal(me.status, 200);
  assert.deepEqual((await me.json()).account, account);

  const devices = await (await api('/v1/devices', token)).json();
  assert.equal(devices.devices.length, 1);
  assert.equal(devices.devices[0].label, 'Test Mac');
  assert.equal(devices.devices[0].current, true);
  assert.ok(devices.devices[0].createdAt);
});

test('the sign-in page escapes every reflected value', async () => {
  const engine = newEngine({ label: '<script>alert(1)</script>' });
  engine.state = '"><img src=x onerror=alert(2)>';
  const response = await fetch(`${server.base}/signin?${new URLSearchParams(authorizeBody(engine))}`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /&quot;&gt;&lt;img src=x onerror=alert\(2\)&gt;/);
});

test('a foreign redirect is refused by the page and by authorize', async () => {
  const engine = newEngine();
  engine.redirectUri = 'https://evil.example/callback';
  const page = await fetch(`${server.base}/signin?${new URLSearchParams(authorizeBody(engine))}`);
  assert.equal(page.status, 400);
  assert.doesNotMatch(await page.text(), /<form/);

  const browser = new Browser();
  await browser.post('/v1/accounts', { email: 'a@example.test', password: PASSWORD });
  const authorized = await browser.post('/v1/auth/authorize', authorizeBody(engine));
  assert.equal(authorized.status, 400);
  assert.equal((await authorized.json()).code, 'invalid_redirect_uri');

  const plain = await browser.post('/v1/auth/authorize', { ...authorizeBody(newEngine()), code_challenge_method: 'plain' });
  assert.equal((await plain.json()).code, 'invalid_code_challenge');
  const { rows } = await server.pool.query('SELECT count(*)::int AS n FROM auth_codes');
  assert.equal(rows[0].n, 0, 'no code is issued for a refused request');
});

test('authorize needs a signed-in browser, and logout ends it', async () => {
  const stranger = await new Browser().post('/v1/auth/authorize', authorizeBody(newEngine()));
  assert.equal(stranger.status, 401);

  const browser = new Browser();
  await browser.post('/v1/accounts', { email: 'a@example.test', password: PASSWORD });
  assert.equal((await browser.post('/v1/auth/logout', {})).status, 204);
  const afterLogout = await browser.post('/v1/auth/authorize', authorizeBody(newEngine()));
  assert.equal(afterLogout.status, 401);
});

test('a wrong verifier is refused and spends the code', async () => {
  const { code, engine } = await authorizeInBrowser({ email: 'a@example.test' });
  const wrong = await exchange(code, randomBytes(32).toString('base64url'));
  assert.equal(wrong.status, 400);
  assert.equal((await wrong.json()).code, 'invalid_grant');
  const retry = await exchange(code, engine.verifier);
  assert.equal(retry.status, 400, 'a stolen code gets one guess');
  const { rows } = await server.pool.query('SELECT count(*)::int AS n FROM device_tokens');
  assert.equal(rows[0].n, 0);
});

test('a code works once', async () => {
  const { code, engine } = await authorizeInBrowser({ email: 'a@example.test' });
  assert.equal((await exchange(code, engine.verifier)).status, 200);
  const reused = await exchange(code, engine.verifier);
  assert.equal(reused.status, 400);
  assert.equal((await reused.json()).code, 'invalid_grant');
});

test('an expired code is refused', async () => {
  const { code, engine } = await authorizeInBrowser({ email: 'a@example.test' });
  await server.pool.query(`UPDATE auth_codes SET expires_at = now() - interval '1 second'`);
  const response = await exchange(code, engine.verifier);
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'invalid_grant');
});

test('registration checks the email, the password length and duplicates', async () => {
  const browser = new Browser();
  const bad = await browser.post('/v1/accounts', { email: 'not-an-email', password: PASSWORD });
  assert.equal((await bad.json()).code, 'invalid_email');
  const short = await browser.post('/v1/accounts', { email: 'a@example.test', password: 'short' });
  assert.equal(short.status, 400);
  assert.equal((await short.json()).code, 'weak_password');
  assert.equal((await browser.post('/v1/accounts', { email: 'a@example.test', password: PASSWORD })).status, 201);
  const dup = await browser.post('/v1/accounts', { email: 'A@example.test', password: PASSWORD });
  assert.equal(dup.status, 409);
  assert.equal((await dup.json()).code, 'email_taken');
});

test('ten failed sign-ins lock the email for a while, even against the right password', async () => {
  const email = 'locked@example.test';
  const browser = new Browser();
  await browser.post('/v1/accounts', { email, password: PASSWORD });
  for (let i = 0; i < 10; i += 1) {
    const wrong = await browser.post('/v1/auth/login', { email, password: 'not the password' });
    assert.equal(wrong.status, 401);
    assert.equal((await wrong.json()).code, 'invalid_credentials');
  }
  const locked = await browser.post('/v1/auth/login', { email, password: PASSWORD });
  assert.equal(locked.status, 429);
  assert.equal((await locked.json()).code, 'too_many_attempts');
});

test('a revoked device is signed out at once, and the others stay signed in', async () => {
  const first = await signIn({ email: 'a@example.test' });
  const second = await signIn({ email: 'a@example.test', register: false, engine: newEngine({ label: 'Laptop' }) });

  const list = await (await api('/v1/devices', second.token)).json();
  assert.equal(list.devices.length, 2);
  const firstDevice = list.devices.find((d) => d.label === 'Test Mac');
  assert.equal(firstDevice.current, false);

  assert.equal((await api(`/v1/devices/${firstDevice.id}`, second.token, { method: 'DELETE' })).status, 204);
  const revoked = await api('/v1/me', first.token);
  assert.equal(revoked.status, 401);
  assert.equal((await revoked.json()).code, 'unauthenticated');
  assert.equal((await api('/v1/me', second.token)).status, 200);
  assert.equal((await api(`/v1/devices/${firstDevice.id}`, second.token, { method: 'DELETE' })).status, 404, 'already revoked');
});

test("another account's device is a 404 and stays signed in", async () => {
  const mine = await signIn({ email: 'a@example.test' });
  const theirs = await signIn({ email: 'b@example.test' });
  const [theirDevice] = (await (await api('/v1/devices', theirs.token)).json()).devices;

  const response = await api(`/v1/devices/${theirDevice.id}`, mine.token, { method: 'DELETE' });
  assert.equal(response.status, 404);
  assert.equal((await response.json()).code, 'not_found');
  assert.equal((await api('/v1/devices/not-a-uuid', mine.token, { method: 'DELETE' })).status, 404);
  assert.equal((await api('/v1/me', theirs.token)).status, 200);
  const myList = await (await api('/v1/devices', mine.token)).json();
  assert.deepEqual(myList.devices.map((d) => d.id).includes(theirDevice.id), false);
});

test('dev mode: an allowlisted email gets Engineer on that device, audited and reported, without touching accounts.plan', async (t) => {
  process.env.DEV_MODE_EMAILS = `other@example.test, ${DEV_EMAIL.toUpperCase()}`;
  process.env.DEV_LOGIN_NOTIFY_EMAIL = 'ops@example.test';
  const sent = [];
  setNotifyProvider({ send: async (message) => sent.push(message) });
  t.mock.method(console, 'warn', () => {});

  const dev = await signIn({ email: DEV_EMAIL, devMode: true });
  assert.deepEqual({ plan: dev.account.plan, devMode: dev.account.devMode }, { plan: 'engineer', devMode: true });

  const me = await (await api('/v1/me', dev.token)).json();
  assert.equal(me.account.plan, 'engineer');
  assert.equal(me.account.devMode, true);
  assert.equal(me.limits.monthlyAnswers, 340);

  const { rows: accounts } = await server.pool.query('SELECT plan FROM accounts WHERE id = $1', [dev.account.id]);
  assert.equal(accounts[0].plan, 'free', 'billing owns accounts.plan');

  const { rows: audit } = await server.pool.query('SELECT * FROM dev_logins');
  const { rows: devices } = await server.pool.query('SELECT id, dev_mode FROM device_tokens');
  assert.equal(audit.length, 1);
  assert.equal(audit[0].account_id, dev.account.id);
  assert.equal(audit[0].device_token_id, devices[0].id);
  assert.equal(audit[0].email, DEV_EMAIL);
  assert.equal(audit[0].label, 'Test Mac');
  assert.ok(audit[0].ip);
  assert.equal(devices[0].dev_mode, true);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'ops@example.test');
  assert.match(sent[0].text, new RegExp(DEV_EMAIL));

  // A normal sign-in on another machine is not dev mode.
  const normal = await signIn({ email: DEV_EMAIL, register: false, engine: newEngine({ label: 'Laptop' }) });
  assert.equal(normal.account.plan, 'free');
  assert.equal(normal.account.devMode, false);
});

test('dev mode is refused for an email that is not allowlisted', async () => {
  process.env.DEV_MODE_EMAILS = DEV_EMAIL;
  const browser = new Browser();
  const register = await browser.post('/v1/accounts', { email: 'a@example.test', password: PASSWORD, dev_mode: true });
  assert.equal(register.status, 403);
  assert.equal((await register.json()).code, 'dev_mode_not_allowed');
  const { rows } = await server.pool.query('SELECT count(*)::int AS n FROM accounts');
  assert.equal(rows[0].n, 0, 'the refused registration made no account');

  await browser.post('/v1/accounts', { email: 'a@example.test', password: PASSWORD });
  const login = await browser.post('/v1/auth/login', { email: 'a@example.test', password: PASSWORD, dev_mode: true });
  assert.equal(login.status, 403);
  assert.equal((await login.json()).code, 'dev_mode_not_allowed');
});

test('taking an email off the allowlist ends dev mode on its devices at once', async (t) => {
  process.env.DEV_MODE_EMAILS = DEV_EMAIL;
  t.mock.method(console, 'warn', () => {});
  const dev = await signIn({ email: DEV_EMAIL, devMode: true });
  assert.equal((await (await api('/v1/me', dev.token)).json()).account.plan, 'engineer');

  process.env.DEV_MODE_EMAILS = 'someone-else@example.test';
  const me = await (await api('/v1/me', dev.token)).json();
  assert.deepEqual(me.account, { id: dev.account.id, email: DEV_EMAIL, plan: 'free', devMode: false });
  assert.deepEqual(me.limits.monthlyAnswers, null);
});

test('with no email provider configured, the dev login is still audited and the notice is skipped with a warning', async (t) => {
  process.env.DEV_MODE_EMAILS = DEV_EMAIL;
  const warn = t.mock.method(console, 'warn', () => {});
  const dev = await signIn({ email: DEV_EMAIL, devMode: true });
  assert.equal(dev.account.devMode, true);
  const { rows } = await server.pool.query('SELECT email FROM dev_logins');
  assert.deepEqual(rows, [{ email: DEV_EMAIL }]);
  assert.equal(warn.mock.callCount(), 1);
  assert.match(warn.mock.calls[0].arguments[0], /notification skipped/);
});

test('/v1/me reports the plan, limits and next model from the ledger', async () => {
  const { token, account } = await signIn({ email: 'student@example.test' });
  await setPlan(account.id, 'student');

  const seed = async (requestId, costUsd, age) => {
    await recordUsage({ accountId: account.id, requestId, model: PLANS.student.models.default, costUsd }, server.pool);
    await server.pool.query(`UPDATE usage_ledger SET created_at = now() - $2::interval WHERE request_id = $1`, [requestId, age]);
  };
  await seed('in-week-old', 0.1, '2 days');
  await seed('in-week-new', 0.05, '1 hour');
  await seed('in-month', 0.4, '10 days');
  await seed('outside', 1.0, '40 days');
  const { rows } = await server.pool.query(`SELECT created_at FROM usage_ledger WHERE request_id = 'in-week-old'`);

  const me = await (await api('/v1/me', token)).json();
  assert.deepEqual(me.account, { id: account.id, email: 'student@example.test', plan: 'student', devMode: false });
  assert.deepEqual(me.capabilities, { chooseCloud: false, autoCloud: true, plugins: ['github', 'local_folder'] });
  assert.deepEqual(me.limits, {
    monthlyAnswers: 200,
    answersUsed: 3,
    weeklyAllowanceUsd: 1.02,
    weeklySpentUsd: 0.15,
    freesUpNext: { amountUsd: 0.1, at: new Date(rows[0].created_at.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString() },
  });
  assert.deepEqual(me.nextModel, PLANS.student.models);
  assert.deepEqual(me.billing, { status: null, renewsAt: null, cancelAt: null });
});

test('/v1/me steps the hard model down past half the week, and reports billing', async () => {
  const { token, account } = await signIn({ email: 'eng@example.test' });
  await setPlan(account.id, 'engineer');
  await server.pool.query(
    `UPDATE accounts SET billing_status = 'active', billing_renews_at = '2026-11-15T00:00:00Z' WHERE id = $1`,
    [account.id]
  );

  const { models } = PLANS.engineer;
  assert.notEqual(models.hard, models.default, 'Engineer answers hard questions on a stronger model');
  let me = await (await api('/v1/me', token)).json();
  assert.deepEqual(me.nextModel, models);
  assert.equal(me.limits.weeklyAllowanceUsd, 2.16);
  assert.equal(me.limits.freesUpNext, null);
  assert.deepEqual(me.billing, { status: 'active', renewsAt: '2026-11-15T00:00:00.000Z', cancelAt: null });

  await recordUsage({ accountId: account.id, requestId: 'big', model: models.hard, hard: true, costUsd: 1.2 }, server.pool);
  me = await (await api('/v1/me', token)).json();
  assert.deepEqual(me.nextModel, { default: models.default, hard: models.default }, 'past half the week, hard steps down');
});

test('/v1/me has null limits on plans without platform-paid cloud', async () => {
  const { token, account } = await signIn({ email: 'free@example.test' });
  const free = await (await api('/v1/me', token)).json();
  assert.deepEqual(free.limits, {
    monthlyAnswers: null, answersUsed: null, weeklyAllowanceUsd: null, weeklySpentUsd: null, freesUpNext: null,
  });
  assert.deepEqual(free.nextModel, { default: null, hard: null });
  assert.deepEqual(free.capabilities, { chooseCloud: false, autoCloud: false, plugins: ['github', 'local_folder'] });

  await setPlan(account.id, 'key_pro');
  const keyPro = await (await api('/v1/me', token)).json();
  assert.equal(keyPro.limits.weeklyAllowanceUsd, null);
  assert.equal(keyPro.capabilities.chooseCloud, true);
});
