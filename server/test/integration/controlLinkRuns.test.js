import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { listPlugins, registerPlugin } from '../../src/workspace/capabilities.js';
import { createEventBus } from '../../src/workspace/events.js';
import { createWorker, defaultAdapters } from '../../src/workspace/runner/index.js';
import { startFakeAnthropic } from '../fakeAnthropic.js';
import { controlAccount, linkUser, startControlPlane } from '../fakeControl.js';
import { createFakeModelPort } from '../fakeModelPort.js';
import { registeredSession, startServer } from '../helpers.js';

// Agent runs against the real control plane (control/), in this process, on
// its own test database, with the platform adapter the worker really makes
// (defaultAdapters().platform). What is under test is whose device token a
// run's cloud calls carry, what happens when the owner is signed out, and
// that a private context never reaches the platform, measured where it
// would land: the control plane's ledger and the Anthropic stand-in behind it.

const PROJECT = 'link-runs';

// A capability that asks the run's model to think, so a step marked hard
// makes a model call of its own through ctx.model.
const thinkPlugin = {
  name: 'linktest',
  capabilities: [
    {
      name: 'linktest.think',
      tags: ['linktest'],
      permission: 'read_graph',
      source: 'linktest',
      input: { type: 'object', properties: {} },
      async run(input, ctx) {
        let text = '';
        for await (const chunk of ctx.model.stream({ messages: [{ role: 'user', content: 'think about the gearbox' }], signal: ctx.signal })) {
          if (chunk.text) text += chunk.text;
        }
        return { output: text };
      },
    },
  ],
};

const choose = (capability, extra = {}) => ({ capability, input: {}, summary: `use ${capability}`, ...extra });
const done = { done: true, summary: 'finished' };

