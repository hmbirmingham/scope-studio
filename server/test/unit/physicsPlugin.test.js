import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createPhysicsPlugin } from '../../src/plugins/physics/index.js';
import { parseDerivationReply, requestDerivation } from '../../src/plugins/physics/derive.js';
import { validateProblems, problemContent } from '../../src/plugins/physics/ingest.js';
import { physicsPrivacy } from '../../src/plugins/physics/nodes.js';
import { createPythonRunner } from '../../src/plugins/physics/python.js';
import {
  compareOutputs,
  computationContent,
  derivationContent,
  parseSpec,
  validateComputeInput,
  validateDerivation,
} from '../../src/plugins/physics/spec.js';
import { registerBuiltInPlugins } from '../../src/plugins/registry.js';
import { capabilitiesForTags, getCapability, getVerifier, listPlugins, resetRegistry } from '../../src/workspace/capabilities.js';
import { SandboxError } from '../../src/workspace/sandbox/run.js';
import { createFakeModelPort } from '../fakeModelPort.js';
import { removeTempDirs, useDataDir } from '../integration/workspaceSandboxFixtures.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(readFileSync(join(here, '../fixtures/physics', `${name}.json`), 'utf8'));
const FIXTURES = ['pendulum-period', 'rc-charging', 'projectile-range'].map(fixture);
const pendulum = FIXTURES[0];

let data;
before(() => {
  data = useDataDir();
});
after(() => {
  data.restore();
  removeTempDirs();
});

// A sandbox that runs nothing: it answers each harness job with a recorded
// payload, the way the real harness prints it (a marker line carrying the
// job's nonce), and records what it was asked to run.
function recordedSandbox(answer, { status = { available: true, mechanism: 'bwrap', reason: null } } = {}) {
  const calls = [];
  return {
    calls,
    status: async () => status,
    async run(options) {
      const job = JSON.parse(readFileSync(options.args[3], 'utf8'));
      calls.push({ options, job, harness: readFileSync(options.args[2], 'utf8') });
      const reply = await answer(job, options);
      if (reply instanceof Error) throw reply;
      if (typeof reply === 'string') return { ok: true, exitCode: 0, output: reply, timedOut: false, limit: null };
      if (reply?.raw) return { ok: false, exitCode: reply.exitCode ?? 1, output: reply.raw, timedOut: Boolean(reply.timedOut), limit: reply.limit ?? null };
      return { ok: true, exitCode: 0, output: `noise\n@@physics-result@@${job.nonce} ${JSON.stringify(reply)}\n`, timedOut: false, limit: null };
    },
  };
}

const PROBE_OK = { ok: true, missing: [], versions: { python: '3.13.0', numpy: '2.0', scipy: '1.14', pint: '0.24' } };

