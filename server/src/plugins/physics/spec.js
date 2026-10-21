import { PhysicsError } from './python.js';

// The shapes the physics plug-in works with, checked on the host before any
// of it reaches Python, and the text form of the derivation and computation
// nodes. A node's content is readable prose for the map and the slice, with
// the exact spec appended as a fenced JSON block so physics.check and
// physics.compute can read it back.

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
// Names the computation namespace already uses, and Python keywords.
const RESERVED = new Set([
  'ureg', 'Q_', 'np', 'numpy', 'scipy', 'math', 'inputs', 'result', 'pi', 'e',
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif',
  'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or',
  'pass', 'raise', 'return', 'try', 'while', 'with', 'yield',
]);

export const MAX_EXPRESSION = 2_000;
export const MAX_CODE = 100 * 1024;
const MAX_TEXT = 2_000;
const MAX_ITEMS = 20;
const MAX_VARIABLES = 32;
const MAX_TOLERANCE = 0.05;
export const DEFAULT_TOLERANCE = 1e-3;
const SPEC_FENCE = 'physics-spec';

function invalid(message) {
  return new PhysicsError('invalid_input', message);
}

function text(value, label, { max = MAX_TEXT, optional = false } = {}) {
  if (value == null && optional) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw invalid(`${label} must be a non-empty string of at most ${max} characters`);
  return value.trim();
}

function texts(value, label, { min = 0 } = {}) {
  if (value == null && min === 0) return [];
  if (!Array.isArray(value) || value.length < min || value.length > MAX_ITEMS) throw invalid(`${label} must be a list of ${min ? `${min} to ` : 'at most '}${MAX_ITEMS} strings`);
  return value.map((item, i) => text(item, `${label}[${i}]`));
}

function name(value, label) {
  if (typeof value !== 'string' || !NAME.test(value) || RESERVED.has(value)) {
    throw invalid(`${label} "${value}" must be an identifier (letters, digits, _) that is not reserved`);
  }
  return value;
}

// A quantity as the model or the user writes it: "9.81 m/s^2", a bare
// number (dimensionless), or { value, units }. Pint parses it, in the sandbox.
export function quantity(value, label) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalid(`${label} must be finite`);
    return value;
  }
  if (typeof value === 'string') {
    if (!value.trim() || value.length > 200) throw invalid(`${label} must be a quantity such as "9.81 m/s^2"`);
    return value.trim();
  }
  if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.value === 'number' && Number.isFinite(value.value)) {
    const units = value.units == null ? '' : value.units;
    if (typeof units !== 'string' || units.length > 200) throw invalid(`${label}.units must be a string`);
    return { value: value.value, units };
  }
  throw invalid(`${label} must be a quantity such as "9.81 m/s^2" or { value, units }`);
}

function units(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) throw invalid(`${label} must name units, such as "m/s" (use "dimensionless" for a pure number)`);
  return value.trim();
}

function tolerance(value, label, fallback) {
  if (value == null) return fallback;
  if (typeof value !== 'number' || !(value >= 0) || value > MAX_TOLERANCE) throw invalid(`${label} must be a number from 0 to ${MAX_TOLERANCE}`);
  return value;
}

function quantities(value, label, { min = 0 } = {}) {
  if (value == null && min === 0) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(`${label} must be an object of name → quantity`);
  const entries = Object.entries(value);
  if (entries.length < min || entries.length > MAX_VARIABLES) throw invalid(`${label} must have ${min} to ${MAX_VARIABLES} entries`);
  const out = {};
  for (const [key, raw] of entries) {
    // A variable may be { value: "1 m", description } as the model is asked
    // to write it, or the quantity alone.
    const described = raw && typeof raw === 'object' && !Array.isArray(raw) && 'value' in raw && typeof raw.value === 'string';
    out[name(key, `${label} name`)] = quantity(described ? raw.value : raw, `${label}.${key}`);
  }
  return out;
}

// Descriptions come with the variables in a model's reply, and separately
// (variableNotes) in a stored spec.
function descriptions(value, stored) {
  const out = {};
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
    for (const [key, note] of Object.entries(stored)) if (key in (value ?? {}) && typeof note === 'string') out[key] = note.slice(0, 300);
  }
  for (const [key, raw] of Object.entries(value ?? {})) {
    if (raw && typeof raw === 'object' && typeof raw.description === 'string') out[key] = raw.description.slice(0, 300);
  }
  return out;
}

