import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { createCadQuery, defaultSandbox } from '../../src/plugins/cad/cadquery.js';
import { createCadPlugin } from '../../src/plugins/cad/index.js';
import { createCodePlugin } from '../../src/plugins/code/index.js';
import { encodeBinaryStl } from '../../src/plugins/cad/stl.js';
import { registerPlugin, resetRegistry } from '../../src/workspace/capabilities.js';
import { createEventBus } from '../../src/workspace/events.js';
import { createWorker } from '../../src/workspace/runner/index.js';
import { roleTemplate } from '../../src/workspace/roles.js';
import { createFakeModelPort } from '../fakeModelPort.js';
import { cadQueryForTests } from '../fixtures/cad/replay.js';
import { BRACKET_SCRIPT } from '../fixtures/cad/scripts.js';
import { box } from '../fixtures/cad/shapes.js';
import { registeredSession, startServer } from '../helpers.js';
import { makeRepo, removeTempDirs, tempDir, useDataDir } from './workspaceSandboxFixtures.js';

// A CAD Designer agent through the real runner: it reads a part, regenerates
// it with a parametric edit in the run's sandbox, the CAD verifiers measure
// the result, and only a verified step writes its findings and the part's
// artifact into the graph. The user's checkout is never touched. When
// CadQuery cannot run, or a declared dimension is missed, the step fails and
// says why, and nothing it claimed is written back.

const FIXTURES = join(import.meta.dirname, '..', 'fixtures', 'cad');
const choose = (capability, input, summary = `use ${capability}`) => ({ capability, input, summary });

