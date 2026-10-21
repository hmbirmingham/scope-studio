import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { workspaceEvents } from '../../src/workspace/events.js';
import { registeredSession, startServer } from '../helpers.js';

describe('approvals API', () => {
  let server;
  let api;
  let other;
  let userId;
  let otherId;
  let agent;
  let theirAgent;

  const query = (sql, params) => server.pool.query(sql, params);
  async function waitingRun(who = userId, agentId = agent.id, status = 'waiting_approval') {
    return (await query("INSERT INTO agent_runs (owner_id, agent_id, instructions, status) VALUES ($1, $2, 'go', $3) RETURNING id", [who, agentId, status])).rows[0].id;
  }
  async function step(runId, index = 0) {
    return (await query("INSERT INTO agent_run_steps (run_id, index, kind, status) VALUES ($1, $2, 'act', 'waiting_approval') RETURNING id", [runId, index])).rows[0].id;
  }
  async function approval({ who = userId, agentId = agent.id, runId = null, stepId = null, capability = 'web', summary = 'Fetch a page', status = 'pending' } = {}) {
    return (await query(
      `INSERT INTO agent_approvals (owner_id, agent_id, run_id, step_id, capability, summary, detail, status)
       VALUES ($1, $2, $3, $4, $5, $6, '{"url":"x"}', $7) RETURNING id`,
      [who, agentId, runId, stepId, capability, summary, status]
    )).rows[0].id;
  }
  const runStatus = async (id) => (await query('SELECT status FROM agent_runs WHERE id = $1', [id])).rows[0].status;
  function collect(ownerId) {
    const events = [];
    // Subscribing replays the bus's buffer, which holds earlier tests' events;
    // only what arrives after the subscription is of interest.
    let live = false;
    const stop = workspaceEvents.subscribe({ ownerId }, (e) => live && events.push(e));
    live = true;
    return { events, stop };
  }

  before(async () => {
    server = await startServer();
    api = await registeredSession(server.base);
    other = await registeredSession(server.base);
    userId = (await api('GET', '/api/auth/session')).data.userId;
    otherId = (await other('GET', '/api/auth/session')).data.userId;
    agent = (await api('POST', '/api/agents', { name: 'A', template: 'builder' })).data.agent;
    theirAgent = (await other('POST', '/api/agents', { name: 'B', template: 'builder' })).data.agent;
  });
  after(() => server.close());

  test('requires a session', async () => {
    assert.equal((await fetch(`${server.base}/api/approvals`)).status, 401);
  });

  test('lists the caller’s approvals, filters by status and validates the filter', async () => {
    const run = await waitingRun();
    const pending = await approval({ runId: run, stepId: await step(run) });
    const approved = await approval({ status: 'approved' });
    const theirs = await approval({ who: otherId, agentId: theirAgent.id });

    const all = (await api('GET', '/api/approvals')).data.approvals;
    const ids = all.map((a) => a.id);
    assert.ok(ids.includes(pending) && ids.includes(approved));
    assert.ok(!ids.includes(theirs));

    const onlyPending = (await api('GET', '/api/approvals?status=pending')).data.approvals;
    assert.ok(onlyPending.every((a) => a.status === 'pending'));
    assert.ok(onlyPending.some((a) => a.id === pending));
    assert.ok(!onlyPending.some((a) => a.id === approved));

    const shape = all.find((a) => a.id === pending);
    assert.deepEqual(Object.keys(shape), ['id', 'agentId', 'runId', 'stepId', 'capability', 'summary', 'detail', 'status', 'createdAt', 'resolvedAt']);
    assert.deepEqual([shape.agentId, shape.runId, shape.capability, shape.summary, shape.detail, shape.resolvedAt], [agent.id, run, 'web', 'Fetch a page', { url: 'x' }, null]);

    const bad = await api('GET', '/api/approvals?status=maybe');
    assert.deepEqual([bad.status, bad.data.error], [400, 'invalid_status']);
  });

  test('approving the only pending approval re-queues the waiting run and publishes both events', async () => {
    const run = await waitingRun();
    const id = await approval({ runId: run, stepId: await step(run) });
    const { events, stop } = collect(userId);
    const { status, data } = await api('POST', `/api/approvals/${id}`, { decision: 'approve' });
    stop();
    assert.equal(status, 200);
    assert.equal(data.approval.status, 'approved');
    assert.ok(data.approval.resolvedAt);
    assert.equal(await runStatus(run), 'queued');
    assert.deepEqual(events.map((e) => e.type), ['approval.resolved', 'run.queued']);
    assert.deepEqual(events[0].data, { approvalId: id, status: 'approved' });
    assert.ok(events.every((e) => e.runId === run && e.agentId === agent.id));
  });

  test('rejecting also re-queues: the worker reads the decision and continues without the step', async () => {
    const run = await waitingRun();
    const id = await approval({ runId: run, stepId: await step(run) });
    const { data } = await api('POST', `/api/approvals/${id}`, { decision: 'reject' });
    assert.equal(data.approval.status, 'rejected');
    assert.equal(await runStatus(run), 'queued');
  });

  test('the run is re-queued only when the last pending approval resolves', async () => {
    const run = await waitingRun();
    const first = await approval({ runId: run, stepId: await step(run, 0) });
    const second = await approval({ runId: run, stepId: await step(run, 1), capability: 'open_pr' });
    const { events, stop } = collect(userId);

    await api('POST', `/api/approvals/${first}`, { decision: 'approve' });
    assert.equal(await runStatus(run), 'waiting_approval');
    assert.deepEqual(events.map((e) => e.type), ['approval.resolved']);

    await api('POST', `/api/approvals/${second}`, { decision: 'reject' });
    stop();
    assert.equal(await runStatus(run), 'queued');
    assert.deepEqual(events.map((e) => e.type), ['approval.resolved', 'approval.resolved', 'run.queued']);
  });

  test('a pending run-level cloud approval does not hold the run once its step approval resolves', async () => {
    const run = await waitingRun();
    const stepApproval = await approval({ runId: run, stepId: await step(run) });
    // The run-level cloud request has no step: the run used local meanwhile.
    const cloud = await approval({ runId: run, capability: 'cloud_model', summary: 'Use the cloud for this run' });
    await api('POST', `/api/approvals/${stepApproval}`, { decision: 'approve' });
    assert.equal(await runStatus(run), 'queued');
    assert.equal((await query('SELECT status FROM agent_approvals WHERE id = $1', [cloud])).rows[0].status, 'pending');
  });

  test('resolving the run-level cloud approval alone does not re-queue a run still waiting on a step', async () => {
    const run = await waitingRun();
    await approval({ runId: run, stepId: await step(run) });
    const cloud = await approval({ runId: run, capability: 'cloud_model', summary: 'Use the cloud for this run' });
    assert.equal((await api('POST', `/api/approvals/${cloud}`, { decision: 'approve' })).status, 200);
    assert.equal(await runStatus(run), 'waiting_approval');
  });

  test('two approvals of one run resolved at the same moment still re-queue it exactly once', async () => {
    for (let round = 0; round < 5; round += 1) {
      const run = await waitingRun();
      const a = await approval({ runId: run, stepId: await step(run, 0) });
      const b = await approval({ runId: run, stepId: await step(run, 1) });
      const { events, stop } = collect(userId);
      const results = await Promise.all([api('POST', `/api/approvals/${a}`, { decision: 'approve' }), api('POST', `/api/approvals/${b}`, { decision: 'approve' })]);
      stop();
      assert.deepEqual(results.map((r) => r.status), [200, 200]);
      assert.equal(await runStatus(run), 'queued', `round ${round}`);
      assert.equal(events.filter((e) => e.type === 'run.queued').length, 1);
    }
  });

  test('a run that is not waiting for approval is left alone', async () => {
    for (const status of ['paused', 'killed', 'running']) {
      const run = await waitingRun(userId, agent.id, status);
      const id = await approval({ runId: run });
      const { events, stop } = collect(userId);
      assert.equal((await api('POST', `/api/approvals/${id}`, { decision: 'approve' })).status, 200);
      stop();
      assert.equal(await runStatus(run), status);
      assert.deepEqual(events.map((e) => e.type), ['approval.resolved']);
    }
  });

  test('an approval with no run resolves without touching any run', async () => {
    const id = await approval();
    const { data } = await api('POST', `/api/approvals/${id}`, { decision: 'approve' });
    assert.equal(data.approval.status, 'approved');
  });

  test('resolving twice, or resolving an expired approval, is a 409 and changes nothing', async () => {
    const run = await waitingRun();
    const id = await approval({ runId: run });
    await api('POST', `/api/approvals/${id}`, { decision: 'approve' });
    const again = await api('POST', `/api/approvals/${id}`, { decision: 'reject' });
    assert.deepEqual([again.status, again.data.error], [409, 'already_resolved']);
    assert.equal((await query('SELECT status FROM agent_approvals WHERE id = $1', [id])).rows[0].status, 'approved');

    const expired = await approval({ status: 'expired' });
    const { events, stop } = collect(userId);
    assert.equal((await api('POST', `/api/approvals/${expired}`, { decision: 'approve' })).status, 409);
    stop();
    assert.deepEqual(events, []);
  });

  test('a 409 does not re-queue a run that moved on', async () => {
    const run = await waitingRun();
    const id = await approval({ runId: run });
    await api('POST', `/api/approvals/${id}`, { decision: 'approve' });
    await query("UPDATE agent_runs SET status = 'waiting_approval' WHERE id = $1", [run]);
    assert.equal((await api('POST', `/api/approvals/${id}`, { decision: 'approve' })).status, 409);
    assert.equal(await runStatus(run), 'waiting_approval');
  });

  test('rejects a missing or unknown decision with a 400 and leaves the approval pending', async () => {
    const id = await approval();
    for (const body of [{}, { decision: 'yes' }, { decision: 'APPROVE' }, { decision: true }]) {
      const result = await api('POST', `/api/approvals/${id}`, body);
      assert.deepEqual([result.status, result.data.error], [400, 'invalid_decision'], JSON.stringify(body));
    }
    assert.equal((await query('SELECT status FROM agent_approvals WHERE id = $1', [id])).rows[0].status, 'pending');
  });

  test('another user’s approval is a 404 and is not resolved', async () => {
    const run = await waitingRun(otherId, theirAgent.id);
    const id = await approval({ who: otherId, agentId: theirAgent.id, runId: run });
    assert.equal((await api('POST', `/api/approvals/${id}`, { decision: 'approve' })).status, 404);
    assert.equal((await api('GET', `/api/approvals/${id}`)).status, 404);
    assert.equal((await api('POST', '/api/approvals/not-a-uuid', { decision: 'approve' })).status, 404);
    assert.equal((await query('SELECT status FROM agent_approvals WHERE id = $1', [id])).rows[0].status, 'pending');
    assert.equal(await runStatus(run), 'waiting_approval');
    assert.equal((await other('GET', `/api/approvals/${id}`)).data.approval.status, 'pending');
  });
});
