import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { withTranscriptBreakpoints } from '../../src/benchmark/endurance/arms.js';
import { contextGrowth, costPerCompleted, meanCurve, priceRequest } from '../../src/benchmark/endurance/economics.js';
import { costUsd } from '../../src/lib/anthropic.js';
import { baselineSystem } from '../../src/benchmark/tasks/baselineArm.js';
import { FIXTURES_DIR, TASKS, fixturePath, selectTasks, validateTask } from '../../src/benchmark/tasks/catalog.js';
import { armSummary, comparisons, stepPrompts, taskRow, tokenTotals } from '../../src/benchmark/tasks/metrics.js';
import { createCallLog, createScript, scopeCloudModel, scriptedPort } from '../../src/benchmark/tasks/models.js';
import { ARMS, liveRefusal, parseArgs, runTaskBenchmark } from '../../src/benchmark/tasks/run.js';

// The task benchmark's arithmetic and bookkeeping, from plain data: pricing,
// the context-growth measure, what counts as completed, and the refusals
// that keep a live run from spending without a key and a cap.

const call = (overrides = {}) => ({
  index: 1,
  purpose: 'step',
  adapter: 'local',
  model: 'scripted-local',
  promptTokens: 100,
  inputTokens: 100,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
  outputTokens: 10,
  costUsd: 0,
  ...overrides,
});

const check = (completed, extra = {}) => ({ completed, exitCode: completed ? 0 : 1, timedOut: false, testsTampered: false, ...extra });
const task = { id: 'code-x', kind: 'code' };

describe('task economics', () => {
  test('context growth is the least-squares slope of prompt size per step', () => {
    assert.equal(contextGrowth([500, 500, 500, 500]), 0);
    assert.equal(contextGrowth([100, 300, 500, 700]), 200);
    // A noisy but bounded series has a slope near zero, a transcript's is what each step adds.
    assert.ok(Math.abs(contextGrowth([900, 1100, 1000, 950, 1050])) < 50);
    assert.equal(contextGrowth([42]), null);
    assert.equal(contextGrowth([]), null);
  });

  test('cost per completed task is null when nothing was completed', () => {
    assert.equal(costPerCompleted(0.5, 4), 0.125);
    assert.equal(costPerCompleted(0, 2), 0);
    assert.equal(costPerCompleted(0.3, 0), null);
  });

  test('the mean curve averages each step over the runs that reached it', () => {
    assert.deepEqual(meanCurve([[100, 200, 300], [300, 400]]), [
      { step: 1, meanPromptTokens: 200, runs: 2 },
      { step: 2, meanPromptTokens: 300, runs: 2 },
      { step: 3, meanPromptTokens: 300, runs: 1 },
    ]);
  });

  test('a growing transcript with breakpoints reads its previous turn from the cache', () => {
    const cache = new Set();
    const model = 'claude-sonnet-5';
    const system = 'You fix bugs. '.repeat(50);
    const transcript = [{ role: 'user', content: 'Task: fix it. '.repeat(40) }];
    const first = priceRequest({ model, system, messages: withTranscriptBreakpoints(transcript), outputTokens: 30, cache });
    assert.equal(first.usage.cache_read_input_tokens, 0);
    assert.ok(first.usage.cache_creation_input_tokens > 0, 'the first turn writes the prefix');

    transcript.push({ role: 'assistant', content: '{"capability":"code.read","input":{"path":"a.js"}}' });
    transcript.push({ role: 'user', content: 'Result of code.read:\n'.concat('x'.repeat(2000)) });
    const second = priceRequest({ model, system, messages: withTranscriptBreakpoints(transcript), outputTokens: 30, cache });
    assert.equal(second.usage.cache_read_input_tokens, first.usage.cache_creation_input_tokens, 'turn 2 reads exactly what turn 1 wrote');
    assert.ok(second.usage.cache_creation_input_tokens > 500, 'and writes what it added');
    // Read at a tenth of the input price, written at 1.25x.
    const expected = costUsd(model, second.usage);
    assert.equal(second.costUsd, expected);
    const uncached = costUsd(model, { input_tokens: second.usage.cache_read_input_tokens + second.usage.cache_creation_input_tokens + second.usage.input_tokens, output_tokens: 30 });
    assert.ok(second.costUsd < uncached, 'caching makes the re-sent prefix cheaper than sending it fresh');
  });
});