// The derivation a model proposes, as physics.derive asks for it.
export function validateDerivation(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid('a derivation must be a JSON object');
  const result = raw.result;
  if (!result || typeof result !== 'object') throw invalid('a derivation needs result: { symbol, expression, units }');
  const variables = quantities(raw.variables, 'variables', { min: 1 });
  const limits = Array.isArray(raw.limits) ? raw.limits : null;
  if (!limits || limits.length === 0 || limits.length > MAX_ITEMS) throw invalid('a derivation needs at least one limiting case in limits');
  return {
    title: text(raw.title, 'title', { max: 300 }),
    result: {
      symbol: name(result.symbol, 'result.symbol'),
      expression: text(result.expression, 'result.expression', { max: MAX_EXPRESSION }),
      units: units(result.units, 'result.units'),
    },
    variables,
    variableNotes: descriptions(raw.variables, raw.variableNotes),
    assumptions: texts(raw.assumptions, 'assumptions', { min: 1 }),
    steps: texts(raw.steps, 'steps'),
    limits: limits.map((limit, i) => validateLimit(limit, i, variables)),
  };
}

function validateLimit(raw, i, variables) {
  const label = `limits[${i}]`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalid(`${label} must be an object`);
  const set = quantities(raw.set, `${label}.set`, { min: 1 });
  for (const key of Object.keys(set)) if (!(key in variables)) throw invalid(`${label} sets ${key}, which is not a declared variable`);
  const hasExpect = raw.expect != null;
  const hasValue = raw.expectValue != null;
  if (hasExpect === hasValue) throw invalid(`${label} needs exactly one of expect (an expression) or expectValue (a quantity)`);
  return {
    name: text(raw.name, `${label}.name`, { max: 200 }),
    set,
    ...(hasExpect ? { expect: text(raw.expect, `${label}.expect`, { max: MAX_EXPRESSION }) } : { expectValue: quantity(raw.expectValue, `${label}.expectValue`) }),
    rtol: tolerance(raw.rtol, `${label}.rtol`, DEFAULT_TOLERANCE),
    ...(raw.atol != null ? { atol: absolute(raw.atol, `${label}.atol`) } : {}),
  };
}

function absolute(value, label) {
  if (typeof value !== 'number' || !(value >= 0) || !Number.isFinite(value)) throw invalid(`${label} must be a non-negative number`);
  return value;
}

// What the harness's "check" mode reads.
export function checkSpec(derivation) {
  return {
    symbol: derivation.result.symbol,
    expression: derivation.result.expression,
    units: derivation.result.units,
    variables: derivation.variables,
    limits: derivation.limits,
  };
}

export function validateComputeInput(input) {
  if (!input || typeof input !== 'object') throw invalid('input must be an object');
  const template = input.template ?? null;
  if (template != null && template !== 'expression') throw invalid('template must be "expression" (evaluate the derivation’s closed form)');
  if (template == null && input.code == null) throw invalid('give code (Python that sets result = {name: quantity}) or template "expression"');
  if (template != null && input.code != null) throw invalid('give either code or a template, not both');
  if (template === 'expression' && input.derivationId == null) throw invalid('the expression template needs a derivationId');
  const code = template == null ? text(input.code, 'code', { max: MAX_CODE }) : null;
  const crossCheck = input.crossCheck;
  if (!crossCheck || typeof crossCheck !== 'object' || Array.isArray(crossCheck)) {
    throw invalid('crossCheck is required: { code, method } — an independent second computation (a different method) whose outputs must agree');
  }
  const cross = {
    code: text(crossCheck.code, 'crossCheck.code', { max: MAX_CODE }),
    method: text(crossCheck.method, 'crossCheck.method', { max: 300, optional: true }),
  };
  if (code != null && normalise(code) === normalise(cross.code)) throw invalid('crossCheck must be a different computation, not the same code again');
  let outputs = null;
  if (input.outputs != null) {
    if (typeof input.outputs !== 'object' || Array.isArray(input.outputs)) throw invalid('outputs must be an object of name → units');
    const entries = Object.entries(input.outputs);
    if (entries.length === 0 || entries.length > MAX_VARIABLES) throw invalid(`outputs must have 1 to ${MAX_VARIABLES} entries`);
    outputs = Object.fromEntries(entries.map(([key, value]) => [name(key, 'outputs name'), units(value, `outputs.${key}`)]));
  } else if (template == null) {
    throw invalid('outputs is required: { name: units } for every result the code sets');
  }
  return {
    derivationId: input.derivationId == null ? null : text(input.derivationId, 'derivationId', { max: 64 }),
    template,
    code,
    crossCheck: cross,
    method: text(input.method, 'method', { max: 300, optional: true }),
    inputs: quantities(input.inputs, 'inputs'),
    outputs,
    tolerance: tolerance(input.tolerance, 'tolerance', DEFAULT_TOLERANCE),
    timeoutMs: timeout(input.timeoutMs),
  };
}

function timeout(value) {
  if (value == null) return 30_000;
  if (!Number.isInteger(value) || value < 1_000 || value > 120_000) throw invalid('timeoutMs must be an integer from 1000 to 120000');
  return value;
}

