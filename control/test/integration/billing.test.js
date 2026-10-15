import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, mock, test } from 'node:test';
import Stripe from 'stripe';
import { hashToken, newDeviceToken } from '../../src/auth/tokens.js';
import { startFakeStripe } from '../fakeStripe.js';
import { createAccount, startServer } from '../helpers.js';

// Obviously fake values: the client only ever talks to the local stand-in.
const TEST_ENV = {
  STRIPE_MODE: 'test', STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_WEBHOOK_SECRET: 'whsec_test_fake',
  STRIPE_PRICE_KEY_PRO: 'price_keypro', STRIPE_PRICE_STUDENT: 'price_student', STRIPE_PRICE_ENGINEER: 'price_engineer',
  BASE_URL: 'https://control.scope.test/',
};
const signer = new Stripe('sk_test_fake');

async function issueDevice(pool, accountId) {
  const token = newDeviceToken();
  await pool.query(`INSERT INTO device_tokens (account_id, token_hash, label) VALUES ($1, $2, 'test device')`, [accountId, hashToken(token)]);
  return token;
}

describe('billing (Stripe Managed Payments)', () => {
  let server;
  let fake;
  let api;
  let accountId;
  let clock = 1790000000;

  const subscriptionObject = ({ id, customer, status, price, withAccount }) => ({
    id, object: 'subscription', customer, status, metadata: withAccount ? { account_id: accountId } : {}, cancel_at: null,
    items: { data: [{ price: { id: price }, current_period_end: clock + 2592000 }] },
  });
  // Sends an event and, unless `current` is false, makes its subscription the
  // current state Stripe returns — the handler reads that, not the event.
  const deliver = (type, { id = 'sub_1', customer = 'cus_new_1', status = 'active', price = 'price_student', withAccount = true, current = true, secret = TEST_ENV.STRIPE_WEBHOOK_SECRET, data } = {}) => {
    clock += 60;
    const object = subscriptionObject({ id, customer, status, price, withAccount });
    if (current) fake.state.subscriptions[id] = object;
    const payload = JSON.stringify({ id: `evt_${clock}`, object: 'event', type, created: clock, data: data ?? { object } });
    return fetch(`${server.base}/v1/billing/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signer.webhooks.generateTestHeaderString({ payload, secret }) },
      body: payload,
    });
  };
  const planOf = async (id) => (await server.pool.query('SELECT plan FROM accounts WHERE id = $1', [id])).rows[0].plan;
  const plan = () => planOf(accountId);
  const deviceApi = (token) => async (method, path, body) => {
    const response = await fetch(`${server.base}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, data: await response.json() };
  };

  before(async () => {
    fake = await startFakeStripe();
    Object.assign(process.env, TEST_ENV, { STRIPE_API_BASE: fake.url });
    server = await startServer();
    accountId = (await createAccount(server.pool, { email: 'buyer@scope.local' })).id;
    api = deviceApi(await issueDevice(server.pool, accountId));
  });

  beforeEach(() => {
    fake.state.requests = [];
    fake.state.status = 200;
  });

  after(async () => {
    for (const key of [...Object.keys(TEST_ENV), 'STRIPE_API_BASE']) delete process.env[key];
    await server.close();
    await fake.close();
  });

  test('every engine-facing billing route needs a device token', async () => {
    const anonymous = deviceApi(null);
    for (const [method, path] of [['GET', '/v1/billing'], ['POST', '/v1/billing/checkout'], ['POST', '/v1/billing/portal']]) {
      const { status, data } = await anonymous(method, path, method === 'POST' ? {} : undefined);
      assert.equal(status, 401, path);
      assert.equal(data.code, 'unauthenticated');
    }
    assert.equal(fake.state.requests.length, 0, 'nothing reached Stripe');
  });

  test('checkout opens a Managed Payments session for the plan, carrying the account id to the subscription', async () => {
    const { status, data } = await api('POST', '/v1/billing/checkout', { plan: 'engineer' });
    assert.equal(status, 200);
    assert.equal(data.url, 'https://checkout.stripe.test/c/pay/cs_test_1');
    const [customer, sent] = fake.state.requests;
    assert.equal(customer.url, '/v1/customers', 'the Stripe Customer is created first');
    assert.equal(customer.form['metadata[account_id]'], accountId);
    assert.equal(customer.form.email, 'buyer@scope.local');
    assert.equal(sent.url, '/v1/checkout/sessions');
    assert.equal(sent.auth, 'Bearer sk_test_fake');
    assert.equal(sent.form.customer, 'cus_new_1', 'checkout is for that Customer');
    assert.equal(sent.form.integration_identifier, 'scope-studio-plans-nviushko', 'unchanged from the engine');
    assert.equal(sent.form.mode, 'subscription');
    assert.equal(sent.form['line_items[0][price]'], 'price_engineer');
    assert.equal(sent.form['managed_payments[enabled]'], 'true', 'Stripe is the merchant of record');
    assert.equal(sent.form.client_reference_id, accountId);
    assert.equal(sent.form['subscription_data[metadata][account_id]'], accountId, 'so every subscription event can find the account');
    assert.equal(sent.form.success_url, 'https://control.scope.test/billing/done?checkout=complete');
    assert.equal(sent.form.cancel_url, 'https://control.scope.test/billing/done?checkout=canceled');
    const free = await api('POST', '/v1/billing/checkout', { plan: 'free' });
    assert.deepEqual([free.status, free.data.code], [400, 'invalid_plan']);
  });

  test('a second checkout reuses the account\'s Stripe Customer instead of creating another', async () => {
    await api('POST', '/v1/billing/checkout', { plan: 'student' });
    assert.ok(!fake.state.requests.some((r) => r.url === '/v1/customers'), 'no new Customer');
    assert.equal(fake.state.requests.find((r) => r.url === '/v1/checkout/sessions').form.customer, 'cus_new_1');
  });

  test('a Stripe error is a 502 with a sentence of our own; Stripe\'s text stays in the log', async () => {
    fake.state.status = 400;
    const errors = mock.method(console, 'error', () => {});
    try {
      const { status, data } = await api('POST', '/v1/billing/checkout', { plan: 'student' });
      assert.equal(status, 502);
      assert.equal(data.code, 'stripe_error');
      assert.doesNotMatch(JSON.stringify(data), /No such price/);
      assert.ok(errors.mock.calls.some((c) => /No such price/.test(c.arguments[0])), 'logged for the owner');
    } finally {
      errors.mock.restore();
    }
  });

  test('a forged webhook is refused and changes nothing', async () => {
    const response = await deliver('customer.subscription.created', { secret: 'whsec_wrong' });
    assert.equal(response.status, 401);
    assert.equal((await response.json()).code, 'invalid_signature');
    assert.equal(await plan(), 'free');
  });

  test('the lifecycle sets the plan: created, upgraded, cancellation scheduled, then deleted', async () => {
    assert.equal((await deliver('customer.subscription.created', { price: 'price_student' })).status, 200);
    assert.equal(await plan(), 'student');
    await deliver('customer.subscription.updated', { price: 'price_engineer' });
    assert.equal(await plan(), 'engineer', 'an upgrade in the portal arrives as an update');
    await deliver('customer.subscription.updated', { price: 'price_engineer', status: 'active' });
    assert.equal(await plan(), 'engineer', 'a scheduled cancellation stays active until the period ends');
    await deliver('customer.subscription.deleted', { price: 'price_engineer', status: 'canceled' });
    assert.equal(await plan(), 'free');
  });

  test('events are matched by the account\'s Stripe Customer, with metadata only as a fallback', async () => {
    // A second account that never went through checkout has no Customer yet.
    const otherId = (await createAccount(server.pool, { email: 'other@scope.local' })).id;
    const saved = accountId;
    accountId = otherId;
    try {
      await deliver('customer.subscription.created', { id: 'sub_other', customer: 'cus_other', price: 'price_student' });
    } finally {
      accountId = saved;
    }
    assert.equal(await planOf(otherId), 'student', 'no Customer on file: metadata finds the account');
    // A forged metadata account id cannot move a plan onto an account that has a Customer.
    await deliver('customer.subscription.created', { id: 'sub_forged', customer: 'cus_someone_else', price: 'price_engineer' });
    assert.notEqual(await plan(), 'engineer', 'an account with a Customer is only matched by that Customer');
  });

  test('later events find the account by customer when they carry no metadata', async () => {
    await deliver('customer.subscription.created', { id: 'sub_2', customer: 'cus_new_1', price: 'price_keypro' });
    assert.equal(await plan(), 'key_pro');
    await deliver('customer.subscription.updated', { id: 'sub_2', customer: 'cus_new_1', status: 'unpaid', price: 'price_keypro', withAccount: false });
    assert.equal(await plan(), 'free', 'payment recovery failed');
  });

  test('a late, older event cannot undo a newer state, because the handler reads the current one', async () => {
    await deliver('customer.subscription.created', { id: 'sub_3', customer: 'cus_new_1', price: 'price_engineer' });
    assert.equal(await plan(), 'engineer');
    // An out-of-order event says canceled, but the subscription is active now.
    const late = await deliver('customer.subscription.deleted', { id: 'sub_3', customer: 'cus_new_1', status: 'canceled', price: 'price_engineer', current: false });
    assert.equal((await late.json()).plan, 'engineer');
    assert.equal(await plan(), 'engineer');
    const reads = fake.state.requests.filter((r) => r.method === 'GET' && r.url.startsWith('/v1/subscriptions/sub_3'));
    assert.ok(reads.length >= 2, 'each event read the subscription from Stripe');
  });

  test('if Stripe cannot be read, the webhook asks Stripe to retry rather than guess', async () => {
    const errors = mock.method(console, 'error', () => {});
    try {
      const response = await deliver('customer.subscription.updated', { id: 'sub_missing', customer: 'cus_x', current: false });
      assert.equal(response.status, 502);
      assert.equal((await response.json()).code, 'stripe_unavailable');
    } finally {
      errors.mock.restore();
    }
  });

  test('a thin-payload event is refused with a clear message', async () => {
    const errors = mock.method(console, 'error', () => {});
    try {
      const response = await deliver('customer.subscription.updated', { data: {} });
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.code, 'snapshot_required');
      assert.match(body.error, /snapshot/i);
    } finally {
      errors.mock.restore();
    }
  });

  test('a subscribed account gets the portal for its customer, never a second checkout', async () => {
    await deliver('customer.subscription.created', { id: 'sub_4', customer: 'cus_new_1', price: 'price_student' });
    const again = await api('POST', '/v1/billing/checkout', { plan: 'engineer' });
    assert.equal(again.status, 409);
    assert.equal(again.data.code, 'already_subscribed');
    const portal = await api('POST', '/v1/billing/portal', {});
    assert.equal(portal.data.url, 'https://billing.stripe.test/p/cus_new_1');
    const sent = fake.state.requests.find((r) => r.url === '/v1/billing_portal/sessions');
    assert.equal(sent.form.return_url, 'https://control.scope.test/billing/done');
    const { status, data } = await api('GET', '/v1/billing');
    assert.equal(status, 200);
    assert.deepEqual([data.plan, data.status, data.hasSubscription], ['student', 'active', true]);
    assert.ok(data.renewsAt);
    assert.equal(data.cancelAt, null);
    assert.deepEqual(data.prices, { key_pro: 5, student: 12, engineer: 25 });
  });

  test('an account with no Stripe Customer has no portal to open', async () => {
    const id = (await createAccount(server.pool, { email: 'new@scope.local' })).id;
    const fresh = deviceApi(await issueDevice(server.pool, id));
    const { status, data } = await fresh('POST', '/v1/billing/portal', {});
    assert.deepEqual([status, data.code], [404, 'no_billing_account']);
  });

  test('an invoice event re-reads the subscription it belongs to', async () => {
    fake.state.subscriptions.sub_inv = { id: 'sub_inv', object: 'subscription', customer: 'cus_new_1', status: 'active', metadata: {}, cancel_at: null, items: { data: [{ price: { id: 'price_keypro' }, current_period_end: 2000000000 }] } };
    const response = await deliver('invoice.paid', { data: { object: { id: 'in_1', object: 'invoice', parent: { type: 'subscription_details', subscription_details: { subscription: 'sub_inv' } } } } });
    assert.equal(response.status, 200);
    assert.equal(await plan(), 'key_pro');
    const oneOff = await deliver('invoice.paid', { data: { object: { id: 'in_2', object: 'invoice', parent: null } } });
    assert.equal((await oneOff.json()).ignored, 'invoice without a subscription');
  });

  test('events that are not subscription or invoice changes are acknowledged and ignored', async () => {
    const response = await deliver('charge.succeeded', { data: { object: { id: 'ch_1' } } });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ignored, 'charge.succeeded');
  });

  test('billing never touches device tokens beyond the sign-in check', async () => {
    const before = (await server.pool.query('SELECT id, account_id, token_hash, label, revoked_at FROM device_tokens ORDER BY id')).rows;
    await deliver('customer.subscription.updated', { id: 'sub_4', customer: 'cus_new_1', price: 'price_engineer' });
    await api('GET', '/v1/billing');
    const afterRows = (await server.pool.query('SELECT id, account_id, token_hash, label, revoked_at FROM device_tokens ORDER BY id')).rows;
    assert.deepEqual(afterRows, before);
  });

  test('with billing unconfigured, every billing call says so instead of guessing', async () => {
    const saved = process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    const errors = mock.method(console, 'error', () => {});
    try {
      for (const [method, path] of [['GET', '/v1/billing'], ['POST', '/v1/billing/checkout'], ['POST', '/v1/billing/portal']]) {
        const { status, data } = await api(method, path, method === 'POST' ? { plan: 'student' } : undefined);
        assert.deepEqual([status, data.code], [503, 'billing_not_configured'], path);
      }
      const hook = await deliver('customer.subscription.created');
      assert.equal(hook.status, 503);
      assert.equal((await hook.json()).code, 'billing_not_configured');
      assert.equal(errors.mock.callCount(), 1, 'one logged error, not one per request');
      assert.match(errors.mock.calls[0].arguments[0], /STRIPE_WEBHOOK_SECRET/);
    } finally {
      errors.mock.restore();
      process.env.STRIPE_WEBHOOK_SECRET = saved;
    }
  });

  test('without BASE_URL, billing stays off rather than invent a return address', async () => {
    const saved = process.env.BASE_URL;
    delete process.env.BASE_URL;
    const errors = mock.method(console, 'error', () => {});
    try {
      const { status, data } = await api('POST', '/v1/billing/checkout', { plan: 'student' });
      assert.deepEqual([status, data.code], [503, 'billing_not_configured']);
      assert.match(errors.mock.calls[0].arguments[0], /BASE_URL/);
      assert.ok(!fake.state.requests.length, 'nothing reached Stripe');
    } finally {
      errors.mock.restore();
      process.env.BASE_URL = saved;
    }
  });

  for (const [mode, key, wrong] of [['live', 'sk_test_fake', 'a test-mode key'], ['test', 'sk_live_fake', 'a live-mode key']]) {
    test(`STRIPE_MODE ${mode} with ${wrong} refuses billing with one logged error that never shows the key`, async () => {
      const saved = { STRIPE_MODE: process.env.STRIPE_MODE, STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY };
      Object.assign(process.env, { STRIPE_MODE: mode, STRIPE_SECRET_KEY: key });
      const errors = mock.method(console, 'error', () => {});
      try {
        for (let i = 0; i < 2; i++) {
          const { status, data } = await api('POST', '/v1/billing/checkout', { plan: 'student' });
          assert.deepEqual([status, data.code], [503, 'billing_not_configured']);
        }
        assert.equal((await deliver('customer.subscription.created')).status, 503);
        assert.equal(errors.mock.callCount(), 1, 'logged once');
        const line = errors.mock.calls[0].arguments.join(' ');
        assert.match(line, new RegExp(`STRIPE_MODE is ${mode} but STRIPE_SECRET_KEY is ${wrong}`));
        assert.ok(!line.includes(key), 'the key itself is never logged');
        assert.ok(!fake.state.requests.length, 'nothing reached Stripe');
      } finally {
        errors.mock.restore();
        Object.assign(process.env, saved);
      }
    });
  }

  test('the done page tells the person to return to the app, configured or not', async () => {
    const complete = await fetch(`${server.base}/billing/done?checkout=complete`);
    assert.equal(complete.status, 200);
    assert.match(complete.headers.get('content-type'), /^text\/html/);
    assert.match(complete.headers.get('content-security-policy'), /default-src 'none'/);
    const html = await complete.text();
    assert.match(html, /Purchase complete/);
    assert.match(html, /Return to Scope Studio/);

    assert.match(await (await fetch(`${server.base}/billing/done?checkout=canceled`)).text(), /Nothing was charged/);
    assert.match(await (await fetch(`${server.base}/billing/done?checkout=__proto__`)).text(), /Return to Scope Studio/);

    const saved = process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_SECRET_KEY;
    const errors = mock.method(console, 'error', () => {});
    try {
      const portalReturn = await fetch(`${server.base}/billing/done`);
      assert.equal(portalReturn.status, 200, 'a person who just paid never lands on an error');
      assert.match(await portalReturn.text(), /Return to Scope Studio/);
    } finally {
      errors.mock.restore();
      process.env.STRIPE_SECRET_KEY = saved;
    }
  });
});
