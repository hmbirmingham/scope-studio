import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { DEMO_EMAIL, DEMO_NODES, DEMO_PROJECT, DEMO_RELATIONSHIPS, WEEKLY_TASK } from '../../src/demo/content.js';
import { seedDemo } from '../../src/demo/seed.js';
import { createEventBus } from '../../src/workspace/events.js';
import { createWorker } from '../../src/workspace/runner/index.js';
import { roleTemplate } from '../../src/workspace/roles.js';
import { sandboxStatus } from '../../src/workspace/sandbox/index.js';
import { demoReply, LAB_TITLE, GUIDE_TITLE } from '../demoModel.js';
import { createFakeModelPort } from '../fakeModelPort.js';
import createApp from '../../src/app.js';
import loadEnv from '../../src/config/env.js';
import { registeredSession, session, startServer } from '../helpers.js';
import { useDataDir } from './workspaceSandboxFixtures.js';

// The student demo (docs/demo.md) on the real engine: the seed, local sign-in,
// and both demo tasks run by the real runner with the scripted demo model.

const sandbox = await sandboxStatus();
const needsOsSandbox = sandbox.available ? false : `no OS sandbox on this machine (${sandbox.reason})`;

// Local mode exactly as the demo launcher sets it up.
function enableLocalMode(overrides = {}) {
  Object.assign(process.env, { SCOPE_LOCAL_USER: DEMO_EMAIL, NODE_ENV: 'development', SCOPE_HOST: '127.0.0.1', ...overrides });
}

function disableLocalMode() {
  delete process.env.SCOPE_LOCAL_USER;
  delete process.env.SCOPE_HOST;
  process.env.NODE_ENV = 'test';
}

