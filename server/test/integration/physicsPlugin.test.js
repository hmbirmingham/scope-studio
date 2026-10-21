import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createPhysicsPlugin } from '../../src/plugins/physics/index.js';
import { ingestProblems } from '../../src/plugins/physics/ingest.js';
import { createPythonRunner } from '../../src/plugins/physics/python.js';
import { registerBuiltInPlugins } from '../../src/plugins/registry.js';
import { registerPlugin, resetRegistry } from '../../src/workspace/capabilities.js';
import { createEventBus } from '../../src/workspace/events.js';
import { createWorker } from '../../src/workspace/runner/index.js';
import { roleTemplate } from '../../src/workspace/roles.js';
import { createFakeModelPort } from '../fakeModelPort.js';
import { registeredSession, startServer } from '../helpers.js';
import { removeTempDirs, useDataDir } from './workspaceSandboxFixtures.js';

// The physics plug-in against the real database and, where this machine has
// it, the real toolchain: bubblewrap, python3, NumPy, SciPy and Pint. The
// model is always a scripted fake. The suites that need the toolchain say so
// and are skipped without it; CI installs it, and the unit tests cover the
// same paths with recorded harness output.

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(here, '../fixtures/physics', `${name}.json`), 'utf8'));
const pendulum = fixture('pendulum-period');
const rc = fixture('rc-charging');
const projectile = fixture('projectile-range');
const PROJECT = 'mechanics';

const toolchain = await createPythonRunner().availability();
const needsToolchain = toolchain.available ? false : `the physics toolchain is unavailable here (${toolchain.reason})`;

let server;
let ownerId;
let data;
let plugin;
let problemIds;

const agentWith = ({ sources = ['*'], projects = [PROJECT] } = {}) => ({
  id: randomUUID(),
  state: 'active',
  level: 'sandboxed',
  overrides: {},
  modelPolicy: 'local_only',
  role: roleTemplate('physicist'),
  scopes: { read: { projects, sources }, write: { projects } },
});

function context({ model = null, agent = agentWith(), ...rest } = {}) {
  return { ownerId, agent, project: PROJECT, run: { id: randomUUID() }, step: { id: randomUUID() }, model, ...rest };
}

const capability = (name, from = plugin) => from.capabilities.find((entry) => entry.name === name);
const verifier = (name, from = plugin) => from.verifiers.find((entry) => entry.name === name);

async function verifyAll(capabilityName, result, ctx, from = plugin) {
  const outcomes = {};
  for (const name of capability(capabilityName, from).verifiers) outcomes[name] = await verifier(name, from).verify(result, ctx);
  return outcomes;
}

async function node(id) {
  return (await server.pool.query('SELECT id, type, content, source, project, privacy, external_id FROM nodes WHERE id = $1', [id])).rows[0];
}

async function derivedFrom(id) {
  const { rows } = await server.pool.query("SELECT target_id FROM node_relationships WHERE source_id = $1 AND type = 'derived_from'", [id]);
  return rows.map((row) => row.target_id);
}

async function physicsNodes(type) {
  return (await server.pool.query("SELECT id, content FROM nodes WHERE owner_id = $1 AND source = 'physics' AND type = $2", [ownerId, type])).rows;
}

const modelReplying = (...replies) => createFakeModelPort({ responses: replies });

before(async () => {
  data = useDataDir();
  server = await startServer();
  const api = await registeredSession(server.base);
  ({ data: { userId: ownerId } } = await api('GET', '/api/auth/session'));
  plugin = createPhysicsPlugin({ embed: null });
  const ingested = await ingestProblems(ownerId, { project: PROJECT, privacy: 'cloud', problems: [pendulum, rc, projectile] }, { embed: null });
  problemIds = Object.fromEntries(ingested.nodes.map((entry) => [entry.problem, entry.id]));
});

after(async () => {
  await server.close();
  data.restore();
  removeTempDirs();
});

