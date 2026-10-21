import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { createEventBus } from '../../src/workspace/events.js';
import { killRun } from '../../src/workspace/runner/store.js';
import { createWorker } from '../../src/workspace/runner/index.js';
import { sandboxRoot } from '../../src/workspace/runner/sandbox.js';
import { roleTemplate } from '../../src/workspace/roles.js';
import { sandboxStatus } from '../../src/workspace/sandbox/index.js';
import { createFakeModelPort } from '../fakeModelPort.js';
import { registeredSession, startServer } from '../helpers.js';
import { makeRepo, removeTempDirs, tempDir, useDataDir } from './workspaceSandboxFixtures.js';

// The runner with the code plug-in and the run's sandbox: a run makes one
// sandbox the first time a step edits or runs something, every later step
// works in it, a resumed run finds it again, and it is removed when the run
// ends. The proof at the end is the product's promise: an agent fixes a bug
// in a sandbox copy, the project's own tests prove it, and the user's
// checkout is never touched.

// Declared scripts in a sandbox copy run only inside the OS sandbox, so the
// tests that run one need it. CI installs bubblewrap.
const sandbox = await sandboxStatus();
const needsOsSandbox = sandbox.available ? false : `no OS sandbox on this machine (${sandbox.reason})`;
if (needsOsSandbox) console.log(`# skipping the OS-sandbox runner tests: ${needsOsSandbox}`);

const choose = (capability, input, summary = `use ${capability}`) => ({ capability, input, summary });

