import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import Stripe from 'stripe';
import { PAID_PLANS, PLAN_PRICE_ENV, billingConfig, entitledPlan, planForPrice, subscriptionRecord, verifyEvent } from '../../src/billing/stripe.js';
import { PLANS } from '../../src/billing/plans.js';

// Obviously fake values; nothing here talks to Stripe.
const env = {
  STRIPE_MODE: 'test', STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_WEBHOOK_SECRET: 'whsec_test_fake',
  STRIPE_PRICE_KEY_PRO: 'price_keypro', STRIPE_PRICE_STUDENT: 'price_student', STRIPE_PRICE_ENGINEER: 'price_engineer',
  BASE_URL: 'https://control.scope.test',
};
const silent = { log: () => {} };
const config = billingConfig(env, silent);
const subscription = (status, price, extra = {}) => ({ id: 'sub_1', customer: 'cus_1', status, metadata: { account_id: 'a1' }, items: { data: [{ price: { id: price }, current_period_end: 1790000000 }] }, ...extra });

// Runs billingConfig and returns what it logged alongside the result.
function configWith(overrides) {
  const lines = [];
  const result = billingConfig({ ...env, ...overrides }, { log: (line) => lines.push(line) });
  return { result, lines };
}

describe('billingConfig', () => {
  test('complete only when every value is set; never a default', () => {
    assert.ok(config);
    for (const key of Object.keys(env)) {
      const { result, lines } = configWith({ [key]: '' });
      assert.equal(result, null, key);
      assert.match(lines.join('\n'), new RegExp(key), `${key} is named`);
    }
  });

  test('silent when billing was never turned on, so a server without it does not complain', () => {
    const lines = [];
    assert.equal(billingConfig({ BASE_URL: env.BASE_URL }, { log: (l) => lines.push(l) }), null);
    assert.deepEqual(lines, []);
  });

  test('every plan in the price table needs its own variable, and nothing else sells', () => {
    assert.deepEqual(PLAN_PRICE_ENV, { key_pro: 'STRIPE_PRICE_KEY_PRO', student: 'STRIPE_PRICE_STUDENT', engineer: 'STRIPE_PRICE_ENGINEER' });
    assert.deepEqual(config.prices, { key_pro: 'price_keypro', student: 'price_student', engineer: 'price_engineer' });
    for (const plan of PAID_PLANS) assert.ok(PLANS[plan].priceUsd > 0, `${plan} has a price in plans.js`);
  });

  test('the mode must be stated as test or live', () => {
    for (const mode of ['', 'TEST', 'production', 'sandbox']) {
      const { result, lines } = configWith({ STRIPE_MODE: mode });
      assert.equal(result, null, mode);
      assert.match(lines.join('\n'), /STRIPE_MODE/);
    }
  });

  test('a test key in live mode is refused, naming the mismatch and never the key', () => {
    for (const key of ['sk_test_fake', 'rk_test_fake']) {
      const { result, lines } = configWith({ STRIPE_MODE: 'live', STRIPE_SECRET_KEY: key });
      assert.equal(result, null);
      assert.equal(lines.length, 1);
      assert.match(lines[0], /STRIPE_MODE is live but STRIPE_SECRET_KEY is a test-mode key/);
      assert.ok(!lines[0].includes(key));
    }
  });

  test('a live key in test mode is refused, naming the mismatch and never the key', () => {
    for (const key of ['sk_live_fake', 'rk_live_fake']) {
      const { result, lines } = configWith({ STRIPE_MODE: 'test', STRIPE_SECRET_KEY: key });
      assert.equal(result, null);
      assert.equal(lines.length, 1);
      assert.match(lines[0], /STRIPE_MODE is test but STRIPE_SECRET_KEY is a live-mode key/);
      assert.ok(!lines[0].includes(key));
    }
  });

  test('a value that is not a Stripe key at all is refused too', () => {
    const { result, lines } = configWith({ STRIPE_SECRET_KEY: 'pk_test_fake' });
    assert.equal(result, null);
    assert.match(lines[0], /not a Stripe secret or restricted key/);
    assert.ok(!lines[0].includes('pk_test_fake'));
  });

  test('matching keys are accepted in either mode, restricted keys included', () => {
    assert.equal(configWith({ STRIPE_MODE: 'live', STRIPE_SECRET_KEY: 'rk_live_fake' }).result.mode, 'live');
    assert.equal(configWith({ STRIPE_SECRET_KEY: 'rk_test_fake' }).result.mode, 'test');
  });

  test('the return URL is BASE_URL/billing/done, with or without a trailing slash', () => {
    assert.equal(config.returnUrl, 'https://control.scope.test/billing/done');
    assert.equal(configWith({ BASE_URL: 'https://control.scope.test/' }).result.returnUrl, 'https://control.scope.test/billing/done');
    assert.equal(configWith({ BASE_URL: 'not a url' }).result, null);
    assert.equal(configWith({ BASE_URL: 'ftp://control.scope.test' }).result, null);
  });

  test('the stand-in API is accepted only on loopback in test mode, so a real key never goes elsewhere', () => {
    assert.equal(configWith({ STRIPE_API_BASE: 'http://localhost:4010' }).result.apiBase.port, '4010');
    assert.equal(configWith({ STRIPE_API_BASE: 'http://stripe.example.test' }).result, null);
    assert.equal(configWith({ STRIPE_MODE: 'live', STRIPE_SECRET_KEY: 'sk_live_fake', STRIPE_API_BASE: 'http://localhost:4010' }).result, null);
  });
});