describe('physics ingest', () => {
  test('writes each problem once as a physics spec node, without its answer', async () => {
    assert.equal(Object.keys(problemIds).length, 3);
    const stored = await node(problemIds['projectile-range']);
    assert.equal(stored.type, 'spec');
    assert.equal(stored.source, 'physics');
    assert.equal(stored.project, PROJECT);
    assert.equal(stored.privacy, 'cloud');
    assert.equal(stored.external_id, 'problem:projectile-range');
    assert.match(stored.content, /quadratic drag/);
    assert.doesNotMatch(stored.content, /84\.6/);

    const again = await ingestProblems(ownerId, { project: PROJECT, privacy: 'cloud', problems: [{ ...projectile, statement: `${projectile.statement} (revised)` }] }, { embed: null });
    assert.equal(again.nodes[0].id, problemIds['projectile-range'], 're-ingest updates the same node');
    assert.match((await node(problemIds['projectile-range'])).content, /\(revised\)/);
  });
});

describe('physics.derive', { skip: needsToolchain }, () => {
  test('writes a checked derivation node from the model’s derivation, derived from the problem', async () => {
    const model = modelReplying(pendulum.derivation);
    const ctx = context({ model });
    const result = await capability('physics.derive').run({ problem: 'Find the period of the pendulum', problemId: problemIds['pendulum-period'] }, ctx);

    assert.ok(result.output.derivationId);
    assert.deepEqual(result.touchedNodeIds, [result.output.derivationId]);
    assert.equal(result.output.checks.units.ok, true);
    assert.match(result.output.checks.units.detail, /T evaluates to 2\.01109 s/);
    assert.equal(result.output.checks.limits.ok, true);
    assert.match(result.findings[0], /^Derived T = 4\*sqrt\(L\/g\)\*ellipk\(sin\(theta0\/2\)\^2\) \[s\]/);
    // The problem node reached the model.
    assert.match(model.calls[0].messages[1].content, /From the project:\nPhysics problem: Period of a simple pendulum/);

    const stored = await node(result.output.derivationId);
    assert.equal(stored.type, 'derivation');
    assert.equal(stored.source, 'physics');
    assert.equal(stored.project, PROJECT);
    assert.equal(stored.privacy, 'local', 'the capability cannot see the slice, so it fails closed');
    assert.equal(stored.external_id, `derivation:${ctx.step.id}`);
    assert.match(stored.content, /Assumptions:\n- point mass/);
    assert.match(stored.content, /Checks: units passed; limits passed/);
    assert.deepEqual(await derivedFrom(stored.id), [problemIds['pendulum-period']]);

    // The verifiers report what the capability checked…
    const outcomes = await verifyAll('physics.derive', result, ctx);
    assert.deepEqual(Object.values(outcomes).map((outcome) => outcome.ok), [true, true]);
    // …and reach the same answer checking from scratch.
    const fresh = await verifyAll('physics.derive', { output: structuredClone(result.output) }, ctx);
    assert.deepEqual(fresh['physics.units'], outcomes['physics.units']);
    assert.equal(fresh['physics.limits'].ok, true);

    // Run again for the same step (a resumed run): one node, updated.
    const again = await capability('physics.derive').run({ problem: 'Find the period of the pendulum' }, { ...ctx, model: modelReplying(pendulum.derivation) });
    assert.equal(again.output.derivationId, result.output.derivationId);
  });

  test('a node is cloud only when the context says it held nothing private and its sources are cloud', async () => {
    const result = await capability('physics.derive').run({ problem: 'RC charging', problemId: problemIds['rc-charging'] }, context({ model: modelReplying(rc.derivation), privateContext: false }));
    assert.equal((await node(result.output.derivationId)).privacy, 'cloud');
  });

  test('a dimensionally wrong derivation is not written and fails physics.units', async () => {
    const before = (await physicsNodes('derivation')).length;
    const wrong = structuredClone(pendulum.derivation);
    wrong.result.expression = '2*pi*sqrt(L*g)';
    wrong.limits[0].expect = '2*pi*sqrt(L*g)';
    const ctx = context({ model: modelReplying(wrong) });
    const result = await capability('physics.derive').run({ problem: 'pendulum' }, ctx);
    assert.equal(result.output.derivationId, null);
    assert.equal(result.findings, undefined);
    const outcomes = await verifyAll('physics.derive', result, ctx);
    assert.equal(outcomes['physics.units'].ok, false);
    assert.match(outcomes['physics.units'].detail, /dimensions \[length\] \/ \[time\] but the result is declared in s/);
    assert.equal((await physicsNodes('derivation')).length, before);
  });

  test('adding quantities of different dimensions fails physics.units', async () => {
    const wrong = structuredClone(rc.derivation);
    wrong.result.expression = 'V0*(1 - exp(-t/(R*C))) + t';
    const ctx = context({ model: modelReplying(wrong) });
    const result = await capability('physics.derive').run({ problem: 'rc' }, ctx);
    const outcomes = await verifyAll('physics.derive', result, ctx);
    assert.equal(outcomes['physics.units'].ok, false);
    assert.match(outcomes['physics.units'].detail, /not dimensionally consistent: DimensionalityError/);
  });

  test('a result that misses its own limiting case is not written and fails physics.limits', async () => {
    const wrong = structuredClone(pendulum.derivation);
    // Right dimensions, wrong physics: twice the small-angle period.
    wrong.result.expression = '8*sqrt(L/g)*ellipk(sin(theta0/2)^2)';
    const ctx = context({ model: modelReplying(wrong) });
    const result = await capability('physics.derive').run({ problem: 'pendulum' }, ctx);
    assert.equal(result.output.derivationId, null);
    const outcomes = await verifyAll('physics.derive', result, ctx);
    assert.equal(outcomes['physics.units'].ok, true);
    assert.equal(outcomes['physics.limits'].ok, false);
    assert.match(outcomes['physics.limits'].detail, /0 of 1 limiting cases hold; failing: small amplitude: 4\.0121/);
  });

  test('an expression that is not plain arithmetic is refused inside the sandbox', async () => {
    const hostile = structuredClone(pendulum.derivation);
    hostile.result.expression = "__import__('os').system('id')";
    const ctx = context({ model: modelReplying(hostile) });
    const result = await capability('physics.derive').run({ problem: 'pendulum' }, ctx);
    assert.equal(result.output.derivationId, null);
    assert.match(result.output.checks.units.detail, /only these functions are allowed/);
    const attribute = structuredClone(pendulum.derivation);
    attribute.result.expression = 'L.__class__';
    const second = await capability('physics.derive').run({ problem: 'pendulum' }, context({ model: modelReplying(attribute) }));
    assert.match(second.output.checks.units.detail, /'Attribute' is not allowed/);
  });

  test('a model that never produces a usable derivation fails the step, writing nothing', async () => {
    await assert.rejects(capability('physics.derive').run({ problem: 'pendulum' }, context({ model: createFakeModelPort({ fallback: '{"title": "no"}' }) })), { code: 'invalid_derivation' });
    await assert.rejects(capability('physics.derive').run({ problem: '' }, context({ model: modelReplying(pendulum.derivation) })), { code: 'invalid_input' });
  });
});

