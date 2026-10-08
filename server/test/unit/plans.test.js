import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { resolveCloudCredential } from '../../src/billing/credential.js';
import {
  MARGIN_TARGET, PLANS, canAutoCloud, canChooseCloud, cloudEffortFor, measuredAnswerUsd, monthlyAnswerLimit,
  monthlyCloudBudgetUsd, netRevenueUsd, planFor, platformModel, resolveCloudModel, weeklyAllowanceUsd,
} from '../../src/billing/plans.js';

describe('plans', () => {
  test('prices, and a cloud budget derived from each price at the target margin', () => {
    assert.deepEqual(Object.fromEntries(Object.entries(PLANS).map(([k, v]) => [k, v.priceUsd])), { free: 0, key_pro: 5, student: 12, engineer: 25 });
    for (const plan of ['student', 'engineer']) {
      const expected = netRevenueUsd(plan) * (1 - MARGIN_TARGET);
      assert.ok(Math.abs(monthlyCloudBudgetUsd(plan) - expected) < 1e-9, plan);
    }
    assert.ok(Math.abs(netRevenueUsd('engineer') - (25 * 0.936 - 0.3)) < 1e-9, 'payment fees come off first');
    assert.equal(monthlyCloudBudgetUsd('key_pro'), null, "the user's own key");
    assert.equal(monthlyCloudBudgetUsd('free'), 0);
    assert.ok(Math.abs(weeklyAllowanceUsd('engineer') - monthlyCloudBudgetUsd('engineer') / (30 / 7)) < 1e-9);
  });

  test('choosing the cloud yourself is Key Pro only; Auto may reach it on Key Pro, Student and Engineer', () => {
    assert.deepEqual(Object.keys(PLANS).filter(canChooseCloud), ['key_pro']);
    assert.deepEqual(Object.keys(PLANS).filter(canAutoCloud).sort(), ['engineer', 'key_pro', 'student']);
    assert.equal(planFor('nonsense'), PLANS.free);
  });

  test('Engineer answers hard questions on Opus and the rest on Sonnet; Student is Sonnet throughout', () => {
    assert.equal(platformModel('engineer', { hard: true }), 'claude-opus-5');
    assert.equal(platformModel('engineer', { hard: false }), 'claude-sonnet-5');
    assert.equal(platformModel('student', { hard: true }), 'claude-sonnet-5');
    assert.equal(platformModel('free', { hard: true }), null);
  });

  test('past half the week\'s budget every platform model steps down one level', () => {
    const allowance = weeklyAllowanceUsd('engineer');
    assert.equal(platformModel('engineer', { hard: true, spentUsd: allowance * 0.4999 }), 'claude-opus-5');
    assert.equal(platformModel('engineer', { hard: true, spentUsd: allowance * 0.5 }), 'claude-sonnet-5');
    assert.equal(platformModel('engineer', { hard: false, spentUsd: allowance * 0.5 }), 'claude-haiku-4-5');
    assert.equal(platformModel('student', { spentUsd: weeklyAllowanceUsd('student') * 0.6 }), 'claude-haiku-4-5');
  });

  test('advertised answer limits fit the budget at measured costs, so the margin holds at or above target', () => {
    assert.equal(monthlyAnswerLimit('student'), 200);
    assert.equal(monthlyAnswerLimit('engineer'), 340);
    assert.equal(monthlyAnswerLimit('key_pro'), null, 'their own key, no limit');
    for (const plan of ['student', 'engineer']) {
      const cost = monthlyAnswerLimit(plan) * measuredAnswerUsd(plan);
      assert.ok(cost <= monthlyCloudBudgetUsd(plan), `${plan}: ${cost.toFixed(2)} of ${monthlyCloudBudgetUsd(plan).toFixed(2)}`);
      assert.ok(1 - cost / netRevenueUsd(plan) >= MARGIN_TARGET, `${plan} margin`);
    }
  });

  test('Opus is never a default, and only offered models can be chosen', () => {
    assert.ok(Object.values(PLANS).every((plan) => plan.models?.default !== 'claude-opus-5'));
    assert.equal(resolveCloudModel('key_pro', 'claude-opus-5'), 'claude-opus-5', 'Key Pro may opt in');
    assert.throws(() => resolveCloudModel('key_pro', 'claude-fable-5-1'), /not offered/);
    assert.equal(resolveCloudModel('key_pro', undefined), 'claude-sonnet-5');
    assert.equal(cloudEffortFor('engineer'), 'medium');
  });
});

describe('resolveCloudCredential', () => {
  const allowance = weeklyAllowanceUsd('student');

  test("Key Pro uses the user's own key for anything, including an explicit Cloud or web request", () => {
    const credential = resolveCloudCredential({ plan: 'key_pro', headerKey: 'user-key', explicit: true, platformKey: 'platform' });
    assert.equal(credential.apiKey, 'user-key');
    assert.equal(credential.billedTo, 'user_key');
    assert.equal(credential.blocked, null);
    assert.equal(credential.modelFor(true), 'claude-sonnet-5', 'Sonnet unless they choose otherwise');
    const opus = resolveCloudCredential({ plan: 'key_pro', headerKey: 'user-key', explicit: false, modelChoice: 'claude-opus-5' });
    assert.equal(opus.modelFor(false), 'claude-opus-5');
  });

  test('off Key Pro an explicit Cloud or web request is blocked, and the user key is never used', () => {
    for (const plan of ['free', 'student', 'engineer']) {
      const credential = resolveCloudCredential({ plan, headerKey: 'user-key', explicit: true, platformKey: 'platform' });
      assert.equal(credential.blocked, 'cloud_requires_key_pro', plan);
      assert.equal(credential.apiKey, null, plan);
    }
  });

  test('an Auto answer on Student uses the platform key, billed to the platform, on the right model', () => {
    const fresh = resolveCloudCredential({ plan: 'student', headerKey: 'user-key', explicit: false, platformKey: 'platform', weeklySpentUsd: 0, modelChoice: 'claude-opus-5' });
    assert.deepEqual([fresh.apiKey, fresh.billedTo, fresh.modelFor(true)], ['platform', 'platform', 'claude-sonnet-5'], 'a Student cannot choose Opus');
    const half = resolveCloudCredential({ plan: 'student', explicit: false, platformKey: 'platform', weeklySpentUsd: allowance / 2 });
    assert.equal(half.modelFor(false), 'claude-haiku-4-5');
    const engineer = resolveCloudCredential({ plan: 'engineer', explicit: false, platformKey: 'platform', weeklySpentUsd: 0 });
    assert.deepEqual([engineer.modelFor(true), engineer.modelFor(false)], ['claude-opus-5', 'claude-sonnet-5']);
  });

  test('a spent allowance, a missing platform key, or Free all mean no cloud credential', () => {
    const spent = resolveCloudCredential({ plan: 'student', explicit: false, platformKey: 'platform', weeklySpentUsd: allowance });
    assert.deepEqual([spent.apiKey, spent.blocked], [null, 'allowance_exhausted']);
    const limit = resolveCloudCredential({ plan: 'student', explicit: false, platformKey: 'platform', monthlyAnswersUsed: 200 });
    assert.deepEqual([limit.apiKey, limit.blocked], [null, 'answer_limit_reached']);
    const unset = resolveCloudCredential({ plan: 'engineer', explicit: false, platformKey: undefined });
    assert.deepEqual([unset.apiKey, unset.blocked], [null, null]);
    const free = resolveCloudCredential({ plan: 'free', headerKey: 'user-key', explicit: false, platformKey: 'platform' });
    assert.deepEqual([free.apiKey, free.blocked], [null, null]);
  });
});
