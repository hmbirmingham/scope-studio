import { test } from 'node:test';
import assert from 'node:assert/strict';
import Anthropic from '@anthropic-ai/sdk';
import { CLOUD_MODELS } from '../../src/billing/plans.js';
import {
  BREVITY_NOTE,
  costUsd,
  describeError,
  effortConfig,
  failureKind,
  mergeUsage,
  priceFor,
  splitSystem,
  withBrevityNote,
  withCacheBreakpoint,
} from '../../src/lib/anthropic.js';

test('every model a plan can route to has a price, so no answer is charged nothing', () => {
  for (const model of CLOUD_MODELS) assert.ok(priceFor(model), model);
  assert.equal(costUsd('not-a-model', { input_tokens: 10 }), null);
});

test('cache writes and reads are folded into the cost', () => {
  const cost = costUsd('claude-sonnet-5', {
    input_tokens: 1_000_000, cache_creation_input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, output_tokens: 1_000_000,
  });
  assert.ok(Math.abs(cost - (2 + 2 * 1.25 + 2 * 0.1 + 10)) < 1e-9);
});

test('effort goes only to the models that accept it', () => {
  assert.deepEqual(effortConfig('claude-sonnet-5', 'medium'), { output_config: { effort: 'medium' } });
  assert.deepEqual(effortConfig('claude-opus-5', 'medium'), { output_config: { effort: 'medium' } });
  assert.deepEqual(effortConfig('claude-haiku-4-5', 'medium'), {});
  assert.deepEqual(effortConfig('claude-sonnet-5', null), {});
});

test('usage reports replace earlier ones rather than adding to them', () => {
  const started = mergeUsage(null, { input_tokens: 1200, output_tokens: 1, cache_read_input_tokens: 300 });
  const ended = mergeUsage(started, { output_tokens: 40 });
  assert.deepEqual(ended, { input_tokens: 1200, output_tokens: 40, cache_creation_input_tokens: 0, cache_read_input_tokens: 300 });
});

test('the cache breakpoint splits the first user turn at the marker', () => {
  const messages = [{ role: 'system', content: 's' }, { role: 'user', content: 'CONTEXT<question>Q' }];
  const [, user] = withCacheBreakpoint(messages, '<question>');
  assert.deepEqual(user.content, [
    { type: 'text', text: 'CONTEXT', cache_control: { type: 'ephemeral' } },
    { type: 'text', text: '<question>Q' },
  ]);
  assert.equal(withCacheBreakpoint(messages, null), messages);
  assert.equal(withCacheBreakpoint(messages, 'absent'), messages);
});

test('the brevity note goes on the latest question, as text or as a block', () => {
  const text = withBrevityNote([{ role: 'user', content: 'Q' }]);
  assert.equal(text[0].content, `Q${BREVITY_NOTE}`);
  const blocks = withBrevityNote([{ role: 'user', content: [{ type: 'text', text: 'Q' }] }]);
  assert.deepEqual(blocks[0].content.at(-1), { type: 'text', text: BREVITY_NOTE.trim() });
});

test('the system message becomes its own parameter', () => {
  const { system, rest } = splitSystem([{ role: 'system', content: 's' }, { role: 'user', content: 'q' }]);
  assert.equal(system, 's');
  assert.deepEqual(rest, [{ role: 'user', content: 'q' }]);
});

test('an upstream error is described without its own text', () => {
  const echoed = 'the prompt was: PRIVATE';
  const errors = [
    new Anthropic.APIError(500, { type: 'error', error: { message: echoed } }, echoed, new Headers()),
    new Anthropic.APIError(undefined, { type: 'error', error: { message: echoed } }, echoed, new Headers()),
    new Error(echoed),
  ];
  for (const err of errors) {
    assert.doesNotMatch(describeError(err), /PRIVATE/);
    assert.doesNotMatch(failureKind(err), /PRIVATE/);
  }
  assert.match(describeError(errors[0]), /500/);
});