describe('physics.compute', { skip: needsToolchain }, () => {
  let pendulumDerivationId;
  before(async () => {
    const result = await capability('physics.derive').run({ problem: 'pendulum', problemId: problemIds['pendulum-period'] }, context({ model: modelReplying(pendulum.derivation) }));
    pendulumDerivationId = result.output.derivationId;
  });

  const close = (got, answer) => Math.abs(got - answer.value) <= answer.rtol * Math.abs(answer.value);

  test('evaluates a derivation’s closed form, cross-checked by integrating the equation of motion', async () => {
    const ctx = context();
    const result = await capability('physics.compute').run({ ...pendulum.computation, derivationId: pendulumDerivationId }, ctx);
    const T = result.output.outputs.T;
    assert.equal(T.units, 's');
    assert.ok(close(T.value, pendulum.answer), `T = ${T.value}`);
    assert.equal(result.output.checks.units.ok, true);
    assert.equal(result.output.checks.rederive.ok, true);
    assert.match(result.output.checks.rederive.detail, /an independent computation agrees: T: 2\.01109 vs 2\.01109 s/);

    const stored = await node(result.output.computationId);
    assert.equal(stored.type, 'computation');
    assert.match(stored.content, /^Computation: Pendulum period at 0\.2 rad\nT = 2\.01109 s/);
    assert.match(stored.content, /Cross-check: integrate the equation of motion/);
    assert.deepEqual(await derivedFrom(stored.id), [pendulumDerivationId]);
    assert.deepEqual(result.touchedNodeIds, [stored.id, pendulumDerivationId]);
    assert.match(result.findings[0], /^Computed T = 2\.01109 s/);

    const outcomes = await verifyAll('physics.compute', result, ctx);
    assert.deepEqual(Object.values(outcomes).map((outcome) => outcome.ok), [true, true]);
    const fresh = await verifyAll('physics.compute', { output: structuredClone(result.output) }, ctx);
    assert.deepEqual(Object.values(fresh).map((outcome) => outcome.ok), [true, true]);
  });

  test('runs model-written code on Pint quantities and gets the fixtures’ known answers', async () => {
    for (const problem of [rc, projectile]) {
      const result = await capability('physics.compute').run({ ...problem.computation, inputs: problem.given }, context());
      const [name] = Object.keys(problem.find);
      const got = result.output.outputs[name];
      assert.equal(got.units, problem.answer.units);
      assert.ok(close(got.value, problem.answer), `${problem.id}: ${got.value} vs ${problem.answer.value}`);
      assert.ok(result.output.computationId, problem.id);
    }
  });

  test('a cross-check that disagrees fails physics.rederive and nothing is written', async () => {
    const before = (await physicsNodes('computation')).length;
    const ctx = context();
    const result = await capability('physics.compute').run({
      ...rc.computation,
      inputs: rc.given,
      crossCheck: { method: 'a wrong closed form', code: "result = {'V': V0 * (1 - np.exp(-2.0))}" },
    }, ctx);
    assert.equal(result.output.computationId, null);
    const outcomes = await verifyAll('physics.compute', result, ctx);
    assert.equal(outcomes['physics.units'].ok, true);
    assert.equal(outcomes['physics.rederive'].ok, false);
    assert.match(outcomes['physics.rederive'].detail, /disagrees: V: 3\.16060 vs 4\.32332 V|disagrees: V: 3\.1606 vs 4\.32332 V/);
    assert.equal((await physicsNodes('computation')).length, before);
  });

  test('an output in the wrong dimensions fails physics.units', async () => {
    const ctx = context();
    const result = await capability('physics.compute').run({
      title: 'time constant mistaken for a voltage',
      code: "result = {'V': (R * C).to('s')}",
      outputs: { V: 'V' },
      inputs: rc.given,
      crossCheck: { code: "result = {'V': R * C}" },
    }, ctx);
    assert.equal(result.output.computationId, null);
    const outcomes = await verifyAll('physics.compute', result, ctx);
    assert.equal(outcomes['physics.units'].ok, false);
    assert.match(outcomes['physics.units'].detail, /'V' is in second, which cannot be expressed in V/);
    assert.equal(outcomes['physics.rederive'].ok, false);
  });

  test('code that raises, runs too long or reaches for the network fails the step', async () => {
    const run = (code, extra = {}) => capability('physics.compute').run({ code, outputs: { x: 'm' }, crossCheck: { code: "result = {'x': Q_(1, 'm')}" }, ...extra }, context());
    await assert.rejects(run("raise ValueError('bad input')"), (err) => err.code === 'computation_failed' && /ValueError: bad input/.test(err.message));
    await assert.rejects(run("x = 1"), (err) => err.code === 'computation_failed' && /must set result/.test(err.message));
    await assert.rejects(run('while True:\n    pass', { timeoutMs: 1_000 }), { code: 'python_limit' });
    await assert.rejects(run("import socket\nsocket.create_connection(('192.0.2.1', 80), timeout=2)\nresult = {'x': Q_(1, 'm')}"), { code: 'computation_failed' });
    await assert.rejects(run("open('/usr/escape.txt', 'w').write('x')\nresult = {'x': Q_(1, 'm')}"), (err) => err.code === 'computation_failed' && /(Read-only|Permission denied)/.test(err.message));
  });

  // Model-written code shares the process of the job that runs it. This
  // prelude finds that job's nonce (from the job file if it is still there,
  // else from the harness's own stack), prints a result line of its own and
  // exits before the harness can print the real one.
  const forging = (payload) => `import json, os, sys
nonce = None
try:
    nonce = json.load(open('job.json'))['nonce']
except Exception:
    frame = sys._getframe()
    while frame is not None and nonce is None:
        job = frame.f_locals.get('job')
        if isinstance(job, dict) and 'nonce' in job:
            nonce = job['nonce']
        frame = frame.f_back
if nonce is None:
    raise RuntimeError('the forger found no nonce')
os.write(1, ('\\n@@physics-result@@' + nonce + ' ' + ${JSON.stringify(JSON.stringify(payload))} + '\\n').encode())
os._exit(0)
`;
  const claimedPass = { ok: true, outputs: { T: { value: 5, units: 's' } }, units: { T: { ok: true, detail: "'T' = 5 s" } }, checks: { units: { ok: true } }, sides: { primary: { outputs: { T: { value: 5, units: 's' } }, units: { T: { ok: true } } } }, log: '' };

  test('code that forges the harness’s result line cannot pass physics.units, and nothing is written', async () => {
    const before = (await physicsNodes('computation')).length;
    const honest = "result = {'T': Q_(5, 'm')}";
    const input = { title: 'forged', code: honest, outputs: { T: 's' }, crossCheck: { code: "result = {'T': 5 * ureg.meter}" } };

    // Honest code in the wrong dimensions fails units.
    const ctx = context();
    const plain = await capability('physics.compute').run(input, ctx);
    assert.equal(plain.output.computationId, null);
    assert.equal((await verifyAll('physics.compute', plain, ctx))['physics.units'].ok, false);

    // The same code claiming a pass in a line of its own fails the step.
    await assert.rejects(
      capability('physics.compute').run({ ...input, code: `${forging(claimedPass)}${honest}` }, context()),
      (err) => err.code === 'computation_failed' && /reported no values/.test(err.message) && !/found no nonce/.test(err.message)
    );

    // A forged line that does carry values is read only as values: these
    // (7 m, not the 5 m the code computed) still fail the units check.
    const withValues = { ...claimedPass, values: { T: { value: 7, units: 'meter' } } };
    const forgedCtx = context();
    const forged = await capability('physics.compute').run({ ...input, code: `${forging(withValues)}${honest}` }, forgedCtx);
    assert.equal(forged.output.computationId, null);
    assert.equal(forged.output.checks.units.ok, false);
    assert.match(forged.output.checks.units.detail, /'T' is in meter, which cannot be expressed in s/);
    const outcomes = await verifyAll('physics.compute', forged, forgedCtx);
    assert.equal(outcomes['physics.units'].ok, false);
    assert.equal((await verifyAll('physics.compute', { output: structuredClone(forged.output) }, forgedCtx))['physics.units'].ok, false);
    assert.equal((await physicsNodes('computation')).length, before);
  });

  test('a cross-check that forges the harness’s result line cannot pass physics.rederive', async () => {
    const before = (await physicsNodes('computation')).length;
    const ctx = context();
    const result = await capability('physics.compute').run({
      ...rc.computation,
      inputs: rc.given,
      crossCheck: { code: forging({ ok: true, outputs: { V: { value: 3.1606, units: 'V' } }, units: { V: { ok: true } }, rederive: { ok: true }, log: '' }) },
    }, ctx);
    assert.equal(result.output.computationId, null);
    assert.equal(result.output.checks.units.ok, true);
    assert.equal(result.output.checks.rederive.ok, false);
    assert.match(result.output.checks.rederive.detail, /the cross-check failed: it reported no values/);
    assert.equal((await verifyAll('physics.compute', result, ctx))['physics.rederive'].ok, false);
    assert.equal((await physicsNodes('computation')).length, before);
  });

  test('code that patches the harness cannot make a non-finite result pass', async () => {
    const ctx = context();
    const result = await capability('physics.compute').run({
      code: "import __main__\n__main__.finite = lambda x: True\nresult = {'T': Q_(float('inf'), 's')}",
      outputs: { T: 's' },
      crossCheck: { code: "result = {'T': Q_(1, 's')}" },
    }, ctx);
    assert.equal(result.output.computationId, null);
    assert.equal(result.output.checks.units.ok, false);
    assert.match(result.output.checks.units.detail, /'T' is not finite/);
  });

  test('a computation can only build on a derivation the agent may read', async () => {
    const input = { ...pendulum.computation, derivationId: pendulumDerivationId };
    await assert.rejects(capability('physics.compute').run(input, context({ agent: agentWith({ sources: ['github'] }) })), { code: 'read_denied' });
    await assert.rejects(capability('physics.compute').run({ ...input, derivationId: problemIds['rc-charging'] }, context()), { code: 'wrong_node_type' });
    await assert.rejects(capability('physics.compute').run({ ...input, derivationId: randomUUID() }, context()), { code: 'not_found' });
    await assert.rejects(capability('physics.compute').run({ ...input, derivationId: 'not-an-id' }, context()), { code: 'invalid_input' });
  });
});

