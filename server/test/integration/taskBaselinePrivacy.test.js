import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { SpendCap } from '../../src/benchmark/endurance/economics.js';
import { WITHHELD_RESULT, runBaselineTask } from '../../src/benchmark/tasks/baselineArm.js';
import { TASKS } from '../../src/benchmark/tasks/catalog.js';
import { registeredSession, startServer } from '../helpers.js';

// The task benchmark's cloud baseline in live mode, against a stand-in
// stream: its tools read the arm's project, so once that project holds a
// private node no tool result may reach the cloud request.

const task = TASKS.find((entry) => entry.id === 'research-cited-summary');
const arm = { name: 'baseline_sonnet', kind: 'baseline', model: 'claude-sonnet-5' };
const project = `bench-${task.id}-${arm.name}`;

// Replies like a model: one sweep, then done. Every request is kept, and
// `beforeFirst` runs once the arm has ingested its library.
function scriptedStream(requests, beforeFirst = async () => {}) {
  const replies = [
    JSON.stringify({ capability: 'research.sweep', input: { question: 'lowest word error rate on the Harbor benchmark', maxPapers: 5 }, summary: 'Find the lowest Harbor result' }),
    JSON.stringify({ done: true, summary: 'Done' }),
  ];
  let next = 0;
  return async function* stream({ messages }) {
    if (next === 0) await beforeFirst();
    requests.push(JSON.stringify(messages));
    yield { text: replies[Math.min(next, replies.length - 1)] };
    next += 1;
    yield { done: true, usage: { input_tokens: 10, output_tokens: 5 } };
  };
}

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

  const run = (requests, beforeFirst) => runBaselineTask({
    task, arm, workspace: null, mode: 'live', cap: new SpendCap(5), apiKey: 'test-key-not-real',
    stream: scriptedStream(requests, beforeFirst), maxTurns: 3, ownerId, db: server.pool,
  });

  test('with only cloud papers in the project, tool results go to the model as they are', async () => {
    const requests = [];
    const result = await run(requests);
    assert.equal(result.privateResultsWithheld, 0);
    assert.equal(requests.length, 2);
    assert.match(requests[1], /Result of research\.sweep/);
    assert.match(requests[1], /Kelp/, 'the sweep result, Kelp included, was sent');
    assert.ok(!requests[1].includes(WITHHELD_RESULT));
  });

  test('once the project holds a private node, no tool result is sent, and the count says so', async () => {
    const requests = [];
    // The paper that answers the task is marked private after the arm
    // ingested it, as a user may mark a source private at any time.
    const result = await run(requests, () => server.pool.query(
      "UPDATE nodes SET privacy = 'local' WHERE owner_id = $1 AND project = $2 AND content LIKE '%Kelp%'",
      [ownerId, project]
    ));
    assert.equal(requests.length, 2);
    for (const body of requests) assert.ok(!body.includes('Kelp'), 'the private paper never reaches a request');
    assert.ok(requests[1].includes(WITHHELD_RESULT), 'the result is replaced by the placeholder');
    assert.equal(result.privateResultsWithheld, 1);
    // The result is still kept locally, for the check that reads it.
    assert.match(JSON.stringify(result.answers), /Kelp/, 'the sweep did find the private paper');
  });
});
