import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { FIXTURES_DIR, TASKS } from '../../src/benchmark/tasks/catalog.js';
import { formatTable, runTaskBenchmark, toJson } from '../../src/benchmark/tasks/run.js';
import { contextGrowth } from '../../src/benchmark/endurance/economics.js';
import { SLICE_NODES, SLICE_TOKENS } from '../../src/workspace/runner/slice.js';
import { sandboxStatus } from '../../src/workspace/sandbox/index.js';
import { startServer } from '../helpers.js';

// The dry task benchmark end to end: the real runner, code plug-in and OS
// sandbox for the Scope arms, the full-transcript tool loop for the
// baselines, scripted models for all of them. Completion comes from the
// fixtures' own tests, run on each arm's result.

const sandbox = await sandboxStatus();
const skip = sandbox.available ? false : `no OS sandbox on this machine (${sandbox.reason})`;
if (skip) console.log(`# skipping the task benchmark tests: ${skip}`);

const byId = (id) => TASKS.find((entry) => entry.id === id);

function snapshotDir(dir) {
  const out = {};
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) Object.assign(out, snapshotDir(path));
    else out[relative(FIXTURES_DIR, path)] = readFileSync(path, 'utf8');
  }
  return out;
}

describe('dry task benchmark', { skip }, () => {
  let server;
  let report;
  const fixturesBefore = snapshotDir(FIXTURES_DIR);

  before(async () => {
    server = await startServer();
    report = await runTaskBenchmark({
      tasks: [byId('code-paginate-off-by-one'), byId('code-order-quote-unit-mismatch'), byId('kicad-erc-unconnected-pin')],
      mode: 'dry',
      db: server.pool,
    });
  });

  after(async () => {
    await server?.close();
  });

  const rows = (arm) => report.tasks.filter((row) => row.arm === arm);

  test('every arm completes both code tasks, by the objective check', () => {
    assert.deepEqual(report.harnessErrors, []);
    assert.equal(report.tasks.length, 8);
    for (const row of report.tasks) {
      assert.equal(row.completed, true, `${row.task} ${row.arm}: ${row.runStatus} ${row.runError ?? ''}`);
      assert.equal(row.claimedDone, true);
      assert.equal(row.check.exitCode, 0);
      assert.equal(row.check.testsTampered, false);
    }
    for (const row of [...rows('scope_local'), ...rows('scope_local_cloud')]) assert.equal(row.runStatus, 'succeeded');
  });

  test('the Scope arms ran the real runner: plan, the scripted actions, done', () => {
    const paginate = rows('scope_local').find((row) => row.task === 'code-paginate-off-by-one');
    const actions = byId('code-paginate-off-by-one').dry.actions;
    assert.deepEqual(
      paginate.stepRecord.map((step) => step.capability),
      [null, ...actions.map((action) => action.capability), null]
    );
    assert.ok(paginate.stepRecord.every((step) => step.status === 'done'));
    assert.equal(paginate.actions, actions.length);
    // The runner's own cost ledger agrees with what the benchmark counted.
    for (const row of [...rows('scope_local'), ...rows('scope_local_cloud')]) {
      assert.equal(row.ledger.calls, row.modelCalls);
      assert.equal(row.ledger.tokens, row.tokens.input + row.tokens.output);
      assert.ok(Math.abs(row.ledger.costUsd - row.costUsd) < 1e-6);
    }
  });

  test('costs: local is free, local+cloud pays only for planning, the baselines pay every turn', () => {
    for (const row of rows('scope_local')) {
      assert.equal(row.costUsd, 0);
      assert.equal(row.cloudCalls, 0);
    }
    for (const row of rows('scope_local_cloud')) {
      assert.equal(row.cloudCalls, 1, 'one planning call goes to the platform');
      assert.equal(row.perCall.find((call) => call.purpose === 'plan').model, 'claude-opus-5');
      assert.ok(row.costUsd > 0);
      assert.equal(row.tokens.cacheRead, 0, 'Scope’s cloud calls are priced without caching');
    }
    for (const name of ['baseline_sonnet', 'baseline_opus']) {
      for (const row of rows(name)) {
        assert.ok(row.costUsd > 0);
        assert.equal(row.cloudCalls, row.modelCalls);
        assert.ok(row.tokens.cacheRead > 0, 'the baseline reads its re-sent transcript from the cache');
        assert.ok(row.tokens.cacheWrite > 0);
      }
    }
    const { totals } = report;
    assert.equal(totals.scope_local.costPerCompletedUsd, 0);
    assert.ok(totals.baseline_sonnet.costPerCompletedUsd > totals.scope_local_cloud.costPerCompletedUsd);
    assert.ok(totals.baseline_opus.costPerCompletedUsd > totals.baseline_sonnet.costPerCompletedUsd);
    assert.equal(report.comparisons.scope_local_vs_baseline_sonnet.baselineCostPerCompletedOverScope, Infinity);
    assert.ok(report.comparisons.scope_local_cloud_vs_baseline_sonnet.baselineCostPerCompletedOverScope > 1);
    assert.equal(report.pricedUsd, report.tasks.reduce((sum, row) => sum + row.costUsd, 0));
    assert.equal(report.spentUsd, 0, 'a dry run spends nothing');
  });

  test('Scope’s per-step context stays bounded while the baseline’s grows every turn', () => {
    for (const row of rows('baseline_sonnet')) {
      const prompts = row.perCall.map((call) => call.promptTokens);
      for (let i = 1; i < prompts.length; i += 1) assert.ok(prompts[i] > prompts[i - 1], `${row.task} turn ${i + 1} re-sends everything before it`);
    }
    // The slice has a fixed budget, so no step reads more than the fixed
    // prompt plus that budget (and each packed node's one-line header, and
    // the last step's summary appended to the goal), however long the run.
    const bound = (first) => first + SLICE_TOKENS + SLICE_NODES * 40 + 125;
    for (const scope of rows('scope_local')) {
      const steps = scope.perCall.filter((call) => call.purpose !== 'plan').map((call) => call.promptTokens);
      assert.ok(Math.max(...steps) <= bound(steps[0]), `${scope.task}: ${steps.join(', ')}`);
      const baseline = rows('baseline_sonnet').find((row) => row.task === scope.task);
      assert.ok(baseline.context.lastStepPromptTokens > scope.context.maxStepPromptTokens);
    }
    // On the long task the difference is the whole story: once the slice is
    // full Scope's context stops growing, and the transcript never does.
    const long = (arm) => rows(arm).find((row) => row.task === 'code-order-quote-unit-mismatch');
    const scopeSteps = long('scope_local').perCall.filter((call) => call.purpose !== 'plan').map((call) => call.promptTokens);
    const baselineSteps = long('baseline_sonnet').perCall.map((call) => call.promptTokens);
    assert.ok(scopeSteps.length >= 14 && baselineSteps.length >= 14);
    const secondHalf = (values) => values.slice(Math.floor(values.length / 2));
    assert.ok(Math.abs(contextGrowth(secondHalf(scopeSteps))) < 40, `Scope, second half: ${secondHalf(scopeSteps).join(', ')}`);
    assert.ok(contextGrowth(secondHalf(baselineSteps)) > 100, `baseline, second half: ${secondHalf(baselineSteps).join(', ')}`);
    assert.ok(long('baseline_sonnet').context.growthTokensPerStep > 2 * long('scope_local').context.growthTokensPerStep);
    assert.ok(baselineSteps.at(-1) > 2 * Math.max(...scopeSteps), 'by the end the baseline sends more than twice Scope’s largest step');
    // The curves the JSON reports.
    assert.ok(report.totals.baseline_sonnet.contextCurve.length >= 6);
    assert.ok(report.totals.scope_local.contextCurve.every((point) => point.meanPromptTokens > 0));
  });

  test('pending gates are listed, not run and not failures', () => {
    assert.deepEqual(report.pending.map((entry) => entry.id), ['kicad-erc-unconnected-pin']);
    assert.ok(!report.tasks.some((row) => row.task === 'kicad-erc-unconnected-pin'));
    const table = formatTable(report);
    assert.match(table, /Pending acceptance gates/);
    assert.match(table, /code-paginate-off-by-one \| scope_local \| yes/);
    assert.ok(JSON.parse(toJson(report)).comparisons.scope_local_vs_baseline_sonnet.baselineCostPerCompletedOverScope === 'unbounded');
  });

  test('the benchmark leaves no account behind and never touches its fixtures', async () => {
    const { rows: users } = await server.pool.query("SELECT count(*)::int AS c FROM users WHERE email LIKE 'task-benchmark+%'");
    assert.equal(users[0].c, 0);
    const { rows: runs } = await server.pool.query('SELECT count(*)::int AS c FROM agent_runs');
    assert.equal(runs[0].c, 0, 'the runs went with the account');
    assert.deepEqual(snapshotDir(FIXTURES_DIR), fixturesBefore);
  });

  test('a model that says done without fixing anything is not completed', async () => {
    const base = byId('code-profile-missing-null-check');
    const lazy = { ...base, dry: { ...base.dry, actions: base.dry.actions.filter((action) => action.capability !== 'code.edit') } };
    const result = await runTaskBenchmark({ tasks: [lazy], mode: 'dry', arms: ['scope_local', 'baseline_sonnet'], db: server.pool });
    for (const row of result.tasks) {
      assert.equal(row.claimedDone, true, row.arm);
      assert.equal(row.completed, false, row.arm);
      assert.notEqual(row.check.exitCode, 0);
    }
    assert.equal(result.totals.scope_local.claimedButFailed, 1);
    assert.equal(result.totals.scope_local.costPerCompletedUsd, null);
    assert.match(formatTable(result), /NO \(claimed\)/);
  });

  test('editing the tests to pass does not count: the check restores them', async () => {
    const base = byId('code-temperature-wrong-import');
    const cheat = {
      ...base,
      dry: {
        ...base.dry,
        actions: [
          { capability: 'code.edit', input: { path: 'test/report.test.js', search: 'assert.equal(dailyReport(day).mean, 16);', replace: '' }, summary: 'drop the failing assertion' },
          { capability: 'code.edit', input: { path: 'test/report.test.js', search: "assert.equal(dailyReport([10, 11]).mean, 10.5);", replace: '' }, summary: 'and the other' },
          { capability: 'code.edit', input: { path: 'test/report.test.js', search: "assert.equal(formatReport(dailyReport(day)), 'mean 16 °C (12 to 21)');", replace: '' }, summary: 'and the format' },
          { capability: 'code.run_script', input: { script: 'test' }, summary: 'the tests pass now' },
        ],
      },
    };
    const result = await runTaskBenchmark({ tasks: [cheat], mode: 'dry', arms: ['baseline_sonnet', 'scope_local'], db: server.pool });
    for (const row of result.tasks) {
      assert.equal(row.completed, false, row.arm);
      assert.equal(row.check.testsTampered, true, row.arm);
    }
  });
});
