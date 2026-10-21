import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import {
  capabilitiesForTags,
  getCapability,
  getVerifier,
  listPlugins,
  registerPlugin,
  resetRegistry,
} from '../../src/workspace/capabilities.js';
import { createEventBus, formatSse } from '../../src/workspace/events.js';
import { localAdapter, ownKeyAdapter, platformAdapter, selectAdapter } from '../../src/workspace/modelPort.js';
import { inheritPrivacy } from '../../src/workspace/nodeTypes.js';
import { CAPABILITIES, LEVELS, can, decide, inReadScope } from '../../src/workspace/permissions.js';
import { ROLE_TEMPLATES, roleTemplate } from '../../src/workspace/roles.js';

const everywhere = { read: { projects: ['*'], sources: ['*'] }, write: { projects: ['*'] } };
const agent = (fields = {}) => ({ level: 'supervised', state: 'active', modelPolicy: 'local_cloud', scopes: everywhere, overrides: {}, ...fields });
// The context a runner passes for an ordinary online step with no private node.
const ctx = (fields = {}) => ({ project: 'p', online: true, privateContext: false, ...fields });

describe('can(): the permission spectrum', () => {
  test('a supervised agent reads and writes notes freely and asks for everything else', () => {
    const supervised = agent();
    assert.equal(can(supervised, 'read_graph', ctx()), 'allow');
    assert.equal(can(supervised, 'write_notes', ctx()), 'allow');
    for (const capability of ['edit_files', 'run_scripts', 'web', 'cloud_model', 'open_pr', 'apply_merge']) {
      assert.equal(can(supervised, capability, ctx()), 'ask', capability);
    }
  });

  test('manual asks for every capability', () => {
    for (const capability of CAPABILITIES) {
      assert.equal(can(agent({ level: 'manual' }), capability, ctx({ inSandbox: true })), 'ask', capability);
    }
  });

  test('sandboxed works freely inside its sandbox and asks outside it', () => {
    const sandboxed = agent({ level: 'sandboxed' });
    assert.equal(can(sandboxed, 'edit_files', ctx({ inSandbox: true })), 'allow');
    assert.equal(can(sandboxed, 'edit_files', ctx({ inSandbox: false })), 'ask');
    assert.equal(can(sandboxed, 'run_generated_code', ctx({ inSandbox: true })), 'allow');
    assert.equal(can(sandboxed, 'apply_merge', ctx({ inSandbox: true })), 'ask');
  });

  test('fully agentic allows within scope', () => {
    for (const capability of CAPABILITIES) {
      assert.equal(can(agent({ level: 'agentic' }), capability, ctx({ inSandbox: true })), 'allow', capability);
    }
  });

  test('generated code never runs outside the sandbox, whatever the level or override', () => {
    for (const level of LEVELS) {
      const bold = agent({ level, overrides: { run_generated_code: 'allow' } });
      assert.deepEqual(decide(bold, 'run_generated_code', ctx()), { decision: 'deny', reason: 'outside_sandbox' });
    }
  });

  test('scopes are hard limits', () => {
    const scoped = agent({ level: 'agentic', scopes: { read: { projects: ['a'], sources: ['github'] }, write: { projects: [] } } });
    assert.equal(can(scoped, 'read_graph', { project: 'a', source: 'github' }), 'allow');
    assert.equal(can(scoped, 'read_graph', { project: 'b' }), 'deny');
    assert.equal(can(scoped, 'read_graph', { project: 'a', source: 'zotero' }), 'deny');
    assert.equal(decide(scoped, 'write_notes', { project: 'a' }).reason, 'outside_write_scope');
    assert.equal(can(agent({ level: 'agentic', overrides: { open_pr: 'allow' }, scopes: scoped.scopes }), 'open_pr', { project: 'a' }), 'deny');
  });

  test('offline, local-only and private context keep work on the machine', () => {
    assert.equal(decide(agent({ level: 'agentic' }), 'web', ctx({ online: false })).reason, 'offline');
    assert.equal(decide(agent({ level: 'agentic', modelPolicy: 'local_only' }), 'cloud_model', ctx()).reason, 'local_only_policy');
    assert.equal(decide(agent({ level: 'agentic', overrides: { cloud_model: 'allow' } }), 'cloud_model', ctx({ privateContext: true })).reason, 'private_context');
  });

  test('a context field left out never widens access', () => {
    const bold = agent({ level: 'agentic', overrides: { web: 'allow', cloud_model: 'allow' } });
    assert.equal(decide(bold, 'web', { project: 'p' }).reason, 'offline');
    assert.equal(decide(bold, 'cloud_model', { project: 'p', online: true }).reason, 'private_context');
    assert.equal(decide(agent({ state: undefined }), 'read_graph', ctx()).reason, 'agent_inactive');
    const someSources = agent({ scopes: { read: { projects: ['*'], sources: ['github'] }, write: { projects: [] } } });
    assert.equal(decide(someSources, 'read_graph', ctx()).reason, 'outside_read_scope');
    assert.equal(can(someSources, 'read_graph', ctx({ source: 'github' })), 'allow');
  });

  test('inReadScope filters nodes for retrieval', () => {
    const scoped = agent({ scopes: { read: { projects: ['a'], sources: ['github'] }, write: { projects: [] } } });
    assert.equal(inReadScope(scoped, { project: 'a', source: 'github' }), true);
    assert.equal(inReadScope(scoped, { project: 'a', source: 'zotero' }), false);
    assert.equal(inReadScope(scoped, { project: 'b', source: 'github' }), false);
    assert.equal(inReadScope(agent(), { project: 'anything' }), true);
  });

  test('running a script needs the project in the write scope', () => {
    const readOnly = agent({ level: 'agentic', scopes: { read: { projects: ['*'], sources: ['*'] }, write: { projects: [] } } });
    assert.equal(decide(readOnly, 'run_scripts', ctx()).reason, 'outside_write_scope');
  });

  test('the kill switch and pause deny everything', () => {
    assert.equal(can(agent({ state: 'killed' }), 'read_graph', ctx()), 'deny');
    assert.equal(can(agent({ state: 'paused' }), 'read_graph', ctx()), 'deny');
  });

  test('overrides replace the level default in either direction', () => {
    assert.equal(can(agent({ overrides: { web: 'allow' } }), 'web', ctx()), 'allow');
    assert.equal(can(agent({ level: 'agentic', overrides: { apply_merge: 'ask' } }), 'apply_merge', ctx()), 'ask');
    assert.equal(can(agent({ overrides: { read_graph: 'deny' } }), 'read_graph', ctx()), 'deny');
    // A malformed override is ignored rather than trusted.
    assert.equal(can(agent({ overrides: { web: 'yes' } }), 'web', ctx()), 'ask');
  });

  test('unknown capabilities and missing agents are denied', () => {
    assert.equal(can(agent({ level: 'agentic' }), 'format_disk', ctx()), 'deny');
    assert.equal(can(null, 'read_graph', {}), 'deny');
  });
});

