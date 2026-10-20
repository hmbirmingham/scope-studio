import { test } from 'node:test';
import assert from 'node:assert/strict';
import { platformCloudRefusal, resolvePlatformCredential } from '../../src/billing/credential.js';
import { ECONOMY_MAX_TOKENS, monthlyAnswerLimit, weeklyAllowanceUsd } from '../../src/billing/plans.js';

const KEY = 'sk-ant-test-not-a-real-key';

test('only the platform-paid plans reach platform cloud, and only with a key', () => {
  assert.equal(platformCloudRefusal('free', KEY), 'cloud_not_in_plan');
  assert.equal(platformCloudRefusal('key_pro', KEY), 'cloud_not_in_plan');
  assert.equal(platformCloudRefusal('no_such_plan', KEY), 'cloud_not_in_plan');
  assert.equal(platformCloudRefusal('student', undefined), 'platform_cloud_unavailable');
  assert.equal(platformCloudRefusal('engineer', ''), 'platform_cloud_unavailable');
  assert.equal(platformCloudRefusal('student', KEY), null);
  assert.equal(platformCloudRefusal('engineer', KEY), null);
});

test('the month and the week are enforced in that order', () => {
  const allowance = weeklyAllowanceUsd('student');
  const limit = monthlyAnswerLimit('student');
  assert.equal(resolvePlatformCredential({ plan: 'student', monthlyAnswersUsed: limit, weeklySpentUsd: allowance, platformKey: KEY }).blocked, 'answer_limit_reached');
  assert.equal(resolvePlatformCredential({ plan: 'student', monthlyAnswersUsed: limit - 1, weeklySpentUsd: allowance, platformKey: KEY }).blocked, 'allowance_exhausted');
  assert.equal(resolvePlatformCredential({ plan: 'student', monthlyAnswersUsed: limit - 1, weeklySpentUsd: allowance - 0.01, platformKey: KEY }).blocked, null);
});

test('below half the allowance an answer runs at full length on the plan model', () => {
  const credential = resolvePlatformCredential({ plan: 'engineer', weeklySpentUsd: 0, platformKey: KEY });
  assert.equal(credential.apiKey, KEY);
  assert.equal(credential.effort, 'medium');
  assert.equal(credential.economy, false);
  assert.equal(credential.maxTokens, undefined);
  assert.equal(credential.brevity, undefined);
  assert.equal(credential.modelFor(false), 'claude-sonnet-5');
  assert.equal(credential.modelFor(true), 'claude-opus-5');
});

test('from half the allowance an answer economises: Opus steps down and the ceiling drops', () => {
  const half = weeklyAllowanceUsd('engineer') / 2;
  const credential = resolvePlatformCredential({ plan: 'engineer', weeklySpentUsd: half, platformKey: KEY });
  assert.equal(credential.economy, true);
  assert.equal(credential.maxTokens, ECONOMY_MAX_TOKENS);
  assert.equal(credential.brevity, true);
  assert.equal(credential.modelFor(true), 'claude-sonnet-5');
  assert.equal(credential.modelFor(false), 'claude-sonnet-5');
});
