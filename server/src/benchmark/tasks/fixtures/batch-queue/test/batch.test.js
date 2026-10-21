import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { runBatches, runInOrder } from '../src/batch.js';

// A job whose later items finish sooner, so overlapping jobs come back out
// of order.
function tracked() {
  let running = 0;
  let overlapped = false;
  const job = async (n) => {
    running += 1;
    if (running > 1) overlapped = true;
    await sleep(5 * (4 - n));
    running -= 1;
    return n * 10;
  };
  return { job, overlapped: () => overlapped };
}

test('runs every job and keeps their order', async () => {
  const { job } = tracked();
  assert.deepEqual(await runInOrder([1, 2, 3], job), [10, 20, 30]);
});

test('never runs two jobs at once', async () => {
  const { job, overlapped } = tracked();
  await runInOrder([1, 2, 3], job);
  assert.equal(overlapped(), false);
});

test('batches run in order too', async () => {
  const { job } = tracked();
  assert.deepEqual(await runBatches([1, 2, 3], 2, job), [[10, 20], [30]]);
});

test('an empty list is fine', async () => {
  assert.deepEqual(await runInOrder([], async () => 1), []);
});
