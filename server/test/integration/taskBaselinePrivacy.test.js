import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { SpendCap } from '../../src/benchmark/endurance/economics.js';
import { WITHHELD_RESULT, runBaselineTask } from '../../src/benchmark/tasks/baselineArm.js';
import { TASKS } from '../../src/benchmark/tasks/catalog.js';
import { taskRow } from '../../src/benchmark/tasks/metrics.js';
import { createScript } from '../../src/benchmark/tasks/models.js';
import { formatTable } from '../../src/benchmark/tasks/run.js';
import { createWorkspace } from '../../src/benchmark/tasks/workspace.js';
import { createPythonRunner } from '../../src/plugins/physics/python.js';
import { sandboxStatus } from '../../src/workspace/sandbox/index.js';
import { registeredSession, startServer } from '../helpers.js';

// The task benchmark's cloud baseline in live mode, against a stand-in
// stream: its tools read the arm's project, so once that project holds a
// private node no tool result, new or already in the transcript, may reach
// the cloud request.

const task = TASKS.find((entry) => entry.id === 'research-cited-summary');
const physicsTask = TASKS.find((entry) => entry.id === 'physics-projectile-range');
const arm = { name: 'baseline_sonnet', kind: 'baseline', model: 'claude-sonnet-5' };
const project = `bench-${task.id}-${arm.name}`;

const SWEEP = JSON.stringify({ capability: 'research.sweep', input: { question: 'lowest word error rate on the Harbor benchmark', maxPapers: 5 }, summary: 'Find the lowest Harbor result' });
const DONE = JSON.stringify({ done: true, summary: 'Done' });

// Replies like a model, from `replies` in order. Every request is kept, and
// `afterRequest(n)` runs once request n (from 0) has been answered, so what
// it changes happens between that request and the next.
function scriptedStream(requests, replies, afterRequest = async () => {}) {
  let next = 0;
  return async function* stream({ messages }) {
    requests.push(JSON.stringify(messages));
    yield { text: replies[Math.min(next, replies.length - 1)] };
    yield { done: true, usage: { input_tokens: 10, output_tokens: 5 } };
    await afterRequest(next);
    next += 1;
  };
}

const physicsToolchain = await createPythonRunner().availability();
const sandbox = await sandboxStatus();
const physicsSkip = !physicsToolchain.available
  ? `the physics toolchain is unavailable here (${physicsToolchain.reason})`
  : !sandbox.available ? `no OS sandbox on this machine (${sandbox.reason})` : false;

describe('the live task baseline and private nodes', () => {
  let server;
  let ownerId;

  before(async () => {
    server = await startServer();
    const api = await registeredSession(server.base);
    ownerId = (await api('GET', '/api/auth/session')).data.userId;
  });

  after(async () => {
    await server.close();
  });

  const run = (requests, replies, afterRequest) => runBaselineTask({
    task, arm, workspace: null, mode: 'live', cap: new SpendCap(5), apiKey: 'test-key-not-real',
    stream: scriptedStream(requests, replies, afterRequest), maxTurns: 4, ownerId, db: server.pool,
  });
  // The paper that answers the task, marked private after the arm ingested
  // it, as a user may mark a source private at any time.
  const markKelpPrivate = () => server.pool.query(
    "UPDATE nodes SET privacy = 'local' WHERE owner_id = $1 AND project = $2 AND content LIKE '%Kelp%'",
    [ownerId, project]
  );

  test('with only cloud papers in the project, tool results go to the model as they are', async () => {
    const requests = [];
    const result = await run(requests, [SWEEP, DONE]);
    assert.equal(result.privateResultsWithheld, 0);
    assert.equal(requests.length, 2);
    assert.match(requests[1], /Result of research\.sweep/);
    assert.match(requests[1], /Kelp/, 'the sweep result, Kelp included, was sent');
    assert.ok(!requests[1].includes(WITHHELD_RESULT));
  });

  test('once the project holds a private node, no tool result is sent, and the count says so', async () => {
    const requests = [];
    // Before the sweep runs: its result reads a private node from the start.
    const result = await run(requests, [SWEEP, DONE], (n) => (n === 0 ? markKelpPrivate() : null));
    assert.equal(requests.length, 2);
    for (const body of requests) assert.ok(!body.includes('Kelp'), 'the private paper never reaches a request');
    assert.ok(requests[1].includes(WITHHELD_RESULT), 'the result is replaced by the placeholder');
    assert.equal(result.privateResultsWithheld, 1);
    // The result is still kept locally, for the check that reads it.
    assert.match(JSON.stringify(result.answers), /Kelp/, 'the sweep did find the private paper');
  });

  test('a result already sent is withheld from every later request once its node turns private', async () => {
    const requests = [];
    // Request 2 carries the first sweep's result; the paper turns private
    // right after it, before the second sweep and request 3, which re-sends
    // the first result along with the second.
    const result = await run(requests, [SWEEP, SWEEP, DONE], (n) => (n === 1 ? markKelpPrivate() : null));
    assert.equal(requests.length, 3);
    assert.match(requests[1], /Kelp/, 'sent while it was still a cloud paper');
    assert.ok(!requests[2].includes('Kelp'), 'never re-sent after it turned private');
    assert.equal(requests[2].split(WITHHELD_RESULT).length - 1, 2, 'both results are withheld');
    assert.equal(result.privateResultsWithheld, 2);

    // The report says so, in the row and in the table.
    const row = taskRow({ task, arm, result: { ...result, check: { completed: false } } });
    assert.equal(row.privateResultsWithheld, 2);
    const table = formatTable({ mode: 'live', spentUsd: 0, partial: false, tasks: [row], totals: {}, comparisons: {}, pending: [], harnessErrors: [] });
    assert.match(table, new RegExp(`- ${task.id} baseline_sonnet: 2 tool result\\(s\\) withheld`));
  });

  test('the physics baseline writes its derived nodes as cloud and sends their results', { skip: physicsSkip }, async () => {
    const workspace = createWorkspace();
    const script = createScript(physicsTask);
    const requests = [];
    const stream = async function* ({ messages }) {
      requests.push(JSON.stringify(messages));
      yield { text: script.reply({ purpose: 'step' }) };
      yield { done: true, usage: { input_tokens: 10, output_tokens: 5 } };
    };
    try {
      const result = await runBaselineTask({
        task: physicsTask, arm, workspace, mode: 'live', cap: new SpendCap(5), apiKey: 'test-key-not-real',
        stream, maxTurns: 4, ownerId, db: server.pool,
      });
      assert.equal(result.claimedDone, true);
      assert.equal(result.privateResultsWithheld, 0);
      const { rows } = await server.pool.query(
        'SELECT type, privacy FROM nodes WHERE owner_id = $1 AND project = $2',
        [ownerId, `bench-${physicsTask.id}-${arm.name}`]
      );
      assert.ok(rows.length > 0, 'the computation wrote a node');
      assert.ok(rows.every((row) => row.privacy === 'cloud'), 'built only on the cloud problem, so cloud');
      assert.match(requests[1], /Result of physics\.compute/);
      assert.ok(!requests[1].includes(WITHHELD_RESULT), 'its result is sent');
    } finally {
      workspace.remove();
    }
  });
});
