import { CadError } from './errors.js';
import { analyseMesh, midPlane, section } from './mesh.js';
import { round } from './units.js';

// Declared dimension checks, measured on a mesh. A check is
//
//   { measure, value, tolerance? }   |value - actual| <= tolerance
//   { measure, min?, max? }          min <= actual <= max
//
// optionally with `section: { axis, at }` for the hole measures (by default
// the plane through the middle of the part along z). Lengths are in the
// project's unit, areas and volumes in its square and cube.

export const MEASURES = {
  'size.x': 'bounding-box length along x',
  'size.y': 'bounding-box length along y',
  'size.z': 'bounding-box length along z',
  volume: 'enclosed volume',
  surfaceArea: 'surface area',
  'holes.count': 'holes through the section',
  'holes.spacing': 'smallest distance between two hole centres',
  'holes.maxSpacing': 'largest distance between two hole centres',
  'holes.diameter': 'smallest hole diameter (from its area)',
  'holes.maxDiameter': 'largest hole diameter (from its area)',
  'holes.minWall': 'thinnest material between a hole and any other edge of the section',
};

const DEFAULT_TOLERANCE = 1e-6;
const MAX_CHECKS = 50;

export function validateCheck(check) {
  if (check == null || typeof check !== 'object') throw new CadError('invalid_input', 'a dimension check must be an object');
  if (!(check.measure in MEASURES)) throw new CadError('invalid_input', `measure must be one of ${Object.keys(MEASURES).join(', ')}`);
  const numbers = ['value', 'tolerance', 'min', 'max'].filter((key) => check[key] != null);
  for (const key of numbers) {
    if (typeof check[key] !== 'number' || !Number.isFinite(check[key])) throw new CadError('invalid_input', `${check.measure}: ${key} must be a number`);
  }
  if (check.value == null && check.min == null && check.max == null) throw new CadError('invalid_input', `${check.measure}: give a value, a min or a max`);
  if (check.tolerance != null && check.tolerance < 0) throw new CadError('invalid_input', `${check.measure}: tolerance cannot be negative`);
  if (check.section != null && (typeof check.section !== 'object' || Array.isArray(check.section))) throw new CadError('invalid_input', `${check.measure}: section must be { axis, at }`);
  return check;
}

export function validateChecks(checks, label = 'expect') {
  if (checks == null) return [];
  if (!Array.isArray(checks) || checks.length > MAX_CHECKS) throw new CadError('invalid_input', `${label} must be a list of at most ${MAX_CHECKS} dimension checks`);
  return checks.map(validateCheck);
}

function sectionOf(triangles, cache, spec = {}) {
  const axis = spec.axis ?? 'z';
  const at = spec.at ?? midPlane(triangles, axis);
  const key = `${axis}:${at}`;
  if (!cache.has(key)) cache.set(key, section(triangles, { axis, at }));
  return cache.get(key);
}

function measureOne(triangles, analysis, check, cache) {
  const [group, name] = check.measure.split('.');
  if (group === 'size') return analysis.boundingBox.size[{ x: 0, y: 1, z: 2 }[name]];
  if (check.measure === 'volume') return analysis.volume;
  if (check.measure === 'surfaceArea') return analysis.surfaceArea;
  const cut = sectionOf(triangles, cache, check.section);
  const holes = cut.holes;
  switch (check.measure) {
    case 'holes.count':
      return holes.length;
    case 'holes.spacing':
      return cut.holeSpacings.length ? cut.holeSpacings[0] : null;
    case 'holes.maxSpacing':
      return cut.holeSpacings.length ? cut.holeSpacings.at(-1) : null;
    case 'holes.diameter':
      return holes.length ? Math.min(...holes.map((h) => h.diameter)) : null;
    case 'holes.maxDiameter':
      return holes.length ? Math.max(...holes.map((h) => h.diameter)) : null;
    case 'holes.minWall':
      return holes.length ? Math.min(...holes.map((h) => h.wall)) : null;
    default:
      throw new CadError('invalid_input', `unknown measure ${check.measure}`);
  }
}

function expectation(check) {
  if (check.value != null) return `${check.value} ± ${check.tolerance ?? DEFAULT_TOLERANCE}`;
  if (check.min != null && check.max != null) return `between ${check.min} and ${check.max}`;
  return check.min != null ? `at least ${check.min}` : `at most ${check.max}`;
}

// Measures every check on one mesh. `analysis` may be passed when the
// caller already has it.
export function evaluateChecks(triangles, checks, { analysis = analyseMesh(triangles), units = 'mm' } = {}) {
  const cache = new Map();
  return checks.map((check) => {
    const actual = measureOne(triangles, analysis, check, cache);
    let ok = actual != null && Number.isFinite(actual);
    if (ok && check.value != null) ok = Math.abs(actual - check.value) <= (check.tolerance ?? DEFAULT_TOLERANCE);
    if (ok && check.min != null) ok = actual >= check.min;
    if (ok && check.max != null) ok = actual <= check.max;
    return {
      measure: check.measure,
      expected: expectation(check),
      actual: actual == null ? null : round(actual, 9),
      units,
      ok,
    };
  });
}

export function describeChecks(results) {
  return results
    .map((r) => `${r.ok ? 'pass' : 'FAIL'} ${r.measure}: ${r.actual ?? 'not measurable'} (expected ${r.expected})`)
    .join('\n');
}