describe('CAD Designer runs', () => {
  let server;
  let ownerId;
  let data;
  let bus;
  let local;
  let projects = 0;
  const workers = [];
  let cadquery;

  function usePlugins(cad) {
    // The worker registers the built-ins only when they are missing, so
    // these stand in for them.
    resetRegistry();
    registerPlugin(createCodePlugin());
    registerPlugin(createCadPlugin({ cadquery: cad }));
  }

  async function project() {
    projects += 1;
    const name = `cad-run-${projects}`;
    const fixture = makeRepo({
      'cad.json': JSON.stringify({ units: 'mm', assembly: ['parts/bracket.step', 'pegs/clear.stl'] }),
      'bracket.stl': readFileSync(join(FIXTURES, 'bracket.stl')),
      'pegs/clear.stl': encodeBinaryStl(box([3, 3, 15], [13.5, 8.5, -5])),
    }, { parent: tempDir('cad-run') });
    await server.pool.query('INSERT INTO project_settings (owner_id, project, local_path) VALUES ($1, $2, $3)', [ownerId, name, fixture.repo]);
    return { name, ...fixture };
  }

  async function designer(projectName) {
    const { rows } = await server.pool.query(
      `INSERT INTO agents (owner_id, name, role, level, scopes, model_policy)
       VALUES ($1, 'CAD Designer', $2, 'sandboxed', $3, 'local_only') RETURNING id`,
      [ownerId, roleTemplate('cad_designer'), { read: { projects: [projectName], sources: ['cad'] }, write: { projects: [projectName] } }]
    );
    return rows[0].id;
  }

  async function startRun(agentId, projectName) {
    const { rows } = await server.pool.query(
      'INSERT INTO agent_runs (owner_id, agent_id, instructions, project) VALUES ($1, $2, $3, $4) RETURNING id',
      [ownerId, agentId, 'Move the bracket holes to 50 mm apart, keeping 4 mm of wall', projectName]
    );
    return rows[0].id;
  }

  function worker() {
    const instance = createWorker({ adapters: { local }, events: bus, embed: false, leaseMs: 30_000, heartbeatMs: 25, onError: () => {} });
    workers.push(instance);
    return instance;
  }

  const runRow = async (id) => (await server.pool.query('SELECT * FROM agent_runs WHERE id = $1', [id])).rows[0];
  const steps = async (id) => (await server.pool.query('SELECT * FROM agent_run_steps WHERE run_id = $1 ORDER BY index', [id])).rows;
  const nodesOf = async (id) =>
    (await server.pool.query('SELECT id, type, content FROM nodes WHERE id IN (SELECT unnest(node_ids) FROM agent_run_steps WHERE run_id = $1)', [id])).rows;

  const editInput = (expect) => ({ script: BRACKET_SCRIPT, output: 'parts/bracket.step', expect });

  before(async () => {
    server = await startServer();
    const api = await registeredSession(server.base);
    ({ data: { userId: ownerId } } = await api('GET', '/api/auth/session'));
    data = useDataDir();
    ({ cadquery } = await cadQueryForTests({ createCadQuery, defaultSandbox }));
  });

  beforeEach(() => {
    for (const instance of workers.splice(0)) instance.abandon();
    bus = createEventBus();
    local = createFakeModelPort({ name: 'local' });
  });

  after(async () => {
    for (const instance of workers.splice(0)) instance.abandon();
    resetRegistry();
    data.restore();
    removeTempDirs();
    await server.close();
  });

  test('inspect, regenerate, verify: the part and what was learned are written back', async () => {
    usePlugins(cadquery);
    const fixture = await project();
    const runId = await startRun(await designer(fixture.name), fixture.name);
    local.push(
      '1. Measure the bracket.\n2. Regenerate it with the holes 50 mm apart.\n3. Check spacing, wall and fit.',
      choose('cad.inspect', { path: 'bracket.stl', section: { axis: 'z' } }, 'Measure the current hole spacing'),
      choose('cad.parametric_edit', editInput([{ measure: 'holes.spacing', value: 50, tolerance: 0.1 }, { measure: 'holes.minWall', min: 4 }]), 'Regenerate with 50 mm spacing'),
      { done: true, summary: 'The bracket now has its holes 50 mm apart with 7.5 mm walls.' }
    );
    await worker().drain();

    const run = await runRow(runId);
    assert.equal(run.status, 'succeeded', run.error);
    const rows = await steps(runId);
    assert.deepEqual(rows.map((s) => [s.capability, s.status]), [[null, 'done'], ['cad.inspect', 'done'], ['cad.parametric_edit', 'done'], [null, 'done']]);
    assert.deepEqual(rows[1].output.section.holeSpacings, [40]);
    const verification = Object.fromEntries(rows[2].verification.map((v) => [v.verifier, v]));
    assert.equal(verification['cad.valid_geometry'].ok, true);
    assert.equal(verification['cad.dimensions'].ok, true);
    assert.match(verification['cad.dimensions'].detail, /pass holes\.minWall/);
    assert.match(verification['cad.no_interference'].detail, /clears pegs\/clear\.stl/);

    const nodes = await nodesOf(runId);
    assert.ok(nodes.some((n) => n.type === 'finding' && /bracket\.stl: 60 × 20 × 5 mm/.test(n.content)), 'the inspection became a finding');
    assert.ok(nodes.some((n) => n.type === 'artifact' && /CAD part bracket\.step/.test(n.content)), 'the part became an artifact');
    assert.ok(!existsSync(join(fixture.repo, 'parts', 'bracket.step')), 'the user’s checkout is untouched');
  });

  test('a missed dimension fails verification, and the step writes no artifact', async () => {
    usePlugins(cadquery);
    const fixture = await project();
    const runId = await startRun(await designer(fixture.name), fixture.name);
    local.push(
      'Regenerate the bracket.',
      choose('cad.parametric_edit', editInput([{ measure: 'holes.spacing', value: 40, tolerance: 0.1 }])),
      { done: true, summary: 'Stopping.' }
    );
    await worker().drain();
    const rows = await steps(runId);
    assert.equal(rows[1].status, 'failed');
    assert.equal(rows[1].error, 'verification_failed');
    const failed = rows[1].verification.find((v) => v.verifier === 'cad.dimensions');
    assert.equal(failed.ok, false);
    assert.match(failed.detail, /FAIL holes\.spacing/);
    assert.ok(!(await nodesOf(runId)).some((n) => n.type === 'artifact'), 'nothing unverified is written back');
  });

  test('without CadQuery the edit step fails with tool_unavailable and the run carries on', async () => {
    usePlugins(createCadQuery({ sandbox: { status: async () => ({ available: false, reason: 'no bubblewrap here' }), run: async () => { throw new Error('must not run'); } } }));
    const fixture = await project();
    const runId = await startRun(await designer(fixture.name), fixture.name);
    local.push(
      'Regenerate the bracket.',
      choose('cad.parametric_edit', editInput([])),
      choose('cad.inspect', { path: 'bracket.stl' }, 'Fall back to measuring what is there'),
      { done: true, summary: 'CadQuery is not available on this machine, so the bracket could not be regenerated.' }
    );
    await worker().drain();
    const run = await runRow(runId);
    assert.equal(run.status, 'succeeded', run.error);
    const rows = await steps(runId);
    assert.equal(rows[1].status, 'failed');
    assert.match(rows[1].error, /^capability_error: CadQuery is not available: no OS sandbox \(no bubblewrap here\)/);
    assert.equal(rows[2].status, 'done', 'JavaScript inspection still works');
    const stepNode = (await nodesOf(runId)).find((n) => n.type === 'step' && /cad\.parametric_edit · failed/.test(n.content));
    assert.match(stepNode.content, /CadQuery is not available/, 'the next step can read why');
  });
});