describe('physics specs', () => {
  test('every fixture derivation validates', () => {
    for (const problem of FIXTURES) {
      const derivation = validateDerivation(problem.derivation);
      assert.equal(derivation.result.symbol, problem.derivation.result.symbol);
      assert.ok(derivation.assumptions.length >= 1);
      assert.ok(derivation.limits.length >= 1);
      assert.equal(typeof derivation.variables[Object.keys(derivation.variables)[0]], 'string', 'variable values are kept as quantities');
    }
  });

  test('a derivation must state assumptions, units and at least one limiting case', () => {
    const base = pendulum.derivation;
    const without = (patch) => ({ ...base, ...patch });
    assert.throws(() => validateDerivation(without({ limits: [] })), /limiting case/);
    assert.throws(() => validateDerivation(without({ assumptions: [] })), /assumptions/);
    assert.throws(() => validateDerivation(without({ result: { ...base.result, units: '' } })), /result.units/);
    assert.throws(() => validateDerivation(without({ variables: {} })), /variables/);
    assert.throws(() => validateDerivation(without({ variables: { result: '1 m' } })), /reserved/);
    assert.throws(() => validateDerivation(without({ variables: { 'L; import os': '1 m' } })), /identifier/);
    assert.throws(() => validateDerivation(without({ limits: [{ name: 'x', set: { nope: '1 m' }, expect: 'L' }] })), /not a declared variable/);
    assert.throws(() => validateDerivation(without({ limits: [{ name: 'x', set: { L: '1 m' }, expect: 'L', expectValue: '1 m' }] })), /exactly one/);
    assert.throws(() => validateDerivation(without({ limits: [{ name: 'x', set: { L: '1 m' }, expect: 'L', rtol: 0.5 }] })), /rtol/);
    assert.throws(() => validateDerivation('not an object'), /JSON object/);
  });

  test('a computation needs an independent cross-check and declared output units', () => {
    const rc = FIXTURES[1].computation;
    const ok = validateComputeInput({ ...rc, inputs: FIXTURES[1].given });
    assert.equal(ok.tolerance, 1e-3);
    assert.deepEqual(ok.outputs, { V: 'V' });
    assert.throws(() => validateComputeInput({ ...rc, crossCheck: undefined }), /crossCheck is required/);
    assert.throws(() => validateComputeInput({ ...rc, crossCheck: { code: `${rc.code}\n# same thing\n` } }), /different computation/);
    assert.throws(() => validateComputeInput({ ...rc, outputs: undefined }), /outputs is required/);
    assert.throws(() => validateComputeInput({ template: 'expression', crossCheck: rc.crossCheck }), /derivationId/);
    assert.throws(() => validateComputeInput({ template: 'expression', code: 'x', derivationId: 'x', crossCheck: rc.crossCheck }), /not both/);
    assert.throws(() => validateComputeInput({ template: 'shell', derivationId: 'x', crossCheck: rc.crossCheck }), /template/);
    assert.throws(() => validateComputeInput({ ...rc, tolerance: 0.2 }), /tolerance/);
    assert.throws(() => validateComputeInput({ ...rc, inputs: { np: '1 m' } }), /reserved/);
    assert.throws(() => validateComputeInput({ ...rc, timeoutMs: 10 }), /timeoutMs/);
  });

  test('node content is readable and carries its spec back', () => {
    const derivation = validateDerivation(pendulum.derivation);
    const content = derivationContent(derivation, { results: { units: { ok: true }, limits: { ok: true } } });
    assert.match(content, /^Derivation: Pendulum period at finite amplitude\nT = 4\*sqrt\(L\/g\)\*ellipk/);
    assert.match(content, /Assumptions:\n- point mass/);
    assert.match(content, /small amplitude: theta0 = 1e-3 rad → 2\*pi\*sqrt\(L\/g\)/);
    assert.match(content, /Checks: units passed; limits passed/);
    const spec = parseSpec(content);
    assert.equal(spec.kind, 'derivation');
    assert.deepEqual(validateDerivation(spec), derivation);

    const unverified = derivationContent(derivation, { unavailable: true, reason: 'Python is missing scipy' });
    assert.match(unverified, /Checks: not run \(Python is missing scipy\) — unverified/);

    const computed = computationContent({ title: 'V', inputs: { t: '1 s' }, outputs: { V: { value: 3.16060279, units: 'V' } }, crossCheck: { method: 'ODE' }, template: null, method: null }, { results: { units: { ok: true }, rederive: { ok: true } } });
    assert.match(computed, /V = 3\.1606 V/);
    assert.match(computed, /Cross-check: ODE/);
    assert.equal(parseSpec(computed).kind, 'computation');

    assert.equal(parseSpec('no spec here'), null);
    assert.equal(parseSpec('```physics-spec\n{not json\n```'), null);
    assert.equal(parseSpec('```physics-spec\n[1]\n```'), null);
  });

  test('outputs agree within the relative tolerance, and anything missing disagrees', () => {
    const a = { x: { value: 1.0, units: 'm' } };
    assert.equal(compareOutputs(a, { x: { value: 1.0005, units: 'm' } }, 1e-3).ok, true);
    const off = compareOutputs(a, { x: { value: 1.01, units: 'm' } }, 1e-3);
    assert.equal(off.ok, false);
    assert.match(off.detail, /disagrees: x: 1 vs 1\.01 m/);
    assert.equal(compareOutputs(a, {}, 1e-3).ok, false);
    assert.equal(compareOutputs({}, {}, 1e-3).ok, false, 'nothing compared is not agreement');
    assert.equal(compareOutputs({ z: { value: 0, units: 'm' } }, { z: { value: 0, units: 'm' } }, 1e-3).ok, true);
  });

  test('physics nodes are local unless the context says outright it held nothing private', () => {
    assert.equal(physicsPrivacy({}, []), 'local');
    assert.equal(physicsPrivacy({ privateContext: true }, []), 'local');
    assert.equal(physicsPrivacy({ privateContext: false }, []), 'cloud');
    assert.equal(physicsPrivacy({ privateContext: false }, [{ privacy: 'cloud' }, { privacy: 'local' }]), 'local');
  });

  test('ingest validates problems and never writes an answer', () => {
    const body = { project: 'mechanics', problems: FIXTURES.map(({ id, title, statement, given, find, answer }) => ({ id, title, statement, given, find, answer })) };
    const { problems, privacy } = validateProblems(body);
    assert.equal(privacy, 'local', 'problems a user brings are private unless they say otherwise');
    assert.equal(problems.length, 3);
    for (const problem of problems) {
      const content = problemContent(problem);
      assert.match(content, /^Physics problem: /);
      assert.doesNotMatch(content, /answer|84\.659|3\.1606|2\.0110/);
    }
    assert.throws(() => validateProblems({ ...body, project: '' }), /project/);
    assert.throws(() => validateProblems({ ...body, problems: [] }), /problems/);
    assert.throws(() => validateProblems({ ...body, problems: [body.problems[0], body.problems[0]] }), /twice/);
    assert.throws(() => validateProblems({ ...body, problems: [{ ...body.problems[0], id: '../x' }] }), /id/);
    assert.throws(() => validateProblems({ ...body, privacy: 'public' }), /privacy/);
    assert.throws(() => validateProblems({ ...body, problems: [{ ...body.problems[0], given: { L: 1 } }] }), /given/);
  });
});

