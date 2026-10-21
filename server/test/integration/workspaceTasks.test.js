import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { registeredSession, startServer } from '../helpers.js';

describe('tasks API', () => {
  let server;
  let api;
  let other;
  let agent;
  let theirAgent;

  before(async () => {
    server = await startServer();
    api = await registeredSession(server.base);
    other = await registeredSession(server.base);
    agent = (await api('POST', '/api/agents', { name: 'A', template: 'researcher' })).data.agent;
    theirAgent = (await other('POST', '/api/agents', { name: 'B', template: 'researcher' })).data.agent;
  });
  after(() => server.close());

  const create = (body = {}, who = api) =>
    who('POST', '/api/tasks', { agentId: agent.id, title: 'Sweep', instructions: 'Summarise new papers', ...body });

  test('requires a session', async () => {
    assert.equal((await fetch(`${server.base}/api/tasks`)).status, 401);
  });

  test('creates a one-off task with no next run', async () => {
    const { status, data } = await create();
    assert.equal(status, 201);
    assert.deepEqual(Object.keys(data.task), ['id', 'agentId', 'title', 'instructions', 'project', 'schedule', 'nextRunAt', 'enabled', 'createdAt', 'updatedAt']);
    assert.equal(data.task.agentId, agent.id);
    assert.equal(data.task.project, null);
    assert.equal(data.task.schedule, null);
    assert.equal(data.task.nextRunAt, null);
    assert.equal(data.task.enabled, true);
  });

  test('a scheduled, enabled task gets the next matching minute in UTC', async () => {
    const before = Date.now();
    const { data } = await create({ schedule: '*/15 * * * *', project: 'p' });
    const next = new Date(data.task.nextRunAt);
    assert.ok(next.getTime() > before && next.getTime() <= before + 15 * 60_000 + 1000);
    assert.equal(next.getUTCMinutes() % 15, 0);
    assert.equal(next.getUTCSeconds(), 0);
    assert.equal(data.task.project, 'p');
  });

  test('a disabled scheduled task has no next run', async () => {
    const { data } = await create({ schedule: '0 * * * *', enabled: false });
    assert.equal(data.task.nextRunAt, null);
    assert.equal(data.task.schedule, '0 * * * *');
  });

  test('a bad schedule is a 400 invalid_schedule with the cron message', async () => {
    for (const schedule of ['every day', '* * * *', '99 * * * *', '0 0 31 2 *', 12]) {
      const { status, data } = await create({ schedule });
      assert.equal(status, 400, String(schedule));
      assert.equal(data.error, 'invalid_schedule');
      assert.ok(data.message);
    }
    assert.equal((await api('GET', '/api/tasks')).data.tasks.some((t) => t.schedule === 'every day'), false);
  });

  test('other validation errors', async () => {
    for (const [code, body] of [
      ['invalid_title', { title: '' }],
      ['invalid_instructions', { instructions: '' }],
      ['invalid_project', { project: '' }],
      ['invalid_enabled', { enabled: 'yes' }],
      ['invalid_agent', { agentId: 'nope' }],
      ['invalid_agent', { agentId: undefined }],
    ]) {
      const { status, data } = await create(body);
      assert.deepEqual([status, data.error], [400, code], JSON.stringify(body));
    }
  });

  test('agentId must be the caller’s own agent', async () => {
    const stranger = await create({ agentId: theirAgent.id });
    assert.deepEqual([stranger.status, stranger.data.error], [404, 'agent_not_found']);
    const missing = await create({ agentId: '33333333-3333-4333-8333-333333333333' });
    assert.equal(missing.status, 404);
    // And the reverse: the other user cannot use this user's agent either.
    assert.equal((await create({ agentId: agent.id }, other)).status, 404);
  });

  test('list filters by agent and never shows other users’ tasks', async () => {
    const second = (await api('POST', '/api/agents', { name: 'C', template: 'builder' })).data.agent;
    const mine = (await create({ agentId: second.id, title: 'only-on-second' })).data.task;
    const theirs = (await create({ agentId: theirAgent.id, title: 'theirs' }, other)).data.task;
    const filtered = (await api('GET', `/api/tasks?agentId=${second.id}`)).data.tasks;
    assert.deepEqual(filtered.map((t) => t.id), [mine.id]);
    const all = (await api('GET', '/api/tasks')).data.tasks.map((t) => t.id);
    assert.ok(all.includes(mine.id));
    assert.ok(!all.includes(theirs.id));
    assert.equal((await api('GET', '/api/tasks?agentId=nope')).status, 400);
    assert.deepEqual((await api('GET', `/api/tasks?agentId=${theirAgent.id}`)).data.tasks, []);
  });

  test('get, patch and delete; the next run is recomputed on every update', async () => {
    const { data } = await create({ schedule: '0 9 * * *' });
    const id = data.task.id;
    const first = data.task.nextRunAt;
    assert.equal(new Date(first).getUTCHours(), 9);

    const moved = (await api('PATCH', `/api/tasks/${id}`, { schedule: '30 14 * * *' })).data.task;
    assert.equal(new Date(moved.nextRunAt).getUTCHours(), 14);
    assert.equal(new Date(moved.nextRunAt).getUTCMinutes(), 30);

    const disabled = (await api('PATCH', `/api/tasks/${id}`, { enabled: false })).data.task;
    assert.equal(disabled.nextRunAt, null);
    assert.equal(disabled.schedule, '30 14 * * *');

    const enabled = (await api('PATCH', `/api/tasks/${id}`, { enabled: true, title: 'Renamed' })).data.task;
    assert.ok(enabled.nextRunAt);
    assert.equal(enabled.title, 'Renamed');
    assert.equal(enabled.instructions, 'Summarise new papers');

    const cleared = (await api('PATCH', `/api/tasks/${id}`, { schedule: null, project: null })).data.task;
    assert.deepEqual([cleared.schedule, cleared.nextRunAt], [null, null]);

    assert.equal((await api('GET', `/api/tasks/${id}`)).data.task.title, 'Renamed');
    assert.equal((await api('DELETE', `/api/tasks/${id}`)).status, 204);
    assert.equal((await api('GET', `/api/tasks/${id}`)).status, 404);
    assert.equal((await api('DELETE', `/api/tasks/${id}`)).status, 404);
  });

  test('patch validates, and a failed patch changes nothing', async () => {
    const { data } = await create({ schedule: '0 9 * * *' });
    const id = data.task.id;
    const bad = await api('PATCH', `/api/tasks/${id}`, { schedule: 'bogus', title: 'Changed' });
    assert.deepEqual([bad.status, bad.data.error], [400, 'invalid_schedule']);
    const unchanged = (await api('GET', `/api/tasks/${id}`)).data.task;
    assert.equal(unchanged.title, 'Sweep');
    assert.equal(unchanged.schedule, '0 9 * * *');
    assert.equal((await api('PATCH', `/api/tasks/${id}`, { agentId: theirAgent.id })).status, 404);
    const reassigned = (await api('POST', '/api/agents', { name: 'D', template: 'builder' })).data.agent;
    assert.equal((await api('PATCH', `/api/tasks/${id}`, { agentId: reassigned.id })).data.task.agentId, reassigned.id);
  });

  test('another user’s task is a 404 for every verb', async () => {
    const { data } = await create({ agentId: theirAgent.id }, other);
    const id = data.task.id;
    for (const [method, body] of [['GET'], ['PATCH', { title: 'x' }], ['DELETE']]) {
      assert.equal((await api(method, `/api/tasks/${id}`, body)).status, 404, method);
    }
    assert.equal((await api('GET', '/api/tasks/not-a-uuid')).status, 404);
    assert.equal((await other('GET', `/api/tasks/${id}`)).data.task.title, 'Sweep');
  });
});
