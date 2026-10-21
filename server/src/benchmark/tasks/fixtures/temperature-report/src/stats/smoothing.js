// Smoothing for the live chart: an exponentially weighted average, so the
// latest readings count most. Not a summary statistic.

export const ALPHA = 0.5;

export function average(values, alpha = ALPHA) {
  if (values.length === 0) return null;
  return values.slice(1).reduce((smoothed, value) => alpha * value + (1 - alpha) * smoothed, values[0]);
}

export function smooth(values, alpha = ALPHA) {
  const out = [];
  for (const value of values) out.push(out.length ? alpha * value + (1 - alpha) * out.at(-1) : value);
  return out;
}
