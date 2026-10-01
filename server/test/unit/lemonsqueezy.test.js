import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, test } from 'node:test';
import { billingConfig, entitledPlan, planForVariant, verifySignature } from '../../src/billing/lemonsqueezy.js';

const env = {
  LEMONSQUEEZY_API_KEY: 'test-api-key', LEMONSQUEEZY_STORE_ID: '11', LEMONSQUEEZY_WEBHOOK_SECRET: 'test-secret',
  LEMONSQUEEZY_VARIANT_KEY_PRO: '101', LEMONSQUEEZY_VARIANT_STUDENT: '102', LEMONSQUEEZY_VARIANT_ENGINEER: '103',
};

describe('billingConfig', () => {
  test('complete only when every value is set; never a default', () => {
    assert.ok(billingConfig(env));
    for (const key of Object.keys(env)) assert.equal(billingConfig({ ...env, [key]: '' }), null, key);
  });
});

describe('plans from subscriptions', () => {
  const config = billingConfig(env);
  test('each variant maps to its plan; an unknown one to none', () => {
    assert.deepEqual(['101', '102', '103', 999].map((v) => planForVariant(config, v)), ['key_pro', 'student', 'engineer', null]);
  });
  test('active, trial, past due and cancelled-until-period-end keep the plan; the rest drop to Free', () => {
    for (const status of ['active', 'on_trial', 'past_due', 'cancelled']) assert.equal(entitledPlan(config, { status, variant_id: 103 }), 'engineer', status);
    for (const status of ['expired', 'unpaid', 'paused']) assert.equal(entitledPlan(config, { status, variant_id: 103 }), 'free', status);
    assert.equal(entitledPlan(config, { status: 'active', variant_id: 999 }), 'free', 'an unknown product grants nothing');
  });
});

describe('verifySignature', () => {
  const body = Buffer.from('{"meta":{}}');
  const sign = (secret) => createHmac('sha256', secret).update(body).digest('hex');
  test('accepts the HMAC-SHA256 hex of the raw body, and nothing else', () => {
    assert.equal(verifySignature(body, sign('test-secret'), 'test-secret'), true);
    assert.equal(verifySignature(body, sign('other-secret'), 'test-secret'), false);
    assert.equal(verifySignature(Buffer.from('{"meta":{ }}'), sign('test-secret'), 'test-secret'), false, 'one byte changed');
    assert.equal(verifySignature(body, undefined, 'test-secret'), false);
    assert.equal(verifySignature(body, 'short', 'test-secret'), false);
  });
});