describe('student demo', () => {
  let server;
  let data;
  // A second engine on the same database, bound to loopback as the demo's is:
  // local sign-in is only ever granted by an engine listening on loopback.
  let loopback;
  let loopbackBase;
  const workers = [];

  before(async () => {
    server = await startServer();
    data = useDataDir();
    const app = createApp({ ...loadEnv(), nodeEnv: 'test' });
    loopback = await new Promise((resolve) => {
      const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    loopbackBase = `http://127.0.0.1:${loopback.address().port}`;
  });

  beforeEach(() => {
    for (const instance of workers.splice(0)) instance.abandon();
    disableLocalMode();
  });

  after(async () => {
    for (const instance of workers.splice(0)) instance.abandon();
    disableLocalMode();
    data.restore();
    await new Promise((resolve) => loopback.close(resolve));
    await server.close();
  });

  const count = async (sql, params) => (await server.pool.query(sql, params)).rows[0].count;

  describe('seed', () => {
    test('writes the student project, the agent and its tasks', async () => {
      const seeded = await seedDemo({ embed: false });
      assert.equal(seeded.user.email, DEMO_EMAIL);
      const { rows: nodes } = await server.pool.query('SELECT type, privacy, project, source, external_id, content FROM nodes WHERE owner_id = $1', [seeded.user.id]);
      assert.equal(nodes.length, DEMO_NODES.length);
      assert.ok(nodes.every((node) => node.project === DEMO_PROJECT && node.source === 'manual' && node.external_id.startsWith('scope-demo/')));
      assert.deepEqual(nodes.filter((node) => node.privacy === 'local').map((node) => node.content.split('\n')[0]), ['Private: my study log and grades']);
      assert.ok(nodes.some((node) => node.content.startsWith('Lab report draft')));
      assert.ok(nodes.some((node) => node.content.startsWith('Raw data: pendulum-data.csv')));
      assert.equal(
        await count('SELECT count(*)::int FROM node_relationships r JOIN nodes n ON n.id = r.source_id WHERE n.owner_id = $1', [seeded.user.id]),
        DEMO_RELATIONSHIPS.length
      );

      const { rows: [agent] } = await server.pool.query('SELECT * FROM agents WHERE owner_id = $1', [seeded.user.id]);
      assert.equal(agent.name, 'Lab Partner');
      assert.equal(agent.role.template, 'physicist');
      assert.deepEqual(agent.role.tags, ['graph', 'physics', 'sandbox']);
      assert.equal(agent.level, 'supervised');
      assert.equal(agent.model_policy, 'local_only');
      assert.deepEqual(agent.scopes, { read: { projects: [DEMO_PROJECT], sources: ['*'] }, write: { projects: [DEMO_PROJECT] } });

      const { rows: tasks } = await server.pool.query('SELECT title, schedule, next_run_at, project FROM tasks WHERE owner_id = $1 ORDER BY created_at, id', [seeded.user.id]);
      assert.equal(tasks.length, 3);
      assert.ok(tasks.every((task) => task.project === DEMO_PROJECT));
      const weekly = tasks.find((task) => task.title === WEEKLY_TASK);
      assert.equal(weekly.schedule, '0 18 * * 0');
      assert.equal(weekly.next_run_at.getUTCDay(), 0);
      assert.equal(weekly.next_run_at.getUTCHours(), 18);
    });

    test('a re-seed resets the demo account only, and keeps the account', async () => {
      const first = await seedDemo({ embed: false });
      // Something the demo made since: a run and a node an agent wrote.
      await server.pool.query("INSERT INTO agent_runs (owner_id, agent_id, instructions, project) VALUES ($1, $2, 'x', $3)", [first.user.id, first.agent.id, DEMO_PROJECT]);
      await server.pool.query("INSERT INTO nodes (owner_id, type, content, source, project) VALUES ($1, 'artifact', 'old', 'agent', $2)", [first.user.id, DEMO_PROJECT]);
      // A research record for one of its notes, and a Scope Studio sign-in.
      await server.pool.query("INSERT INTO research_items (node_id, owner_id, kind, item_key) VALUES ($1, $2, 'note', 'DEMO0001')", [first.nodeIds['lecture-7'], first.user.id]);
      await server.pool.query("INSERT INTO control_links (owner_id, token_sealed, account_id, email) VALUES ($1, 'sealed-test-not-real', 'acct-test', 'student@example.com')", [first.user.id]);
      // And another person's data in the same database.
      const other = await registeredSession(server.base);
      const { data: otherNode } = await other('POST', '/api/nodes', { type: 'decision', content: 'Not the demo', project: DEMO_PROJECT });
      const { data: { userId: otherId } } = await other('GET', '/api/auth/session');
      const { data: { agent: otherAgent } } = await other('POST', '/api/agents', { name: 'Theirs', template: 'researcher' });
      await server.pool.query("INSERT INTO control_links (owner_id, token_sealed, account_id, email) VALUES ($1, 'sealed-test-not-real', 'acct-other', 'other@example.com')", [otherId]);

      const second = await seedDemo({ embed: false });
      assert.equal(second.user.id, first.user.id);
      assert.equal(await count('SELECT count(*)::int FROM nodes WHERE owner_id = $1', [first.user.id]), DEMO_NODES.length);
      assert.equal(await count('SELECT count(*)::int FROM agent_runs WHERE owner_id = $1', [first.user.id]), 0);
      assert.equal(await count('SELECT count(*)::int FROM agents WHERE owner_id = $1', [first.user.id]), 1);
      assert.equal(await count('SELECT count(*)::int FROM tasks WHERE owner_id = $1', [first.user.id]), 3);
      assert.equal(await count('SELECT count(*)::int FROM research_items WHERE owner_id = $1', [first.user.id]), 0);
      assert.equal(await count('SELECT count(*)::int FROM control_links WHERE owner_id = $1', [first.user.id]), 0);
      assert.equal(await count('SELECT count(*)::int FROM control_links WHERE owner_id = $1', [otherId]), 1);

      assert.equal(await count('SELECT count(*)::int FROM nodes WHERE id = $1 AND owner_id = $2', [otherNode.id, otherId]), 1);
      assert.equal(await count('SELECT count(*)::int FROM agents WHERE id = $1 AND owner_id = $2', [otherAgent.id, otherId]), 1);
    });
  });

  describe('local sign-in', () => {
    const signIn = (api, headers = { 'X-Scope-Local-Signin': '1' }) => api.raw('POST', '/api/auth/local', undefined, { headers });

    test('signs this machine’s browser in to the demo account, and says it will', async () => {
      const seeded = await seedDemo({ embed: false });
      enableLocalMode();
      const api = session(loopbackBase);
      const before = await api('GET', '/api/auth/session');
      assert.equal(before.status, 401);
      assert.deepEqual(before.data, { error: 'not authenticated', localSignin: true });
      const response = await signIn(api, { 'X-Scope-Local-Signin': '1', Origin: loopbackBase });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { id: seeded.user.id, email: DEMO_EMAIL });
      const { status, data: me } = await api('GET', '/api/auth/session');
      assert.equal(status, 200);
      assert.equal(me.userId, seeded.user.id);
      const { data: graph } = await api('GET', '/api/graph');
      assert.equal(graph.nodes.length, DEMO_NODES.length);
    });

    test('is neither offered nor granted by an engine listening on every interface', async () => {
      await seedDemo({ embed: false });
      enableLocalMode();
      const api = session(server.base);
      assert.deepEqual((await api('GET', '/api/auth/session')).data, { error: 'not authenticated' });
      assert.equal((await signIn(api)).status, 404);
      assert.equal((await api('GET', '/api/auth/session')).status, 401);
    });

    test('is refused without the header, from another origin, through a proxy, or outside the demo’s exact configuration', async () => {
      await seedDemo({ embed: false });
      const other = await registeredSession(server.base);
      const { data: { userId: otherId } } = await other('GET', '/api/auth/session');
      const { rows: [otherUser] } = await server.pool.query('SELECT email FROM users WHERE id = $1', [otherId]);
      const api = session(loopbackBase);
      const refused = async (headers, label) => {
        const response = await signIn(api, headers);
        assert.equal(response.status, 404, label);
        assert.deepEqual(await response.json(), { error: 'local_signin_unavailable' }, label);
      };

      enableLocalMode();
      await refused({}, 'no header');
      await refused({ 'X-Scope-Local-Signin': '1', Origin: 'https://evil.example' }, 'cross-site origin');
      await refused({ 'X-Scope-Local-Signin': '1', 'X-Forwarded-For': '192.168.1.20' }, 'forwarded by a proxy');

      enableLocalMode({ NODE_ENV: 'production' });
      await refused(undefined, 'production');
      enableLocalMode({ NODE_ENV: '' });
      await refused(undefined, 'NODE_ENV unset');
      enableLocalMode({ SCOPE_HOST: '0.0.0.0' });
      await refused(undefined, 'not configured for loopback');
      // A real account, even one that exists, is never signed in this way.
      enableLocalMode({ SCOPE_LOCAL_USER: otherUser.email });
      await refused(undefined, 'a real account');
      disableLocalMode();
      await refused(undefined, 'local mode off');
      assert.equal((await api('GET', '/api/auth/session')).status, 401);
    });

    test('is refused for the demo account until it has been seeded', async () => {
      await server.pool.query('DELETE FROM users WHERE email = $1', [DEMO_EMAIL]);
      enableLocalMode();
      assert.equal((await signIn(session(loopbackBase))).status, 404);
    });
  });

  describe('the demo tasks on the runner', () => {
    let bus;
    let local;
    let api;
    let seeded;

    beforeEach(async () => {
      seeded = await seedDemo({ embed: false });
      enableLocalMode();
      api = session(loopbackBase);
      const signedIn = await api.raw('POST', '/api/auth/local', undefined, { headers: { 'X-Scope-Local-Signin': '1' } });
      assert.equal(signedIn.status, 200, await signedIn.text());
      assert.equal((await api('GET', '/api/auth/session')).status, 200);
      bus = createEventBus();
      local = createFakeModelPort({ name: 'local', fallback: (request) => demoReply(request.messages) ?? 'unscripted' });
    });

    function worker() {
      const instance = createWorker({ adapters: { local }, events: bus, embed: false, online: () => false, leaseMs: 30_000, heartbeatMs: 25, onError: () => {} });
      workers.push(instance);
      return instance;
    }

    const taskId = (title) => seeded.tasks.find((task) => task.title === title).id;

    test('“Check my lab report”: asks before running the analysis, then saves the fixes as an artifact', { skip: needsOsSandbox }, async () => {
      const events = [];
      bus.subscribe({ ownerId: seeded.user.id }, (event) => events.push(event));
      const { status, data: { run: started } } = await api('POST', '/api/agent-runs', { taskId: taskId('Check my lab report against the data') });
      assert.equal(status, 201);
      const runner = worker();
      await runner.drain();

      // Planning is a note (allowed); running model-written code asks.
      let { data: { run } } = await api('GET', `/api/agent-runs/${started.id}`);
      assert.equal(run.status, 'waiting_approval');
      const { data: { approvals } } = await api('GET', '/api/approvals?status=pending');
      assert.equal(approvals.length, 1);
      assert.equal(approvals[0].capability, 'code.run_generated');
      assert.match(approvals[0].summary, /Recompute g/);
      assert.match(approvals[0].detail.input.code, /4 \* Math\.PI \*\* 2/);

      assert.equal((await api('POST', `/api/approvals/${approvals[0].id}`, { decision: 'approve' })).status, 200);
      await runner.drain();

      ({ data: { run } } = await api('GET', `/api/agent-runs/${started.id}`));
      assert.equal(run.status, 'succeeded');
      assert.deepEqual(run.steps.map((step) => [step.capability, step.status]), [
        [null, 'done'],
        ['code.run_generated', 'done'],
        ['graph.write_artifact', 'done'],
        [null, 'done'],
      ]);
      // The analysis really ran, in the OS sandbox, and computed g.
      assert.match(run.steps[1].output.output, /g = 4π²\/slope = 9\.78 ± 0\.04 m\/s²/);
      assert.equal(run.steps[1].output.ok, true);
      assert.equal(Number(run.costUsd), 0);

      const { rows: [artifact] } = await server.pool.query("SELECT id, content, privacy, source FROM nodes WHERE owner_id = $1 AND type = 'artifact'", [seeded.user.id]);
      assert.ok(artifact.content.startsWith(`${LAB_TITLE}\n\n1. Results table`));
      assert.equal(artifact.source, 'agent');
      const derived = await count("SELECT count(*)::int FROM node_relationships WHERE source_id = $1 AND type = 'derived_from'", [artifact.id]);
      assert.ok(derived > 0, 'the artifact links to what it was made from');
      // Anything made from a private note is private too.
      const { rows: sources } = await server.pool.query("SELECT n.privacy FROM node_relationships r JOIN nodes n ON n.id = r.target_id WHERE r.source_id = $1 AND r.type = 'derived_from'", [artifact.id]);
      assert.equal(artifact.privacy, sources.some((node) => node.privacy === 'local') ? 'local' : 'cloud');

      const { data: graph } = await api('GET', '/api/graph');
      assert.ok(graph.nodes.some((node) => node.id === artifact.id && node.label === LAB_TITLE));
      assert.ok(events.some((event) => event.type === 'approval.requested'));
      assert.ok(events.some((event) => event.type === 'node.written' && event.data.type === 'artifact'));
    });

    test('a rejected analysis is recorded and the run carries on without it', async () => {
      const { data: { run: started } } = await api('POST', '/api/agent-runs', { taskId: taskId('Check my lab report against the data') });
      const runner = worker();
      await runner.drain();
      const { data: { approvals } } = await api('GET', '/api/approvals?status=pending');
      await api('POST', `/api/approvals/${approvals[0].id}`, { decision: 'reject' });
      await runner.drain();
      const { data: { run } } = await api('GET', `/api/agent-runs/${started.id}`);
      assert.equal(run.status, 'succeeded');
      assert.deepEqual(run.steps.map((step) => step.status), ['done', 'rejected', 'done', 'done']);
      assert.equal(run.steps[1].output, null);
    });

    test('an artifact made from a private note is private; one made from shared notes is not', async () => {
      const owner = await registeredSession(server.base);
      const { data: { userId: ownerId } } = await owner('GET', '/api/auth/session');
      const role = { ...roleTemplate('physicist') };
      // Every node of the project is in the slice, so what the step read is
      // known exactly rather than left to retrieval.
      const gather = async ({ ownerId: who, project }) => {
        const { rows } = await server.pool.query('SELECT id, type, content, source, project, privacy, token_length, created_at FROM nodes WHERE owner_id = $1 AND project = $2', [who, project]);
        return { candidates: rows.map((node) => ({ node, score: 1 })) };
      };
      async function guideFrom(project, privacy) {
        await server.pool.query("INSERT INTO nodes (owner_id, type, content, source, project, privacy) VALUES ($1, 'note', 'Lecture notes: T = 2π√(L/g)', 'manual', $2, $3)", [ownerId, project, privacy]);
        const { rows: [agent] } = await server.pool.query(
          `INSERT INTO agents (owner_id, name, role, level, scopes, model_policy) VALUES ($1, $2, $3, 'supervised', $4, 'local_only') RETURNING id`,
          [ownerId, `Agent ${project}`, role, { read: { projects: [project], sources: ['*'] }, write: { projects: [project] } }]
        );
        const { rows: [run] } = await server.pool.query(
          "INSERT INTO agent_runs (owner_id, agent_id, instructions, project) VALUES ($1, $2, 'Make a one-page study guide, save it with graph.write_artifact, then finish.', $3) RETURNING id",
          [ownerId, agent.id, project]
        );
        const instance = createWorker({ adapters: { local }, events: bus, embed: false, online: () => false, gather, leaseMs: 30_000, heartbeatMs: 25, onError: () => {} });
        workers.push(instance);
        await instance.drain();
        const { rows: [finished] } = await server.pool.query('SELECT status FROM agent_runs WHERE id = $1', [run.id]);
        assert.equal(finished.status, 'succeeded');
        const { rows: [step] } = await server.pool.query("SELECT detail FROM agent_run_steps WHERE run_id = $1 AND capability = 'graph.write_artifact'", [run.id]);
        const { rows: artifacts } = await server.pool.query("SELECT privacy FROM nodes WHERE owner_id = $1 AND project = $2 AND type = 'artifact'", [ownerId, project]);
        assert.equal(artifacts.length, 1);
        return { privacy: artifacts[0].privacy, privateContext: step.detail.privateContext };
      }

      assert.deepEqual(await guideFrom('private-notes', 'local'), { privacy: 'local', privateContext: true });
      assert.deepEqual(await guideFrom('shared-notes', 'cloud'), { privacy: 'cloud', privateContext: false });
    });

    test('graph.write_artifact is denied once the agent may no longer write to the run’s project', async () => {
      const { data: { run: started } } = await api('POST', '/api/agent-runs', { taskId: taskId('Check my lab report against the data') });
      const runner = worker();
      await runner.drain();
      // While the run waits on its first approval, the user takes the project
      // out of the agent's write scope, then rejects the code step.
      const patched = await api('PATCH', `/api/agents/${seeded.agent.id}`, { scopes: { read: { projects: [DEMO_PROJECT], sources: ['*'] }, write: { projects: [] } } });
      assert.equal(patched.status, 200);
      const { data: { approvals } } = await api('GET', '/api/approvals?status=pending');
      await api('POST', `/api/approvals/${approvals[0].id}`, { decision: 'reject' });
      await runner.drain();

      const { rows: steps } = await server.pool.query('SELECT index, capability, status, error FROM agent_run_steps WHERE run_id = $1 ORDER BY index', [started.id]);
      const write = steps.find((step) => step.capability === 'graph.write_artifact');
      assert.equal(write.status, 'failed');
      assert.equal(write.error, 'denied: outside_write_scope');
      assert.equal(await count("SELECT count(*)::int FROM nodes WHERE owner_id = $1 AND type = 'artifact'", [seeded.user.id]), 0);
    });

    test('“Make a study guide”: notes are allowed, so it runs straight through', async () => {
      const posted = await api('POST', '/api/agent-runs', { taskId: taskId('Make a study guide from my lecture notes') });
      assert.equal(posted.status, 201, JSON.stringify(posted.data));
      const started = posted.data.run;
      await worker().drain();
      const { data: { run } } = await api('GET', `/api/agent-runs/${started.id}`);
      assert.equal(run.status, 'succeeded');
      assert.deepEqual(run.steps.map((step) => step.capability), [null, 'graph.write_artifact', null]);
      assert.equal((await api('GET', '/api/approvals?status=pending')).data.approvals.length, 0);
      const { rows } = await server.pool.query("SELECT content FROM nodes WHERE owner_id = $1 AND type = 'artifact'", [seeded.user.id]);
      assert.equal(rows.length, 1);
      assert.ok(rows[0].content.startsWith(GUIDE_TITLE));
    });
  });
});
