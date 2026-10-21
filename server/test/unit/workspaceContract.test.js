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
import { CAPABILITIES, LEVELS, can, decide } from '../../src/workspace/permissions.js';
import { ROLE_TEMPLATES, roleTemplate } from '../../src/workspace/roles.js';

const everywhere = { read: { projects: ['*'], sources: ['*'] }, write: { projects: ['*'] } };
const agent = (fields = {}) => ({ level: 'supervised', state: 'active', modelPolicy: 'local_cloud', scopes: everywhere, overrides: {}, ...fields });

describe('can(): the permission spectrum', () => {
  test('a supervised agent reads and writes notes freely and asks for everything else', () => {
    const supervised = agent();
    assert.equal(can(supervised, 'read_graph', { project: 'p' }), 'allow');
    assert.equal(can(supervised, 'write_notes', { project: 'p' }), 'allow');
    for (const capability of ['edit_files', 'run_scripts', 'web', 'cloud_model', 'open_pr', 'apply_merge']) {
      assert.equal(can(supervised, capability, { project: 'p' }), 'ask', capability);
    }
  });

  test('manual asks for every capability', () => {
    for (const capability of CAPABILITIES) {
      assert.equal(can(agent({ level: 'manual' }), capability, { project: 'p', inSandbox: true }), 'ask', capability);
    }
  });

  test('sandboxed works freely inside its sandbox and asks outside it', () => {
    const sandboxed = agent({ level: 'sandboxed' });
    assert.equal(can(sandboxed, 'edit_files', { project: 'p', inSandbox: true }), 'allow');
    assert.equal(can(sandboxed, 'edit_files', { project: 'p', inSandbox: false }), 'ask');
    assert.equal(can(sandboxed, 'run_generated_code', { project: 'p', inSandbox: true }), 'allow');
    assert.equal(can(sandboxed, 'apply_merge', { project: 'p', inSandbox: true }), 'ask');
  });

  test('fully agentic allows within scope', () => {
    for (const capability of CAPABILITIES) {
      assert.equal(can(agent({ level: 'agentic' }), capability, { project: 'p', inSandbox: true }), 'allow', capability);
    }
  });

  test('generated code never runs outside the sandbox, whatever the level or override', () => {
    for (const level of LEVELS) {
      const bold = agent({ level, overrides: { run_generated_code: 'allow' } });
      assert.deepEqual(decide(bold, 'run_generated_code', { project: 'p' }), { decision: 'deny', reason: 'outside_sandbox' });
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
    assert.equal(decide(agent({ level: 'agentic' }), 'web', { project: 'p', online: false }).reason, 'offline');
    assert.equal(decide(agent({ level: 'agentic', modelPolicy: 'local_only' }), 'cloud_model', { project: 'p' }).reason, 'local_only_policy');
    assert.equal(decide(agent({ level: 'agentic', overrides: { cloud_model: 'allow' } }), 'cloud_model', { project: 'p', privateContext: true }).reason, 'private_context');
  });

  test('the kill switch and pause deny everything', () => {
    assert.equal(can(agent({ state: 'killed' }), 'read_graph', { project: 'p' }), 'deny');
    assert.equal(can(agent({ state: 'paused' }), 'read_graph', { project: 'p' }), 'deny');
  });

  test('overrides replace the level default in either direction', () => {
    assert.equal(can(agent({ overrides: { web: 'allow' } }), 'web', { project: 'p' }), 'allow');
    assert.equal(can(agent({ level: 'agentic', overrides: { apply_merge: 'ask' } }), 'apply_merge', { project: 'p' }), 'ask');
    assert.equal(can(agent({ overrides: { read_graph: 'deny' } }), 'read_graph', { project: 'p' }), 'deny');
    // A malformed override is ignored rather than trusted.
    assert.equal(can(agent({ overrides: { web: 'yes' } }), 'web', { project: 'p' }), 'ask');
  });

  test('unknown capabilities and missing agents are denied', () => {
    assert.equal(can(agent({ level: 'agentic' }), 'format_disk', { project: 'p' }), 'deny');
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
  test('sequences per run, replays after Last-Event-ID, and isolates owners', () => {
    const bus = createEventBus({ now: () => new Date('2026-01-01T00:00:00Z') });
    bus.publish({ runId: 'r1', agentId: 'a', ownerId: 'u1', type: 'run.started' });
    bus.publish({ runId: 'r1', agentId: 'a', ownerId: 'u1', type: 'step.started', data: { index: 0 } });

    const seen = [];
    const stop = bus.subscribe({ ownerId: 'u1', runId: 'r1', afterSeq: 1 }, (event) => seen.push(event));
    const other = [];
    bus.subscribe({ ownerId: 'u2' }, (event) => other.push(event));
    bus.publish({ runId: 'r1', agentId: 'a', ownerId: 'u1', type: 'run.finished', data: { status: 'succeeded' } });
    stop();
    bus.publish({ runId: 'r1', agentId: 'a', ownerId: 'u1', type: 'cost', data: { usd: 0 } });

    assert.deepEqual(seen.map((event) => [event.seq, event.type]), [[2, 'step.started'], [3, 'run.finished']]);
    assert.deepEqual(other, []);
    assert.throws(() => bus.publish({ runId: 'r1', ownerId: 'u1', type: 'made.up' }));
  });

  test('formats one SSE frame per event', () => {
    const frame = formatSse({ v: 1, seq: 7, runId: 'r', type: 'cost', data: {} });
    assert.match(frame, /^id: 7\nevent: cost\ndata: \{.*\}\n\n$/);
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