describe('physics.check', { skip: needsToolchain }, () => {
  let derivationId;
  let computationId;
  before(async () => {
    derivationId = (await capability('physics.derive').run({ problem: 'rc' }, context({ model: modelReplying(rc.derivation) }))).output.derivationId;
    computationId = (await capability('physics.compute').run({ ...rc.computation, inputs: rc.given, derivationId }, context())).output.computationId;
  });

  test('re-runs the checks on stored derivations and computations', async () => {
    const onDerivation = await capability('physics.check').run({ nodeId: derivationId }, context());
    assert.equal(onDerivation.output.passed, true);
    assert.deepEqual(Object.keys(onDerivation.output.checks), ['units', 'limits']);
    assert.match(onDerivation.findings[0], /passes units and limits: dimensionally consistent: V evaluates to 3\.1606 V; 2 of 2 limiting cases hold/);

    const onComputation = await capability('physics.check').run({ nodeId: computationId, checks: ['rederive'] }, context());
    assert.equal(onComputation.output.passed, true);
    assert.deepEqual(Object.keys(onComputation.output.checks), ['rederive']);
  });

  test('finds a stored derivation that was edited into a wrong one', async () => {
    const stored = await node(derivationId);
    const tampered = stored.content.replace('"expression":"V0*(1 - exp(-t/(R*C)))"', '"expression":"V0*(1 - exp(-t*R*C))"');
    assert.notEqual(tampered, stored.content);
    const copy = (await server.pool.query("INSERT INTO nodes (owner_id, type, content, source, project, privacy) VALUES ($1, 'derivation', $2, 'physics', $3, 'local') RETURNING id", [ownerId, tampered, PROJECT])).rows[0].id;
    const result = await capability('physics.check').run({ nodeId: copy }, context());
    assert.equal(result.output.passed, false);
    assert.equal(result.output.checks.units.ok, false);
    assert.match(result.findings[0], /FAILS units and limits/);
  });

  test('refuses what it cannot check', async () => {
    await assert.rejects(capability('physics.check').run({ nodeId: problemIds['rc-charging'] }, context()), { code: 'wrong_node_type' });
    await assert.rejects(capability('physics.check').run({ nodeId: derivationId, checks: ['rederive'] }, context()), { code: 'invalid_input' });
    await assert.rejects(capability('physics.check').run({ nodeId: derivationId }, context({ agent: agentWith({ projects: ['elsewhere'] }) })), { code: 'read_denied' });
    const plain = (await server.pool.query("INSERT INTO nodes (owner_id, type, content, source, project) VALUES ($1, 'derivation', 'E = mc^2, trust me', 'physics', $2) RETURNING id", [ownerId, PROJECT])).rows[0].id;
    await assert.rejects(capability('physics.check').run({ nodeId: plain }, context()), { code: 'no_spec' });
  });
});

