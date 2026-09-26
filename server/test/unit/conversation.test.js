import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { projectAmbiguity } from '../../src/routing/ambiguity.js';
import {
  getConversation,
  resetConversations,
  readsAsFollowUp,
  retrievalQuery,
  continuation,
  saveConversation,
} from '../../src/routing/conversation.js';

const source = (id, project = 'hmb/p', score = 0.05) => ({ node: { id, project }, score });
const entryFor = (ids) => ({
  tier: 'local_7b',
  sources: ids.map((id) => source(id)),
  messages: [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'context + question' },
    { role: 'assistant', content: 'answer' },
  ],
  contextTokens: 900,
  lastQuestion: 'what does it return',
});

describe('conversation store', () => {
  beforeEach(() => resetConversations());

  test('round-trips for its owner only', () => {
    saveConversation('c1', 'owner-1', entryFor(['a', 'b']));
    assert.equal(getConversation('c1', 'owner-1').lastQuestion, 'what does it return');
    assert.equal(getConversation('c1', 'owner-2'), null);
    assert.equal(getConversation(undefined, 'owner-1'), null);
  });

  test('continues the thread, appending only the nodes the context lacks', () => {
    saveConversation('c1', 'owner-1', entryFor(['a', 'b']));
    const entry = getConversation('c1', 'owner-1');

    const covered = continuation(entry, { selected: [source('a')], tier: 'local_7b' });
    assert.deepEqual(covered.added, [], 'nothing new to add — a pure append');

    const partly = continuation(entry, { selected: [source('a'), source('c')], tier: 'local_7b' });
    assert.deepEqual(partly.added.map(({ node }) => node.id), ['c'], 'the new node rides along, the cached prefix stays');

    assert.equal(continuation(entry, { selected: [source('a')], tier: 'cloud_frontier' }), null);
    assert.equal(continuation(null, { selected: [], tier: 'local_7b' }), null);
  });

  test('a question that shares nothing with the context starts a fresh block', () => {
    saveConversation('c1', 'owner-1', entryFor(['a', 'b']));
    const entry = getConversation('c1', 'owner-1');
    assert.equal(
      continuation(entry, { selected: [source('x'), source('y')], tier: 'local_7b' }),
      null,
      'the thread moved on — carrying the old files along is what leaks one project into another'
    );
    assert.ok(continuation(entry, { selected: [source('a'), source('x')], tier: 'local_7b' }), 'still on subject');
  });

  test('switching project starts a fresh block', () => {
    saveConversation('c1', 'owner-1', { ...entryFor(['a']), project: 'hmb/plates' });
    const entry = getConversation('c1', 'owner-1');
    assert.ok(continuation(entry, { selected: [source('a')], tier: 'local_7b', project: 'hmb/plates' }));
    assert.equal(
      continuation(entry, { selected: [source('a')], tier: 'local_7b', project: 'hmb/firmware' }),
      null,
      'a different project is a different subject'
    );
    assert.equal(continuation(entry, { selected: [source('a')], tier: 'local_7b' }), null, 'and so is all-maps');
  });

  test('a prompt past the budget starts a fresh context block', () => {
    const long = entryFor(['a']);
    long.messages = [{ role: 'user', content: 'x'.repeat(6001 * 4) }];
    saveConversation('c1', 'owner-1', long);
    assert.equal(continuation(getConversation('c1', 'owner-1'), { selected: [source('a')], tier: 'local_7b' }), null);
  });

  test('a follow-up retrieves on the previous question too', () => {
    saveConversation('c1', 'owner-1', entryFor(['a']));
    const entry = getConversation('c1', 'owner-1');
    assert.equal(retrievalQuery(entry, 'and for empty plates'), 'what does it return and for empty plates');
    assert.equal(retrievalQuery(null, 'and for empty plates'), 'and for empty plates');
  });
});

describe('readsAsFollowUp', () => {
  test('wording that leans on the previous turn is a follow-up', () => {
    for (const q of ['and where is that set?', 'what does it return for empty plates', 'why is this slow',
      'what about the firmware', 'but how are they deployed', 'show me the same for huskybook', 'also check the tests']) {
      assert.equal(readsAsFollowUp(q), true, q);
    }
  });
  test('a question that stands on its own is not', () => {
    for (const q of ['describe a tree', 'what does quantify_colonies return', 'which repositories use Flask',
      'how is the USART peripheral configured', 'iterate over the items']) {
      assert.equal(readsAsFollowUp(q), false, q);
    }
  });
});

describe('projectAmbiguity', () => {
  test('suggests projects when the strongest candidates are split', () => {
    const suggestions = projectAmbiguity([
      source('a', 'hmb/plates', 0.05),
      source('b', 'hmb/firmware', 0.04),
      source('c', 'hmb/firmware', 0.03),
    ]);
    assert.deepEqual(suggestions.map((s) => s.project), ['hmb/firmware', 'hmb/plates']);
    assert.ok(suggestions[0].share > 0.5 && suggestions[0].share < 0.7);
  });

  test('stays quiet when one project dominates or only one is present', () => {
    assert.equal(projectAmbiguity([source('a', 'hmb/plates', 0.9), source('b', 'hmb/firmware', 0.02)]), null);
    assert.equal(projectAmbiguity([source('a', 'hmb/plates'), source('b', 'hmb/plates')]), null);
    assert.equal(projectAmbiguity([]), null);
  });
});
