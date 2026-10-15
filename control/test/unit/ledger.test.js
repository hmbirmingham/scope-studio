import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowanceWeekStart, answerMonthStart } from '../../src/models/ledger.js';

const DAY_MS = 24 * 60 * 60 * 1000;
// Whatever the window, it must hold these: it has started, it covers at most
// a week, and (next test) it never moves backwards.
for (const now of [
  new Date('2026-10-15T09:00:00Z'),
  new Date('2026-10-18T23:59:59Z'),
  new Date('2026-10-19T00:00:01Z'),
  new Date('2026-09-02T18:00:00Z'),
]) {
  test(`the allowance week at ${now.toISOString()} has started and spans at most seven days`, () => {
    const start = allowanceWeekStart(now);
    assert.ok(start instanceof Date && !Number.isNaN(start.getTime()), 'returns a valid Date');
    assert.ok(start <= now, 'the week has already started');
    assert.ok(now - start <= 7 * DAY_MS, 'no older spend counts against this week');
  });
}

test('the allowance week moves forward with time, never back', () => {
  let previous = allowanceWeekStart(new Date('2026-10-01T00:00:00Z'));
  for (let hour = 1; hour <= 24 * 21; hour += 1) {
    const now = new Date(Date.UTC(2026, 9, 1) + hour * 60 * 60 * 1000);
    const start = allowanceWeekStart(now);
    assert.ok(start >= previous, `week start went backwards at ${now.toISOString()}`);
    previous = start;
  }
});

test('any seven days can spend at most one allowance: the window is exactly a week', () => {
  const now = new Date('2026-10-19T00:00:01Z');
  assert.equal(now - allowanceWeekStart(now), 7 * DAY_MS);
});

test('the answer month is the last thirty days', () => {
  const now = new Date('2026-10-15T09:00:00Z');
  assert.equal(now - answerMonthStart(now), 30 * DAY_MS);
});
