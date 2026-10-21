import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { nextRunAt, parseCron, validateCron } from '../../src/workspace/cron.js';

const at = (iso) => new Date(iso);

describe('cron schedules', () => {
  test('every fifteen minutes', () => {
    assert.equal(nextRunAt('*/15 * * * *', at('2026-10-21T06:07:30Z')).toISOString(), '2026-10-21T06:15:00.000Z');
    // Strictly after: a run at exactly :15 schedules the next one at :30.
    assert.equal(nextRunAt('*/15 * * * *', at('2026-10-21T06:15:00Z')).toISOString(), '2026-10-21T06:30:00.000Z');
  });

  test('weekdays at 09:00 skip the weekend', () => {
    // 2026-10-23 is a Friday.
    assert.equal(nextRunAt('0 9 * * 1-5', at('2026-10-23T10:00:00Z')).toISOString(), '2026-10-26T09:00:00.000Z');
  });

  test('both 0 and 7 mean Sunday', () => {
    assert.equal(nextRunAt('0 0 * * 7', at('2026-10-21T00:00:00Z')).toISOString(), '2026-10-25T00:00:00.000Z');
    assert.equal(nextRunAt('0 0 * * 0', at('2026-10-21T00:00:00Z')).toISOString(), '2026-10-25T00:00:00.000Z');
  });

  test('restricted day-of-month and day-of-week match either', () => {
    // The 1st of November 2026 is a Sunday; Monday the 26th of October comes first.
    assert.equal(nextRunAt('0 12 1 * 1', at('2026-10-21T00:00:00Z')).toISOString(), '2026-10-26T12:00:00.000Z');
  });

  test('a leap-day schedule finds the next leap year', () => {
    assert.equal(nextRunAt('0 0 29 2 *', at('2026-03-01T00:00:00Z')).toISOString(), '2028-02-29T00:00:00.000Z');
  });

  test('an impossible date returns null instead of looping', () => {
    assert.equal(nextRunAt('0 0 31 2 *', at('2026-01-01T00:00:00Z')), null);
  });

  test('a stepped day field counts as unrestricted, so both day fields must match', () => {
    // Odd days of the month that are also Mondays: 2026-11-09 is a Monday on an odd date.
    assert.equal(nextRunAt('0 9 */2 * 1', at('2026-10-21T00:00:00Z')).toISOString(), '2026-11-09T09:00:00.000Z');
  });

  test('lists, ranges and stepped ranges', () => {
    const cron = parseCron('0,30 10-14/2 * * *');
    assert.deepEqual([...cron.minutes], [0, 30]);
    assert.deepEqual([...cron.hours], [10, 12, 14]);
  });

  test('malformed schedules are rejected with a reason', () => {
    for (const bad of ['0 0 31 2 *', '', '* * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '* * * * 8', '5-1 * * * *', '*/0 * * * *', 'a * * * *', '@daily']) {
      assert.ok(validateCron(bad), bad);
    }
    assert.equal(validateCron('0 9 * * 1-5'), null);
    assert.ok(validateCron(42));
  });
});