describe('agent runs and the control link', () => {
  let server;
  let control;
  let anthropic;
  let local;
  const users = {};

  async function makeAgent(ownerId) {
    const { rows } = await server.pool.query(
      `INSERT INTO agents (owner_id, name, role, level, scopes, model_policy)
       VALUES ($1, 'Linked agent', $2, 'agentic', $3, 'local_cloud') RETURNING id`,
      [
        ownerId,
        { template: null, title: 'Thinker', description: '', embodiment: 'You think things through.', tags: ['linktest'] },
        { read: { projects: [PROJECT], sources: ['*'] }, write: { projects: [PROJECT] } },
      ]
    );
    return rows[0].id;
  }

  async function makeRun(ownerId, agentId, instructions) {
    const { rows } = await server.pool.query(
      'INSERT INTO agent_runs (owner_id, agent_id, instructions, project) VALUES ($1, $2, $3, $4) RETURNING id',
      [ownerId, agentId, instructions, PROJECT]
    );
    return rows[0].id;
  }

  // The worker as the engine makes it, except for the local model: the
  // platform entry is the real per-run factory.
  function worker() {
    return createWorker({ adapters: { local, platform: defaultAdapters().platform }, events: createEventBus(), embed: false, leaseMs: 30_000, heartbeatMs: 25, onError: () => {} });
  }

  const ledger = async () => (await control.pool.query('SELECT account_id, hard FROM usage_ledger ORDER BY id')).rows;
  const steps = async (runId) => (await server.pool.query('SELECT index, adapter, status, detail FROM agent_run_steps WHERE run_id = $1 ORDER BY index', [runId])).rows;
  const costs = async (runId) =>
    (await server.pool.query('SELECT purpose, adapter, fallback_from FROM agent_run_costs WHERE run_id = $1 ORDER BY created_at, id', [runId])).rows;
  const runStatus = async (runId) => (await server.pool.query('SELECT status FROM agent_runs WHERE id = $1', [runId])).rows[0].status;

  before(async () => {
    anthropic = await startFakeAnthropic();
    process.env.ANTHROPIC_BASE_URL = anthropic.url;
    server = await startServer();
    control = await startControlPlane();
    process.env.CONTROL_URL = control.url;
    if (!listPlugins().includes('linktest')) registerPlugin(thinkPlugin);
    for (const name of ['ada', 'bea']) {
      const api = await registeredSession(server.base);
      const ownerId = (await api('GET', '/api/auth/session')).data.userId;
      users[name] = { api, ownerId };
    }
  });

  beforeEach(async () => {
    // Both linked on the Engineer plan, each with their own account and
    // device on the control plane.
    await control.truncate();
    await server.pool.query('DELETE FROM control_links');
    await server.pool.query("UPDATE agent_runs SET status = 'killed' WHERE status IN ('queued', 'running', 'waiting_approval', 'paused')");
    await server.pool.query("DELETE FROM nodes WHERE privacy = 'local'");
    for (const [name, user] of Object.entries(users)) {
      const account = await controlAccount(control, { email: `${name}@scope.test`, plan: 'engineer' });
      await linkUser(server.pool, user.ownerId, 'engineer', { token: account.token });
      Object.assign(user, { accountId: account.id, token: account.token });
    }
    anthropic.state.requests = [];
    anthropic.state.authHeaders = [];
    local = createFakeModelPort({ name: 'local' });
  });

  after(async () => {
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.CONTROL_URL;
    await control.close();
    await server.close();
    await anthropic.close();
  });

  test('with two users linked, each run’s cloud calls carry its own owner’s device token', async () => {
    const { ada, bea } = users;
    const runA = await makeRun(ada.ownerId, await makeAgent(ada.ownerId), 'Plan the walrus gearbox teardown');
    const runB = await makeRun(bea.ownerId, await makeAgent(bea.ownerId), 'Plan the heron pump rebuild');
    local.push(done, done);
    const instance = worker();

    // One run at a time, so each new ledger row can be told apart.
    assert.equal((await instance.runNext()).runId, runA);
    assert.deepEqual(await ledger(), [{ account_id: ada.accountId, hard: true }], 'Ada’s plan was charged to Ada’s account');
    assert.equal((await instance.runNext()).runId, runB);
    assert.deepEqual((await ledger()).map((row) => row.account_id), [ada.accountId, bea.accountId], 'and Bea’s to Bea’s');

    // What reached Anthropic, in that order, was each run's own goal, on the
    // platform's key; the engine never called Anthropic itself.
    assert.equal(anthropic.state.requests.length, 2);
    assert.match(JSON.stringify(anthropic.state.requests[0].messages), /walrus gearbox/);
    assert.match(JSON.stringify(anthropic.state.requests[1].messages), /heron pump/);
    assert.deepEqual(anthropic.state.authHeaders, ['sk-ant-test-not-a-real-key', 'sk-ant-test-not-a-real-key']);
    for (const runId of [runA, runB]) {
      assert.equal(await runStatus(runId), 'succeeded');
      assert.equal((await steps(runId))[0].adapter, 'platform');
    }
  });

  test('a signed-out owner’s run uses the local adapter while another user stays linked', async () => {
    const { ada, bea } = users;
    // Bea signs out through the engine, which revokes her device.
    const { data } = await bea.api('POST', '/api/control/signout');
    assert.deepEqual(data, { signedOut: true, revoked: true });

    const runB = await makeRun(bea.ownerId, await makeAgent(bea.ownerId), 'Plan the heron pump rebuild');
    local.push('1. Look at the pump\n2. Finish', choose('linktest.think', { hard: true }), 'local thoughts', done);
    await worker().runNext();

    assert.equal(await runStatus(runB), 'succeeded');
    // Signed out is Free: nothing was even offered to the platform, with her
    // token or with Ada's, which is still linked.
    assert.deepEqual(await ledger(), []);
    assert.equal(anthropic.state.requests.length, 0);
    assert.deepEqual((await costs(runB)).map((cost) => [cost.purpose, cost.adapter, cost.fallback_from]), [
      ['plan', 'local', null],
      ['step', 'local', null],
      ['capability', 'local', null],
      ['step', 'local', null],
    ]);
    assert.ok((await server.pool.query('SELECT 1 FROM control_links WHERE owner_id = $1', [ada.ownerId])).rowCount === 1);
  });

  test('an owner signed out on the control plane falls back to local, and another user’s token is never used', async () => {
    const { ada, bea } = users;
    // Bea's device is removed from another machine. The engine still holds
    // her link and a fresh Engineer plan, so the run tries the platform with
    // her token and is refused.
    await control.pool.query('UPDATE device_tokens SET revoked_at = now() WHERE account_id = $1', [bea.accountId]);
    const runB = await makeRun(bea.ownerId, await makeAgent(bea.ownerId), 'Plan the heron pump rebuild');
    local.push('1. Look at the pump\n2. Finish', done);
    await worker().runNext();

    assert.equal(await runStatus(runB), 'succeeded');
    const [planStep] = await steps(runB);
    assert.equal(planStep.adapter, 'local');
    assert.deepEqual(planStep.detail.fallbacks, [{ from: 'platform', to: 'local' }]);
    assert.deepEqual((await costs(runB))[0], { purpose: 'plan', adapter: 'local', fallback_from: 'platform' });
    assert.deepEqual(await ledger(), [], 'nothing was charged, to Bea or to Ada');
    assert.equal(anthropic.state.requests.length, 0);

    // Ada is unaffected: her next run still reaches the platform as herself.
    const runA = await makeRun(ada.ownerId, await makeAgent(ada.ownerId), 'Plan the walrus gearbox teardown');
    local.push(done);
    await worker().runNext();
    assert.equal(await runStatus(runA), 'succeeded');
    assert.deepEqual((await ledger()).map((row) => row.account_id), [ada.accountId]);
  });

  test('through the real platform adapter, a private context never reaches the platform', async () => {
    const { ada } = users;
    const agentId = await makeAgent(ada.ownerId);
    // The same agent and plan without anything private: the plan and the
    // hard step go to the platform, so the setup below is not vacuously local.
    const open = await makeRun(ada.ownerId, agentId, 'Think about the gearbox tolerances');
    local.push(choose('linktest.think', { hard: true }), done);
    await worker().runNext();
    assert.equal(await runStatus(open), 'succeeded');
    assert.deepEqual((await costs(open)).map((cost) => [cost.purpose, cost.adapter]), [
      ['plan', 'platform'],
      ['step', 'local'],
      ['capability', 'platform'],
      ['step', 'local'],
    ]);
    assert.equal((await ledger()).length, 2);
    const reachedBefore = anthropic.state.requests.length;

    // Now the project holds a private note the run will read.
    await server.pool.query(
      "INSERT INTO nodes (owner_id, type, content, source, project, privacy) VALUES ($1, 'decision', $2, 'manual', $3, 'local')",
      [ada.ownerId, 'Gearbox tolerances: the quokka-otter shim is 0.15 mm, never share this', PROJECT]
    );
    const privateRun = await makeRun(ada.ownerId, agentId, 'Think about the gearbox tolerances');
    local.push('1. Think\n2. Finish', choose('linktest.think', { hard: true }), 'local thoughts', done);
    await worker().runNext();

    assert.equal(await runStatus(privateRun), 'succeeded');
    assert.deepEqual((await costs(privateRun)).map((cost) => [cost.purpose, cost.adapter, cost.fallback_from]), [
      ['plan', 'local', null],
      ['step', 'local', null],
      ['capability', 'local', null],
      ['step', 'local', null],
    ]);
    assert.equal((await ledger()).length, 2, 'no new answer on the control plane');
    assert.equal(anthropic.state.requests.length, reachedBefore, 'nothing new reached Anthropic');
    assert.ok(!JSON.stringify(anthropic.state.requests).includes('quokka-otter'), 'the private note never left the machine');
    // The note was in the slice the local model read, so the test did put it in play.
    assert.ok(local.calls.some((call) => JSON.stringify(call.messages).includes('quokka-otter')));
    const { rows: written } = await server.pool.query(
      'SELECT privacy FROM nodes WHERE id IN (SELECT unnest(node_ids) FROM agent_run_steps WHERE run_id = $1)',
      [privateRun]
    );
    assert.ok(written.length > 0 && written.every((node) => node.privacy === 'local'), 'what the run learned from it stays private');
  });
});