describe('capability registry', () => {
  beforeEach(resetRegistry);
  const run = async () => ({ output: 'ok' });

  test('registers capabilities and verifiers and selects them by tag', () => {
    registerPlugin({
      name: 'code',
      capabilities: [{ name: 'code.search', tags: ['code'], permission: 'read_graph', input: { type: 'object' }, verifiers: ['code.tests'], run }],
      verifiers: [{ name: 'code.tests', tags: ['code'], verify: async () => ({ ok: true }) }],
    });
    assert.deepEqual(listPlugins(), ['code']);
    assert.equal(getCapability('code.search').plugin, 'code');
    assert.ok(getVerifier('code.tests'));
    assert.deepEqual(capabilitiesForTags(['graph', 'code']).map((entry) => entry.name), ['code.search']);
    assert.deepEqual(capabilitiesForTags(['kicad']), []);
  });

  test('refuses bad declarations and leaves the registry unchanged', () => {
    const bad = [
      { name: 'x', capabilities: [{ name: 'nope', tags: ['x'], permission: 'read_graph', input: { type: 'object' }, run }] },
      { name: 'x', capabilities: [{ name: 'x.a', tags: [], permission: 'read_graph', input: { type: 'object' }, run }] },
      { name: 'x', capabilities: [{ name: 'x.a', tags: ['x'], permission: 'root', input: { type: 'object' }, run }] },
      { name: 'x', capabilities: [{ name: 'x.a', tags: ['x'], permission: 'read_graph', run }] },
      { name: 'x', capabilities: [{ name: 'x.a', tags: ['x'], permission: 'read_graph', input: { type: 'object' } }] },
      { name: 'x', capabilities: [{ name: 'x.a', tags: ['x'], permission: 'read_graph', input: { type: 'object' }, verifiers: ['x.missing'], run }] },
      { name: 'x', capabilities: [
        { name: 'x.a', tags: ['x'], permission: 'read_graph', input: { type: 'object' }, run },
        { name: 'x.a', tags: ['x'], permission: 'read_graph', input: { type: 'object' }, run },
      ] },
      { name: 'Bad Name' },
    ];
    for (const plugin of bad) assert.throws(() => registerPlugin(plugin));
    assert.deepEqual(listPlugins(), []);
    assert.equal(getCapability('x.a'), null);
  });

  test('a plug-in registers once', () => {
    registerPlugin({ name: 'once' });
    assert.throws(() => registerPlugin({ name: 'once' }), /already registered/);
  });
});

