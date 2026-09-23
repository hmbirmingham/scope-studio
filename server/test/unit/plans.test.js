import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CLOUD_MODELS, PLANS, cloudEffortFor, planFor, resolveCloudModel, weeklyAllowanceUsd } from '../../src/billing/plans.js';

describe('plans', () => {
  test('no plan routes to Opus, and it cannot be configured back in', () => {
    assert.ok(!CLOUD_MODELS.includes('claude-opus-5'));
    assert.ok(Object.values(PLANS).every((plan) => plan.cloud !== 'claude-opus-5'));
    assert.throws(() => resolveCloudModel('student', 'claude-opus-5'), /not offered/);
  });

  test('student and key_pro both answer on Sonnet', () => {
    assert.equal(resolveCloudModel('student'), 'claude-sonnet-5');
    assert.equal(resolveCloudModel('key_pro'), 'claude-sonnet-5');
    assert.equal(planFor('key_pro').ownKey, true, "key_pro spends the user's own money");
    assert.equal(planFor('student').ownKey, false);
  });

  test('free is local only and an unknown plan falls back to it', () => {
    assert.equal(planFor('free').cloud, null);
    assert.equal(planFor('nonsense').cloud, null);
    assert.equal(weeklyAllowanceUsd('free'), 0);
  });

  test('engineer buys depth and volume, not a pricier model', () => {
    assert.equal(resolveCloudModel('engineer'), resolveCloudModel('student'));
    assert.equal(cloudEffortFor('engineer'), 'high');
    assert.equal(cloudEffortFor('student'), 'medium');
    assert.ok(weeklyAllowanceUsd('engineer') > weeklyAllowanceUsd('student'));
  });

  test('a monthly budget becomes a weekly allowance', () => {
    assert.ok(Math.abs(weeklyAllowanceUsd('student') - 2.25 / (30 / 7)) < 1e-9);
    assert.equal(weeklyAllowanceUsd('key_pro'), null, 'nothing to meter on the user\'s own key');
  });

  test('an offered override is honoured', () => {
    assert.equal(resolveCloudModel('student', 'claude-haiku-4-5'), 'claude-haiku-4-5');
  });
});