describe('without the physics toolchain', () => {
  // The real plug-in with a machine that has no OS sandbox: the probe is
  // refused and nothing runs, whatever is installed here.
  const noSandbox = {
    status: async () => ({ available: false, mechanism: null, reason: 'missing bwrap' }),
    run: async () => {
      const err = new Error('no OS sandbox is available (missing bwrap); refusing to run unsandboxed');
      err.code = 'sandbox_unavailable';
      throw err;
    },
  };
  const bare = createPhysicsPlugin({ sandbox: noSandbox, embed: null });

  test('physics.derive writes the derivation marked unverified, and the verifiers say unavailable', async () => {
    const ctx = context({ model: modelReplying(pendulum.derivation) });
    const result = await capability('physics.derive', bare).run({ problem: 'pendulum' }, ctx);
    assert.ok(result.output.derivationId);
    assert.match(result.output.checks.unavailable, /missing bwrap/);
    assert.match(result.findings[0], /checks: not checked \(no OS sandbox is available/);
    assert.match((await node(result.output.derivationId)).content, /Checks: not run \(.*missing bwrap.*\) — unverified/);
    const outcomes = await verifyAll('physics.derive', result, ctx, bare);
    for (const outcome of Object.values(outcomes)) {
      assert.equal(outcome.ok, true);
      assert.equal(outcome.unavailable, true);
      assert.match(outcome.detail, /was not checked: .*missing bwrap/);
    }
  });

  test('physics.derive sends a private problem node’s text to the model only in a private context', async () => {
    const statement = 'Physics problem: a private pendulum on the bench';
    const local = (await server.pool.query("INSERT INTO nodes (owner_id, type, content, source, project, privacy) VALUES ($1, 'spec', $2, 'physics', $3, 'local') RETURNING id", [ownerId, statement, PROJECT])).rows[0].id;
    for (const privateContext of [undefined, false]) {
      const model = modelReplying(pendulum.derivation);
      const result = await capability('physics.derive', bare).run({ problem: 'pendulum', problemId: local }, context({ model, privateContext }));
      assert.doesNotMatch(JSON.stringify(model.calls), /private pendulum/, `privateContext ${privateContext}`);
      assert.equal((await node(result.output.derivationId)).privacy, 'local');
      assert.deepEqual(await derivedFrom(result.output.derivationId), [local]);
    }
    const model = modelReplying(pendulum.derivation);
    await capability('physics.derive', bare).run({ problem: 'pendulum', problemId: local }, context({ model, privateContext: true }));
    assert.match(JSON.stringify(model.calls), /private pendulum/);
  });

  test('physics.compute refuses rather than run unsandboxed, and physics.check reports it could not check', async () => {
    await assert.rejects(capability('physics.compute', bare).run({ ...rc.computation, inputs: rc.given }, context()), { code: 'physics_unavailable' });
    const derivationId = (await capability('physics.derive', bare).run({ problem: 'rc' }, context({ model: modelReplying(rc.derivation) }))).output.derivationId;
    const result = await capability('physics.check', bare).run({ nodeId: derivationId }, context());
    assert.equal(result.output.passed, null);
    assert.match(result.output.unavailable, /missing bwrap/);
    assert.match(result.findings[0], /could not be checked/);
  });
});

describe('a Physicist run', { skip: needsToolchain }, () => {
  test('derives, computes and finishes, each step reading the last one’s result from the graph', async () => {
    resetRegistry();
    registerPlugin(createPhysicsPlugin({ embed: null }));
    registerBuiltInPlugins();

    const role = roleTemplate('physicist');
    const { rows: [{ id: agentId }] } = await server.pool.query(
      `INSERT INTO agents (owner_id, name, role, level, overrides, scopes, model_policy, budget)
       VALUES ($1, 'Physicist', $2, 'sandboxed', '{}', $3, 'local_only', '{}') RETURNING id`,
      [ownerId, role, { read: { projects: [PROJECT], sources: ['*'] }, write: { projects: [PROJECT] } }]
    );
    const { rows: [{ id: runId }] } = await server.pool.query(
      'INSERT INTO agent_runs (owner_id, agent_id, instructions, project) VALUES ($1, $2, $3, $4) RETURNING id',
      [ownerId, agentId, 'Find the capacitor voltage after one second, units checked.', PROJECT]
    );

    // The chooser that picks the computation finds the derivation's id in
    // the graph slice it is shown, where the derive step's finding put it.
    let sawDerivation = null;
    const local = createFakeModelPort({
      responses: [
        '1. Derive V(t).\n2. Compute V at 1 s with a cross-check.\n3. Finish.',
        { capability: 'physics.derive', input: { problem: rc.statement, problemId: problemIds['rc-charging'] }, summary: 'derive the charging curve' },
        rc.derivation,
        (request) => {
          sawDerivation = request.messages[1].content.match(/derivation ([0-9a-f-]{36})/)?.[1] ?? null;
          return { capability: 'physics.compute', input: { ...rc.computation, inputs: rc.given, derivationId: sawDerivation }, summary: 'compute V(1 s)' };
        },
        { done: true, summary: 'V(1 s) = 3.16 V, units checked and cross-checked' },
      ],
    });
    const worker = createWorker({ adapters: { local }, events: createEventBus(), embed: false, leaseMs: 30_000, heartbeatMs: 25, registerPlugins: false });
    try {
      await worker.drain();
    } finally {
      worker.abandon();
    }

    const run = (await server.pool.query('SELECT status, error FROM agent_runs WHERE id = $1', [runId])).rows[0];
    assert.equal(run.status, 'succeeded', run.error);
    const { rows: steps } = await server.pool.query('SELECT capability, status, verification, output FROM agent_run_steps WHERE run_id = $1 ORDER BY index', [runId]);
    assert.deepEqual(steps.map((step) => [step.capability, step.status]), [[null, 'done'], ['physics.derive', 'done'], ['physics.compute', 'done'], [null, 'done']]);
    assert.deepEqual(steps[1].verification.map((entry) => [entry.verifier, entry.ok]), [['result.schema', true], ['physics.units', true], ['physics.limits', true]]);
    assert.deepEqual(steps[2].verification.map((entry) => [entry.verifier, entry.ok]), [['result.schema', true], ['physics.units', true], ['physics.rederive', true]]);
    assert.equal(sawDerivation, steps[1].output.derivationId);
    assert.deepEqual(await derivedFrom(steps[2].output.computationId), [sawDerivation]);
    assert.ok(Math.abs(steps[2].output.outputs.V.value - rc.answer.value) < 1e-6);
  });
});
