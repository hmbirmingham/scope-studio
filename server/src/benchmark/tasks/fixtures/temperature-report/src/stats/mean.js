// Plain summary statistics over a list of readings.

export function average(values) {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function range(values) {
  if (values.length === 0) return null;
  return { min: Math.min(...values), max: Math.max(...values) };
}
