import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { resolveCloudCredential } from '../../src/billing/credential.js';
import {
  CLOUD_MODELS, PLANS, canAutoCloud, canChooseCloud, cloudEffortFor, planFor, platformModel,
  resolveCloudModel, weeklyAllowanceUsd,
} from '../../src/billing/plans.js';

describe('plans', () => {
  test('no plan routes to Opus, and it cannot be configured back in', () => {
    assert.ok(!CLOUD_MODELS.includes('claude-opus-5'));
    assert.ok(Object.values(PLANS).every((plan) => plan.cloud !== 'claude-opus-5'));
    assert.throws(() => resolveCloudModel('key_pro', 'claude-opus-5'), /not offered/);
  });

  test('choosing the cloud yourself is Key Pro only', () => {
    assert.deepEqual(Object.keys(PLANS).filter(canChooseCloud), ['key_pro']);
    assert.equal(canChooseCloud('nonsense'), false);
  });

  test('Auto may reach the cloud on Key Pro, Student and Engineer, never on Free', () => {
    assert.deepEqual(Object.keys(PLANS).filter(canAutoCloud).sort(), ['engineer', 'key_pro', 'student']);
    assert.equal(canAutoCloud('free'), false);
    assert.equal(planFor('nonsense'), PLANS.free);
  });

  test('allowances: a monthly budget becomes a weekly one; Key Pro has none, Free has zero', () => {
    assert.ok(Math.abs(weeklyAllowanceUsd('student') - 2.25 / (30 / 7)) < 1e-9);
    assert.ok(weeklyAllowanceUsd('engineer') > weeklyAllowanceUsd('student'));
    assert.equal(weeklyAllowanceUsd('key_pro'), null);
    assert.equal(weeklyAllowanceUsd('free'), 0);
  });

  test('platform answers use Sonnet until half the allowance is spent, then Haiku', () => {
    assert.equal(platformModel(0, 1), 'claude-sonnet-5');
    assert.equal(platformModel(0.4999, 1), 'claude-sonnet-5');
    assert.equal(platformModel(0.5, 1), 'claude-haiku-4-5');
    assert.equal(platformModel(0.9, 1), 'claude-haiku-4-5');
  });

  test('engineer buys depth, not a pricier model', () => {
    assert.equal(cloudEffortFor('engineer'), 'high');
    assert.equal(cloudEffortFor('student'), 'medium');
  });
});

describe('resolveCloudCredential', () => {
  const allowance = weeklyAllowanceUsd('student');

  test("Key Pro uses the user's own key for anything, including an explicit Cloud or web request", () => {
    const credential = resolveCloudCredential({ plan: 'key_pro', headerKey: 'user-key', explicit: true, platformKey: 'platform' });
    assert.equal(credential.apiKey, 'user-key');
    assert.equal(credential.billedTo, 'user_key');
    assert.equal(credential.blocked, null);
  });

  test('off Key Pro an explicit Cloud or web request is blocked, and the user key is never used', () => {
    for (const plan of ['free', 'student', 'engineer']) {
      const credential = resolveCloudCredential({ plan, headerKey: 'user-key', explicit: true, platformKey: 'platform' });
      assert.equal(credential.blocked, 'cloud_requires_key_pro', plan);
      assert.equal(credential.apiKey, null, plan);
    }
  });

  test('an Auto answer on Student uses the platform key, billed to the platform, on the right model', () => {
    const fresh = resolveCloudCredential({ plan: 'student', headerKey: 'user-key', explicit: false, platformKey: 'platform', weeklySpentUsd: 0 });
    assert.deepEqual([fresh.apiKey, fresh.billedTo, fresh.model], ['platform', 'platform', 'claude-sonnet-5']);
    const half = resolveCloudCredential({ plan: 'student', explicit: false, platformKey: 'platform', weeklySpentUsd: allowance / 2 });
    assert.equal(half.model, 'claude-haiku-4-5');
  });

  test('a spent allowance, a missing platform key, or Free all mean no cloud credential', () => {
    const spent = resolveCloudCredential({ plan: 'student', explicit: false, platformKey: 'platform', weeklySpentUsd: allowance });
    assert.deepEqual([spent.apiKey, spent.blocked], [null, 'allowance_exhausted']);
    const unset = resolveCloudCredential({ plan: 'engineer', explicit: false, platformKey: undefined });
    assert.deepEqual([unset.apiKey, unset.blocked], [null, null]);
    const free = resolveCloudCredential({ plan: 'free', headerKey: 'user-key', explicit: false, platformKey: 'platform' });
    assert.deepEqual([free.apiKey, free.blocked], [null, null]);
  });
});
