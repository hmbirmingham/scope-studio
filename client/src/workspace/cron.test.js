import { describe, expect, it } from 'vitest';
import { CRON_PRESETS, cronError, describeCron, nextRuns } from './cron.js';

const FROM = new Date(Date.UTC(2026, 9, 21, 8, 30)); // Wednesday 08:30 UTC

describe('describeCron', () => {
  it('reads every preset as a sentence', () => {
    expect(CRON_PRESETS.map((preset) => describeCron(preset.expression))).toEqual([
      'Every 15 minutes',
      'Every hour, on the hour',
      'Every day at 09:00 UTC',
      'At 09:00 UTC on Monday through Friday',
      'At 09:00 UTC on Monday',
    ]);
  });

  it('describes lists, steps, months and both day fields', () => {
    expect(describeCron('30 8,17 * * *')).toBe('Every day at 08:30 and 17:30 UTC');
    expect(describeCron('15 */6 * * *')).toBe('Every 6 hours at 15 minutes past');
    expect(describeCron('0 9 1 1 *')).toBe('At 09:00 UTC on day 1 of the month in January');
    expect(describeCron('0 9 1 * 1')).toBe('At 09:00 UTC on day 1 of the month or on Monday');
    expect(describeCron('0 12 * * 0,6')).toBe('At 12:00 UTC on Saturday and Sunday');
    expect(describeCron('* * * * *')).toBe('Every minute');
  });

  it('returns null for an expression that does not parse', () => {
    expect(describeCron('0 9 * *')).toBeNull();
    expect(describeCron('61 * * * *')).toBeNull();
  });
});

describe('nextRuns', () => {
  it('lists the next matching minutes in UTC', () => {
    expect(nextRuns('0 9 * * 1-5', FROM, 3).map((date) => date.toISOString())).toEqual([
      '2026-10-21T09:00:00.000Z',
      '2026-10-22T09:00:00.000Z',
      '2026-10-23T09:00:00.000Z',
    ]);
    expect(nextRuns('*/15 * * * *', FROM, 2).map((date) => date.toISOString())).toEqual(['2026-10-21T08:45:00.000Z', '2026-10-21T09:00:00.000Z']);
  });

  it('is strictly after the starting minute', () => {
    expect(nextRuns('30 8 * * *', FROM, 1)[0].toISOString()).toBe('2026-10-22T08:30:00.000Z');
  });

  it('finds a leap day years away without walking every minute', () => {
    const started = performance.now();
    expect(nextRuns('0 0 29 2 *', FROM, 1)[0].toISOString()).toBe('2028-02-29T00:00:00.000Z');
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe('cronError', () => {
  it('accepts valid schedules', () => {
    for (const preset of CRON_PRESETS) expect(cronError(preset.expression)).toBeNull();
  });

  it('explains what is wrong, in the server’s words', () => {
    expect(cronError('0 9 * *')).toBe('a schedule needs five fields: minute hour day-of-month month day-of-week');
    expect(cronError('0 25 * * *')).toBe('invalid hour "25"');
    expect(cronError('0 0 31 2 *')).toBe('this schedule never matches a date');
  });
});
