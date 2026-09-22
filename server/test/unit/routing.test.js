import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseNdjson } from '../../src/lib/ollama.js';
import { resolveConfig } from '../../src/retrieval/score.js';
import { SYSTEM_PROMPTS, buildMessages } from '../../src/routing/prompt.js';
import { CLOUD_TIER, LOCAL_TIER, decideRoute, provisionalTier } from '../../src/routing/route.js';

const entry = (privacy, overrides = {}) => ({
  node: { id: overrides.id ?? privacy, type: 'file', project: 'hmb/p', privacy, content: overrides.content ?? privacy },
  score: overrides.score ?? 0.01,
});
const publicOnly = [entry('cloud')];
const withPrivate = [entry('cloud'), entry('local')];

describe('provisionalTier', () => {
  test('local when the local model can serve, cloud otherwise', () => {
    assert.equal(provisionalTier({ localAvailable: true }), LOCAL_TIER);
    assert.equal(provisionalTier({ localAvailable: false }), CLOUD_TIER);
  });

  test("the user's tier choice sets the provisional tier", () => {
    assert.equal(provisionalTier({ localAvailable: true, preferredTier: CLOUD_TIER }), CLOUD_TIER);
  });
});

describe('decideRoute', () => {
  const route = (selected, extra = {}) =>
    decideRoute({ selected, localAvailable: true, cloudAvailable: false, ...extra });

  test('a small public context on a running local model routes local for context_size', () => {
    assert.deepEqual(route(publicOnly), { decision: 'local', tier: LOCAL_TIER, reason: 'context_size', blocked: null });
  });

  test('a private node forces local, even over an explicit cloud choice with cloud available', () => {
    const decided = route(withPrivate, { preferredTier: CLOUD_TIER, cloudAvailable: true });
    assert.equal(decided.tier, LOCAL_TIER);
    assert.equal(decided.reason, 'privacy_flag');
    assert.equal(decided.blocked, null);
  });

  test('private context with no local model is refused, never rerouted to cloud', () => {
    const decided = route(withPrivate, { localAvailable: false, cloudAvailable: true });
    assert.equal(decided.decision, 'local');
    assert.equal(decided.reason, 'privacy_flag');
    assert.equal(decided.blocked, 'local_unavailable');
  });

  test('no local model routes cloud for no_ollama, blocked until a cloud client exists', () => {
    assert.deepEqual(route(publicOnly, { localAvailable: false }), {
      decision: 'cloud', tier: CLOUD_TIER, reason: 'no_ollama', blocked: 'cloud_unavailable',
    });
    assert.equal(route(publicOnly, { localAvailable: false, cloudAvailable: true }).blocked, null);
  });

  test('an explicit tier choice routes there with reason user_override', () => {
    const cloud = route(publicOnly, { preferredTier: CLOUD_TIER });
    assert.equal(cloud.reason, 'user_override');
    assert.equal(cloud.blocked, 'cloud_unavailable');
    const local = route(publicOnly, { preferredTier: LOCAL_TIER, localAvailable: false, cloudAvailable: true });
    assert.equal(local.tier, LOCAL_TIER);
    assert.equal(local.blocked, 'local_unavailable');
  });
});

describe('buildMessages', () => {
  const selected = [
    entry('cloud', { id: 'b', content: 'second', score: 0.02 }),
    entry('cloud', { id: 'a', content: 'first', score: 0.05 }),
  ];

  test('strict_xml: static system prefix, relevance-descending sources, question last', () => {
    const { messages, sources } = buildMessages({ query: 'q?', selected, config: resolveConfig(LOCAL_TIER) });
    assert.equal(messages[0].content, SYSTEM_PROMPTS.strict_xml);
    assert.deepEqual(sources.map((s) => s.node.id), ['a', 'b'], 'citation [1] is the most relevant node');
    const body = messages[1].content;
    assert.ok(body.indexOf('<source index="1" type="file" project="hmb/p">\nfirst') < body.indexOf('<source index="2"'));
    assert.ok(body.endsWith('<question>\nq?\n</question>'));
  });

  test('the system prompt is byte-identical across queries (KV-cache prefix)', () => {
    const config = resolveConfig(LOCAL_TIER);
    const one = buildMessages({ query: 'one', selected, config }).messages[0].content;
    const two = buildMessages({ query: 'two', selected: [], config }).messages[0].content;
    assert.equal(one, two);
  });

  test('markdown structure for the cloud tier', () => {
    const { messages } = buildMessages({ query: 'q?', selected, config: resolveConfig(CLOUD_TIER) });
    assert.equal(messages[0].content, SYSTEM_PROMPTS.markdown);
    assert.ok(messages[1].content.startsWith('## Context\n\n### [1] file · hmb/p\n\nfirst'));
    assert.ok(messages[1].content.endsWith('## Question\n\nq?'));
  });

  test('an empty retrieval says so instead of sending an empty block', () => {
    const { messages } = buildMessages({ query: 'q?', selected: [], config: resolveConfig(LOCAL_TIER) });
    assert.match(messages[1].content, /<context>\nNo matching excerpts/);
  });
});

describe('parseNdjson', () => {
  async function* chunks(...parts) {
    for (const part of parts) yield part;
  }

  test('reassembles lines split across chunks, including inside a multi-byte character', async () => {
    const bytes = Buffer.from('{"t":"naïve"}\n{"t":"—"}\n\n{"t":"end"}');
    const cutInsideDash = bytes.indexOf(Buffer.from('—')) + 1;
    const parsed = [];
    for await (const line of parseNdjson(chunks(bytes.subarray(0, 5), bytes.subarray(5, cutInsideDash), bytes.subarray(cutInsideDash)))) {
      parsed.push(line.t);
    }
    assert.deepEqual(parsed, ['naïve', '—', 'end'], 'trailing line without a newline is still emitted');
  });
});