describe('physics.derive model reply', () => {
  test('takes the JSON object out of fences, prose and think blocks', () => {
    const reply = `<think>units first</think>Here it is:\n\`\`\`json\n${JSON.stringify(pendulum.derivation)}\n\`\`\`\nDone.`;
    assert.equal(parseDerivationReply(reply).result.expression, pendulum.derivation.result.expression);
    assert.throws(() => parseDerivationReply('no json'), { code: 'invalid_derivation' });
    assert.throws(() => parseDerivationReply('{"title": "x"}'), { code: 'invalid_derivation' });
  });

  test('asks once more, saying what was wrong, and then gives up', async () => {
    const model = createFakeModelPort({ responses: ['{"title": "half"}', pendulum.derivation] });
    const { derivation, attempts } = await requestDerivation({ model, problem: 'pendulum period', agent: { role: { embodiment: 'You are a physicist.' } } });
    assert.equal(attempts, 2);
    assert.equal(derivation.result.symbol, 'T');
    assert.match(model.calls[0].messages[0].content, /^You are a physicist\./);
    assert.match(model.calls[0].messages[0].content, /at least one limiting case/);
    assert.match(model.calls[1].messages.at(-1).content, /cannot be used: a derivation needs result/);

    const stubborn = createFakeModelPort({ fallback: 'I would rather not' });
    await assert.rejects(requestDerivation({ model: stubborn, problem: 'x' }), { code: 'invalid_derivation' });
    assert.equal(stubborn.calls.length, 2);
    await assert.rejects(requestDerivation({ model: null, problem: 'x' }), { code: 'no_model' });
  });
});