describe('task metrics', () => {
  test('completed is the objective check, never the model saying so', () => {
    const claimed = taskRow({ task, arm: ARMS.baseline_sonnet, result: { check: check(false), claimedDone: true, runStatus: 'claimed_done', wallMs: 5, steps: 3, calls: [call()] } });
    assert.equal(claimed.completed, false);
    assert.equal(claimed.claimedDone, true);
    const quiet = taskRow({ task, arm: ARMS.baseline_sonnet, result: { check: check(true), claimedDone: false, runStatus: 'turn_limit', wallMs: 5, steps: 3, calls: [call()] } });
    assert.equal(quiet.completed, true, 'a fix the model never announced still counts');
  });

  test('tokens are split into uncached input, cache writes, cache reads and output', () => {
    const calls = [call({ inputTokens: 10, cacheWriteTokens: 200, cacheReadTokens: 0, outputTokens: 5 }), call({ inputTokens: 12, cacheWriteTokens: 50, cacheReadTokens: 200, outputTokens: 7 })];
    assert.deepEqual(tokenTotals(calls), { input: 22, cacheWrite: 250, cacheRead: 200, output: 12 });
  });

  test('the step curve leaves the planning call out', () => {
    const calls = [call({ purpose: 'plan', promptTokens: 900 }), call({ promptTokens: 400 }), call({ promptTokens: 450 })];
    assert.deepEqual(stepPrompts(calls), [400, 450]);
    const row = taskRow({ task, arm: ARMS.scope_local, result: { check: check(true), claimedDone: true, runStatus: 'succeeded', wallMs: 1, steps: 3, calls, stepRecord: [{ capability: null }, { capability: 'code.read' }, { capability: null }] } });
    assert.equal(row.context.firstStepPromptTokens, 400);
    assert.equal(row.context.maxStepPromptTokens, 450);
    assert.equal(row.actions, 1, 'actions count capability steps, not the plan or the final done');
    assert.equal(row.modelCalls, 3);
  });

  test('an arm summary prices each completed task and counts claims that failed', () => {
    const rows = [
      taskRow({ task: { id: 'a', kind: 'code' }, arm: ARMS.baseline_sonnet, result: { check: check(true), claimedDone: true, runStatus: 'claimed_done', wallMs: 10, steps: 4, calls: [call({ costUsd: 0.02, adapter: 'cloud' })] } }),
      taskRow({ task: { id: 'b', kind: 'code' }, arm: ARMS.baseline_sonnet, result: { check: check(false), claimedDone: true, runStatus: 'claimed_done', wallMs: 20, steps: 5, calls: [call({ costUsd: 0.04, adapter: 'cloud' })] } }),
    ];
    const summary = armSummary(rows);
    assert.equal(summary.completed, 1);
    assert.equal(summary.claimedButFailed, 1);
    assert.ok(Math.abs(summary.costUsd - 0.06) < 1e-12);
    assert.ok(Math.abs(summary.costPerCompletedUsd - 0.06) < 1e-12, 'a failed task’s spend is charged to the completed ones');
    assert.equal(summary.wallMs, 30);
    assert.equal(summary.steps, 9);
  });

  test('comparisons divide cost per completed task, baseline over Scope', () => {
    const totals = {
      scope_local: { completed: 2, costPerCompletedUsd: 0, maxStepPromptTokens: 1, meanGrowthTokensPerStep: 0 },
      scope_local_cloud: { completed: 2, costPerCompletedUsd: 0.01, maxStepPromptTokens: 1, meanGrowthTokensPerStep: 0 },
      baseline_sonnet: { completed: 2, costPerCompletedUsd: 0.05, maxStepPromptTokens: 9, meanGrowthTokensPerStep: 500 },
    };
    const out = comparisons(totals, [ARMS.scope_local, ARMS.scope_local_cloud, ARMS.baseline_sonnet]);
    assert.equal(out.scope_local_vs_baseline_sonnet.baselineCostPerCompletedOverScope, Infinity);
    assert.ok(Math.abs(out.scope_local_cloud_vs_baseline_sonnet.baselineCostPerCompletedOverScope - 5) < 1e-9);
    const none = comparisons({ ...totals, scope_local: { ...totals.scope_local, completed: 0, costPerCompletedUsd: null } }, [ARMS.scope_local, ARMS.baseline_sonnet]);
    assert.equal(none.scope_local_vs_baseline_sonnet.baselineCostPerCompletedOverScope, null);
  });
});

