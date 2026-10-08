import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import Stripe from 'stripe';
import { billingConfig, entitledPlan, planForPrice, subscriptionRecord, verifyEvent } from '../../src/billing/stripe.js';

const env = {
  STRIPE_SECRET_KEY: 'sk_test_fake', STRIPE_WEBHOOK_SECRET: 'whsec_test_fake',
  STRIPE_PRICE_KEY_PRO: 'price_keypro', STRIPE_PRICE_STUDENT: 'price_student', STRIPE_PRICE_ENGINEER: 'price_engineer',
};
const config = billingConfig(env);
const subscription = (status, price, extra = {}) => ({ id: 'sub_1', customer: 'cus_1', status, metadata: { user_id: 'u1' }, items: { data: [{ price: { id: price }, current_period_end: 1790000000 }] }, ...extra });

describe('billingConfig', () => {
  test('complete only when every value is set; never a default', () => {
    assert.ok(config);
    for (const key of Object.keys(env)) assert.equal(billingConfig({ ...env, [key]: '' }), null, key);
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
      [record.userId, record.customerId, record.subscriptionId, record.plan, record.renewsAt, record.cancelAt],
      ['u1', 'cus_1', 'sub_1', 'student', new Date(1790000000 * 1000).toISOString(), new Date(1790000000 * 1000).toISOString()]
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
