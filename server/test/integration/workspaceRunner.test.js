import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { listPlugins, registerPlugin } from '../../src/workspace/capabilities.js';
import { createEventBus } from '../../src/workspace/events.js';
import { createWorker } from '../../src/workspace/runner/index.js';
import { SLICE_TOKENS } from '../../src/workspace/runner/slice.js';
import { createFakeModelPort, platformUnavailable } from '../fakeModelPort.js';
import { registeredSession, startServer } from '../helpers.js';

const PROJECT = 'fixture-repo';

// What the test-only plug-in did, so a test can prove a finished step was
// never repeated after a crash.
const invocations = { list: 0, count: 0, block: 0, flaky: 0, think: 0 };
// The block capability waits on this gate; a test opens it, or never does.
const gate = { open: null, entered: null, signal: null, blocking: true };

function resetGate() {
  gate.blocking = true;
  gate.signal = null;
  gate.entered = new Promise((resolveEntered) => {
    gate.notifyEntered = resolveEntered;
  });
  gate.released = new Promise((resolveReleased) => {
    gate.open = resolveReleased;
  });
}

function inside(root, file) {
  const path = resolve(root, file);
  if (path !== root && !path.startsWith(root + sep)) throw new Error('outside the working copy');
  return path;
}

const fixturePlugin = {
  name: 'fixture',
  capabilities: [
    {
      name: 'fixture.list_files',
      tags: ['fixture'],
      permission: 'read_graph',
      source: 'fixture',
      input: { type: 'object', properties: {} },
      verifiers: ['fixture.nonempty'],
      async run(input, ctx) {
        invocations.list += 1;
        const files = (await readdir(ctx.localPath)).sort();
        return { output: { files }, findings: [`The fixture repo holds ${files.length} files: ${files.join(', ')}`] };
      },
    },
    {
      name: 'fixture.count_lines',
      tags: ['fixture'],
      permission: 'run_scripts',
      input: { type: 'object', required: ['file'], properties: { file: { type: 'string' } } },
      verifiers: ['fixture.counted'],
      async run(input, ctx) {
        invocations.count += 1;
        const text = await readFile(inside(ctx.localPath, input.file), 'utf8');
        const lines = text.split('\n').filter(Boolean).length;
        return { output: { file: input.file, lines }, findings: [{ content: `${input.file} has ${lines} lines` }], artifacts: [{ name: 'line-count.csv', content: `file,lines\n${input.file},${lines}` }] };
      },
    },
    {
      name: 'fixture.block',
      tags: ['fixture'],
      permission: 'read_graph',
      source: 'fixture',
      input: { type: 'object', properties: {} },
      async run(input, ctx) {
        invocations.block += 1;
        gate.signal = ctx.signal;
        gate.notifyEntered();
        if (gate.blocking) await gate.released;
        return { output: 'unblocked', findings: ['The block step finished'] };
      },
    },
    {
      name: 'fixture.flaky',
      tags: ['fixture'],
      permission: 'read_graph',
      source: 'fixture',
      input: { type: 'object', properties: {} },
      verifiers: ['fixture.nonempty'],
      async run() {
        invocations.flaky += 1;
        return { output: '', findings: ['this must never be written'] };
      },
    },
    {
      name: 'fixture.explode',
      tags: ['fixture'],
      permission: 'read_graph',
      source: 'fixture',
      input: { type: 'object', properties: {} },
      async run() {
        throw new Error(`exploded ${'x'.repeat(5000)} END-OF-TRACE`);
      },
    },
    {
      name: 'fixture.think',
      tags: ['fixture'],
      permission: 'read_graph',
      source: 'fixture',
      input: { type: 'object', properties: {} },
      async run(input, ctx) {
        invocations.think += 1;
        let text = '';
        for await (const chunk of ctx.model.stream({ messages: [{ role: 'user', content: 'think hard' }], signal: ctx.signal })) {
          if (chunk.text) text += chunk.text;
        }
        return { output: text };
      },
    },
  ],
  verifiers: [
    { name: 'fixture.nonempty', tags: ['fixture'], async verify(result) { const empty = result.output == null || result.output === '' ; return { ok: !empty, detail: empty ? 'empty output' : 'has output' }; } },
    { name: 'fixture.counted', tags: ['fixture'], async verify(result) { return { ok: Number.isInteger(result.output?.lines), detail: `lines=${result.output?.lines}` }; } },
  ],
};

const plan = '1. List the files\n2. Count lines in a.js\n3. Finish';
const choose = (capability, input = {}, extra = {}) => ({ capability, input, summary: `use ${capability}`, ...extra });
const done = { done: true, summary: 'all counted' };