describe('plans from subscriptions', () => {
  test('each price maps to its plan; an unknown one to none', () => {
    assert.deepEqual(['price_keypro', 'price_student', 'price_engineer', 'price_other'].map((p) => planForPrice(config, p)), ['key_pro', 'student', 'engineer', null]);
  });
  test('active, trialing and past due keep the plan; canceled, unpaid, paused and incomplete drop to Free', () => {
    for (const status of ['active', 'trialing', 'past_due']) assert.equal(entitledPlan(config, subscription(status, 'price_engineer')), 'engineer', status);
    for (const status of ['canceled', 'unpaid', 'paused', 'incomplete', 'incomplete_expired']) assert.equal(entitledPlan(config, subscription(status, 'price_engineer')), 'free', status);
    assert.equal(entitledPlan(config, subscription('active', 'price_other')), 'free', 'an unknown product grants nothing');
  });
  test('the record reads the period end from the item, or from the subscription on older API versions', () => {
    const record = subscriptionRecord(config, subscription('active', 'price_student', { cancel_at: 1790000000 }));
    assert.deepEqual(
      [record.accountId, record.customerId, record.subscriptionId, record.plan, record.renewsAt, record.cancelAt],
      ['a1', 'cus_1', 'sub_1', 'student', new Date(1790000000 * 1000).toISOString(), new Date(1790000000 * 1000).toISOString()]
    );
    const older = subscriptionRecord(config, { ...subscription('active', 'price_student'), items: { data: [{ price: { id: 'price_student' } }] }, current_period_end: 1780000000 });
    assert.equal(older.renewsAt, new Date(1780000000 * 1000).toISOString());
  });
});

describe('verifyEvent', () => {
  const stripe = new Stripe('sk_test_fake');
  const payload = JSON.stringify({ id: 'evt_1', type: 'customer.subscription.created', created: 1, data: { object: {} } });
  test('accepts a correctly signed body and refuses a wrong secret or an altered body', () => {
    const header = stripe.webhooks.generateTestHeaderString({ payload, secret: env.STRIPE_WEBHOOK_SECRET });
    assert.equal(verifyEvent(config, Buffer.from(payload), header).id, 'evt_1');
    const forged = stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_other' });
    assert.throws(() => verifyEvent(config, Buffer.from(payload), forged));
    assert.throws(() => verifyEvent(config, Buffer.from(payload.replace('evt_1', 'evt_2')), header));
    assert.throws(() => verifyEvent(config, Buffer.from(payload), undefined));
  });
});
