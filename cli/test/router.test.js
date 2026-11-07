import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLOUD, LOCAL, cloudAllowance, decideRoute, questionDifficulty } from '../src/core/router.js';

const open = { available: true, reason: null };

test('a private source forces local ahead of an explicit request for cloud', () => {
  const route = decideRoute({
    sources: [{ privacy: 'local' }],
    preferred: CLOUD,
    localAvailable: true,
    cloud: open,
    hard: 'wording',
  });
  // Order is the privacy contract: putting the user's choice first would let
  // --cloud carry vault text off the machine.
  assert.equal(route.tier, LOCAL);
  assert.equal(route.reason, 'privacy_flag');
});

test('a private source with no local model is refused, never rerouted', () => {
  const route = decideRoute({ sources: [{ privacy: 'local' }], localAvailable: false, cloud: open });
  assert.equal(route.tier, LOCAL);
  assert.equal(route.blocked, 'local_unavailable');
});

test('public sources and a hard question go to cloud when there is allowance', () => {
  const route = decideRoute({ sources: [{ privacy: 'public' }], localAvailable: true, cloud: open, hard: 'wording' });
  assert.equal(route.tier, CLOUD);
  assert.equal(route.reason, 'complexity');
});

test('a hard question with no allowance is served locally and says so', () => {
  const route = decideRoute({
    sources: [{ privacy: 'public' }],
    localAvailable: true,
    cloud: { available: false, reason: 'uncalibrated' },
    hard: 'wording',
  });
  assert.equal(route.tier, LOCAL);
  // Not 'local_sufficient' — the trace has to be able to say the router thought
  // the model was too small for the question it was given.
  assert.equal(route.reason, 'local_only_despite_wording');
});

test('an uncalibrated ceiling is reported as such, not as an absent subscription', () => {
  assert.deepEqual(cloudAllowance({ cloud: { dailyCloudSteps: 0 } }), {
    available: false,
    reason: 'uncalibrated',
    ceiling: 0,
    remaining: 0,
  });
  assert.equal(cloudAllowance({ cloud: { dailyCloudSteps: 8 } }, { spentToday: 8 }).reason, 'ceiling_reached');
  assert.equal(cloudAllowance({ cloud: { dailyCloudSteps: 8 } }, { spentToday: 3 }).remaining, 5);
});

test('difficulty is wording, length and multi-part; a lookup is none of them', () => {
  assert.equal(questionDifficulty('What does quantify_colonies return?'), null);
  assert.equal(questionDifficulty('Compare BM25 versus dense retrieval'), 'wording');
  assert.equal(questionDifficulty('Why did the ingest fail'), 'wording');
  assert.equal(questionDifficulty(`${'word '.repeat(40)}?`), 'length');
  assert.equal(questionDifficulty('What is DCG? And what is NDCG?'), 'multi_part');
});