describe('the sandboxed Python runner', () => {
  test('runs the harness in the sandbox with a fixed argument list and reads the marked result', async () => {
    const sandbox = recordedSandbox((job) => (job.mode === 'probe' ? PROBE_OK : { ok: true, checks: { units: { ok: true, detail: 'fine' } } }));
    const py = createPythonRunner({ sandbox, python: 'python3' });
    const payload = await py.run({ mode: 'check', checks: ['units'], spec: { expression: 'L' } }, { ctx: { localPath: '/home/someone/project' } });
    assert.deepEqual(payload.checks.units, { ok: true, detail: 'fine' });

    assert.equal(sandbox.calls.length, 2, 'one probe, one job');
    const { options, job, harness } = sandbox.calls[1];
    assert.equal(options.command, 'python3');
    assert.deepEqual(options.args.slice(0, 2), ['-I', '-B']);
    assert.match(options.args[2], /physics-[0-9a-f-]+\/harness\.py$/);
    assert.deepEqual(options.writable, [options.cwd], 'only the job directory is writable');
    assert.deepEqual(options.readOnly, []);
    assert.deepEqual(options.protect, ['/home/someone/project'], "the user's checkout is never mounted");
    assert.equal(options.env.OPENBLAS_NUM_THREADS, '1');
    assert.ok(options.timeoutMs <= 120_000 && options.memoryMb >= 512);
    assert.equal(job.mode, 'check');
    assert.match(harness, /def evaluate\(expression, values\)/);
    // The scratch sandbox made for the call is gone afterwards.
    assert.equal(existsSync(options.cwd), false);
  });

  test('ignores a result line forged without the nonce', async () => {
    const sandbox = recordedSandbox((job) => (job.mode === 'probe' ? PROBE_OK : `@@physics-result@@not-the-nonce {"ok": true, "checks": {}}\n`));
    const py = createPythonRunner({ sandbox });
    await assert.rejects(py.run({ mode: 'check', checks: [], spec: {} }), { code: 'python_failed' });
  });

  test('reports the time limit and a crash as errors, with the output tail', async () => {
    const limited = recordedSandbox((job) => (job.mode === 'probe' ? PROBE_OK : { raw: 'partial', timedOut: true, limit: 'timeout', exitCode: null }));
    await assert.rejects(createPythonRunner({ sandbox: limited }).run({ mode: 'compute' }), { code: 'python_limit', limit: 'timeout' });
    const crashed = recordedSandbox((job) => (job.mode === 'probe' ? PROBE_OK : { raw: 'Segmentation fault', exitCode: 139 }));
    await assert.rejects(createPythonRunner({ sandbox: crashed }).run({ mode: 'compute' }), (err) => err.code === 'python_failed' && /Segmentation fault/.test(err.message));
  });

  for (const [label, answer, reason] of [
    ['no OS sandbox', () => new SandboxError('sandbox_unavailable', 'no OS sandbox is available (missing bwrap); refusing to run unsandboxed'), /missing bwrap/],
    ['no python3', () => new SandboxError('command_not_found', 'python3 is not installed'), /python3 is not installed/],
    ['missing packages', () => ({ ok: false, missing: ['scipy', 'pint'], versions: { python: '3.12' } }), /Python is missing scipy, pint/],
    ['a broken interpreter', () => ({ raw: 'Fatal Python error', exitCode: 1 }), /the Python probe failed/],
  ]) {
    test(`with ${label} the toolchain is unavailable and nothing else runs`, async () => {
      const sandbox = recordedSandbox(answer);
      const py = createPythonRunner({ sandbox });
      const state = await py.availability();
      assert.equal(state.available, false);
      assert.match(state.reason, reason);
      await assert.rejects(py.run({ mode: 'compute', code: 'result = {}' }), (err) => err.code === 'physics_unavailable' && reason.test(err.message));
      assert.ok(sandbox.calls.every((call) => call.job.mode === 'probe'), 'only the probe was attempted');
    });
  }

  test('keeps a working toolchain, and tries a missing one again after a while', async () => {
    let clock = 0;
    let installed = false;
    const sandbox = recordedSandbox(() => (installed ? PROBE_OK : { ok: false, missing: ['pint'] }));
    const py = createPythonRunner({ sandbox, now: () => clock });
    assert.equal((await py.availability()).available, false);
    installed = true;
    clock += 1_000;
    assert.equal((await py.availability()).available, false, 'a failure is kept for a short while');
    clock += 30_000;
    assert.equal((await py.availability()).available, true);
    const probes = sandbox.calls.length;
    clock += 10 * 60_000;
    await Promise.all([py.availability(), py.availability()]);
    assert.equal(sandbox.calls.length, probes, 'a success is kept');
  });
});

