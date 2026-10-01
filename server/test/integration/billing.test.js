import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { after, before, beforeEach, describe, test } from 'node:test';
import { startFakeLemonSqueezy } from '../fakeLemonSqueezy.js';
import { registeredSession, startServer } from '../helpers.js';

const TEST_ENV = {
  LEMONSQUEEZY_API_KEY: 'test-api-key', LEMONSQUEEZY_STORE_ID: '11', LEMONSQUEEZY_WEBHOOK_SECRET: 'test-webhook-secret',
  LEMONSQUEEZY_VARIANT_KEY_PRO: '101', LEMONSQUEEZY_VARIANT_STUDENT: '102', LEMONSQUEEZY_VARIANT_ENGINEER: '103',
};

describe('billing', () => {
  let server;
  let lemon;
  let api;
  let userId;
  let clock = Date.parse('2026-10-01T00:00:00Z');

  const deliver = (name, { id = 'sub_1', status = 'active', variant = 102, userIdOverride, updatedAt, secret = TEST_ENV.LEMONSQUEEZY_WEBHOOK_SECRET } = {}) => {
    clock += 60_000;
    const body = JSON.stringify({
      meta: { event_name: name, ...(userIdOverride === null ? {} : { custom_data: { user_id: userIdOverride ?? userId } }) },
      data: { type: 'subscriptions', id, attributes: { status, variant_id: variant, customer_id: 77, renews_at: '2026-11-01T00:00:00Z', ends_at: null, updated_at: updatedAt ?? new Date(clock).toISOString() } },
    });
    return fetch(`${server.base}/api/billing/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Event-Name': name, 'X-Signature': createHmac('sha256', secret).update(body).digest('hex') },
      body,
    });
  };
  const plan = async () => (await server.pool.query('SELECT plan FROM users WHERE id = $1', [userId])).rows[0].plan;

  before(async () => {
    lemon = await startFakeLemonSqueezy();
    Object.assign(process.env, TEST_ENV, { LEMONSQUEEZY_API_URL: lemon.url });
    server = await startServer();
    api = await registeredSession(server.base);
    userId = (await api('GET', '/api/auth/session')).data.userId;
  });

  beforeEach(async () => {
    lemon.state.requests = [];
    lemon.state.status = 200;
  });

  after(async () => {
    for (const key of [...Object.keys(TEST_ENV), 'LEMONSQUEEZY_API_URL']) delete process.env[key];
    await server.close();
    await lemon.close();
  });

  test('checkout opens a hosted page for the plan, carrying the user id and email', async () => {
    const { status, data } = await api('POST', '/api/billing/checkout', { plan: 'engineer' });
    assert.equal(status, 200);
    assert.equal(data.url, 'https://scope.lemonsqueezy.test/checkout/chk_1');
    const [sent] = lemon.state.requests;
    assert.equal(sent.auth, 'Bearer test-api-key');
    assert.equal(sent.accept, 'application/vnd.api+json');
    assert.equal(sent.body.data.relationships.variant.data.id, '103');
    assert.equal(sent.body.data.relationships.store.data.id, '11');
    assert.equal(sent.body.data.attributes.checkout_data.custom.user_id, userId);
    assert.match(sent.body.data.attributes.checkout_data.email, /@example\.com$/);
    assert.equal((await api('POST', '/api/billing/checkout', { plan: 'free' })).status, 400);
  });

  test('a provider error surfaces as a message, not a crash', async () => {
    lemon.state.status = 404;
    const { status, data } = await api('POST', '/api/billing/checkout', { plan: 'student' });
    assert.equal(status, 502);
    assert.match(data.error, /variant not found/);
  });

  test('a forged or altered webhook is refused and changes nothing', async () => {
    assert.equal((await deliver('subscription_created', { secret: 'wrong-secret' })).status, 401);
    assert.equal(await plan(), 'free');
  });

  test('the subscription lifecycle sets the plan: created, upgraded, cancelled to period end, expired', async () => {
    assert.equal((await deliver('subscription_created', { variant: 102 })).status, 200);
    assert.equal(await plan(), 'student');

    await deliver('subscription_updated', { variant: 103 });
    assert.equal(await plan(), 'engineer', 'an upgrade in the portal arrives as an update');

    await deliver('subscription_cancelled', { status: 'cancelled', variant: 103 });
    assert.equal(await plan(), 'engineer', 'cancelled keeps the plan until the paid period ends');

    await deliver('subscription_expired', { status: 'expired', variant: 103 });
    assert.equal(await plan(), 'free');
  });

  test('later events find the user by subscription id when they carry no custom data', async () => {
    await deliver('subscription_created', { id: 'sub_2', variant: 101 });
    assert.equal(await plan(), 'key_pro');
    await deliver('subscription_payment_failed', { id: 'sub_2', status: 'unpaid', variant: 101, userIdOverride: null });
    assert.equal(await plan(), 'free', 'payment recovery failed');
  });

  test('a late, older event cannot undo a newer one, and a repeat is harmless', async () => {
    await deliver('subscription_created', { id: 'sub_3', variant: 103, updatedAt: '2026-12-01T00:00:00Z' });
    assert.equal(await plan(), 'engineer');
    const stale = await deliver('subscription_expired', { id: 'sub_3', status: 'expired', variant: 103, updatedAt: '2026-11-15T00:00:00Z' });
    assert.equal((await stale.json()).applied, false);
    assert.equal(await plan(), 'engineer');
    await deliver('subscription_created', { id: 'sub_3', variant: 103, updatedAt: '2026-12-01T00:00:00Z' });
    assert.equal(await plan(), 'engineer');
  });

  test('a subscribed user is sent to the portal instead of a second checkout', async () => {
    await deliver('subscription_created', { id: 'sub_4', variant: 102, updatedAt: '2027-01-01T00:00:00Z' });
    const again = await api('POST', '/api/billing/checkout', { plan: 'engineer' });
    assert.equal(again.status, 409);
    assert.equal(again.data.code, 'already_subscribed');
    const portal = await api('POST', '/api/billing/portal', {});
    assert.equal(portal.data.url, 'https://scope.lemonsqueezy.test/portal/sub_4');
    const status = (await api('GET', '/api/billing')).data;
    assert.deepEqual([status.configured, status.plan, status.status, status.hasSubscription], [true, 'student', 'active', true]);
    assert.deepEqual(status.prices, { free: 0, key_pro: 5, student: 12, engineer: 25 });
  });

  test('events that are not subscription changes are acknowledged and ignored', async () => {
    const response = await deliver('order_created');
    assert.equal(response.status, 200);
  });

  test('with billing unconfigured, every billing call says so instead of guessing', async () => {
    const saved = process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
    delete process.env.LEMONSQUEEZY_WEBHOOK_SECRET;
    try {
      assert.equal((await api('POST', '/api/billing/checkout', { plan: 'student' })).data.code, 'billing_not_configured');
      assert.equal((await deliver('subscription_created')).status, 503);
      assert.equal((await api('GET', '/api/billing')).data.configured, false);
    } finally {
      process.env.LEMONSQUEEZY_WEBHOOK_SECRET = saved;
    }
  });
});
