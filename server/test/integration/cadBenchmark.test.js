import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { TASKS } from '../../src/benchmark/tasks/catalog.js';
import { formatTable, runTaskBenchmark } from '../../src/benchmark/tasks/run.js';
import { createCadQuery, defaultSandbox } from '../../src/plugins/cad/cadquery.js';
import { createCadPlugin } from '../../src/plugins/cad/index.js';
import { createCodePlugin } from '../../src/plugins/code/index.js';
import { registerPlugin, resetRegistry } from '../../src/workspace/capabilities.js';
import { sandboxStatus } from '../../src/workspace/sandbox/index.js';
import { cadQueryForTests } from '../fixtures/cad/replay.js';
import { startServer } from '../helpers.js';

// The CAD task through the dry task benchmark: the CAD Designer (Scope arms)
// and the full-transcript loop (baselines) regenerate the bracket with the
// same scripted calls, and the objective check measures the part each one
// leaves. Doing nothing, or claiming success without the edit, does not
// count; without CadQuery the task is listed as unavailable, not failed.

const sandbox = await sandboxStatus();
const skip = sandbox.available ? false : `no OS sandbox on this machine (${sandbox.reason})`;
if (skip) console.log(`# skipping the CAD benchmark tests: ${skip}`);

const cadTask = TASKS.find((entry) => entry.id === 'cad-bracket-hole-spacing');

describe('the CAD task in the dry task benchmark', { skip }, () => {
  let server;
  let cadquery;
  let save = () => {};

  before(async () => {
    server = await startServer();
    ({ cadquery, save } = await cadQueryForTests({ createCadQuery, defaultSandbox }));
    // The arms register the built-ins only when they are missing, so this
    // CadQuery (real, recording or replaying) is the one they use.
    resetRegistry();
    registerPlugin(createCodePlugin());
    registerPlugin(createCadPlugin({ cadquery }));
  });

  after(async () => {
    save();
    resetRegistry();
    await server?.close();
  });

  const run = (task, options = {}) =>
    runTaskBenchmark({ tasks: [task], mode: 'dry', db: server.pool, tools: { cadquery: () => cadquery.status() }, ...options });

  test('every arm regenerates the bracket, and the measured part completes the task', async () => {
    const report = await run(cadTask);
    assert.deepEqual(report.harnessErrors, []);
    assert.equal(report.tasks.length, 4);
    for (const row of report.tasks) {
      assert.equal(row.completed, true, `${row.arm}: ${row.runStatus} ${row.runError ?? ''}`);
      assert.equal(row.claimedDone, true);
    }
    const scope = report.tasks.find((row) => row.arm === 'scope_local');
    assert.equal(scope.costUsd, 0, 'the local arm costs nothing');
    assert.ok(report.tasks.find((row) => row.arm === 'baseline_opus').costUsd > 0);
    assert.match(formatTable(report), /cad-bracket-hole-spacing \| scope_local \| yes/);
  });

  test('claiming success without the edit is not completed', async () => {
    const lazy = {
      ...cadTask,
      dry: { ...cadTask.dry, actions: cadTask.dry.actions.filter((action) => action.capability === 'cad.inspect') },
    };
    const report = await run(lazy, { arms: ['scope_local', 'baseline_sonnet'] });
    for (const row of report.tasks) {
      assert.equal(row.claimedDone, true, row.arm);
      assert.equal(row.completed, false, row.arm);
    }
  });

  test('without CadQuery the task is listed as unavailable, never run and never failed', async () => {
    const report = await run(cadTask, { tools: { cadquery: async () => ({ available: false, reason: 'not installed' }) } });
    assert.equal(report.tasks.length, 0);
    assert.deepEqual(report.pending.map((entry) => [entry.id, entry.status]), [['cad-bracket-hole-spacing', 'unavailable']]);
    assert.match(report.pending[0].reason, /cadquery is not available here \(not installed\)/);
    assert.match(formatTable(report), /cad-bracket-hole-spacing \(cad\): cadquery is not available here/);
  });
});