describe('physics plug-in', () => {
  beforeEach(resetRegistry);

  test('registers through the built-in registry with its tag, permissions and verifiers', () => {
    registerBuiltInPlugins();
    registerBuiltInPlugins();
    assert.ok(listPlugins().includes('physics'));
    assert.equal(getCapability('physics.derive').permission, 'write_notes');
    assert.equal(getCapability('physics.compute').permission, 'run_generated_code');
    assert.equal(getCapability('physics.check').permission, 'run_generated_code');
    assert.deepEqual(getCapability('physics.derive').verifiers, ['physics.units', 'physics.limits']);
    assert.deepEqual(getCapability('physics.compute').verifiers, ['physics.units', 'physics.rederive']);
    for (const name of ['physics.units', 'physics.limits', 'physics.rederive']) assert.ok(getVerifier(name), name);
    assert.deepEqual(capabilitiesForTags(['physics']).map((entry) => entry.name).sort(), ['physics.check', 'physics.compute', 'physics.derive']);
    assert.equal(capabilitiesForTags(['code', 'scripts', 'sandbox']).some((entry) => entry.plugin === 'physics'), false, 'only roles with the physics tag reach it');
  });

  const derivationResult = () => ({ output: { spec: { kind: 'derivation', ...pendulum.derivation } } });

  test('verifiers report unavailable, never a pass, without the toolchain', async () => {
    const sandbox = recordedSandbox(() => ({ ok: false, missing: ['numpy', 'scipy', 'pint'] }));
    const plugin = createPhysicsPlugin({ sandbox, embed: null });
    for (const verifier of plugin.verifiers) {
      const outcome = await verifier.verify(derivationResult(), {});
      if (verifier.name === 'physics.rederive') {
        assert.equal(outcome.ok, true);
        assert.equal(outcome.unavailable, true);
      } else {
        assert.deepEqual(outcome, { ok: true, unavailable: true, detail: `${verifier.name} was not checked: Python is missing numpy, scipy, pint` });
      }
    }
    assert.ok(sandbox.calls.every((call) => call.job.mode === 'probe'));
  });

  test('verifiers check a result they did not see made, and fail what fails', async () => {
    const sandbox = recordedSandbox((job) => {
      if (job.mode === 'probe') return PROBE_OK;
      assert.equal(job.mode, 'check');
      assert.equal(job.spec.expression, pendulum.derivation.result.expression);
      return { ok: true, checks: { units: { ok: true, detail: 'consistent' }, limits: { ok: false, detail: '0 of 1 limiting cases hold' } } };
    });
    const plugin = createPhysicsPlugin({ sandbox, embed: null });
    const verify = (name, result) => plugin.verifiers.find((entry) => entry.name === name).verify(result, {});
    assert.deepEqual(await verify('physics.units', derivationResult()), { ok: true, detail: 'consistent' });
    assert.deepEqual(await verify('physics.limits', derivationResult()), { ok: false, detail: '0 of 1 limiting cases hold' });
    assert.equal((await verify('physics.rederive', derivationResult())).ok, false, 'rederive does not apply to a derivation');
    assert.equal((await verify('physics.units', { output: 'plain text' })).ok, false, 'nothing to check is not a pass');
  });

  test('physics.compute refuses to run anything without the toolchain', async () => {
    const sandbox = recordedSandbox(() => new SandboxError('sandbox_unavailable', 'no OS sandbox is available (missing bwrap)'));
    const plugin = createPhysicsPlugin({ sandbox, embed: null });
    const compute = plugin.capabilities.find((entry) => entry.name === 'physics.compute');
    const rc = FIXTURES[1];
    await assert.rejects(compute.run({ ...rc.computation, inputs: rc.given }, { ownerId: null }), { code: 'physics_unavailable' });
  });

  test('physics.compute rejects bad input before any sandbox work', async () => {
    const sandbox = recordedSandbox(() => PROBE_OK);
    const plugin = createPhysicsPlugin({ sandbox, embed: null });
    const compute = plugin.capabilities.find((entry) => entry.name === 'physics.compute');
    await assert.rejects(compute.run({ code: 'result = {}', outputs: { x: 'm' } }, {}), /crossCheck is required/);
    assert.equal(sandbox.calls.length, 0);
  });
});