describe('scripted models', () => {
  const ready = TASKS.find((entry) => entry.id === 'code-paginate-off-by-one');

  test('the script plans, plays its actions in order, then says done', () => {
    const script = createScript(ready);
    assert.equal(script.reply({ purpose: 'plan' }), ready.dry.plan);
    for (const action of ready.dry.actions) {
      const reply = JSON.parse(script.reply({ purpose: 'step' }));
      assert.equal(reply.capability, action.capability);
      assert.deepEqual(reply.input, action.input);
      assert.equal(reply.done, false);
    }
    assert.deepEqual(JSON.parse(script.reply({ purpose: 'step' })), { done: true, summary: ready.dry.summary });
  });

  test('a local port costs nothing; a platform port is priced as the plan’s model', async () => {
    const log = createCallLog();
    const script = createScript(ready);
    const messages = [{ role: 'system', content: 'plan it' }, { role: 'user', content: 'goal '.repeat(200) }];
    const drain = async (port, purpose) => {
      let text = '';
      let done;
      for await (const chunk of port.stream({ messages, purpose })) {
        if (chunk.done) done = chunk;
        else text += chunk.text;
      }
      return { text, done };
    };
    const planned = await drain(scriptedPort({ name: 'platform', script, log }), 'plan');
    assert.equal(planned.text, ready.dry.plan);
    assert.equal(planned.done.model, 'claude-opus-5', 'the engineer plan plans on its hard model');
    assert.equal(planned.done.costUsd, costUsd('claude-opus-5', planned.done.usage));
    assert.ok(planned.done.costUsd > 0);
    const step = await drain(scriptedPort({ name: 'local', script, log }), 'step');
    assert.equal(step.done.costUsd, 0);
    assert.equal(log.calls.length, 2);
    assert.equal(log.calls[0].promptTokens, log.calls[1].promptTokens, 'the same prompt measures the same');
    assert.equal(scopeCloudModel({ purpose: 'step', hard: false }), 'claude-sonnet-5');
  });

  test('the baseline’s system prompt lists every tool with its schema', () => {
    const system = baselineSystem([{ name: 'code.read', input: { type: 'object', required: ['path'] } }]);
    assert.match(system, /"name":"code.read"/);
    assert.match(system, /"required":\["path"\]/);
    assert.match(system, /exactly one JSON object/);
  });
});

