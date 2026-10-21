import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { TASKS } from '../../src/benchmark/tasks/catalog.js';
import { answerCheck, prepareLibrary } from '../../src/benchmark/tasks/research.js';
import { runTaskBenchmark } from '../../src/benchmark/tasks/run.js';
import { sandboxStatus } from '../../src/workspace/sandbox/index.js';
import { registeredSession, startServer } from '../helpers.js';

// The research task in the task benchmark: its paper set is ingested for
// each arm, both kinds of arm answer from the research plug-in, and the
// answer is judged against the key, never by what the model claims.

const task = TASKS.find((entry) => entry.id === 'research-cited-summary');
const sandbox = await sandboxStatus();

describe('research task benchmark', () => {
  let server;
  let ownerId;

  before(async () => {
    server = await startServer();
    const api = await registeredSession(server.base);
    ({ data: { userId: ownerId } } = await api('GET', '/api/auth/session'));
    await prepareLibrary(task, { ownerId, project: 'answers', db: server.pool });
  });
  after(() => server.close());

  const judge = (answer) => answerCheck(task, { answer, ownerId, project: 'answers', db: server.pool });

  test('the paper set is ingested with its page text', async () => {
    const { rows } = await server.pool.query("SELECT type, count(*)::int AS c FROM nodes WHERE owner_id = $1 AND project = 'answers' GROUP BY type ORDER BY type", [ownerId]);
    assert.deepEqual(rows, [{ type: 'excerpt', c: 10 }, { type: 'paper', c: 5 }]);
  });

  test('the right answer, cited, completes the task', async () => {
    const verdict = await judge('Kelp has the lowest word error rate on Harbor (7.4, Table 2) [@osei2022kelp].');
    assert.equal(verdict.completed, true, verdict.output);
  });

  test('a wrong method, a missing citation or table, or an unresolvable citation does not', async () => {
    let verdict = await judge('Drift has the lowest word error rate on Harbor (Table 2) [@silva2023drift].');
    assert.equal(verdict.completed, false);
    assert.match(verdict.output, /does not name Kelp.*does not cite \[@osei2022kelp\]/);
    verdict = await judge('Kelp has the lowest word error rate on Harbor, in Table 2.');
    assert.match(verdict.output, /does not cite/);
    verdict = await judge('Kelp is lowest [@osei2022kelp].');
    assert.match(verdict.output, /does not name Table 2/);
    verdict = await judge('Kelp is lowest in Table 2 [@osei2022kelp], beating [@madeup2024].');
    assert.equal(verdict.completed, false);
    assert.match(verdict.output, /resolve to no ingested paper: @madeup2024/);
    verdict = await judge('Kelpie is lowest in Table 2 [@osei2022kelp].');
    assert.match(verdict.output, /does not name Kelp/, 'the method is matched as a word');
    assert.equal((await judge(null)).completed, false);
  });

  test('every arm completes it in a dry run, by the answer check', { skip: sandbox.available ? false : `no OS sandbox (${sandbox.reason})` }, async () => {
    const report = await runTaskBenchmark({ tasks: [task], mode: 'dry', db: server.pool });
    assert.deepEqual(report.harnessErrors, []);
    assert.equal(report.tasks.length, 4);
    for (const row of report.tasks) {
      assert.equal(row.completed, true, `${row.arm}: ${row.runStatus} ${row.runError ?? ''}`);
      assert.equal(row.check.exitCode, null);
    }
    const scope = report.tasks.find((row) => row.arm === 'scope_local');
    assert.deepEqual(scope.stepRecord.map((step) => [step.capability, step.status]), [[null, 'done'], ['research.sweep', 'done'], ['research.sweep', 'done'], [null, 'done']]);
    assert.equal(scope.costUsd, 0);
    assert.deepEqual(report.pending.map((entry) => entry.kind).filter((kind) => kind === 'research'), []);
  });
});