describe('selectAdapter', () => {
  test('execution steps stay local; the cloud is for planning and hard steps', () => {
    assert.equal(selectAdapter({ policy: 'local_cloud', plan: 'engineer', purpose: 'step' }).adapter, 'local');
    assert.equal(selectAdapter({ policy: 'local_cloud', plan: 'engineer', purpose: 'plan' }).adapter, 'platform');
    assert.equal(selectAdapter({ policy: 'local_cloud', plan: 'student', hard: true }).adapter, 'platform');
  });

  test('privacy, offline and local-only outrank the plan', () => {
    const base = { policy: 'local_cloud', plan: 'engineer', purpose: 'plan' };
    assert.deepEqual(selectAdapter({ ...base, privateContext: true }), { adapter: 'local', reason: 'private_context' });
    assert.deepEqual(selectAdapter({ ...base, online: false }), { adapter: 'local', reason: 'offline' });
    assert.deepEqual(selectAdapter({ ...base, policy: 'local_only' }), { adapter: 'local', reason: 'policy' });
  });

  test('own key is Key Pro with a key, never the platform', () => {
    assert.equal(selectAdapter({ policy: 'own_key', plan: 'key_pro', hasOwnKey: true, purpose: 'plan' }).adapter, 'own_key');
    assert.equal(selectAdapter({ policy: 'own_key', plan: 'key_pro', hasOwnKey: false, purpose: 'plan' }).reason, 'no_key');
    assert.equal(selectAdapter({ policy: 'own_key', plan: 'engineer', hasOwnKey: true, purpose: 'plan' }).adapter, 'local');
    assert.equal(selectAdapter({ policy: 'local_cloud', plan: 'key_pro', hasOwnKey: true, purpose: 'plan' }).adapter, 'own_key');
    assert.equal(selectAdapter({ policy: 'local_cloud', plan: 'free', purpose: 'plan' }).adapter, 'local');
  });
});

describe('model adapters share one stream shape', () => {
  async function collect(port) {
    const out = [];
    for await (const event of port.stream({ messages: [{ role: 'user', content: 'hi' }] })) out.push(event);
    return out;
  }

  test('local yields text then done at zero cost', async () => {
    const stream = async function* () {
      yield { message: { content: 'a' } };
      yield { message: { content: 'b' }, done: true, prompt_eval_count: 3, eval_count: 2 };
    };
    const events = await collect(localAdapter({ model: 'm', stream }));
    assert.deepEqual(events, [{ text: 'a' }, { text: 'b' }, { done: true, usage: { input_tokens: 3, output_tokens: 2 }, costUsd: 0, model: 'm' }]);
  });

  test('own key prices the usage and refuses to start without a key', async () => {
    const stream = async function* () {
      yield { text: 'x' };
      yield { done: true, usage: { input_tokens: 1000, output_tokens: 1000 } };
    };
    const events = await collect(ownKeyAdapter({ apiKey: 'test-key-not-real', model: 'claude-sonnet-5', stream }));
    assert.equal(events[0].text, 'x');
    assert.ok(events[1].done && events[1].costUsd > 0);
    assert.throws(() => ownKeyAdapter({ apiKey: '', model: 'm', stream }));
  });

  test('platform refuses cleanly until it is connected', async () => {
    await assert.rejects(collect(platformAdapter()), (err) => err.code === 'platform_unavailable');
  });
});

