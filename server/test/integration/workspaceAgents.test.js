import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { workspaceEvents } from '../../src/workspace/events.js';
import { registeredSession, startServer } from '../helpers.js';

describe('agents API', () => {
  let server;
  let api;
  let other;
  let userId;
  let otherId;

  const makeAgent = async (body = {}, who = api) => {
    const { status, data } = await who('POST', '/api/agents', { name: 'Ada', template: 'builder', ...body });
    assert.equal(status, 201, JSON.stringify(data));
    return data.agent;
  };
  const insertRun = async (agentId, status, ownerId = userId) =>
    (await server.pool.query("INSERT INTO agent_runs (owner_id, agent_id, instructions, status) VALUES ($1, $2, 'go', $3) RETURNING id", [ownerId, agentId, status])).rows[0].id;
  const runStatus = async (id) =>
    (await server.pool.query('SELECT status, finished_at FROM agent_runs WHERE id = $1', [id])).rows[0];

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
  });
  after(() => server.close());

  test('requires a session', async () => {
    const anonymous = await fetch(`${server.base}/api/agents`);
    assert.equal(anonymous.status, 401);
  });

  describe('create', () => {
    test('from a built-in template, with the documented defaults', async () => {
      const agent = await makeAgent({ name: '  Ada  ' });
      assert.equal(agent.name, 'Ada');
      assert.deepEqual(agent.role.tags, ['graph', 'code', 'scripts', 'vcs']);
      assert.equal(agent.role.template, 'builder');
      assert.equal(agent.role.title, 'Builder');
      assert.equal(agent.level, 'supervised');
      assert.equal(agent.modelPolicy, 'local_only');
      assert.deepEqual(agent.scopes, { read: { projects: ['*'], sources: ['*'] }, write: { projects: [] } });
      assert.deepEqual(agent.budget, { maxTokens: 200000, maxUsd: 0.5, maxWallMs: 3600000 });
      assert.equal(agent.state, 'active');
      assert.deepEqual(agent.overrides, {});
      assert.match(agent.color, /^#[0-9a-f]{6}$/);
      assert.match(agent.id, /^[0-9a-f-]{36}$/);
      assert.ok(agent.createdAt && agent.updatedAt);
    });

    test('the template is copied, so editing the agent never changes the template', async () => {
      const agent = await makeAgent();
      await api('PATCH', `/api/agents/${agent.id}`, { role: { embodiment: 'Be terse.', tags: ['graph'] } });
      const { data } = await api('GET', '/api/agents/templates');
      assert.notEqual(data.templates.find((t) => t.template === 'builder').embodiment, 'Be terse.');
    });

    test('colours cycle deterministically through the palette', async () => {
      const fresh = await registeredSession(server.base);
      const colors = [];
      for (let i = 0; i < 3; i += 1) colors.push((await makeAgent({ name: `a${i}` }, fresh)).color);
      assert.equal(new Set(colors).size, 3);
      const again = await registeredSession(server.base);
      const second = [];
      for (let i = 0; i < 3; i += 1) second.push((await makeAgent({ name: `a${i}` }, again)).color);
      assert.deepEqual(second, colors);
    });

    test('from one of the user’s own roles (copied, not linked)', async () => {
      const { data } = await api('POST', '/api/agents/roles', { title: 'Reviewer', embodiment: 'Review.', tags: ['graph', 'code'] });
      const agent = await makeAgent({ template: undefined, roleId: data.role.id });
      assert.deepEqual(agent.role, { template: null, title: 'Reviewer', description: '', embodiment: 'Review.', tags: ['graph', 'code'] });
      await api('PATCH', `/api/agents/roles/${data.role.id}`, { title: 'Changed' });
      assert.equal((await api('GET', `/api/agents/${agent.id}`)).data.agent.role.title, 'Reviewer');
      await api('DELETE', `/api/agents/roles/${data.role.id}`);
      assert.equal((await api('GET', `/api/agents/${agent.id}`)).status, 200);
    });

    test('from a custom role object', async () => {
      const agent = await makeAgent({ template: undefined, role: { title: 'Scribe', tags: ['graph'] } });
      assert.equal(agent.role.template, null);
      assert.equal(agent.role.title, 'Scribe');
    });

    test('accepts explicit settings', async () => {
      const agent = await makeAgent({
        level: 'sandboxed',
        overrides: { web: 'deny' },
        scopes: { read: { projects: ['p'], sources: ['github'] }, write: { projects: ['p'] } },
        modelPolicy: 'local_cloud',
        budget: { maxUsd: 2 },
        color: '#ABCDEF',
      });
      assert.equal(agent.level, 'sandboxed');
      assert.deepEqual(agent.overrides, { web: 'deny' });
      assert.deepEqual(agent.scopes.write.projects, ['p']);
      assert.equal(agent.modelPolicy, 'local_cloud');
      assert.deepEqual(agent.budget, { maxTokens: 200000, maxUsd: 2, maxWallMs: 3600000 });
      assert.equal(agent.color, '#abcdef');
    });

    const invalid = [
      ['invalid_name', { name: '' }],
      ['invalid_name', { name: 'x'.repeat(81) }],
      ['invalid_name', { name: 5 }],
      ['invalid_level', { level: 'root' }],
      ['invalid_overrides', { overrides: { shell: 'allow' } }],
      ['invalid_overrides', { overrides: { web: 'maybe' } }],
      ['invalid_scopes', { scopes: { read: { projects: 'p' } } }],
      ['invalid_scopes', { scopes: { write: { projects: [''] } } }],
      ['invalid_model_policy', { modelPolicy: 'cloud' }],
      ['own_key_requires_key_pro', { modelPolicy: 'own_key' }],
      ['invalid_budget', { budget: { maxUsd: 0 } }],
      ['invalid_budget', { budget: { maxTokens: -5 } }],
      ['invalid_budget', { budget: { maxWallMs: 'long' } }],
      ['invalid_color', { color: 'red' }],
      ['invalid_role', { template: undefined, role: { title: '' } }],
      ['invalid_role', { template: undefined, role: { title: 'T', embodiment: 'x'.repeat(8001) } }],
      ['unknown_template', { template: 'wizard' }],
      ['ambiguous_role', { role: { title: 'T' } }],
    ];
    for (const [code, body] of invalid) {
      test(`rejects ${JSON.stringify(body).slice(0, 60)} with ${code}`, async () => {
        const { status, data } = await api('POST', '/api/agents', { name: 'Ada', template: 'builder', ...body });
        assert.equal(status, 400);
        assert.equal(data.error, code);
      });
    }

    test('an unknown or foreign roleId is a 404', async () => {
      const { data } = await other('POST', '/api/agents/roles', { title: 'Theirs' });
      for (const roleId of [data.role.id, '22222222-2222-4222-8222-222222222222', 'nope']) {
        const result = await api('POST', '/api/agents', { name: 'x', roleId });
        assert.equal(result.status, 404, roleId);
        assert.equal(result.data.error, 'role_not_found');
      }
    });

    test('own_key is accepted only on the key_pro plan', async () => {
      const keyed = await registeredSession(server.base);
      const id = (await keyed('GET', '/api/auth/session')).data.userId;
      await server.pool.query("UPDATE users SET plan = 'key_pro' WHERE id = $1", [id]);
      const agent = await makeAgent({ modelPolicy: 'own_key' }, keyed);
      assert.equal(agent.modelPolicy, 'own_key');
      // Patching in own_key for a free user is refused too.
      const free = await makeAgent();
      const refused = await api('PATCH', `/api/agents/${free.id}`, { modelPolicy: 'own_key' });
      assert.deepEqual([refused.status, refused.data.error], [400, 'own_key_requires_key_pro']);
      // A downgraded user can still edit other fields of an own_key agent.
      await server.pool.query("UPDATE users SET plan = 'free' WHERE id = $1", [id]);
      const edited = await keyed('PATCH', `/api/agents/${agent.id}`, { name: 'Renamed', modelPolicy: 'own_key' });
      assert.equal(edited.status, 200);
    });
  });

  describe('read, update, delete', () => {
    test('lists only the caller’s agents', async () => {
      const mine = await makeAgent({ name: 'mine' });
      const theirs = await makeAgent({ name: 'theirs' }, other);
      const ids = (await api('GET', '/api/agents')).data.agents.map((a) => a.id);
      assert.ok(ids.includes(mine.id));
      assert.ok(!ids.includes(theirs.id));
    });

    test('patch updates any field except state and validates like create', async () => {
      const agent = await makeAgent({ budget: { maxUsd: 3 } });
      const { status, data } = await api('PATCH', `/api/agents/${agent.id}`, {
        name: 'New',
        level: 'agentic',
        overrides: { open_pr: 'deny' },
        scopes: { write: { projects: ['p'] } },
        budget: { maxTokens: 10 },
        color: '#000000',
        role: { title: 'Lead' },
      });
      assert.equal(status, 200);
      assert.equal(data.agent.name, 'New');
      assert.equal(data.agent.level, 'agentic');
      assert.deepEqual(data.agent.overrides, { open_pr: 'deny' });
      // Omitted scope parts become empty, never wider.
      assert.deepEqual(data.agent.scopes, { read: { projects: [], sources: [] }, write: { projects: ['p'] } });
      assert.deepEqual(data.agent.budget, { maxTokens: 10, maxUsd: 3, maxWallMs: 3600000 });
      assert.equal(data.agent.role.title, 'Lead');
      assert.equal(data.agent.role.embodiment.length > 0, true, 'untouched role fields are kept');
      assert.ok(data.agent.updatedAt >= agent.updatedAt);

      for (const [code, body] of [['state_not_editable', { state: 'killed' }], ['invalid_level', { level: 'x' }], ['invalid_budget', { budget: { maxUsd: -1 } }], ['invalid_name', { name: ' ' }]]) {
        const bad = await api('PATCH', `/api/agents/${agent.id}`, body);
        assert.deepEqual([bad.status, bad.data.error], [400, code]);
      }
      assert.equal((await api('GET', `/api/agents/${agent.id}`)).data.agent.name, 'New');
    });

    test('delete removes the agent (and its tasks)', async () => {
      const agent = await makeAgent();
      await api('POST', '/api/tasks', { agentId: agent.id, title: 't', instructions: 'i' });
      assert.equal((await api('DELETE', `/api/agents/${agent.id}`)).status, 204);
      assert.equal((await api('GET', `/api/agents/${agent.id}`)).status, 404);
      assert.equal((await api('DELETE', `/api/agents/${agent.id}`)).status, 404);
      assert.equal((await server.pool.query('SELECT 1 FROM tasks WHERE agent_id = $1', [agent.id])).rowCount, 0);
    });

    test('another user’s agent is a 404 for every verb', async () => {
      const theirs = await makeAgent({}, other);
      for (const [method, path, body] of [
        ['GET', `/api/agents/${theirs.id}`],
        ['PATCH', `/api/agents/${theirs.id}`, { name: 'x' }],
        ['DELETE', `/api/agents/${theirs.id}`],
        ['POST', `/api/agents/${theirs.id}/pause`],
        ['POST', `/api/agents/${theirs.id}/resume`],
        ['POST', `/api/agents/${theirs.id}/kill`],
        ['POST', `/api/agents/${theirs.id}/reactivate`],
        ['GET', `/api/agents/${theirs.id}/can?capability=read_graph`],
        ['GET', '/api/agents/not-a-uuid'],
      ]) {
        assert.equal((await api(method, path, body)).status, 404, `${method} ${path}`);
      }
      const still = (await other('GET', `/api/agents/${theirs.id}`)).data.agent;
      assert.equal(still.name, 'Ada');
      assert.equal(still.state, 'active');
    });
  });

  describe('templates and roles', () => {
    test('lists the six built-in templates', async () => {
      const { status, data } = await api('GET', '/api/agents/templates');
      assert.equal(status, 200);
      assert.deepEqual(data.templates.map((t) => t.template), ['researcher', 'builder', 'debugger', 'physicist', 'hardware_engineer', 'cad_designer']);
    });

    test('role CRUD with owner isolation and validation', async () => {
      const created = await api('POST', '/api/agents/roles', { title: 'Mine', description: 'd', embodiment: 'e', tags: ['graph'] });
      assert.equal(created.status, 201);
      const id = created.data.role.id;
      assert.equal(created.data.role.template, null);
      assert.ok((await api('GET', '/api/agents/roles')).data.roles.some((r) => r.id === id));
      assert.ok(!(await other('GET', '/api/agents/roles')).data.roles.some((r) => r.id === id));

      const patched = await api('PATCH', `/api/agents/roles/${id}`, { description: 'new' });
      assert.equal(patched.data.role.description, 'new');
      assert.equal(patched.data.role.title, 'Mine');

      assert.equal((await api('POST', '/api/agents/roles', { title: '' })).data.error, 'invalid_role');
      assert.equal((await api('PATCH', `/api/agents/roles/${id}`, { tags: 'x' })).status, 400);

      for (const [method, body] of [['GET'], ['PATCH', { title: 'x' }], ['DELETE']]) {
        assert.equal((await other(method, `/api/agents/roles/${id}`, body)).status, 404, method);
      }
      assert.equal((await api('DELETE', `/api/agents/roles/${id}`)).status, 204);
      assert.equal((await api('DELETE', `/api/agents/roles/${id}`)).status, 404);
    });

    test('"templates" and "roles" are not mistaken for agent ids', async () => {
      assert.equal((await api('GET', '/api/agents/roles')).status, 200);
      assert.equal((await api('GET', '/api/agents/templates')).status, 200);
    });
  });

  describe('lifecycle', () => {
    test('pause moves live runs to paused and publishes run.paused; resume re-queues them', async () => {
      const agent = await makeAgent();
      const other2 = await makeAgent({ name: 'bystander' });
      const runs = {
        queued: await insertRun(agent.id, 'queued'),
        running: await insertRun(agent.id, 'running'),
        waiting: await insertRun(agent.id, 'waiting_approval'),
        done: await insertRun(agent.id, 'succeeded'),
        bystander: await insertRun(other2.id, 'queued'),
      };
      const { events, stop } = collect(userId);
      const paused = await api('POST', `/api/agents/${agent.id}/pause`);
      assert.equal(paused.status, 200);
      assert.equal(paused.data.agent.state, 'paused');
      assert.deepEqual(
        await Promise.all(Object.values(runs).map(async (id) => (await runStatus(id)).status)),
        ['paused', 'paused', 'paused', 'succeeded', 'queued']
      );
      const pausedEvents = events.filter((e) => e.type === 'run.paused');
      assert.deepEqual(pausedEvents.map((e) => e.runId).sort(), [runs.queued, runs.running, runs.waiting].sort());
      assert.ok(pausedEvents.every((e) => e.agentId === agent.id));

      assert.equal((await api('POST', `/api/agents/${agent.id}/pause`)).status, 409);

      const resumed = await api('POST', `/api/agents/${agent.id}/resume`);
      stop();
      assert.equal(resumed.data.agent.state, 'active');
      assert.deepEqual(
        await Promise.all([runs.queued, runs.running, runs.waiting, runs.done].map(async (id) => (await runStatus(id)).status)),
        ['queued', 'queued', 'queued', 'succeeded']
      );
      assert.deepEqual(events.filter((e) => e.type === 'run.queued').map((e) => e.runId).sort(), [runs.queued, runs.running, runs.waiting].sort());
      assert.equal((await api('POST', `/api/agents/${agent.id}/resume`)).status, 409);
    });

    test('resume clears the lease a run was paused with, so any worker can claim it', async () => {
      const agent = await makeAgent();
      const run = await insertRun(agent.id, 'running');
      await server.pool.query("UPDATE agent_runs SET lease_owner = 'old-worker', lease_until = now() + interval '1 hour' WHERE id = $1", [run]);
      await api('POST', `/api/agents/${agent.id}/pause`);
      await api('POST', `/api/agents/${agent.id}/resume`);
      const { rows: [row] } = await server.pool.query('SELECT status, lease_owner, lease_until FROM agent_runs WHERE id = $1', [run]);
      assert.deepEqual(row, { status: 'queued', lease_owner: null, lease_until: null });
    });

    test('kill stops every non-terminal run, expires their approvals and publishes run.finished', async () => {
      const agent = await makeAgent();
      const runs = {
        queued: await insertRun(agent.id, 'queued'),
        running: await insertRun(agent.id, 'running'),
        paused: await insertRun(agent.id, 'paused'),
        waiting: await insertRun(agent.id, 'waiting_approval'),
        succeeded: await insertRun(agent.id, 'succeeded'),
        failed: await insertRun(agent.id, 'failed'),
      };
      const approval = (await server.pool.query(
        "INSERT INTO agent_approvals (owner_id, agent_id, run_id, capability, summary) VALUES ($1, $2, $3, 'web', 's') RETURNING id",
        [userId, agent.id, runs.waiting]
      )).rows[0].id;
      const settled = (await server.pool.query(
        "INSERT INTO agent_approvals (owner_id, agent_id, run_id, capability, summary, status) VALUES ($1, $2, $3, 'web', 's', 'approved') RETURNING id",
        [userId, agent.id, runs.succeeded]
      )).rows[0].id;
      const { events, stop } = collect(userId);

      const killed = await api('POST', `/api/agents/${agent.id}/kill`);
      stop();
      assert.equal(killed.status, 200);
      assert.equal(killed.data.agent.state, 'killed');
      for (const id of [runs.queued, runs.running, runs.paused, runs.waiting]) {
        const run = await runStatus(id);
        assert.equal(run.status, 'killed');
        assert.ok(run.finished_at);
      }
      assert.equal((await runStatus(runs.succeeded)).status, 'succeeded');
      assert.equal((await runStatus(runs.failed)).status, 'failed');
      const status = async (id) => (await server.pool.query('SELECT status, resolved_at FROM agent_approvals WHERE id = $1', [id])).rows[0];
      assert.equal((await status(approval)).status, 'expired');
      assert.ok((await status(approval)).resolved_at);
      assert.equal((await status(settled)).status, 'approved');

      const finished = events.filter((e) => e.type === 'run.finished');
      assert.deepEqual(finished.map((e) => e.runId).sort(), [runs.queued, runs.running, runs.paused, runs.waiting].sort());
      assert.ok(finished.every((e) => e.data.status === 'killed'));
      assert.ok(events.some((e) => e.type === 'approval.resolved' && e.data.approvalId === approval && e.data.status === 'expired'));

      assert.equal((await api('POST', `/api/agents/${agent.id}/kill`)).status, 409);
      assert.equal((await api('POST', `/api/agents/${agent.id}/pause`)).status, 409);
      assert.equal((await api('POST', `/api/agents/${agent.id}/resume`)).status, 409);
    });

    test('a paused agent can be killed; reactivate leaves killed runs killed', async () => {
      const agent = await makeAgent();
      const run = await insertRun(agent.id, 'running');
      await api('POST', `/api/agents/${agent.id}/pause`);
      assert.equal((await api('POST', `/api/agents/${agent.id}/kill`)).data.agent.state, 'killed');
      assert.equal((await runStatus(run)).status, 'killed');
      assert.equal((await api('POST', `/api/agents/${agent.id}/reactivate`)).data.agent.state, 'active');
      assert.equal((await runStatus(run)).status, 'killed');
      // Only a killed agent can be reactivated.
      assert.equal((await api('POST', `/api/agents/${agent.id}/reactivate`)).status, 409);
    });

    test('lifecycle changes touch only the caller’s own agent’s runs', async () => {
      const mine = await makeAgent();
      const theirs = await makeAgent({}, other);
      const theirRun = await insertRun(theirs.id, 'running', otherId);
      await api('POST', `/api/agents/${mine.id}/kill`);
      assert.equal((await runStatus(theirRun)).status, 'running');
    });

    test('events for one owner never reach another', async () => {
      const agent = await makeAgent();
      await insertRun(agent.id, 'queued');
      const { events, stop } = collect(otherId);
      await api('POST', `/api/agents/${agent.id}/kill`);
      stop();
      assert.deepEqual(events, []);
    });
  });

  describe('GET /:id/can', () => {
    const can = (id, query) => api('GET', `/api/agents/${id}/can?${new URLSearchParams(query)}`);

    test('answers with decision and reason from decide()', async () => {
      const agent = await makeAgent({ level: 'agentic', scopes: { read: { projects: ['*'], sources: ['*'] }, write: { projects: ['p'] } } });
      assert.deepEqual((await can(agent.id, { capability: 'edit_files', project: 'p' })).data, { decision: 'allow', reason: 'level' });
      assert.deepEqual((await can(agent.id, { capability: 'edit_files', project: 'q' })).data, { decision: 'deny', reason: 'outside_write_scope' });
      assert.deepEqual((await can(agent.id, { capability: 'nope' })).data, { decision: 'deny', reason: 'unknown_capability' });
    });

    test('omitted flags take the cautious value; only literal true/false parse', async () => {
      const agent = await makeAgent({ level: 'agentic', modelPolicy: 'local_cloud', scopes: { read: { projects: ['*'], sources: ['*'] }, write: { projects: ['*'] } } });
      assert.equal((await can(agent.id, { capability: 'web' })).data.reason, 'offline');
      assert.equal((await can(agent.id, { capability: 'web', online: 'true' })).data.decision, 'allow');
      assert.equal((await can(agent.id, { capability: 'web', online: 'false' })).data.reason, 'offline');
      assert.equal((await can(agent.id, { capability: 'cloud_model', online: 'true' })).data.reason, 'private_context');
      assert.equal((await can(agent.id, { capability: 'cloud_model', online: 'true', privateContext: 'false' })).data.decision, 'allow');
      assert.equal((await can(agent.id, { capability: 'run_generated_code' })).data.reason, 'outside_sandbox');
      assert.equal((await can(agent.id, { capability: 'run_generated_code', inSandbox: 'true' })).data.decision, 'allow');
      for (const value of ['1', 'yes', 'TRUE', '']) {
        const result = await can(agent.id, { capability: 'web', online: value });
        assert.equal(result.status, 400, value);
        assert.equal(result.data.error, 'invalid_online');
      }
      assert.equal((await can(agent.id, { capability: 'run_generated_code', inSandbox: 'maybe' })).data.error, 'invalid_inSandbox');
      assert.equal((await can(agent.id, { capability: 'cloud_model', privateContext: 'no' })).data.error, 'invalid_privateContext');
    });

    test('reads respect source scope; a missing capability is a 400', async () => {
      const agent = await makeAgent({ scopes: { read: { projects: ['p'], sources: ['github'] } } });
      assert.equal((await can(agent.id, { capability: 'read_graph', project: 'p', source: 'github' })).data.decision, 'allow');
      assert.equal((await can(agent.id, { capability: 'read_graph', project: 'p', source: 'kicad' })).data.reason, 'outside_read_scope');
      assert.equal((await can(agent.id, { capability: 'read_graph', project: 'p' })).data.reason, 'outside_read_scope');
      assert.equal((await can(agent.id, {})).data.error, 'capability_required');
    });

    test('a paused or killed agent is denied everything', async () => {
      const agent = await makeAgent({ level: 'agentic' });
      await api('POST', `/api/agents/${agent.id}/pause`);
      assert.deepEqual((await can(agent.id, { capability: 'write_notes', project: 'p' })).data.reason, 'agent_paused');
      await api('POST', `/api/agents/${agent.id}/kill`);
      assert.deepEqual((await can(agent.id, { capability: 'read_graph', project: 'p' })).data.reason, 'agent_killed');
    });

    test('overrides show up as the reason', async () => {
      const agent = await makeAgent({ overrides: { write_notes: 'deny' }, scopes: { write: { projects: ['*'] } } });
      assert.deepEqual((await can(agent.id, { capability: 'write_notes', project: 'p' })).data, { decision: 'deny', reason: 'override' });
    });
  });
});
