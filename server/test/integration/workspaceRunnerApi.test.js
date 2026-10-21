import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { createEventBus, workspaceEvents } from '../../src/workspace/events.js';
import { createScheduler, createWorker, enqueueDueTasks, setRunQueuedListener } from '../../src/workspace/runner/index.js';
import { createFakeModelPort } from '../fakeModelPort.js';
import { registeredSession, session, startServer } from '../helpers.js';

describe('/api/agent-runs and the scheduler', () => {
  let server;
  let api;
  let ownerId;
  let other;
  let otherId;
  let seen;

  async function makeAgent(owner, { state = 'active' } = {}) {
    const { rows } = await server.pool.query(
      `INSERT INTO agents (owner_id, name, role, state, scopes)
       VALUES ($1, 'Runner', '{"tags": ["graph"]}', $2, '{"read":{"projects":["*"],"sources":["*"]},"write":{"projects":["*"]}}')
       RETURNING id`,
      [owner, state]
    );
    return rows[0].id;
  }

  async function makeTask(owner, agentId, { schedule = null, nextRunAt = null, enabled = true, project = 'demo' } = {}) {
    const { rows } = await server.pool.query(
      `INSERT INTO tasks (owner_id, agent_id, title, instructions, project, schedule, next_run_at, enabled)
       VALUES ($1, $2, 'Nightly', 'Summarise what changed', $3, $4, $5, $6) RETURNING id`,
      [owner, agentId, project, schedule, nextRunAt, enabled]
    );
    return rows[0].id;
  }

  before(async () => {
    server = await startServer();
    api = await registeredSession(server.base);
    ({ data: { userId: ownerId } } = await api('GET', '/api/auth/session'));
    other = await registeredSession(server.base);
    ({ data: { userId: otherId } } = await other('GET', '/api/auth/session'));
    workspaceEvents.subscribe({ ownerId }, (event) => seen.push(event));
  });

  beforeEach(async () => {
    seen = [];
    await server.pool.query('DELETE FROM agent_runs');
    await server.pool.query('DELETE FROM tasks');
  });

  after(() => server.close());

  test('starts a run from an agent and instructions, queued, and wakes the worker', async () => {
    const agentId = await makeAgent(ownerId);
    let woken = 0;
    setRunQueuedListener(() => {
      woken += 1;
    });
    const { status, data } = await api('POST', '/api/agent-runs', { agentId, instructions: '  Find the flaky test  ', project: 'demo', budget: { maxSteps: 5 } });
    setRunQueuedListener(null);
    assert.equal(status, 201);
    assert.deepEqual(Object.keys(data.run).sort(), [
      'agentId', 'budget', 'costUsd', 'error', 'finishedAt', 'id', 'instructions', 'planNodeId', 'project', 'queuedAt', 'startedAt', 'status', 'stepIndex', 'taskId', 'tokensUsed', 'wallMs',
    ].sort());
    assert.equal(data.run.status, 'queued');
    assert.equal(data.run.instructions, 'Find the flaky test');
    assert.equal(data.run.project, 'demo');
    assert.deepEqual(data.run.budget, { maxSteps: 5 });
    assert.equal(data.run.taskId, null);
    assert.equal(woken, 1);
    assert.deepEqual(seen.map((event) => [event.type, event.runId]), [['run.queued', data.run.id]]);
  });

  test('starts a run from a task, copying its instructions and project', async () => {
    const agentId = await makeAgent(ownerId);
    const taskId = await makeTask(ownerId, agentId);
    const { status, data } = await api('POST', '/api/agent-runs', { taskId });
    assert.equal(status, 201);
    assert.equal(data.run.taskId, taskId);
    assert.equal(data.run.agentId, agentId);
    assert.equal(data.run.instructions, 'Summarise what changed');
    assert.equal(data.run.project, 'demo');
  });

  test('validates the request and never touches another user’s agent or task', async () => {
    const agentId = await makeAgent(ownerId);
    const theirs = await makeAgent(otherId);
    const theirTask = await makeTask(otherId, theirs);
    const cases = [
      [{}, 400],
      [{ agentId: 'nope', instructions: 'x' }, 400],
      [{ agentId }, 400],
      [{ agentId, instructions: '   ' }, 400],
      [{ agentId, instructions: 'x', project: 5 }, 400],
      [{ agentId, instructions: 'x'.repeat(20_001) }, 400],
      [{ agentId, instructions: 'x', budget: { maxTokens: -1 } }, 400],
      [{ taskId: theirTask, instructions: 'x' }, 400],
      [{ agentId: theirs, instructions: 'x' }, 404],
      [{ taskId: theirTask }, 404],
    ];
    for (const [body, expected] of cases) {
      const { status, data } = await api('POST', '/api/agent-runs', body);
      assert.equal(status, expected, JSON.stringify(body).slice(0, 80));
      assert.ok(data.error);
    }
    const { rows } = await server.pool.query('SELECT count(*)::int AS count FROM agent_runs');
    assert.equal(rows[0].count, 0);
  });

  test('a paused or killed agent starts nothing new', async () => {
    for (const state of ['paused', 'killed']) {
      const agentId = await makeAgent(ownerId, { state });
      const { status, data } = await api('POST', '/api/agent-runs', { agentId, instructions: 'x' });
      assert.equal(status, 409);
      assert.equal(data.error, 'agent_not_active');
    }
  });

  test('lists, filters and inspects runs with their steps', async () => {
    const agentId = await makeAgent(ownerId);
    const second = await makeAgent(ownerId);
    const { data: { run: first } } = await api('POST', '/api/agent-runs', { agentId, instructions: 'one' });
    await api('POST', '/api/agent-runs', { agentId: second, instructions: 'two' });
    await other('POST', '/api/agent-runs', { agentId: await makeAgent(otherId), instructions: 'not yours' });
    await server.pool.query(
      "INSERT INTO agent_run_steps (run_id, index, kind, capability, status, input, output, adapter, tokens, cost_usd) VALUES ($1, 0, 'plan', NULL, 'done', '{}', '{\"plan\":\"p\"}', 'local', 12, 0.5)",
      [first.id]
    );

    assert.equal((await api('GET', '/api/agent-runs')).data.runs.length, 2);
    const { data: filtered } = await api('GET', `/api/agent-runs?agentId=${agentId}&status=queued`);
    assert.deepEqual(filtered.runs.map((run) => run.id), [first.id]);
    assert.equal((await api('GET', '/api/agent-runs?status=running')).data.runs.length, 0);
    assert.equal((await api('GET', '/api/agent-runs?status=sleeping')).status, 400);
    assert.equal((await api('GET', '/api/agent-runs?agentId=x')).status, 400);

    const { status, data } = await api('GET', `/api/agent-runs/${first.id}`);
    assert.equal(status, 200);
    assert.equal(data.run.steps.length, 1);
    assert.deepEqual(Object.keys(data.run.steps[0]).sort(), ['adapter', 'capability', 'costUsd', 'finishedAt', 'id', 'index', 'input', 'kind', 'nodeIds', 'output', 'startedAt', 'status', 'tokens', 'verification'].sort());
    assert.deepEqual(data.run.steps[0].output, { plan: 'p' });
    assert.equal(data.run.steps[0].costUsd, 0.5);

    assert.equal((await other('GET', `/api/agent-runs/${first.id}`)).status, 404);
    assert.equal((await api('GET', '/api/agent-runs/not-a-uuid')).status, 404);
    assert.equal((await session(server.base)('GET', '/api/agent-runs')).status, 401);
  });

  test('cancel kills the run, expires its approvals and is 409 once finished', async () => {
    const agentId = await makeAgent(ownerId);
    const { data: { run } } = await api('POST', '/api/agent-runs', { agentId, instructions: 'x' });
    const { rows: [approval] } = await server.pool.query(
      "INSERT INTO agent_approvals (owner_id, agent_id, run_id, capability, summary) VALUES ($1, $2, $3, 'cloud_model', 'cloud?') RETURNING id",
      [ownerId, agentId, run.id]
    );
    await server.pool.query("UPDATE agent_runs SET status = 'waiting_approval' WHERE id = $1", [run.id]);

    assert.equal((await other('POST', `/api/agent-runs/${run.id}/cancel`)).status, 404);
    const { status, data } = await api('POST', `/api/agent-runs/${run.id}/cancel`);
    assert.equal(status, 200);
    assert.equal(data.run.status, 'killed');
    assert.ok(data.run.finishedAt);
    const { rows: [after] } = await server.pool.query('SELECT status FROM agent_approvals WHERE id = $1', [approval.id]);
    assert.equal(after.status, 'expired');
    assert.ok(seen.some((event) => event.type === 'approval.resolved' && event.data.approvalId === approval.id && event.data.status === 'expired'));
    assert.ok(seen.some((event) => event.type === 'run.finished' && event.data.status === 'killed'));

    const again = await api('POST', `/api/agent-runs/${run.id}/cancel`);
    assert.equal(again.status, 409);
    assert.equal(again.data.error, 'run_finished');
  });

  test('a run started over HTTP is executed by a worker end to end', async () => {
    const agentId = await makeAgent(ownerId);
    const { data: { run } } = await api('POST', '/api/agent-runs', { agentId, instructions: 'Say what the graph holds', project: 'demo' });
    const local = createFakeModelPort({ responses: ['1. Look\n2. Finish', { done: true, summary: 'nothing to do' }] });
    const worker = createWorker({ adapters: { local }, events: createEventBus(), embed: false });
    await worker.drain();
    const { data } = await api('GET', `/api/agent-runs/${run.id}`);
    assert.equal(data.run.status, 'succeeded');
    assert.equal(data.run.tokensUsed, 240);
    assert.ok(data.run.planNodeId);
    assert.deepEqual(data.run.steps.map((step) => [step.kind, step.status]), [['plan', 'done'], ['act', 'done']]);
    assert.equal(data.run.steps[0].nodeIds[0], data.run.planNodeId);
  });

  test('the scheduler enqueues a due task once, however many schedulers race', async () => {
    const agentId = await makeAgent(ownerId);
    const slot = new Date(Date.now() - 60_000);
    slot.setUTCSeconds(0, 0);
    const taskId = await makeTask(ownerId, agentId, { schedule: '*/5 * * * *', nextRunAt: slot });
    const notDue = await makeTask(ownerId, agentId, { schedule: '*/5 * * * *', nextRunAt: new Date(Date.now() + 3_600_000) });
    const disabled = await makeTask(ownerId, agentId, { schedule: '*/5 * * * *', nextRunAt: slot, enabled: false });

    const results = await Promise.all([enqueueDueTasks(), enqueueDueTasks(), enqueueDueTasks()]);
    assert.equal(results.flat().length, 1);
    const { rows: runs } = await server.pool.query('SELECT task_id, scheduled_for, status, instructions, project FROM agent_runs');
    assert.equal(runs.length, 1);
    assert.equal(runs[0].task_id, taskId);
    assert.equal(runs[0].scheduled_for.toISOString(), slot.toISOString());
    assert.equal(runs[0].status, 'queued');
    assert.equal(runs[0].instructions, 'Summarise what changed');

    const { rows: tasks } = await server.pool.query('SELECT id, next_run_at FROM tasks');
    const next = new Map(tasks.map((task) => [task.id, task.next_run_at]));
    assert.ok(next.get(taskId) > new Date(), 'the due task moved to its next slot');
    assert.equal(next.get(taskId).getUTCMinutes() % 5, 0);
    assert.equal(next.get(disabled).toISOString(), slot.toISOString(), 'a disabled task is left alone');
    assert.ok(next.get(notDue) > new Date());
    assert.ok(seen.some((event) => event.type === 'run.queued' && event.data.scheduledFor === slot.toISOString()));

    // The same slot can never be enqueued again, even if next_run_at is set back.
    await server.pool.query('UPDATE tasks SET next_run_at = $2 WHERE id = $1', [taskId, slot]);
    assert.deepEqual(await enqueueDueTasks(), []);
    assert.equal((await server.pool.query('SELECT count(*)::int AS count FROM agent_runs')).rows[0].count, 1);
  });

  test('the scheduler skips a paused agent’s slot and stops an unparseable schedule', async () => {
    const paused = await makeAgent(ownerId, { state: 'paused' });
    const slot = new Date(Date.now() - 60_000);
    const pausedTask = await makeTask(ownerId, paused, { schedule: '0 * * * *', nextRunAt: slot });
    const active = await makeAgent(ownerId);
    const broken = await makeTask(ownerId, active, { schedule: 'every day', nextRunAt: slot });

    const queued = [];
    const scheduler = createScheduler({ intervalMs: 60_000, onQueued: (ids) => queued.push(...ids) });
    assert.equal((await scheduler.tick()).length, 1, 'the broken schedule still runs the slot it was due for');
    await scheduler.stop();
    const { rows } = await server.pool.query('SELECT id, next_run_at FROM tasks');
    const next = new Map(rows.map((row) => [row.id, row.next_run_at]));
    assert.ok(next.get(pausedTask) > new Date());
    assert.equal(next.get(broken), null);
    const { rows: runs } = await server.pool.query('SELECT task_id FROM agent_runs');
    assert.deepEqual(runs.map((run) => run.task_id), [broken]);
    assert.equal(queued.length, 1);
  });
});
