import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { workspaceEvents } from '../../src/workspace/events.js';
import { registeredSession, session, startServer } from '../helpers.js';

describe('agent-workspace contract', () => {
  let server;
  let api;

  before(async () => {
    server = await startServer();
    api = await registeredSession(server.base);
  });

  after(() => server.close());

  test('the write-back node and relationship types are accepted', async () => {
    const insert = (type) =>
      server.pool.query("INSERT INTO nodes (type, content, source, privacy) VALUES ($1, 'x', 'agent', 'local') RETURNING id", [type]);
    const ids = [];
    for (const type of ['plan', 'step', 'finding', 'decision', 'artifact', 'question']) {
      ids.push((await insert(type)).rows[0].id);
    }
    for (const type of ['derived_from', 'produces', 'follows', 'answers', 'part_of']) {
      await server.pool.query('INSERT INTO node_relationships (source_id, target_id, type) VALUES ($1, $2, $3)', [ids[0], ids[1], type]);
    }
    await assert.rejects(insert('wish'));
  });

  test('workspace tables cascade from their owner', async () => {
    const { rows: [user] } = await server.pool.query("INSERT INTO users (email, password_hash) VALUES ('cascade@example.com', 'x') RETURNING id");
    const { rows: [agent] } = await server.pool.query("INSERT INTO agents (owner_id, name) VALUES ($1, 'a') RETURNING id, level, model_policy, state", [user.id]);
    assert.deepEqual([agent.level, agent.model_policy, agent.state], ['supervised', 'local_only', 'active']);
    const { rows: [run] } = await server.pool.query("INSERT INTO agent_runs (owner_id, agent_id, instructions) VALUES ($1, $2, 'go') RETURNING id, status", [user.id, agent.id]);
    assert.equal(run.status, 'queued');
    await server.pool.query("INSERT INTO agent_run_steps (run_id, index, kind) VALUES ($1, 0, 'plan')", [run.id]);
    // A run can never point at another user's agent.
    const { rows: [stranger] } = await server.pool.query("INSERT INTO users (email, password_hash) VALUES ('stranger@example.com', 'x') RETURNING id");
    await assert.rejects(server.pool.query("INSERT INTO agent_runs (owner_id, agent_id, instructions) VALUES ($1, $2, 'go')", [stranger.id, agent.id]));
    await server.pool.query('DELETE FROM users WHERE id = $1', [user.id]);
    const { rows } = await server.pool.query('SELECT (SELECT count(*) FROM agents WHERE id = $1)::int AS agents, (SELECT count(*) FROM agent_run_steps WHERE run_id = $2)::int AS steps', [agent.id, run.id]);
    assert.deepEqual(rows[0], { agents: 0, steps: 0 });
  });

  test('stubbed routes need a session and answer 501 until their path lands', async () => {
    const anonymous = session(server.base);
    for (const path of ['/api/agents', '/api/tasks', '/api/approvals', '/api/agent-runs', '/api/workspace/events']) {
      assert.equal((await anonymous('GET', path)).status, 401, path);
    }
    for (const path of ['/api/agents', '/api/agents/x/kill', '/api/tasks', '/api/approvals', '/api/agent-runs']) {
      assert.equal((await api('GET', path)).status, 501, path);
    }
  });

  test('the event stream delivers only the signed-in owner’s events', async () => {
    const { data: { userId: ownerId } } = await api('GET', '/api/auth/session');
    const controller = new AbortController();
    const response = await api.raw('GET', '/api/workspace/events?runId=r-1', null, { signal: controller.signal });
    assert.equal(response.headers.get('content-type'), 'text/event-stream');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    workspaceEvents.publish({ runId: 'r-1', agentId: 'a', ownerId: 'someone-else', type: 'run.started' });
    workspaceEvents.publish({ runId: 'r-1', agentId: 'a', ownerId, type: 'run.finished', data: { status: 'succeeded' } });
    while (!text.includes('run.finished')) {
      const { value } = await reader.read();
      text += decoder.decode(value);
    }
    controller.abort();
    assert.match(text, /event: run\.finished/);
    assert.doesNotMatch(text, /run\.started/);
  });
});