function normalise(code) {
  return code.replace(/#.*$/gm, '').replace(/\s+/g, '');
}

// Relative agreement of two outputs, or absolute agreement around zero.
export function agree(a, b, rtol) {
  const diff = Math.abs(a - b);
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return diff <= rtol * scale || diff <= 1e-12;
}

export function compareOutputs(primary, second, rtol) {
  const rows = [];
  for (const [key, value] of Object.entries(primary)) {
    const other = second[key];
    if (!other) {
      rows.push({ name: key, ok: false, detail: `the cross-check did not produce ${key}` });
      continue;
    }
    const ok = agree(value.value, other.value, rtol);
    const rel = Math.abs(value.value - other.value) / Math.max(Math.abs(value.value), Math.abs(other.value), 1e-300);
    rows.push({ name: key, ok, primary: value.value, crossCheck: other.value, units: value.units, relativeDifference: rel, detail: `${key}: ${fmt(value.value)} vs ${fmt(other.value)} ${value.units} (relative difference ${rel.toExponential(2)}, tolerance ${rtol})` });
  }
  const failed = rows.filter((row) => !row.ok);
  return {
    ok: rows.length > 0 && failed.length === 0,
    detail: rows.length === 0 ? 'there were no outputs to compare' : failed.length ? `the independent computation disagrees: ${failed.map((row) => row.detail).join('; ')}` : `an independent computation agrees: ${rows.map((row) => row.detail).join('; ')}`,
    rows,
  };
}

export function fmt(value) {
  return Number(value).toPrecision(6).replace(/\.?0+(e|$)/, '$1');
}

function quantityText(value) {
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value;
  return `${value.value} ${value.units}`.trim();
}

function checkLine(checks) {
  if (!checks) return 'Checks: not run';
  if (checks.unavailable) return `Checks: not run (${checks.reason}) — unverified`;
  return `Checks: ${Object.entries(checks.results).map(([key, value]) => `${key} ${value.ok ? 'passed' : 'FAILED'}`).join('; ')}`;
}

function withSpec(lines, spec) {
  return `${lines.filter((line) => line != null).join('\n')}\n\n\`\`\`${SPEC_FENCE}\n${JSON.stringify(spec)}\n\`\`\``;
}

export function derivationContent(derivation, checks) {
  const { result } = derivation;
  return withSpec([
    `Derivation: ${derivation.title}`,
    `${result.symbol} = ${result.expression}   [${result.units}]`,
    '',
    'Assumptions:',
    ...derivation.assumptions.map((item) => `- ${item}`),
    '',
    'Variables:',
    ...Object.entries(derivation.variables).map(([key, value]) => `- ${key} = ${quantityText(value)}${derivation.variableNotes?.[key] ? ` — ${derivation.variableNotes[key]}` : ''}`),
    '',
    'Limiting cases:',
    ...derivation.limits.map((limit) => `- ${limit.name}: ${Object.entries(limit.set).map(([key, value]) => `${key} = ${quantityText(value)}`).join(', ')} → ${limit.expect ?? quantityText(limit.expectValue)}`),
    ...(derivation.steps.length ? ['', 'Steps:', ...derivation.steps.map((step, i) => `${i + 1}. ${step}`)] : []),
    '',
    checkLine(checks),
  ], { kind: 'derivation', ...derivation });
}

export function computationContent(computation, checks) {
  return withSpec([
    `Computation: ${computation.title}`,
    ...Object.entries(computation.outputs).map(([key, value]) => `${key} = ${fmt(value.value)} ${value.units}`),
    '',
    `Method: ${computation.method ?? (computation.template === 'expression' ? 'the derivation’s closed form' : 'model-written Python (NumPy/SciPy/Pint)')}`,
    `Cross-check: ${computation.crossCheck.method ?? 'an independent computation'}`,
    'Inputs:',
    ...Object.entries(computation.inputs).map(([key, value]) => `- ${key} = ${quantityText(value)}`),
    '',
    checkLine(checks),
  ], { kind: 'computation', ...computation });
}

// The spec stored in a node, or null when the content holds none (a node
// written by something else, or edited past recognition).
export function parseSpec(content) {
  if (typeof content !== 'string') return null;
  const at = content.lastIndexOf(`\`\`\`${SPEC_FENCE}\n`);
  if (at === -1) return null;
  const body = content.slice(at + SPEC_FENCE.length + 4);
  const end = body.indexOf('\n```');
  if (end === -1) return null;
  try {
    const spec = JSON.parse(body.slice(0, end));
    return spec && typeof spec === 'object' && !Array.isArray(spec) ? spec : null;
  } catch {
    return null;
  }
}