describe('agent runner', () => {
  let server;
  let ownerId;
  let workdir;
  let bus;
  let events;
  let local;
  let platform;
  const workers = [];

  async function makeAgent({ level = 'agentic', overrides = {}, modelPolicy = 'local_only', budget = {}, sources = ['*'] } = {}) {
    const { rows } = await server.pool.query(
      `INSERT INTO agents (owner_id, name, role, level, overrides, scopes, model_policy, budget)
       VALUES ($1, 'Fixture agent', $2, $3, $4, $5, $6, $7) RETURNING id`,
      [
        ownerId,
        { template: null, title: 'Counter', description: '', embodiment: 'You count lines carefully.', tags: ['fixture'] },
        level,
        overrides,
        { read: { projects: [PROJECT], sources }, write: { projects: [PROJECT] } },
        modelPolicy,
        budget,
      ]
    );
    return rows[0].id;
  }

  async function makeRun(agentId, { instructions = 'Count the lines of the fixture repo files', budget = {} } = {}) {
    const { rows } = await server.pool.query(
      'INSERT INTO agent_runs (owner_id, agent_id, instructions, project, budget) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [ownerId, agentId, instructions, PROJECT, budget]
    );
    return rows[0].id;
  }

  function worker(options = {}) {
    const instance = createWorker({ adapters: { local, platform }, events: bus, embed: false, leaseMs: 30_000, heartbeatMs: 25, ...options });
    workers.push(instance);
    return instance;
  }

  async function runRow(runId) {
    return (await server.pool.query('SELECT * FROM agent_runs WHERE id = $1', [runId])).rows[0];
  }

  async function steps(runId) {
    return (await server.pool.query('SELECT * FROM agent_run_steps WHERE run_id = $1 ORDER BY index', [runId])).rows;
  }

  async function nodesOf(runId) {
    const { rows } = await server.pool.query(
      `SELECT n.id, n.type, n.content, n.source, n.project, n.privacy, n.owner_id
       FROM nodes n WHERE n.id IN (SELECT unnest(node_ids) FROM agent_run_steps WHERE run_id = $1)`,
      [runId]
    );
    return rows;
  }

  async function edges(ids) {
    const { rows } = await server.pool.query('SELECT source_id, target_id, type FROM node_relationships WHERE source_id = ANY($1)', [ids]);
    return rows;
  }

  const typesFor = (runId) => events.filter((event) => event.runId === runId).map((event) => event.type);

  before(async () => {
    server = await startServer();
    const api = await registeredSession(server.base);
    ({ data: { userId: ownerId } } = await api('GET', '/api/auth/session'));
    if (!listPlugins().includes('fixture')) registerPlugin(fixturePlugin);

    workdir = await mkdtemp(join(tmpdir(), 'scope-runner-'));
    await writeFile(join(workdir, 'a.js'), 'const a = 1;\nconst b = 2;\nexport default a + b;\n');
    await writeFile(join(workdir, 'b.js'), 'export const answer = 42;\n');
    await server.pool.query('INSERT INTO project_settings (owner_id, project, local_path) VALUES ($1, $2, $3)', [ownerId, PROJECT, workdir]);
  });

  beforeEach(async () => {
    for (const instance of workers.splice(0)) instance.abandon();
    await server.pool.query("UPDATE agent_runs SET status = 'killed' WHERE status IN ('queued', 'running', 'waiting_approval', 'paused')");
    await server.pool.query("UPDATE users SET plan = 'free' WHERE id = $1", [ownerId]);
    // Anything private (and everything learned from it) would keep later runs
    // local, so each test starts without it.
    await server.pool.query("DELETE FROM nodes WHERE privacy = 'local'");
    for (const key of Object.keys(invocations)) invocations[key] = 0;
    resetGate();
    bus = createEventBus();
    events = [];
    bus.subscribe({ ownerId }, (event) => events.push(event));
    local = createFakeModelPort({ name: 'local' });
    platform = createFakeModelPort({ name: 'platform', usage: { input_tokens: 1000, output_tokens: 100 }, costUsd: 0.01 });
  });

  after(async () => {
    for (const instance of workers.splice(0)) instance.abandon();
    await server.close();
  });

  test('a multi-step run plans, acts, verifies and writes its memory into the graph', async () => {
    const agentId = await makeAgent();
    const runId = await makeRun(agentId);
    local.push(plan, choose('fixture.list_files'), choose('fixture.count_lines', { file: 'a.js' }), done);

    const [result] = await worker().drain();
    assert.deepEqual(result, { runId, outcome: 'finished' });

    const run = await runRow(runId);
    assert.equal(run.status, 'succeeded');
    assert.ok(run.finished_at);
    assert.equal(run.step_index, 4);
    assert.equal(run.lease_owner, null);

    const rows = await steps(runId);
    assert.deepEqual(rows.map((step) => [step.index, step.kind, step.capability, step.status]), [
      [0, 'plan', null, 'done'],
      [1, 'act', 'fixture.list_files', 'done'],
      [2, 'act', 'fixture.count_lines', 'done'],
      [3, 'act', null, 'done'],
    ]);
    assert.deepEqual(rows[2].input, { file: 'a.js' });
    assert.deepEqual(rows[2].output, { file: 'a.js', lines: 3 });
    assert.deepEqual(rows[2].verification.map((entry) => [entry.verifier, entry.ok]), [['result.schema', true], ['fixture.counted', true]]);
    assert.ok(rows.every((step) => step.adapter === 'local'));
    assert.deepEqual(invocations, { list: 1, count: 1, block: 0, flaky: 0, think: 0 });

    // The graph: one plan, a step node per action, and the notes they produced.
    const nodes = await nodesOf(runId);
    const byType = (type) => nodes.filter((node) => node.type === type);
    assert.equal(byType('plan').length, 1);
    assert.equal(run.plan_node_id, byType('plan')[0].id);
    assert.equal(byType('step').length, 3);
    assert.equal(byType('finding').length, 2);
    assert.equal(byType('artifact').length, 1);
    assert.match(byType('artifact')[0].content, /line-count\.csv\n\nfile,lines\na\.js,3/);
    assert.ok(nodes.every((node) => node.source === 'agent' && node.project === PROJECT && node.owner_id === ownerId && node.privacy === 'cloud'));

    const links = await edges(nodes.map((node) => node.id));
    const count = (type) => links.filter((link) => link.type === type).length;
    assert.equal(count('part_of'), 3, 'every step is part of the plan');
    assert.equal(count('follows'), 2, 'each step follows the previous one');
    assert.equal(count('produces'), 3, 'steps produce their notes');
    assert.ok(count('derived_from') >= 3, 'notes are derived from the slice they were read from');
    const planId = run.plan_node_id;
    assert.ok(links.filter((link) => link.type === 'part_of').every((link) => link.target_id === planId));

    // Step 2's chooser read step 1's finding from the graph, not a transcript.
    const chooserCalls = local.calls.filter((call) => call.format === 'json');
    assert.equal(chooserCalls.length, 3);
    assert.match(chooserCalls[1].messages[1].content, /The fixture repo holds 2 files: a\.js, b\.js/);
    assert.match(chooserCalls[0].messages[1].content, /Count lines in a\.js/, 'the plan is in the slice');
    assert.equal(local.calls[0].purpose, 'plan');

    // Costs: one ledger row per model call, and the run's totals from it.
    const { rows: costs } = await server.pool.query('SELECT purpose, adapter, input_tokens, output_tokens, usd FROM agent_run_costs WHERE run_id = $1', [runId]);
    assert.equal(costs.length, 4);
    assert.ok(costs.every((cost) => cost.adapter === 'local' && Number(cost.usd) === 0));
    assert.equal(run.tokens_used, 4 * 120);
    assert.equal(rows[1].tokens, 120);

    // Events for every transition.
    const types = typesFor(runId);
    assert.equal(types[0], 'run.started');
    assert.equal(types.at(-1), 'run.finished');
    assert.deepEqual(events.filter((event) => event.type === 'run.finished').map((event) => event.data), [{ status: 'succeeded' }]);
    for (const type of ['step.started', 'step.verified', 'step.output', 'node.written', 'step.finished', 'cost']) assert.ok(types.includes(type), type);
    assert.equal(types.filter((type) => type === 'node.written').length, nodes.length);
    assert.equal(types.filter((type) => type === 'cost').length, 4);
  });

  test('a crash mid-run resumes from the last checkpoint and never repeats a finished step', async () => {
    const agentId = await makeAgent();
    const runId = await makeRun(agentId);
    local.push(plan, choose('fixture.list_files'), choose('fixture.block'));

    const first = worker();
    first.runNext(); // Never settles: the worker "dies" inside step 2.
    await gate.entered;
    first.abandon();
    assert.equal((await runRow(runId)).status, 'running');
    assert.equal((await runRow(runId)).step_index, 2);

    // A fresh worker cannot take the run while the dead one's lease holds.
    const second = worker();
    assert.equal(await second.runNext(), null);

    await server.pool.query("UPDATE agent_runs SET lease_until = now() - interval '1 second' WHERE id = $1", [runId]);
    gate.blocking = false;
    local.push(choose('fixture.block'), done);
    const result = await second.runNext();
    assert.deepEqual(result, { runId, outcome: 'finished' });

    const run = await runRow(runId);
    assert.equal(run.status, 'succeeded');
    assert.equal(run.attempts, 0, 'progress resets the attempt count');
    // The plan and the list step ran once; only the step in flight was redone.
    assert.equal(local.calls.filter((call) => call.purpose === 'plan').length, 1);
    assert.equal(invocations.list, 1);
    assert.equal(invocations.block, 2);
    const rows = await steps(runId);
    assert.deepEqual(rows.map((step) => [step.index, step.capability, step.status]), [
      [0, null, 'done'],
      [1, 'fixture.list_files', 'done'],
      [2, 'fixture.block', 'done'],
      [3, null, 'done'],
    ]);
    const nodes = await nodesOf(runId);
    assert.equal(nodes.filter((node) => node.type === 'plan').length, 1);
    assert.equal(nodes.filter((node) => node.type === 'step').length, 3);
    // The ledger keeps what the lost attempt spent on the redone step.
    const { rows: [{ count }] } = await server.pool.query('SELECT count(*)::int AS count FROM agent_run_costs WHERE run_id = $1', [runId]);
    assert.equal(count, 5);
    assert.ok(typesFor(runId).includes('run.resumed'));
  });

  test('a run that keeps losing its worker is failed after three attempts', async () => {
    const agentId = await makeAgent();
    const runId = await makeRun(agentId);
    await server.pool.query("UPDATE agent_runs SET status = 'running', attempts = 3, lease_owner = 'dead', lease_until = now() - interval '1 second', started_at = now() WHERE id = $1", [runId]);
    const [result] = await worker().drain();
    assert.deepEqual(result, { runId, outcome: 'failed' });
    const run = await runRow(runId);
    assert.equal(run.status, 'failed');
    assert.equal(run.error, 'too_many_attempts');
    assert.equal(local.calls.length, 0);
  });

  test('ask parks the step; a re-queue finds the same approval; approval resumes it', async () => {
    const agentId = await makeAgent({ level: 'supervised' });
    const runId = await makeRun(agentId);
    local.push(plan, choose('fixture.count_lines', { file: 'a.js' }));
    const instance = worker();

    assert.deepEqual(await instance.drain(), [{ runId, outcome: 'parked' }]);
    let run = await runRow(runId);
    assert.equal(run.status, 'waiting_approval');
    assert.equal(run.lease_owner, null);
    const parked = (await steps(runId))[1];
    assert.equal(parked.status, 'waiting_approval');
    assert.equal(invocations.count, 0);
    const approvals = async () => (await server.pool.query('SELECT id, step_id, capability, status, summary, detail FROM agent_approvals WHERE run_id = $1', [runId])).rows;
    let [approval] = await approvals();
    assert.equal(approval.step_id, parked.id);
    assert.equal(approval.capability, 'fixture.count_lines');
    assert.equal(approval.detail.permission, 'run_scripts');
    assert.ok(events.some((event) => event.type === 'approval.requested' && event.data.approvalId === approval.id));

    // Paused and resumed by the agents API while still pending: parked again,
    // with the same approval and without asking the model again.
    const callsBefore = local.calls.length;
    await server.pool.query("UPDATE agent_runs SET status = 'queued' WHERE id = $1", [runId]);
    assert.deepEqual(await instance.drain(), [{ runId, outcome: 'parked' }]);
    assert.equal((await approvals()).length, 1);
    assert.equal(local.calls.length, callsBefore);
    assert.equal((await runRow(runId)).status, 'waiting_approval');

    // Approved: the approvals API re-queues the run and the step runs as chosen.
    await server.pool.query("UPDATE agent_approvals SET status = 'approved', resolved_at = now() WHERE id = $1", [approval.id]);
    await server.pool.query("UPDATE agent_runs SET status = 'queued' WHERE id = $1", [runId]);
    local.push(done);
    assert.deepEqual(await instance.drain(), [{ runId, outcome: 'finished' }]);
    run = await runRow(runId);
    assert.equal(run.status, 'succeeded');
    assert.equal(invocations.count, 1);
    const rows = await steps(runId);
    assert.equal(rows[1].status, 'done');
    assert.deepEqual(rows[1].output, { file: 'a.js', lines: 3 });
    [approval] = await approvals();
    assert.equal(approval.status, 'approved');
  });

  test('a rejected step is recorded and the run continues without it', async () => {
    const agentId = await makeAgent({ level: 'supervised' });
    const runId = await makeRun(agentId);
    local.push(plan, choose('fixture.count_lines', { file: 'a.js' }));
    const instance = worker();
    await instance.drain();
    await server.pool.query("UPDATE agent_approvals SET status = 'rejected', resolved_at = now() WHERE run_id = $1", [runId]);
    await server.pool.query("UPDATE agent_runs SET status = 'queued' WHERE id = $1", [runId]);
    local.push(choose('fixture.list_files'), done);
    await instance.drain();

    assert.equal((await runRow(runId)).status, 'succeeded');
    assert.equal(invocations.count, 0, 'a rejected capability never runs');
    assert.equal(invocations.list, 1);
    const rows = await steps(runId);
    assert.deepEqual(rows.map((step) => step.status), ['done', 'rejected', 'done', 'done']);
    const [rejectedNode] = (await server.pool.query('SELECT content FROM nodes WHERE id = $1', [rows[1].node_ids[0]])).rows;
    assert.match(rejectedNode.content, /rejected/);
    // The next chooser saw the rejection in its slice.
    const chooserCalls = local.calls.filter((call) => call.format === 'json');
    assert.match(chooserCalls[1].messages[1].content, /the user rejected this step/);
  });

  test('deny fails the step with its reason and runs nothing', async () => {
    const agentId = await makeAgent({ level: 'agentic', overrides: { run_scripts: 'deny' } });
    const runId = await makeRun(agentId);
    local.push(plan, choose('fixture.count_lines', { file: 'a.js' }), done);
    await worker().drain();
    assert.equal(invocations.count, 0);
    const rows = await steps(runId);
    assert.equal(rows[1].status, 'failed');
    assert.equal(rows[1].error, 'denied: override');
    assert.equal((await runRow(runId)).status, 'succeeded');
  });

  test('bad chooser output, unknown capabilities, bad input and failed verification fail the step, not the run', async () => {
    const agentId = await makeAgent();
    const runId = await makeRun(agentId);
    local.push(
      plan,
      'I think we should list files.',
      choose('fixture.nope'),
      choose('fixture.count_lines', { file: 7 }),
      choose('fixture.flaky'),
      choose('fixture.list_files'),
      done
    );
    await worker().drain();
    const rows = await steps(runId);
    assert.deepEqual(rows.map((step) => [step.status, step.error]), [
      ['done', null],
      ['failed', 'chooser_not_json'],
      ['failed', 'unknown_capability: fixture.nope'],
      ['failed', 'invalid_input: input.file must be string'],
      ['failed', 'verification_failed'],
      ['done', null],
      ['done', null],
    ]);
    assert.equal(invocations.count, 0, 'invalid input never reaches the capability');
    // Failed verification writes a failed step node and no findings.
    assert.equal(rows[4].node_ids.length, 1);
    const [flakyStep] = (await server.pool.query('SELECT type, content FROM nodes WHERE id = $1', [rows[4].node_ids[0]])).rows;
    assert.equal(flakyStep.type, 'step');
    assert.match(flakyStep.content, /failed/);
    const { rows: never } = await server.pool.query("SELECT 1 FROM nodes WHERE content LIKE 'this must never be written%'");
    assert.equal(never.length, 0);
    assert.equal((await runRow(runId)).status, 'succeeded');
  });

  test('a long capability error is truncated in the step record and the step node', async () => {
    const agentId = await makeAgent();
    const runId = await makeRun(agentId);
    local.push(plan, choose('fixture.explode'), done);
    await worker().drain();
    const [, failed] = await steps(runId);
    assert.equal(failed.status, 'failed');
    assert.match(failed.error, /^capability_error: exploded x+/);
    assert.ok(failed.error.length <= 500, `error is ${failed.error.length} chars`);
    assert.doesNotMatch(failed.error, /END-OF-TRACE/);
    const [node] = (await server.pool.query('SELECT content FROM nodes WHERE id = $1', [failed.node_ids[0]])).rows;
    assert.match(node.content, /Reason: capability_error: exploded/);
    assert.doesNotMatch(node.content, /END-OF-TRACE/);
    assert.ok(node.content.length < 700, `step node is ${node.content.length} chars`);
  });

  test('a run that only fails is stopped after five failures in a row', async () => {
    const agentId = await makeAgent();
    const runId = await makeRun(agentId);
    local.push(plan);
    local.push(...Array.from({ length: 5 }, () => 'not json'));
    await worker().drain();
    const run = await runRow(runId);
    assert.equal(run.status, 'failed');
    assert.equal(run.error, 'too_many_failed_steps');
  });

  test('the kill switch aborts the step in flight and is never overwritten', async () => {
    const agentId = await makeAgent();
    const runId = await makeRun(agentId);
    local.push(plan, choose('fixture.block'));
    const instance = worker();
    const pending = instance.runNext();
    await gate.entered;

    await server.pool.query("UPDATE agent_runs SET status = 'killed', finished_at = now(), lease_owner = NULL, lease_until = NULL WHERE id = $1", [runId]);
    assert.deepEqual(await pending, { runId, outcome: 'killed' });
    assert.ok(gate.signal.aborted, 'the capability’s signal was aborted');

    const run = await runRow(runId);
    assert.equal(run.status, 'killed');
    const rows = await steps(runId);
    assert.equal(rows[1].status, 'failed');
    assert.equal(rows[1].error, 'killed');
    assert.ok(!typesFor(runId).some((type) => type === 'run.finished'), 'the worker publishes no transition it did not make');
    gate.open();
  });

  test('killing the agent stops its running run', async () => {
    const agentId = await makeAgent();
    const runId = await makeRun(agentId);
    local.push(plan, choose('fixture.block'));
    const pending = worker().runNext();
    await gate.entered;
    await server.pool.query("UPDATE agents SET state = 'killed' WHERE id = $1", [agentId]);
    assert.deepEqual(await pending, { runId, outcome: 'killed' });
    const run = await runRow(runId);
    assert.equal(run.status, 'killed');
    assert.equal(run.error, 'agent_killed');
    gate.open();
  });

  test('pause lets the step in flight finish, keeps the pause, and resume continues after it', async () => {
    const agentId = await makeAgent();
    const runId = await makeRun(agentId);
    local.push(plan, choose('fixture.block'));
    const instance = worker();
    const pending = instance.runNext();
    await gate.entered;

    // The agents API pauses the run while the block step is running.
    await server.pool.query("UPDATE agent_runs SET status = 'paused' WHERE id = $1", [runId]);
    gate.open();
    assert.deepEqual(await pending, { runId, outcome: 'lost' });
    let run = await runRow(runId);
    assert.equal(run.status, 'paused', 'the pause is not overwritten');
    assert.equal(run.step_index, 2, 'the finished step was checkpointed');
    assert.equal((await steps(runId))[1].status, 'done');
    assert.equal(await instance.runNext(), null, 'a paused run is not claimed');

    await server.pool.query("UPDATE agent_runs SET status = 'queued' WHERE id = $1", [runId]);
    local.push(done);
    assert.deepEqual(await instance.runNext(), { runId, outcome: 'finished' });
    run = await runRow(runId);
    assert.equal(run.status, 'succeeded');
    assert.equal(invocations.block, 1);
  });

  test('a paused agent pauses its run at the next step boundary', async () => {
    const agentId = await makeAgent();
    const runId = await makeRun(agentId);
    await server.pool.query("UPDATE agents SET state = 'paused' WHERE id = $1", [agentId]);
    assert.deepEqual(await worker().runNext(), { runId, outcome: 'paused' });
    assert.equal((await runRow(runId)).status, 'paused');
    assert.ok(typesFor(runId).includes('run.paused'));
  });

  test('a token budget stops the run with budget_exceeded', async () => {
    const agentId = await makeAgent({ budget: { maxTokens: 300 } });
    const runId = await makeRun(agentId);
    local.push(plan, choose('fixture.list_files'), choose('fixture.list_files'));
    assert.deepEqual(await worker().runNext(), { runId, outcome: 'budget_exceeded' });
    const run = await runRow(runId);
    assert.equal(run.status, 'budget_exceeded');
    assert.ok(run.finished_at);
    assert.equal(run.tokens_used, 360);
    // The step that crossed the limit never acted.
    assert.equal(invocations.list, 1);
    assert.deepEqual(events.filter((event) => event.type === 'budget.exceeded').map((event) => event.data), [{ limit: 'tokens' }]);
    assert.deepEqual(events.filter((event) => event.type === 'run.finished').map((event) => event.data), [{ status: 'budget_exceeded' }]);
  });

  test('a wall-clock budget aborts a step that runs too long', async () => {
    const agentId = await makeAgent({ budget: { maxWallMs: 60_000 } });
    const runId = await makeRun(agentId, { budget: { maxWallMs: 400 } });
    local.push(plan, choose('fixture.block'));
    assert.deepEqual(await worker().runNext(), { runId, outcome: 'budget_exceeded' });
    assert.ok(gate.signal.aborted);
    const run = await runRow(runId);
    assert.equal(run.status, 'budget_exceeded');
    assert.equal(run.error, 'budget_exceeded:wall');
    assert.equal((await steps(runId))[1].error, 'budget_exceeded');
    gate.open();
  });

  test('a step budget caps how many steps a run takes', async () => {
    const agentId = await makeAgent();
    const runId = await makeRun(agentId, { budget: { maxSteps: 3 } });
    local.push(plan, choose('fixture.list_files'), choose('fixture.list_files'), choose('fixture.list_files'));
    await worker().runNext();
    const run = await runRow(runId);
    assert.equal(run.status, 'budget_exceeded');
    assert.equal(run.step_index, 3);
    assert.equal(invocations.list, 2);
  });

  test('the slice stays the same size at step 40 as at step 2', async () => {
    const agentId = await makeAgent();
    const runId = await makeRun(agentId, { budget: { maxSteps: 41 } });
    local.push(plan);
    local.push(...Array.from({ length: 40 }, () => choose('fixture.list_files')));
    await worker().runNext();
    assert.equal(invocations.list, 40);
    const chooserCalls = local.calls.filter((call) => call.format === 'json');
    assert.equal(chooserCalls.length, 40);
    const sizes = chooserCalls.map((call) => call.messages.reduce((sum, message) => sum + message.content.length, 0));
    // The slice is capped at SLICE_TOKENS (about four characters each); the
    // rest of the prompt is fixed. So the prompt is bounded however long the
    // run has gone on, and once the slice is full it stops growing.
    const fixed = sizes[0];
    for (const size of sizes) assert.ok(size <= fixed + SLICE_TOKENS * 4, `prompt ${size} exceeds the bound`);
    const late = sizes.slice(10);
    assert.ok(Math.max(...late) - Math.min(...late) < 400, `prompts vary ${Math.min(...late)}–${Math.max(...late)}`);
    assert.ok(sizes[39] <= sizes[10] + 200, `step 40 (${sizes[39]}) vs step 11 (${sizes[10]})`);
    // The most recent finding is always in the slice; the oldest ones age out.
    assert.match(chooserCalls[39].messages[1].content, /This is step 40/);
    const run = await runRow(runId);
    assert.equal(run.status, 'budget_exceeded');
  });

  test('private context never reaches a non-local adapter, and what it produces stays private', async () => {
    await server.pool.query("UPDATE users SET plan = 'engineer' WHERE id = $1", [ownerId]);
    await server.pool.query(
      "INSERT INTO nodes (owner_id, type, content, source, project, privacy) VALUES ($1, 'decision', 'Secret widget gizmo tolerances: count lines carefully', 'manual', $2, 'local')",
      [ownerId, PROJECT]
    );
    const agentId = await makeAgent({ modelPolicy: 'local_cloud' });
    const runId = await makeRun(agentId, { instructions: 'Count lines for the widget gizmo tolerances' });
    local.push(plan, choose('fixture.think', {}, { hard: true }), 'local thoughts', done);
    await worker().runNext();

    assert.equal((await runRow(runId)).status, 'succeeded');
    assert.equal(platform.calls.length, 0, 'nothing went to the platform model');
    const { rows: costs } = await server.pool.query('SELECT DISTINCT adapter FROM agent_run_costs WHERE run_id = $1', [runId]);
    assert.deepEqual(costs, [{ adapter: 'local' }]);
    const nodes = await nodesOf(runId);
    assert.ok(nodes.length > 0);
    assert.ok(nodes.every((node) => node.privacy === 'local'), 'everything learned from a private node is private');
  });

  test('without private context the plan and hard steps use the cloud the agent may use', async () => {
    await server.pool.query("UPDATE users SET plan = 'engineer' WHERE id = $1", [ownerId]);
    const agentId = await makeAgent({ modelPolicy: 'local_cloud' });
    const runId = await makeRun(agentId);
    platform.push(plan, 'cloud thoughts');
    local.push(choose('fixture.think', {}, { hard: true }), choose('fixture.list_files'), done);
    await worker().runNext();

    assert.equal((await runRow(runId)).status, 'succeeded');
    assert.equal(platform.calls.length, 2);
    assert.equal(platform.calls[0].purpose, 'plan');
    const rows = await steps(runId);
    assert.equal(rows[0].adapter, 'platform');
    assert.equal(rows[1].output, 'cloud thoughts');
    const { rows: costs } = await server.pool.query('SELECT purpose, adapter, usd FROM agent_run_costs WHERE run_id = $1 ORDER BY created_at', [runId]);
    assert.deepEqual(costs.map((cost) => [cost.purpose, cost.adapter]), [
      ['plan', 'platform'],
      ['step', 'local'],
      ['capability', 'platform'],
      ['step', 'local'],
      ['step', 'local'],
    ]);
    const run = await runRow(runId);
    assert.equal(Number(run.cost_usd), 0.02);
  });

  test('offline keeps every call local', async () => {
    await server.pool.query("UPDATE users SET plan = 'engineer' WHERE id = $1", [ownerId]);
    const agentId = await makeAgent({ modelPolicy: 'local_cloud' });
    const runId = await makeRun(agentId);
    local.push(plan, done);
    await worker({ online: () => false }).runNext();
    assert.equal((await runRow(runId)).status, 'succeeded');
    assert.equal(platform.calls.length, 0);
  });

  test('platform_unavailable falls back to local for that call and is recorded', async () => {
    await server.pool.query("UPDATE users SET plan = 'engineer' WHERE id = $1", [ownerId]);
    const agentId = await makeAgent({ modelPolicy: 'local_cloud' });
    const runId = await makeRun(agentId);
    platform.push(platformUnavailable());
    local.push(plan, done);
    await worker().runNext();

    assert.equal((await runRow(runId)).status, 'succeeded');
    assert.equal(platform.calls.length, 1);
    const [planStep] = await steps(runId);
    assert.equal(planStep.adapter, 'local');
    assert.deepEqual(planStep.detail.fallbacks, [{ from: 'platform', to: 'local' }]);
    const { rows: [cost] } = await server.pool.query("SELECT adapter, fallback_from FROM agent_run_costs WHERE run_id = $1 AND purpose = 'plan'", [runId]);
    assert.deepEqual(cost, { adapter: 'local', fallback_from: 'platform' });
  });

  test('cloud ask opens one approval per run and stays local until it is approved', async () => {
    await server.pool.query("UPDATE users SET plan = 'engineer' WHERE id = $1", [ownerId]);
    const agentId = await makeAgent({ level: 'supervised', modelPolicy: 'local_cloud' });
    const runId = await makeRun(agentId);
    // The plan asks for the cloud and is served locally meanwhile; the hard
    // step asks again and finds the same request; count_lines then parks.
    local.push(plan, choose('fixture.think', {}, { hard: true }), 'local thoughts', choose('fixture.count_lines', { file: 'b.js' }));
    const instance = worker();
    assert.deepEqual(await instance.runNext(), { runId, outcome: 'parked' });

    const cloudApprovals = async () =>
      (await server.pool.query("SELECT id, status, step_id FROM agent_approvals WHERE run_id = $1 AND capability = 'cloud_model'", [runId])).rows;
    let approvals = await cloudApprovals();
    assert.equal(approvals.length, 1);
    assert.equal(approvals[0].step_id, null, 'the request belongs to the run, not a step');
    assert.equal(platform.calls.length, 0);
    let rows = await steps(runId);
    assert.equal(rows[0].adapter, 'local');
    assert.equal(rows[1].output, 'local thoughts');
    assert.equal(events.filter((event) => event.type === 'approval.requested' && event.data.capability === 'cloud_model').length, 1);

    // Approved (with the parked step): the rest of the run's hard steps may use the cloud.
    await server.pool.query("UPDATE agent_approvals SET status = 'approved', resolved_at = now() WHERE run_id = $1", [runId]);
    await server.pool.query("UPDATE agent_runs SET status = 'queued' WHERE id = $1", [runId]);
    local.push(choose('fixture.think', {}, { hard: true }), done);
    platform.push('cloud thoughts');
    assert.deepEqual(await instance.runNext(), { runId, outcome: 'finished' });
    assert.equal(platform.calls.length, 1);
    rows = await steps(runId);
    assert.deepEqual(rows[2].output, { file: 'b.js', lines: 1 });
    assert.equal(rows[3].output, 'cloud thoughts');
    assert.equal(rows[3].adapter, 'platform');
    approvals = await cloudApprovals();
    assert.equal(approvals.length, 1);
  });

  test('the worker loop runs queued runs in the background and stops cleanly', async () => {
    const agentId = await makeAgent();
    local.push(plan, done, plan, done);
    const instance = worker({ pollMs: 20 });
    instance.start();
    const first = await makeRun(agentId);
    const second = await makeRun(agentId);
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      const { rows } = await server.pool.query("SELECT count(*)::int AS count FROM agent_runs WHERE id = ANY($1) AND status = 'succeeded'", [[first, second]]);
      if (rows[0].count === 2) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
    await instance.stop();
    assert.equal((await runRow(first)).status, 'succeeded');
    assert.equal((await runRow(second)).status, 'succeeded');
  });

  test('stop hands a run in flight back to the queue at the next step boundary', async () => {
    const agentId = await makeAgent();
    const runId = await makeRun(agentId);
    local.push(plan, choose('fixture.block'));
    const instance = worker({ pollMs: 20 });
    instance.start();
    await gate.entered;
    const stopping = instance.stop();
    gate.open();
    await stopping;
    const run = await runRow(runId);
    assert.equal(run.status, 'queued');
    assert.equal(run.lease_owner, null);
    assert.equal(run.step_index, 2, 'the finished step was kept');
    local.push(done);
    assert.deepEqual(await worker().runNext(), { runId, outcome: 'finished' });
    assert.equal(invocations.block, 1);
  });

  test('two workers never claim the same run', async () => {
    const agentId = await makeAgent();
    const runId = await makeRun(agentId);
    const { claimRun } = await import('../../src/workspace/runner/store.js');
    const claims = await Promise.all([claimRun({ workerId: 'w1', leaseMs: 30_000 }), claimRun({ workerId: 'w2', leaseMs: 30_000 })]);
    const won = claims.filter(Boolean);
    assert.equal(won.length, 1);
    assert.equal(won[0].id, runId);
    assert.equal(won[0].attempts, 1);
  });
});
