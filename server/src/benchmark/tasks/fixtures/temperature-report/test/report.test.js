import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dailyReport, formatReport } from '../src/report.js';
import { smooth } from '../src/stats/smoothing.js';

const day = [12, 14, 15, 19, 21, 18, 13];

test('the daily mean is the arithmetic mean of the readings', () => {
  assert.equal(dailyReport(day).mean, 16);
  assert.equal(dailyReport([10, 11]).mean, 10.5);
});

test('the report carries the range', () => {
  const report = dailyReport(day);
  assert.equal(report.min, 12);
  assert.equal(report.max, 21);
});

test('an empty day has no report', () => {
  assert.deepEqual(dailyReport([]), { mean: null, min: null, max: null });
  assert.equal(formatReport(dailyReport([])), 'No readings');
});

test('formats the report', () => {
  assert.equal(formatReport(dailyReport(day)), 'mean 16 °C (12 to 21)');
});

test('the chart smoothing is unchanged', () => {
  assert.deepEqual(smooth([10, 20]), [10, 15]);
});