describe('event bus', () => {
  const bus = () => createEventBus({ now: () => new Date('2026-01-01T00:00:00Z'), boot: 'b1' });

  test('replays after Last-Event-ID for one run and isolates owners', () => {
    const events = bus();
    const first = events.publish({ runId: 'r1', agentId: 'a', ownerId: 'u1', type: 'run.started' });
    events.publish({ runId: 'r2', agentId: 'a', ownerId: 'u1', type: 'run.started' });
    events.publish({ runId: 'r1', agentId: 'a', ownerId: 'u1', type: 'step.started', data: { index: 0 } });
    assert.equal(first.id, 'b1-1');

    const seen = [];
    const stop = events.subscribe({ ownerId: 'u1', runId: 'r1', lastEventId: first.id }, (event) => seen.push(event));
    const other = [];
    events.subscribe({ ownerId: 'u2' }, (event) => other.push(event));
    events.publish({ runId: 'r1', agentId: 'a', ownerId: 'u1', type: 'run.finished', data: { status: 'succeeded' } });
    stop();
    events.publish({ runId: 'r1', agentId: 'a', ownerId: 'u1', type: 'cost', data: { usd: 0 } });

    assert.deepEqual(seen.map((event) => [event.id, event.type]), [['b1-3', 'step.started'], ['b1-4', 'run.finished']]);
    assert.deepEqual(other, []);
    assert.throws(() => events.publish({ runId: 'r1', ownerId: 'u1', type: 'made.up' }));
  });

  test('a stream of every run resumes too, and an id from another boot replays the buffer', () => {
    const events = bus();
    const a = events.publish({ runId: 'r1', ownerId: 'u1', type: 'run.started' });
    events.publish({ runId: 'r2', ownerId: 'u1', type: 'run.started' });
    const resumed = [];
    events.subscribe({ ownerId: 'u1', lastEventId: a.id }, (event) => resumed.push(event.runId));
    assert.deepEqual(resumed, ['r2']);
    const fromOldBoot = [];
    events.subscribe({ ownerId: 'u1', lastEventId: 'old-99' }, (event) => fromOldBoot.push(event.runId));
    assert.deepEqual(fromOldBoot, ['r1', 'r2']);
  });

  test('a subscriber that throws is dropped and never fails the publisher', () => {
    const events = bus();
    let calls = 0;
    events.subscribe({ ownerId: 'u1' }, () => {
      calls += 1;
      throw new Error('socket gone');
    });
    events.publish({ runId: 'r1', ownerId: 'u1', type: 'run.started' });
    events.publish({ runId: 'r1', ownerId: 'u1', type: 'run.finished' });
    assert.equal(calls, 1);
  });

  test('the replay buffer is bounded', () => {
    const events = createEventBus({ boot: 'b', replay: 2 });
    for (let i = 0; i < 5; i++) events.publish({ runId: 'r', ownerId: 'u', type: 'cost' });
    const replayed = [];
    events.subscribe({ ownerId: 'u' }, (event) => replayed.push(event.seq));
    assert.deepEqual(replayed, [4, 5]);
  });

  test('formats one SSE frame per event', () => {
    const frame = formatSse({ v: 1, id: 'b1-7', seq: 7, runId: 'r', type: 'cost', data: {} });
    assert.match(frame, /^id: b1-7\nevent: cost\ndata: \{.*\}\n\n$/);
  });
});

describe('write-back helpers', () => {
  test('privacy is inherited from any private source', () => {
    assert.equal(inheritPrivacy([{ privacy: 'cloud' }, { privacy: 'local' }]), 'local');
    assert.equal(inheritPrivacy([{ privacy: 'cloud' }]), 'cloud');
    assert.equal(inheritPrivacy([]), 'cloud');
  });

  test('every role template names tags and resolves by key', () => {
    assert.equal(ROLE_TEMPLATES.length, 6);
    for (const role of ROLE_TEMPLATES) assert.ok(role.tags.includes('graph'), role.template);
    assert.equal(roleTemplate('builder').title, 'Builder');
    assert.equal(roleTemplate('nope'), null);
  });
});