describe('agent runner with sandboxes', () => {
  let server;
  let ownerId;
  let data;
  let bus;
  let events;
  let local;
  const workers = [];
  let projects = 0;

  async function project(files) {
    projects += 1;
    const name = `sandbox-project-${projects}`;
    const fixture = makeRepo(files, { parent: tempDir('runner-repo') });
    await server.pool.query('INSERT INTO project_settings (owner_id, project, local_path) VALUES ($1, $2, $3)', [ownerId, name, fixture.repo]);
    return { name, ...fixture };
  }

  async function plainProject(files) {
    projects += 1;
    const name = `plain-project-${projects}`;
    const dir = tempDir('runner-plain');
    for (const [path, content] of Object.entries(files)) writeFileSync(join(dir, path), content);
    await server.pool.query('INSERT INTO project_settings (owner_id, project, local_path) VALUES ($1, $2, $3)', [ownerId, name, dir]);
    return { name, repo: dir };
  }

  // A Builder: the built-in role, sandboxed autonomous, writing only to the
  // one project.
  async function builder(projectName, { level = 'sandboxed', overrides = {} } = {}) {
    const role = roleTemplate('builder');
    const { rows } = await server.pool.query(
      `INSERT INTO agents (owner_id, name, role, level, overrides, scopes, model_policy)
       VALUES ($1, 'Builder', $2, $3, $4, $5, 'local_only') RETURNING id`,
      [ownerId, role, level, overrides, { read: { projects: [projectName], sources: ['*'] }, write: { projects: [projectName] } }]
    );
    return rows[0].id;
  }

  async function makeRun(agentId, projectName, instructions) {
    const { rows } = await server.pool.query(
      'INSERT INTO agent_runs (owner_id, agent_id, instructions, project) VALUES ($1, $2, $3, $4) RETURNING id',
      [ownerId, agentId, instructions, projectName]
    );
    return rows[0].id;
  }

  function worker(options = {}) {
    const instance = createWorker({ adapters: { local }, events: bus, embed: false, leaseMs: 30_000, heartbeatMs: 25, onError: () => {}, ...options });
    workers.push(instance);
    return instance;
  }

  const runRow = async (runId) => (await server.pool.query('SELECT * FROM agent_runs WHERE id = $1', [runId])).rows[0];
  const steps = async (runId) => (await server.pool.query('SELECT * FROM agent_run_steps WHERE run_id = $1 ORDER BY index', [runId])).rows;
  const fileIn = (root, path) => readFileSync(join(root, path), 'utf8');

  before(async () => {
    server = await startServer();
    const api = await registeredSession(server.base);
    ({ data: { userId: ownerId } } = await api('GET', '/api/auth/session'));
    data = useDataDir();
  });

  beforeEach(() => {
    for (const instance of workers.splice(0)) instance.abandon();
    bus = createEventBus();
    events = [];
    bus.subscribe({ ownerId }, (event) => events.push(event));
    local = createFakeModelPort({ name: 'local' });
  });

  after(async () => {
    for (const instance of workers.splice(0)) instance.abandon();
    data.restore();
    removeTempDirs();
    await server.close();
  });

  test('one sandbox serves every step: an edit is made there once and later reads see it', async () => {
    const fixture = await project({ 'notes.txt': 'one\n' });
    const agentId = await builder(fixture.name);
    const runId = await makeRun(agentId, fixture.name, 'Change one to two in notes.txt');
    local.push(
      'Edit notes.txt',
      choose('code.read', { path: 'notes.txt' }),
      choose('code.edit', { path: 'notes.txt', search: 'one', replace: 'two' }),
      choose('code.read', { path: 'notes.txt' }),
      { done: true, summary: 'notes.txt says two' }
    );
    // The record in the checkpoint as each step finished.
    const records = [];
    bus.subscribe({ ownerId, runId }, (event) => {
      if (event.type === 'step.finished') records.push(existsSync(sandboxRoot(runId)));
    });

    await worker().drain();
    const run = await runRow(runId);
    assert.equal(run.status, 'succeeded', run.error);
    const rows = await steps(runId);
    assert.deepEqual(rows.map((step) => [step.capability, step.status]), [
      [null, 'done'],
      ['code.read', 'done'],
      ['code.edit', 'done'],
      ['code.read', 'done'],
      [null, 'done'],
    ]);
    assert.match(rows[1].output.content, /^one/, 'before the edit there is no sandbox; the read sees the checkout');
    assert.match(rows[3].output.content, /^two/, 'after the edit the read sees the sandbox copy');
    assert.deepEqual(records, [false, false, true, true, true], 'made by the edit and kept for every later step');
    assert.ok(!existsSync(sandboxRoot(runId)), 'removed once the run ended');
    assert.equal(fileIn(fixture.repo, 'notes.txt'), 'one\n', 'the user’s checkout is untouched');
    assert.equal(run.checkpoint.sandbox, undefined, 'the record is cleared with the sandbox');
    // Sandboxed autonomous edits in a sandbox without asking.
    assert.equal((await server.pool.query('SELECT count(*)::int AS c FROM agent_approvals WHERE run_id = $1', [runId])).rows[0].c, 0);
  });

  test('a resumed run finds its sandbox from the checkpoint', async () => {
    const fixture = await project({ 'notes.txt': 'one\n' });
    const agentId = await builder(fixture.name);
    const runId = await makeRun(agentId, fixture.name, 'Change one to two');
    const first = worker();
    local.push(
      'Edit, then read',
      choose('code.edit', { path: 'notes.txt', search: 'one', replace: 'two' }),
      // The worker dies while the next step is being chosen.
      () => {
        first.abandon();
        return choose('code.read', { path: 'notes.txt' });
      }
    );
    await first.drain();
    let run = await runRow(runId);
    assert.equal(run.status, 'running');
    assert.equal(run.checkpoint.sandbox.root, sandboxRoot(runId));
    assert.equal(run.checkpoint.sandbox.kind, 'project');
    assert.equal(fileIn(join(sandboxRoot(runId), 'worktree'), 'notes.txt'), 'two\n');

    await server.pool.query("UPDATE agent_runs SET lease_until = now() - interval '1 second' WHERE id = $1", [runId]);
    local.push(choose('code.read', { path: 'notes.txt' }), { done: true });
    await worker().drain();
    run = await runRow(runId);
    assert.equal(run.status, 'succeeded', run.error);
    const rows = await steps(runId);
    assert.match(rows[2].output.content, /^two/, 'the resumed run read its own sandbox');
    assert.ok(!existsSync(sandboxRoot(runId)));
  });

  test('a resumed run whose sandbox is gone makes it again', async () => {
    const fixture = await project({ 'notes.txt': 'one\n' });
    const agentId = await builder(fixture.name);
    const runId = await makeRun(agentId, fixture.name, 'Edit twice');
    const first = worker();
    local.push(
      'Edit twice',
      choose('code.edit', { path: 'notes.txt', search: 'one', replace: 'two' }),
      () => {
        first.abandon();
        return choose('code.edit', { path: 'notes.txt', search: 'one', replace: 'three' });
      }
    );
    await first.drain();
    // The worktree disappeared while no worker held the run; the directory is
    // left half there.
    rmSync(join(sandboxRoot(runId), 'worktree'), { recursive: true, force: true });

    await server.pool.query("UPDATE agent_runs SET lease_until = now() - interval '1 second' WHERE id = $1", [runId]);
    local.push(choose('code.edit', { path: 'notes.txt', search: 'one', replace: 'three' }), choose('code.read', { path: 'notes.txt' }), { done: true });
    const seen = [];
    bus.subscribe({ ownerId, runId }, (event) => {
      if (event.type === 'step.finished' && existsSync(join(sandboxRoot(runId), 'worktree', 'notes.txt'))) {
        seen.push(fileIn(join(sandboxRoot(runId), 'worktree'), 'notes.txt'));
      }
    });
    await worker().drain();
    const run = await runRow(runId);
    assert.equal(run.status, 'succeeded', run.error);
    const rows = await steps(runId);
    assert.equal(rows[2].status, 'done', 'the edit ran in a fresh copy of the checkout');
    assert.match(rows[3].output.content, /^three/);
    assert.deepEqual(seen.slice(0, 1), ['three\n']);
    assert.equal(fileIn(fixture.repo, 'notes.txt'), 'one\n');
    assert.ok(!existsSync(sandboxRoot(runId)));
  });

  test('a run killed while it waits for approval has its sandbox swept', async () => {
    const fixture = await project({ 'notes.txt': 'one\n', 'package.json': '{"scripts":{"check":"node -e 0"}}\n' });
    const agentId = await builder(fixture.name, { overrides: { run_scripts: 'ask' } });
    const runId = await makeRun(agentId, fixture.name, 'Edit then check');
    local.push('Edit then check', choose('code.edit', { path: 'notes.txt', search: 'one', replace: 'two' }), choose('code.run_script', { script: 'check' }));
    const instance = worker();
    assert.deepEqual(await instance.drain(), [{ runId, outcome: 'parked' }]);
    assert.ok(existsSync(sandboxRoot(runId)), 'a parked run keeps its sandbox');
    const [approval] = (await server.pool.query('SELECT capability, detail FROM agent_approvals WHERE run_id = $1', [runId])).rows;
    assert.equal(approval.capability, 'code.run_script');

    assert.ok(await killRun(ownerId, runId));
    assert.deepEqual(await instance.sweep(), [runId]);
    assert.ok(!existsSync(sandboxRoot(runId)));
    assert.equal((await runRow(runId)).checkpoint.sandbox, undefined);
    assert.deepEqual(await instance.sweep(), [], 'nothing is left to sweep');
  });

  test('a run killed while a worker holds it has its sandbox removed by that worker', async () => {
    const fixture = await project({ 'notes.txt': 'one\n' });
    const agentId = await builder(fixture.name);
    const runId = await makeRun(agentId, fixture.name, 'Edit, then get killed');
    let killing = null;
    local = createFakeModelPort({ name: 'local', delayMs: 200 });
    local.push('Edit', choose('code.edit', { path: 'notes.txt', search: 'one', replace: 'two' }), () => {
      // The user cancels the run while the next step is being chosen.
      killing = killRun(ownerId, runId);
      return choose('code.read', { path: 'notes.txt' });
    });
    const [result] = await worker().drain();
    await killing;
    assert.equal(result.outcome, 'killed');
    assert.equal((await runRow(runId)).status, 'killed');
    assert.ok(!existsSync(sandboxRoot(runId)));
    assert.equal((await runRow(runId)).checkpoint.sandbox, undefined);
  });

  test('a project with no git checkout has no project sandbox, so can() is told the edit is not sandboxed', async () => {
    const plain = await plainProject({ 'notes.txt': 'one\n' });
    const agentId = await builder(plain.name);
    const runId = await makeRun(agentId, plain.name, 'Edit notes');
    local.push('Edit notes', choose('code.edit', { path: 'notes.txt', search: 'one', replace: 'two' }));
    assert.deepEqual(await worker().drain(), [{ runId, outcome: 'parked' }], 'sandboxed autonomous asks for an edit outside a sandbox');
    assert.ok(!existsSync(sandboxRoot(runId)));
    assert.equal(fileIn(plain.repo, 'notes.txt'), 'one\n');
  });

  test('a sandbox that cannot be made fails the step, not the run', async () => {
    const fixture = await project({ 'notes.txt': 'one\n' });
    const agentId = await builder(fixture.name);
    const runId = await makeRun(agentId, fixture.name, 'Edit notes');
    // A data directory where nothing can be created: a file stands where the
    // sandboxes directory would go.
    const blocked = tempDir('runner-blocked');
    writeFileSync(join(blocked, 'sandboxes'), 'not a directory');
    local.push('Edit notes', choose('code.edit', { path: 'notes.txt', search: 'one', replace: 'two' }), { done: true });
    await worker({ sandboxEnv: { SCOPE_DATA_DIR: blocked } }).drain();
    const rows = await steps(runId);
    assert.equal(rows[1].status, 'failed');
    assert.match(rows[1].error, /^sandbox_error: /);
    assert.equal((await runRow(runId)).status, 'succeeded');
  });

  describe('in the OS sandbox', { skip: needsOsSandbox }, () => {
    test('generated code in a project without a checkout runs in a scratch sandbox that is removed afterwards', async () => {
      const plain = await plainProject({ 'notes.txt': 'one\n' });
      const role = { ...roleTemplate('debugger') };
      const { rows: [agent] } = await server.pool.query(
        `INSERT INTO agents (owner_id, name, role, level, scopes, model_policy)
         VALUES ($1, 'Debugger', $2, 'sandboxed', $3, 'local_only') RETURNING id`,
        [ownerId, role, { read: { projects: [plain.name], sources: ['*'] }, write: { projects: [plain.name] } }]
      );
      const runId = await makeRun(agent.id, plain.name, 'Compute something');
      local.push('Compute', choose('code.run_generated', { language: 'node', code: 'console.log(6 * 7)' }), { done: true });
      const during = [];
      bus.subscribe({ ownerId, runId }, (event) => {
        if (event.type === 'step.output') during.push(existsSync(join(sandboxRoot(runId), 'scratch')));
      });
      await worker().drain();
      const run = await runRow(runId);
      const rows = await steps(runId);
      assert.equal(rows[1].status, 'done', JSON.stringify(rows.map((step) => [step.capability, step.error])));
      assert.equal(run.status, 'succeeded', run.error);
      assert.equal(rows[1].output.output, '42');
      assert.deepEqual(during, [true]);
      assert.ok(!existsSync(sandboxRoot(runId)));
    });

    test('the proof: a Builder fixes a failing test in its sandbox and the user’s checkout is untouched', async () => {
      const buggy = 'export function sum(a, b) {\n  return a - b;\n}\n';
      const fixture = await project({
        'package.json': JSON.stringify({ name: 'fixture', version: '1.0.0', type: 'module', scripts: { test: 'node test.js' } }, null, 2),
        'src/sum.js': buggy,
        'test.js': "import { sum } from './src/sum.js';\nif (sum(2, 3) !== 5) {\n  console.error(`sum(2, 3) is ${sum(2, 3)}, expected 5`);\n  process.exit(1);\n}\nconsole.log('sum ok');\n",
      });
      const agentId = await builder(fixture.name);
      const runId = await makeRun(agentId, fixture.name, 'npm test fails: sum(2, 3) is not 5. Find the bug and fix it.');
      local.push(
        '1. Find sum\n2. Read it\n3. Fix the operator\n4. Let the tests prove it',
        choose('code.search', { query: 'function sum' }, 'find where sum is defined'),
        choose('code.read', { path: 'src/sum.js' }, 'read sum'),
        choose('code.edit', { path: 'src/sum.js', search: 'return a - b;', replace: 'return a + b;' }, 'sum subtracted instead of adding'),
        { done: true, summary: 'sum() subtracted its arguments; it now adds them and npm test passes' }
      );

      // What the sandbox held when the tests verified the edit.
      let sandboxAtVerify = null;
      bus.subscribe({ ownerId, runId }, (event) => {
        if (event.type === 'step.verified' && event.data.verifier === 'code.tests') {
          sandboxAtVerify = fileIn(join(sandboxRoot(runId), 'worktree'), 'src/sum.js');
        }
      });

      await worker().drain();
      const run = await runRow(runId);
      assert.equal(run.status, 'succeeded', run.error);

      // The steps: plan, search, read, edit verified by the project's tests, done.
      const rows = await steps(runId);
      assert.deepEqual(rows.map((step) => [step.kind, step.capability, step.status]), [
        ['plan', null, 'done'],
        ['act', 'code.search', 'done'],
        ['act', 'code.read', 'done'],
        ['act', 'code.edit', 'done'],
        ['act', null, 'done'],
      ]);
      assert.deepEqual(rows[1].output.matches.map((match) => match.path), ['src/sum.js']);
      assert.match(rows[2].output.content, /return a - b;/);
      assert.match(rows[3].output.diff, /-  return a - b;\n\+  return a \+ b;/);
      const tests = rows[3].verification.find((entry) => entry.verifier === 'code.tests');
      assert.equal(tests.ok, true);
      assert.match(tests.detail, /npm run test passed[\s\S]*sum ok/);
      assert.ok(rows.every((step) => step.adapter === 'local'));

      // The sandbox had the fix; the user's checkout never changed.
      assert.equal(sandboxAtVerify, buggy.replace('a - b', 'a + b'));
      assert.equal(fileIn(fixture.repo, 'src/sum.js'), buggy);
      assert.equal(fixture.git(['status', '--porcelain']), '');

      // The graph: one plan; a step node per action, each part of the plan and
      // following the one before; the diff as an artifact and the conclusion as
      // a finding, produced by their steps and derived from what they read.
      const { rows: nodes } = await server.pool.query(
        'SELECT id, type, content, source, project, privacy FROM nodes WHERE id IN (SELECT unnest(node_ids) FROM agent_run_steps WHERE run_id = $1)',
        [runId]
      );
      const byType = (type) => nodes.filter((node) => node.type === type);
      assert.equal(byType('plan').length, 1);
      assert.equal(byType('plan')[0].id, run.plan_node_id);
      assert.equal(byType('step').length, 4);
      assert.equal(byType('artifact').length, 1);
      assert.match(byType('artifact')[0].content, /\+  return a \+ b;/);
      assert.equal(byType('finding').length, 1);
      assert.match(byType('finding')[0].content, /now adds them/);
      assert.ok(nodes.every((node) => node.source === 'agent' && node.project === fixture.name));

      const { rows: links } = await server.pool.query(
        'SELECT source_id, target_id, type FROM node_relationships WHERE source_id = ANY($1)',
        [nodes.map((node) => node.id)]
      );
      const stepNodeOf = (index) => rows[index].node_ids.find((id) => byType('step').some((node) => node.id === id));
      const has = (source, target, type) => links.some((link) => link.source_id === source && link.target_id === target && link.type === type);
      for (let index = 1; index <= 4; index += 1) {
        assert.ok(has(stepNodeOf(index), run.plan_node_id, 'part_of'), `step ${index} is part of the plan`);
        if (index > 1) assert.ok(has(stepNodeOf(index), stepNodeOf(index - 1), 'follows'), `step ${index} follows step ${index - 1}`);
      }
      assert.ok(has(stepNodeOf(3), byType('artifact')[0].id, 'produces'), 'the edit step produced the diff');
      assert.ok(has(stepNodeOf(4), byType('finding')[0].id, 'produces'), 'the final step produced the finding');
      assert.ok(links.some((link) => link.source_id === byType('finding')[0].id && link.type === 'derived_from'));

      // Events and costs.
      const types = events.filter((event) => event.runId === runId).map((event) => event.type);
      for (const type of ['run.started', 'step.started', 'step.output', 'step.verified', 'step.finished', 'node.written', 'cost', 'run.finished']) {
        assert.ok(types.includes(type), `${type} was published`);
      }
      assert.deepEqual(events.find((event) => event.runId === runId && event.type === 'run.finished').data, { status: 'succeeded' });
      const { rows: costs } = await server.pool.query('SELECT purpose, adapter, input_tokens, output_tokens FROM agent_run_costs WHERE run_id = $1', [runId]);
      assert.equal(costs.length, 5, 'one ledger row per model call');
      assert.ok(costs.every((cost) => cost.adapter === 'local'));
      assert.equal(run.tokens_used, costs.reduce((sum, cost) => sum + cost.input_tokens + cost.output_tokens, 0));

      // Nothing to approve at sandboxed autonomous, and the sandbox is gone.
      assert.equal((await server.pool.query('SELECT count(*)::int AS c FROM agent_approvals WHERE run_id = $1', [runId])).rows[0].c, 0);
      assert.ok(!existsSync(sandboxRoot(runId)));
      assert.equal(run.checkpoint.sandbox, undefined);
    });
  });
});
