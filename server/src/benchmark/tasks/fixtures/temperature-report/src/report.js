import { range } from './stats/mean.js';
import { average } from './stats/smoothing.js';

// The daily report: the day's mean temperature and its range, in °C to one
// decimal place.

const oneDecimal = (value) => Math.round(value * 10) / 10;

export function dailyReport(readings) {
  if (readings.length === 0) return { mean: null, min: null, max: null };
  const { min, max } = range(readings);
  return { mean: oneDecimal(average(readings)), min, max };
}

export function formatReport(report) {
  if (report.mean == null) return 'No readings';
  return `mean ${report.mean} °C (${report.min} to ${report.max})`;
}
