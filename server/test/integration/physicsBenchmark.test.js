import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { TASKS, problemOf, validateTask } from '../../src/benchmark/tasks/catalog.js';
import { runTaskBenchmark } from '../../src/benchmark/tasks/run.js';
import { quantityCheck } from '../../src/benchmark/tasks/workspace.js';
import { createPythonRunner } from '../../src/plugins/physics/python.js';
import { startServer } from '../helpers.js';

// The physics task in the task benchmark: ready, run by every arm in a dry
// run, and judged by a quantity check against a reference the arms never see.

const task = TASKS.find((entry) => entry.id === 'physics-projectile-range');
const toolchain = await createPythonRunner().availability();
const skip = toolchain.available ? false : `the physics toolchain is unavailable here (${toolchain.reason})`;

describe('the physics benchmark task', () => {
  test('is ready, valid, and keeps its reference out of what the arms see', () => {
    assert.equal(task.status, 'ready');
    assert.equal(task.role, 'physicist');
    assert.deepEqual(validateTask(task), []);
    const problem = JSON.stringify(problemOf(task));
    assert.doesNotMatch(problem, /84\.6/);
    assert.doesNotMatch(task.instructions, /84\.6/);
    assert.ok(validateTask({ ...task, check: { ...task.check, reference: 'about 85' } }).length >= 1);
    assert.ok(validateTask({ ...task, problem: 'missing.json' }).length >= 1);
  });

  test('the quantity check reads only verified results in the right units', () => {
    const answer = (value, { units = 'm', computationId = 'c1', capability = 'physics.compute' } = {}) => ({ capability, output: { computationId, outputs: { range: { value, units } } } });
    assert.equal(quantityCheck(task, [answer(84.7)]).completed, true);
    assert.equal(quantityCheck(task, [answer(84.7), answer(90)]).completed, false, 'the last verified result counts');
    assert.equal(quantityCheck(task, [answer(90), answer(84.7)]).completed, true);
    assert.equal(quantityCheck(task, [answer(84.7, { computationId: null })]).completed, false, 'a result that failed its own checks never counts');
    assert.match(quantityCheck(task, [answer(0.0847, { units: 'km' })]).output, /in km, not m/);
    assert.equal(quantityCheck(task, [answer(84.7, { capability: 'code.run_generated' })]).completed, false);
    assert.match(quantityCheck(task, []).output, /no verified physics\.compute result/);
  });
});

describe('a dry benchmark run of the physics task', { skip }, () => {
  let server;
  let report;

  before(async () => {
    server = await startServer();
    report = await runTaskBenchmark({ tasks: [task], mode: 'dry', db: server.pool });
  });
  after(async () => {
    await server?.close();
  });

  test('every arm computes the range, verified, and completes by the objective check', () => {
    assert.deepEqual(report.harnessErrors, []);
    assert.equal(report.tasks.length, 4);
    for (const row of report.tasks) {
      assert.equal(row.completed, true, `${row.arm}: ${row.runStatus} ${row.runError ?? ''}`);
      assert.equal(row.claimedDone, true);
    }
    const scope = report.tasks.find((row) => row.arm === 'scope_local');
    assert.equal(scope.runStatus, 'succeeded');
    assert.deepEqual(scope.stepRecord.map((step) => [step.capability, step.status]), [[null, 'done'], ['physics.compute', 'done'], [null, 'done']]);
    assert.ok(!report.pending.some((entry) => entry.id === task.id));
  });

  test('an arm whose computation is wrong does not complete, though it says it is done', async () => {
    const [action] = task.dry.actions;
    // The drag-free range: a self-consistent computation (its cross-check
    // agrees) of the wrong thing.
    const dragFree = "angle = theta.to('rad').magnitude\nresult = {'range': (v0**2 * np.sin(2 * angle) / g).to('m')}\n";
    const wrong = {
      ...task,
      dry: { ...task.dry, actions: [{ ...action, input: { ...action.input, code: dragFree, crossCheck: { code: "result = {'range': v0**2 * math.sin(2 * theta.to('rad').magnitude) / g}" } } }] },
    };
    const result = await runTaskBenchmark({ tasks: [wrong], mode: 'dry', db: server.pool, arms: ['scope_local', 'baseline_sonnet'] });
    for (const row of result.tasks) {
      assert.equal(row.claimedDone, true, row.arm);
      assert.equal(row.completed, false, row.arm);
    }
  });
});
