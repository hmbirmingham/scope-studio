import { randomBytes } from 'node:crypto';
import http from 'node:http';
import pg from 'pg';
import { canAutoCloud, canChooseCloud, monthlyAnswerLimit, planFor, platformModel, weeklyAllowanceUsd } from '../src/billing/plans.js';
import { saveLink, saveMe } from '../src/control/linkStore.js';

// Two ways for engine tests to have a control plane:
//
// - startFakeControl(): a stand-in that speaks control/API.md's shapes and
//   does what each test tells it (a refusal, a failed answer, an outage), and
//   records what the engine sent.
// - startControlPlane(): the real control app from control/, in this process,
//   on its own test database, for end-to-end tests. It talks to the Anthropic
//   stand-in through ANTHROPIC_BASE_URL like its own tests do.
//
// Device tokens here are minted by the tests in the control plane's format
// and reach nothing but these servers.

export const newDeviceToken = () => `sst_${randomBytes(32).toString('base64url')}`;

// A GET /v1/me answer for a plan, as the control plane would send it with
// nothing spent yet.
export function meFor(plan, { email = 'person@scope.test', devMode = false, limits = {}, nextModel } = {}) {
  const platformPaid = planFor(plan).platformPaid;
  return {
    account: { id: 'acct-test', email, plan, devMode },
    capabilities: { chooseCloud: canChooseCloud(plan), autoCloud: canAutoCloud(plan), plugins: ['github', 'local_folder'] },
    limits: platformPaid
      ? {
          monthlyAnswers: monthlyAnswerLimit(plan), answersUsed: 0,
          weeklyAllowanceUsd: Number(weeklyAllowanceUsd(plan).toFixed(2)), weeklySpentUsd: 0, freesUpNext: null,
          ...limits,
        }
      : { monthlyAnswers: null, answersUsed: null, weeklyAllowanceUsd: null, weeklySpentUsd: null, freesUpNext: null },
    nextModel: nextModel ?? { default: platformModel(plan), hard: platformModel(plan, { hard: true }) },
    billing: { status: null, renewsAt: null, cancelAt: null },
  };
}

// Signs a local user in without a browser: the link a finished sign-in leaves,
// with a /v1/me answer cached just now, so the engine uses it without asking.
export async function linkUser(pool, ownerId, plan, { token = newDeviceToken(), me = meFor(plan), fetchedAt = new Date() } = {}) {
  const account = me?.account ?? { id: 'acct-test', email: 'person@scope.test', devMode: false };
  await saveLink({ ownerId, token, account }, pool);
  if (me) await saveMe(ownerId, me, fetchedAt, pool);
  return token;
}

const sse = (res, events) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
  for (const event of events) res.write(`data: ${JSON.stringify(event)}\n\n`);
  res.end();
};

export const doneEvent = (overrides = {}) => ({
  done: true,
  usage: { input_tokens: 1200, output_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  stopReason: 'end_turn', model: 'claude-sonnet-5', costUsd: 0.0042, economy: false,
  ...overrides,
});

// `state.me` maps a token to its /v1/me answer; a token not in it is a 401.
// `state.cloud` is a queue of answers for /v1/cloud/messages, one per
// request: `{ status, body }` for a refusal, `{ events }` for a stream, or
// 'network' to drop the connection; when it is empty the answer is
// `state.answer`. `state.billing` likewise for /v1/billing*.
// `state.meFailure` and `state.billingFailure`, when set, are what GET /v1/me
// and GET /v1/billing answer instead, for every token: `{ status, body }` or
// 'network'.
export async function startFakeControl() {
  const state = {
    me: new Map(),
    meFailure: null,
    billingFailure: null,
    cloud: [],
    answer: { events: [{ text: 'Platform ' }, { text: 'answer.' }, doneEvent()] },
    exchange: null,
    devices: [{ id: 'device-1', label: 'this one', current: true }],
    billing: { plan: 'student', status: 'active', renewsAt: '2026-11-21T00:00:00.000Z', cancelAt: null, hasSubscription: true, prices: { key_pro: 5, student: 12, engineer: 25 } },
    checkout: { status: 200, body: { url: 'https://checkout.stripe.test/session' } },
    portal: { status: 200, body: { url: 'https://billing.stripe.test/portal' } },
    requests: [],
    seenIds: new Set(),
  };

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    const body = raw ? JSON.parse(raw) : null;
    const auth = req.headers.authorization ?? null;
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
    const url = new URL(req.url, 'http://control.test');
    state.requests.push({ method: req.method, path: url.pathname, auth, body });
    const json = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(payload === undefined ? '' : JSON.stringify(payload));
    };
    const unauthenticated = () => json(401, { error: 'Sign in to Scope Studio again on this device.', code: 'unauthenticated' });

    if (req.method === 'POST' && url.pathname === '/v1/auth/token') {
      const answer = state.exchange?.(body);
      if (!answer) return json(400, { error: 'This sign-in code is not valid any more.', code: 'invalid_grant' });
      return json(200, answer);
    }
    if (!token || !state.me.has(token)) return unauthenticated();

    const fail = (failure) => (failure === 'network' ? req.socket.destroy() : json(failure.status, failure.body));
    if (req.method === 'GET' && url.pathname === '/v1/me') return state.meFailure ? fail(state.meFailure) : json(200, state.me.get(token));
    if (req.method === 'GET' && url.pathname === '/v1/devices') return json(200, { devices: state.devices });
    if (req.method === 'DELETE' && url.pathname.startsWith('/v1/devices/')) {
      const id = decodeURIComponent(url.pathname.slice('/v1/devices/'.length));
      const before = state.devices.length;
      state.devices = state.devices.filter((device) => device.id !== id);
      if (state.devices.length === before) return json(404, { error: 'No device with that id.', code: 'not_found' });
      state.me.delete(token);
      res.writeHead(204).end();
      return undefined;
    }
    if (req.method === 'GET' && url.pathname === '/v1/billing') {
      if (state.billingFailure) return fail(state.billingFailure);
      return state.billing.status === 503
        ? json(503, { error: 'Billing is not configured on this server.', code: 'billing_not_configured' })
        : json(200, state.billing);
    }
    if (req.method === 'POST' && url.pathname === '/v1/billing/checkout') return json(state.checkout.status, state.checkout.body);
    if (req.method === 'POST' && url.pathname === '/v1/billing/portal') return json(state.portal.status, state.portal.body);
    if (req.method === 'POST' && url.pathname === '/v1/cloud/messages') {
      // Like the real ledger: an id is answered once, ever.
      if (state.seenIds.has(body?.requestId)) return json(409, { error: 'This request has already been answered.', code: 'duplicate_request' });
      state.seenIds.add(body?.requestId);
      const next = state.cloud.length ? state.cloud.shift() : state.answer;
      if (next === 'network') return req.socket.destroy();
      if (next.events) return sse(res, next.events);
      return json(next.status, next.body);
    }
    return json(404, { error: 'not found', code: 'not_found' });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    state,
    cloudRequests: () => state.requests.filter((r) => r.path === '/v1/cloud/messages'),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  };
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', 'postgres']);

