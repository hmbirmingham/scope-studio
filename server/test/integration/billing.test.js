import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import Stripe from 'stripe';
import { startFakeStripe } from '../fakeStripe.js';
import { registeredSession, startServer } from '../helpers.js';

const TEST_ENV = {
  STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_WEBHOOK_SECRET: 'whsec_test_fake',
  STRIPE_PRICE_KEY_PRO: 'price_keypro', STRIPE_PRICE_STUDENT: 'price_student', STRIPE_PRICE_ENGINEER: 'price_engineer',
};
const signer = new Stripe('sk_test_fake');

describe('billing (Stripe Managed Payments)', () => {
  let server;
  let fake;
  let api;
  let userId;
  let clock = 1790000000;

  const subscriptionObject = ({ id, customer, status, price, withUser }) => ({
    id, object: 'subscription', customer, status, metadata: withUser ? { user_id: userId } : {}, cancel_at: null,
    items: { data: [{ price: { id: price }, current_period_end: clock + 2592000 }] },
  });
  // Sends an event and, unless `current` is false, makes its subscription the
  // current state Stripe returns — the handler reads that, not the event.
  const deliver = (type, { id = 'sub_1', customer = 'cus_new_1', status = 'active', price = 'price_student', withUser = true, current = true, secret = TEST_ENV.STRIPE_WEBHOOK_SECRET, data } = {}) => {
    clock += 60;
    const object = subscriptionObject({ id, customer, status, price, withUser });
    if (current) fake.state.subscriptions[id] = object;
    const payload = JSON.stringify({ id: `evt_${clock}`, object: 'event', type, created: clock, data: data ?? { object } });
    return fetch(`${server.base}/api/billing/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Stripe-Signature': signer.webhooks.generateTestHeaderString({ payload, secret }) },
      body: payload,
    });
  };
  const plan = async () => (await server.pool.query('SELECT plan FROM users WHERE id = $1', [userId])).rows[0].plan;

  before(async () => {
    fake = await startFakeStripe();
    Object.assign(process.env, TEST_ENV, { STRIPE_API_BASE: fake.url });
    server = await startServer();
    api = await registeredSession(server.base);
    userId = (await api('GET', '/api/auth/session')).data.userId;
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

  test('checkout opens a Managed Payments session for the plan, carrying the user id to the subscription', async () => {
    const { status, data } = await api('POST', '/api/billing/checkout', { plan: 'engineer' });
    assert.equal(status, 200);
    assert.equal(data.url, 'https://checkout.stripe.test/c/pay/cs_test_1');
    const [customer, sent] = fake.state.requests;
    assert.equal(customer.url, '/v1/customers', 'the Stripe Customer is created first');
    assert.equal(customer.form['metadata[user_id]'], userId);
    assert.match(customer.form.email, /@example\.com$/);
    assert.equal(sent.url, '/v1/checkout/sessions');
    assert.equal(sent.auth, 'Bearer sk_test_fake');
    assert.equal(sent.form.customer, 'cus_new_1', 'checkout is for that Customer');
    assert.match(sent.form.integration_identifier, /^scope-studio-plans-[a-z]{8}$/);
    assert.equal(sent.form.mode, 'subscription');
    assert.equal(sent.form['line_items[0][price]'], 'price_engineer');
    assert.equal(sent.form['managed_payments[enabled]'], 'true', 'Stripe is the merchant of record');
    assert.equal(sent.form.client_reference_id, userId);
    assert.equal(sent.form['subscription_data[metadata][user_id]'], userId, 'so every subscription event can find the account');
    assert.match(sent.form.success_url, /\?billing=done$/);
    assert.equal((await api('POST', '/api/billing/checkout', { plan: 'free' })).status, 400);
  });

  test('a second checkout reuses the account\'s Stripe Customer instead of creating another', async () => {
    await api('POST', '/api/billing/checkout', { plan: 'student' });
    assert.ok(!fake.state.requests.some((r) => r.url === '/v1/customers'), 'no new Customer');
    assert.equal(fake.state.requests.find((r) => r.url === '/v1/checkout/sessions').form.customer, 'cus_new_1');
  });

  test('a Stripe error surfaces as a message, not a crash', async () => {
    fake.state.status = 400;
    const { status, data } = await api('POST', '/api/billing/checkout', { plan: 'student' });
    assert.equal(status, 502);
    assert.match(data.error, /No such price/);
  });

  test('a forged webhook is refused and changes nothing', async () => {
    assert.equal((await deliver('customer.subscription.created', { secret: 'whsec_wrong' })).status, 401);
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
    const other = await registeredSession(server.base);
    const otherId = (await other('GET', '/api/auth/session')).data.userId;
    const otherPlan = async () => (await server.pool.query('SELECT plan FROM users WHERE id = $1', [otherId])).rows[0].plan;
    const saved = userId;
    userId = otherId;
    try {
      await deliver('customer.subscription.created', { id: 'sub_other', customer: 'cus_other', price: 'price_student' });
    } finally {
      userId = saved;
    }
    assert.equal(await otherPlan(), 'student', 'no Customer on file: metadata finds the account');
    // A forged metadata user id cannot move a plan onto an account that has a Customer.
    const saved2 = userId;
    try {
      await deliver('customer.subscription.created', { id: 'sub_forged', customer: 'cus_someone_else', price: 'price_engineer' });
    } finally {
      userId = saved2;
    }
    assert.notEqual(await plan(), 'engineer', 'an account with a Customer is only matched by that Customer');
  });

  test('later events find the user by customer when they carry no metadata', async () => {
    await deliver('customer.subscription.created', { id: 'sub_2', customer: 'cus_new_1', price: 'price_keypro' });
    assert.equal(await plan(), 'key_pro');
    await deliver('customer.subscription.updated', { id: 'sub_2', customer: 'cus_new_1', status: 'unpaid', price: 'price_keypro', withUser: false });
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
    const response = await deliver('customer.subscription.updated', { id: 'sub_missing', customer: 'cus_x', current: false });
    assert.equal(response.status, 502);
  });

  test('a thin-payload event is refused with a clear message', async () => {
    const response = await deliver('customer.subscription.updated', { data: {} });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /snapshot/);
  });

  test('a subscribed user gets the portal for their customer, never a second checkout', async () => {
    await deliver('customer.subscription.created', { id: 'sub_4', customer: 'cus_new_1', price: 'price_student' });
    const again = await api('POST', '/api/billing/checkout', { plan: 'engineer' });
    assert.equal(again.status, 409);
    assert.equal(again.data.code, 'already_subscribed');
    const portal = await api('POST', '/api/billing/portal', {});
    assert.equal(portal.data.url, 'https://billing.stripe.test/p/cus_new_1');
    const status = (await api('GET', '/api/billing')).data;
    assert.deepEqual([status.configured, status.plan, status.status, status.hasSubscription], [true, 'student', 'active', true]);
    assert.deepEqual(status.prices, { free: 0, key_pro: 5, student: 12, engineer: 25 });
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

  test('with billing unconfigured, every billing call says so instead of guessing', async () => {
    const saved = process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    try {
      assert.equal((await api('POST', '/api/billing/checkout', { plan: 'student' })).data.code, 'billing_not_configured');
      assert.equal((await deliver('customer.subscription.created')).status, 503);
      assert.equal((await api('GET', '/api/billing')).data.configured, false);
    } finally {
      process.env.STRIPE_WEBHOOK_SECRET = saved;
    }
  });
});