describe('the task catalog', () => {
  test('every task is well formed', () => {
    for (const entry of TASKS) assert.deepEqual(validateTask(entry), [], entry.id);
  });

  test('at least five ready code tasks, each a different kind of bug', () => {
    const ready = TASKS.filter((entry) => entry.status === 'ready' && entry.kind === 'code');
    assert.ok(ready.length >= 5);
    const bugs = new Set(ready.map((entry) => entry.bug));
    for (const bug of ['off-by-one', 'wrong operator', 'missing null check', 'wrong import', 'async ordering']) assert.ok(bugs.has(bug), bug);
    for (const entry of ready) {
      const manifest = JSON.parse(readFileSync(join(fixturePath(entry), 'package.json'), 'utf8'));
      assert.equal(manifest.license, 'MIT');
      assert.deepEqual(Object.keys(manifest.dependencies ?? {}), [], `${entry.id} has no dependencies`);
      assert.ok(entry.dry.actions.some((action) => action.capability === 'code.edit'), `${entry.id} fixes something`);
    }
  });

  test('the fixtures record their provenance and licence', () => {
    assert.match(readFileSync(join(FIXTURES_DIR, 'README.md'), 'utf8'), /written for this benchmark, MIT/);
  });

  test('the research task is ready: a paper set, an answer key and a scripted dry run', () => {
    const research = TASKS.filter((entry) => entry.kind === 'research');
    assert.ok(research.length >= 1);
    for (const entry of research) {
      assert.equal(entry.status, 'ready');
      assert.equal(entry.check.kind, 'answer');
      const library = JSON.parse(readFileSync(join(fixturePath(entry), 'library.json'), 'utf8'));
      assert.ok(library.items.length >= 5, `${entry.id} has at least five papers`);
      assert.ok(library.items.some((item) => item.citationKey === entry.check.citekey), 'the paper with the answer is in the set');
      for (const item of library.items) assert.ok(existsSync(join(fixturePath(entry), item.attachments[0].path)), item.citationKey);
      assert.match(readFileSync(join(fixturePath(entry), 'README.md'), 'utf8'), /CC0/);
      assert.ok(entry.dry.actions.every((action) => action.capability.startsWith('research.')));
      assert.match(entry.dry.summary, new RegExp(`\\[@${entry.check.citekey}\\]`));
    }
    const broken = { ...research[0], check: { kind: 'answer', method: 'Kelp' } };
    assert.match(validateTask(broken).join(), /answer against a key/);
    assert.match(validateTask({ ...research[0], fixture: 'nope' }).join(), /missing its library\.json/);
  });

  test('KiCad, physics and CAD are pending gates that say what makes them ready', () => {
    for (const kind of ['kicad', 'physics', 'cad']) {
      const gates = TASKS.filter((entry) => entry.kind === kind);
      assert.ok(gates.length >= 1, kind);
      for (const gate of gates) {
        assert.equal(gate.status, 'pending');
        assert.ok(gate.pending.reason && gate.pending.readyWhen, gate.id);
        assert.ok(!existsSync(join(FIXTURES_DIR, gate.id)));
      }
    }
  });

  test('a broken definition is refused', () => {
    assert.ok(validateTask({ id: 'Bad Id', status: 'ready', kind: 'code', instructions: 'x', fixture: 'nope', check: {}, dry: { actions: [] } }).length >= 3);
    assert.ok(validateTask({ id: 'p', status: 'pending', instructions: 'x', pending: {} }).length === 1);
  });

  test('tasks select by id and kind', () => {
    assert.deepEqual(selectTasks(TASKS, { kinds: ['cad'] }).map((entry) => entry.kind), ['cad']);
    assert.equal(selectTasks(TASKS, { ids: ['code-invoice-wrong-operator'] }).length, 1);
  });
});

describe('live mode refuses to spend without a key and a cap', () => {
  test('liveRefusal', () => {
    assert.equal(liveRefusal({ mode: 'dry', maxUsd: null, env: {} }), null);
    assert.equal(liveRefusal({ mode: 'live-local', maxUsd: null, env: {} }), null);
    assert.match(liveRefusal({ mode: 'live', maxUsd: 2, env: {} }), /PLATFORM_ANTHROPIC_API_KEY/);
    assert.match(liveRefusal({ mode: 'live', maxUsd: null, env: { PLATFORM_ANTHROPIC_API_KEY: 'test-key-not-real' } }), /--max-usd/);
    assert.match(liveRefusal({ mode: 'live', maxUsd: 6, env: { PLATFORM_ANTHROPIC_API_KEY: 'test-key-not-real' } }), /at most 5/);
    assert.equal(liveRefusal({ mode: 'live', maxUsd: 5, env: { PLATFORM_ANTHROPIC_API_KEY: 'test-key-not-real' } }), null);
  });

  test('the arguments', () => {
    assert.equal(parseArgs([]).mode, 'dry');
    assert.throws(() => parseArgs(['--live', '--max-usd', '6']), /at most 5/);
    assert.throws(() => parseArgs(['--max-usd', '1']), /--live only/);
    assert.throws(() => parseArgs(['--dry', '--live']), /choose one/);
    assert.deepEqual(parseArgs(['--live-local']).arms, ['scope_local']);
    assert.equal(parseArgs(['--live', '--max-usd=2.5']).maxUsd, 2.5);
    assert.throws(() => parseArgs(['--arms', 'scope_local,nope']), /unknown arm/);
  });

  test('runTaskBenchmark refuses a live run without a key before touching anything', async () => {
    const db = { query: () => assert.fail('the database must not be touched') };
    await assert.rejects(runTaskBenchmark({ mode: 'live', maxUsd: 1, db }), /PLATFORM_ANTHROPIC_API_KEY/);
    await assert.rejects(runTaskBenchmark({ mode: 'live', maxUsd: 7, apiKey: 'test-key-not-real', db }), /at most 5/);
    await assert.rejects(runTaskBenchmark({ mode: 'live-local', arms: ['scope_local', 'baseline_sonnet'], db }), /scope_local arm alone/);
  });
});