// The control plane's test database: CONTROL_TEST_DATABASE_URL, or the
// engine's test database name with `_control` added, created on first use.
async function controlDatabaseUrl() {
  if (process.env.CONTROL_TEST_DATABASE_URL) return process.env.CONTROL_TEST_DATABASE_URL;
  const engine = new URL(process.env.TEST_DATABASE_URL);
  const name = `${engine.pathname.slice(1)}_control`;
  const admin = new pg.Client({ connectionString: engine.toString() });
  await admin.connect();
  try {
    const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (!rowCount) await admin.query(`CREATE DATABASE "${name.replace(/"/g, '')}"`);
  } finally {
    await admin.end();
  }
  const url = new URL(engine);
  url.pathname = `/${name}`;
  return url.toString();
}

// The real control plane, in this process. Its modules keep their own pool,
// created from DATABASE_URL on first use, so DATABASE_URL points at the
// control database just long enough for that pool to be made.
export async function startControlPlane() {
  const url = await controlDatabaseUrl();
  if (!LOCAL_HOSTS.has(new URL(url).hostname)) throw new Error('Refusing to run the control plane against a non-local database');
  // Test-only values, never real: the session secret signs cookies on this
  // throwaway server, and the platform key only ever reaches the Anthropic
  // stand-in at ANTHROPIC_BASE_URL.
  const saved = { DATABASE_URL: process.env.DATABASE_URL, CONTROL_SESSION_SECRET: process.env.CONTROL_SESSION_SECRET, PLATFORM_ANTHROPIC_API_KEY: process.env.PLATFORM_ANTHROPIC_API_KEY };
  process.env.CONTROL_SESSION_SECRET = 'test-control-session-secret-not-real';
  process.env.PLATFORM_ANTHROPIC_API_KEY = 'sk-ant-test-not-a-real-key';

  process.env.DATABASE_URL = url;
  const { getPool } = await import('../../control/src/db/pool.js');
  const pool = getPool();
  process.env.DATABASE_URL = saved.DATABASE_URL;

  const { migrate } = await import('../../control/src/db/migrate.js');
  const { default: createControlApp } = await import('../../control/src/app.js');
  const { default: loadControlEnv } = await import('../../control/src/config/env.js');
  await migrate(pool, { log: () => {} });
  const truncate = async () => {
    const { rows } = await pool.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`);
    if (rows.length) await pool.query(`TRUNCATE ${rows.map((r) => `"${r.tablename}"`).join(', ')} CASCADE`);
  };
  await truncate();

  const app = createControlApp(loadControlEnv(), { pool });
  const server = await new Promise((resolve) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    pool,
    truncate,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await pool.end();
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

// An account on the real control plane with a signed-in device, without the
// browser: what /v1/auth/token leaves behind.
export async function controlAccount(control, { email, plan = 'free' }) {
  const { hashToken } = await import('../../control/src/auth/tokens.js');
  const { rows: [account] } = await control.pool.query(
    `INSERT INTO accounts (email, password_hash, plan) VALUES ($1, 'unused', $2) RETURNING id`,
    [email, plan]
  );
  const token = newDeviceToken();
  await control.pool.query(`INSERT INTO device_tokens (account_id, token_hash, label) VALUES ($1, $2, 'engine test')`, [account.id, hashToken(token)]);
  return { id: account.id, email, token };
}
