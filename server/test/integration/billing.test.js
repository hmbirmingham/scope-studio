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
  const deliver = (type, { id = 'sub_1', customer = 'cus_1', status = 'active', price = 'price_student', withUser = true, current = true, secret = TEST_ENV.STRIPE_WEBHOOK_SECRET, data } = {}) => {
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
    const [sent] = fake.state.requests;
    assert.equal(sent.url, '/v1/checkout/sessions');
    assert.equal(sent.auth, 'Bearer sk_test_fake');
    assert.equal(sent.form.mode, 'subscription');
    assert.equal(sent.form['line_items[0][price]'], 'price_engineer');
    assert.equal(sent.form['managed_payments[enabled]'], 'true', 'Stripe is the merchant of record');
    assert.equal(sent.form.client_reference_id, userId);
    assert.equal(sent.form['subscription_data[metadata][user_id]'], userId, 'so every subscription event can find the account');
    assert.match(sent.form.customer_email, /@example\.com$/);
    assert.match(sent.form.success_url, /\?billing=done$/);
    assert.equal((await api('POST', '/api/billing/checkout', { plan: 'free' })).status, 400);
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

  test('later events find the user by customer when they carry no metadata', async () => {
    await deliver('customer.subscription.created', { id: 'sub_2', customer: 'cus_2', price: 'price_keypro' });
    assert.equal(await plan(), 'key_pro');
    await deliver('customer.subscription.updated', { id: 'sub_2', customer: 'cus_2', status: 'unpaid', price: 'price_keypro', withUser: false });
    assert.equal(await plan(), 'free', 'payment recovery failed');
  });

  test('a late, older event cannot undo a newer state, because the handler reads the current one', async () => {
    await deliver('customer.subscription.created', { id: 'sub_3', customer: 'cus_3', price: 'price_engineer' });
    assert.equal(await plan(), 'engineer');
    // An out-of-order event says canceled, but the subscription is active now.
    const late = await deliver('customer.subscription.deleted', { id: 'sub_3', customer: 'cus_3', status: 'canceled', price: 'price_engineer', current: false });
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
    await deliver('customer.subscription.created', { id: 'sub_4', customer: 'cus_4', price: 'price_student' });
    const again = await api('POST', '/api/billing/checkout', { plan: 'engineer' });
    assert.equal(again.status, 409);
    assert.equal(again.data.code, 'already_subscribed');
    const portal = await api('POST', '/api/billing/portal', {});
    assert.equal(portal.data.url, 'https://billing.stripe.test/p/cus_4');
    const status = (await api('GET', '/api/billing')).data;
    assert.deepEqual([status.configured, status.plan, status.status, status.hasSubscription], [true, 'student', 'active', true]);
    assert.deepEqual(status.prices, { free: 0, key_pro: 5, student: 12, engineer: 25 });
  });

  test('events that are not subscription changes are acknowledged and ignored', async () => {
    const response = await deliver('invoice.paid');
    assert.equal(response.status, 200);
    assert.equal((await response.json()).ignored, 'invoice.paid');
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
