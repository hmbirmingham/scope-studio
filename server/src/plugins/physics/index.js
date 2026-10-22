import { tryEmbedDocument } from '../../lib/embeddings.js';
import { requestDerivation } from './derive.js';
import { readNode, writePhysicsNode } from './nodes.js';
import { PhysicsError, createPythonRunner, defaultSandbox, defaultPython } from './python.js';
import {
  checkSpec,
  compareOutputs,
  computationContent,
  derivationContent,
  fmt,
  parseSpec,
  validateComputeInput,
  validateDerivation,
} from './spec.js';

// The physics vertical (docs/architecture/agent-workspace.md, "Verticals").
//
//   physics.derive   a model-assisted derivation (through ctx.model), with
//                    explicit assumptions, units and limiting cases, written
//                    as a `derivation` node once its checks pass.
//   physics.compute  a model-written or template Python computation on Pint
//                    quantities, run in the OS sandbox with an independent
//                    cross-check, written as a `computation` node
//                    `derived_from` its derivation.
//   physics.check    runs the checks again on a stored derivation or
//                    computation.
//
// Verifiers: physics.units (dimensional consistency), physics.limits
// (declared limiting cases hold), physics.rederive (an independent second
// computation agrees). All Python runs through runSandboxed; without the
// sandbox, Python, NumPy, SciPy or Pint the verifiers say "unavailable" and
// never claim a pass.
//
// A capability writes its node itself, because the runner's write-back only
// makes findings, decisions, questions and artifacts. To keep the protocol's
// rule that nothing is written before it is verified, the capability runs
// the checks first and writes the node only when they pass; the verifiers
// then report those same results (kept per result object, so the sandbox
// work is not done twice) or, given a result they did not see made, run the
// checks themselves.

const DERIVATION_CHECKS = ['units', 'limits'];
const COMPUTATION_CHECKS = ['units', 'rederive'];
const MAX_PROBLEM = 6_000;

function problemText(input) {
  if (typeof input?.problem !== 'string' || !input.problem.trim() || input.problem.length > MAX_PROBLEM) {
    throw new PhysicsError('invalid_input', `problem must be a non-empty string of at most ${MAX_PROBLEM} characters`);
  }
  return input.problem.trim();
}

function summarise(checks) {
  if (checks.unavailable) return `not checked (${checks.reason})`;
  return Object.entries(checks.results).map(([name, entry]) => `${name} ${entry.ok ? 'passed' : 'failed'}`).join(', ');
}

function passed(checks) {
  return !checks.unavailable && Object.values(checks.results).every((entry) => entry.ok === true);
}

export function createPhysicsPlugin({ sandbox = defaultSandbox, python = defaultPython(), runner, embed = tryEmbedDocument } = {}) {
  const py = runner ?? createPythonRunner({ sandbox, python });
  // What the capability found, per result object, for the verifiers.
  const memo = new WeakMap();

  // The units and limits checks of a derivation, in one sandboxed run.
  async function derivationChecks(derivation, names, ctx) {
    const state = await py.availability({ ctx });
    if (!state.available) return { unavailable: true, reason: state.reason };
    let payload;
    try {
      payload = await py.run({ mode: 'check', checks: names, spec: checkSpec(derivation) }, { ctx });
    } catch (err) {
      if (err?.code === 'physics_unavailable') return { unavailable: true, reason: err.reason ?? err.message };
      throw err;
    }
    if (!payload.ok) return { results: Object.fromEntries(names.map((name) => [name, { ok: false, detail: payload.detail ?? 'the check did not run' }])) };
    return { results: Object.fromEntries(names.map((name) => [name, payload.checks?.[name] ?? { ok: false, detail: `${name} was not reported` }])) };
  }

  // Runs one side of a computation. A computation that raises is an error of
  // the step, not a check result. Model-written code runs in the same Python
  // process that prints this result, so the result says no more than which
  // values the code reports: it carries no check outcome, and anything
  // other than a plain `values` object is treated as a failed run.
  async function runSide(job, ctx, timeoutMs, label) {
    const payload = await py.run({ mode: 'run', ...job }, { ctx, timeoutMs });
    const log = payload?.log ? `\n${String(payload.log).slice(-1_000)}` : '';
    if (payload?.ok !== true) return { failed: true, detail: `${label} failed: ${payload?.detail ?? payload?.error ?? 'unknown error'}${log}` };
    const values = payload.values;
    if (!values || typeof values !== 'object' || Array.isArray(values)) return { failed: true, detail: `${label} failed: it reported no values${log}` };
    return { values, log: typeof payload.log === 'string' ? payload.log : '' };
  }

  // The primary computation and its independent cross-check, each in its
  // own sandboxed process, and the units and agreement checks on them. The
  // units check, and the conversion the agreement check compares, run in a
  // third sandboxed process that runs no model-written code: only that
  // process holds the nonce of a result that can pass a check.
  async function computationChecks(plan, ctx) {
    const state = await py.availability({ ctx });
    if (!state.available) throw new PhysicsError('physics_unavailable', `the physics toolchain is unavailable: ${state.reason}`, { reason: state.reason });
    const shared = { inputs: plan.inputs, outputs: plan.outputs };
    const primaryJob = plan.expression != null
      ? { ...shared, expression: plan.expression, expressionOutput: plan.expressionOutput }
      : { ...shared, code: plan.code };
    const primary = await runSide(primaryJob, ctx, plan.timeoutMs, 'the computation');
    if (primary.failed) throw new PhysicsError('computation_failed', primary.detail);
    const cross = await runSide({ ...shared, code: plan.crossCheck.code }, ctx, plan.timeoutMs, 'the cross-check');

    const sides = { primary: primary.values, ...(cross.failed ? {} : { cross: cross.values }) };
    const converted = await py.run({ mode: 'convert', outputs: plan.outputs, sides }, { ctx });
    if (converted?.ok !== true) {
      const detail = `the units check did not run: ${converted?.detail ?? converted?.error ?? 'unknown error'}`;
      return { outputs: {}, log: primary.log, checks: { results: { units: { ok: false, detail }, rederive: { ok: false, detail } } } };
    }
    const checkedPrimary = converted.sides?.primary ?? {};
    const unitRows = Object.values(checkedPrimary.units ?? {});
    const units = {
      ok: unitRows.length > 0 && unitRows.every((row) => row.ok === true),
      detail: unitRows.map((row) => row.detail).join('; ') || 'no outputs were declared',
    };
    const outputs = checkedPrimary.outputs ?? {};
    let rederive;
    if (cross.failed) rederive = { ok: false, detail: cross.detail };
    else {
      const missing = Object.keys(plan.outputs).filter((name) => !outputs[name]);
      const compared = compareOutputs(outputs, converted.sides?.cross?.outputs ?? {}, plan.tolerance);
      rederive = missing.length
        ? { ok: false, detail: `the computation produced no usable ${missing.join(', ')}, so it cannot be compared` }
        : { ok: compared.ok, detail: compared.detail, rows: compared.rows };
    }
    return { outputs, log: primary.log, checks: { results: { units, rederive } } };
  }

  // A derivation as stored in a node, re-validated: the content can have
  // been edited since it was written.
  function storedDerivation(node) {
    const spec = parseSpec(node.content);
    if (!spec || spec.kind !== 'derivation') throw new PhysicsError('no_spec', `node ${node.id} holds no derivation this plug-in can read`);
    return validateDerivation(spec);
  }

  function storedComputation(node) {
    const spec = parseSpec(node.content);
    if (!spec || spec.kind !== 'computation') throw new PhysicsError('no_spec', `node ${node.id} holds no computation this plug-in can read`);
    return computationPlan(spec);
  }

  // What a computation runs, from a compute input or a stored spec, checked
  // the same way either way.
  function computationPlan(spec, derivation = null) {
    const usingTemplate = spec.template === 'expression';
    const checked = validateComputeInput({
      ...spec,
      outputs: spec.declaredOutputs ?? spec.outputs ?? undefined,
      derivationId: spec.derivationId ?? undefined,
    });
    const expression = usingTemplate ? (derivation?.result.expression ?? spec.expression) : null;
    const expressionOutput = usingTemplate ? (derivation?.result.symbol ?? spec.expressionOutput) : null;
    if (usingTemplate && (typeof expression !== 'string' || typeof expressionOutput !== 'string')) {
      throw new PhysicsError('invalid_input', 'the expression template needs the derivation’s expression');
    }
    const outputs = usingTemplate
      ? { [expressionOutput]: checked.outputs?.[expressionOutput] ?? derivation?.result.units ?? spec.declaredOutputs?.[expressionOutput] }
      : checked.outputs;
    if (Object.values(outputs).some((value) => typeof value !== 'string')) throw new PhysicsError('invalid_input', 'every output needs units');
    return {
      ...checked,
      title: typeof spec.title === 'string' && spec.title.trim() ? spec.title.trim().slice(0, 300) : Object.keys(outputs).join(', '),
      derivationId: spec.derivationId ?? null,
      inputs: { ...(derivation?.variables ?? {}), ...checked.inputs },
      outputs,
      expression,
      expressionOutput,
    };
  }

  // The checks a verifier needs on a result it was not given the outcome of.
  async function recheck(spec, names, ctx) {
    if (spec?.kind === 'derivation') return derivationChecks(validateDerivation(spec), names.filter((name) => DERIVATION_CHECKS.includes(name)), ctx);
    if (spec?.kind === 'computation') {
      try {
        return (await computationChecks(computationPlan(spec), ctx)).checks;
      } catch (err) {
        if (err?.code === 'physics_unavailable') return { unavailable: true, reason: err.reason ?? err.message };
        throw err;
      }
    }
    return null;
  }

  async function derive(input, ctx) {
    const problem = problemText(input);
    const sources = [];
    let context = null;
    if (input.problemId != null) {
      const node = await readNode(ctx, input.problemId);
      sources.push(node);
      // The step's model is chosen by its slice, not by this node, so a
      // private node read here could otherwise reach a cloud model. Its text
      // goes to the model only when the node is cloud or the context says
      // outright that the step is private (and so routed to a local model).
      // The derivation is still built on it, and so inherits its privacy.
      if (node.privacy === 'cloud' || ctx.privateContext === true) context = node.content;
    }
    const { derivation, attempts } = await requestDerivation({ model: ctx.model, agent: ctx.agent, problem, context, signal: ctx.signal });
    const checks = await derivationChecks(derivation, DERIVATION_CHECKS, ctx);
    const spec = { kind: 'derivation', ...derivation };
    const output = { title: derivation.title, result: derivation.result, assumptions: derivation.assumptions, checks: checks.unavailable ? { unavailable: checks.reason } : checks.results, attempts, spec };

    // A derivation that failed a check is not written; the verifiers fail
    // the step and its step node records why.
    if (!checks.unavailable && !passed(checks)) {
      const result = { output: { ...output, derivationId: null } };
      memo.set(result, checks);
      return result;
    }
    const node = await writePhysicsNode(ctx, { type: 'derivation', content: derivationContent(derivation, checks), sources, embed });
    const { symbol, expression, units } = derivation.result;
    const result = {
      output: { ...output, derivationId: node.id },
      touchedNodeIds: [node.id],
      findings: [`Derived ${symbol} = ${expression} [${units}] — ${derivation.title} (derivation ${node.id}; checks: ${summarise(checks)}).`],
    };
    memo.set(result, checks);
    return result;
  }

  async function compute(input, ctx) {
    const checkedInput = validateComputeInput(input);
    let derivationNode = null;
    let derivation = null;
    if (checkedInput.derivationId) {
      derivationNode = await readNode(ctx, checkedInput.derivationId, { types: ['derivation'] });
      derivation = storedDerivation(derivationNode);
    }
    const plan = computationPlan({ ...input, kind: 'computation', derivationId: checkedInput.derivationId }, derivation);
    const { outputs, log, checks } = await computationChecks(plan, ctx);
    const stored = {
      title: plan.title,
      derivationId: plan.derivationId,
      template: plan.template,
      code: plan.code,
      expression: plan.expression,
      expressionOutput: plan.expressionOutput,
      method: plan.method,
      crossCheck: plan.crossCheck,
      inputs: plan.inputs,
      declaredOutputs: plan.outputs,
      outputs,
      tolerance: plan.tolerance,
      timeoutMs: plan.timeoutMs,
    };
    const spec = { kind: 'computation', ...stored };
    const output = { title: plan.title, outputs, checks: checks.results, log: log.slice(-2_000), spec };
    if (!passed(checks)) {
      const result = { output: { ...output, computationId: null } };
      memo.set(result, checks);
      return result;
    }
    const node = await writePhysicsNode(ctx, { type: 'computation', content: computationContent(stored, checks), sources: derivationNode ? [derivationNode] : [], embed });
    const values = Object.entries(outputs).map(([name, value]) => `${name} = ${fmt(value.value)} ${value.units}`).join(', ');
    const result = {
      output: { ...output, computationId: node.id },
      touchedNodeIds: [node.id, ...(derivationNode ? [derivationNode.id] : [])],
      findings: [`Computed ${values} — ${plan.title} (computation ${node.id}${derivationNode ? `, from derivation ${derivationNode.id}` : ''}; units and an independent cross-check agree).`],
    };
    memo.set(result, checks);
    return result;
  }

  async function check(input, ctx) {
    const node = await readNode(ctx, input?.nodeId, { types: ['derivation', 'computation'] });
    const allowed = node.type === 'derivation' ? DERIVATION_CHECKS : COMPUTATION_CHECKS;
    const names = input.checks == null ? allowed : input.checks;
    if (!Array.isArray(names) || names.length === 0 || names.some((name) => !allowed.includes(name))) {
      throw new PhysicsError('invalid_input', `checks for a ${node.type} must be some of ${allowed.join(', ')}`);
    }
    let checks;
    if (node.type === 'derivation') checks = await derivationChecks(storedDerivation(node), names, ctx);
    else {
      const plan = storedComputation(node);
      try {
        checks = (await computationChecks(plan, ctx)).checks;
        checks.results = Object.fromEntries(names.map((name) => [name, checks.results[name]]));
      } catch (err) {
        if (err?.code !== 'physics_unavailable') throw err;
        checks = { unavailable: true, reason: err.reason ?? err.message };
      }
    }
    const ok = checks.unavailable ? null : passed(checks);
    const verdict = ok == null ? 'could not be checked' : ok ? 'passes' : 'FAILS';
    return {
      output: { nodeId: node.id, kind: node.type, passed: ok, checks: checks.unavailable ? null : checks.results, unavailable: checks.unavailable ? checks.reason : null },
      touchedNodeIds: [node.id],
      findings: [`The ${node.type} ${node.id} ${verdict} ${names.join(' and ')}${checks.unavailable ? ` (${checks.reason})` : `: ${Object.values(checks.results).map((entry) => entry.detail).join('; ')}`}.`],
    };
  }

  function verifier(name) {
    return {
      name: `physics.${name}`,
      tags: ['physics'],
      async verify(result, ctx) {
        const checks = memo.get(result) ?? (await recheck(result?.output?.spec, [name], ctx));
        if (!checks) return { ok: false, detail: `physics.${name} found nothing it can check in this result` };
        if (checks.unavailable) return { ok: true, unavailable: true, detail: `physics.${name} was not checked: ${checks.reason}` };
        const entry = checks.results?.[name];
        if (!entry) return { ok: false, detail: `physics.${name} does not apply to this result` };
        return { ok: entry.ok === true, detail: entry.detail ?? null };
      },
    };
  }

  const quantitySchema = { description: 'A quantity with units, e.g. "9.81 m/s^2", or { value, units }.' };

  return {
    name: 'physics',
    toolchain: py,
    capabilities: [
      {
        name: 'physics.derive',
        tags: ['physics'],
        permission: 'write_notes',
        input: {
          type: 'object',
          required: ['problem'],
          properties: {
            problem: { type: 'string', description: 'What to derive, with the situation and the quantity wanted.' },
            problemId: { type: 'string', description: 'A node holding the problem statement, to derive from.' },
          },
        },
        verifiers: ['physics.units', 'physics.limits'],
        run: derive,
      },
      {
        name: 'physics.compute',
        tags: ['physics'],
        permission: 'run_generated_code',
        writesCode: true,
        input: {
          type: 'object',
          required: ['crossCheck'],
          properties: {
            title: { type: 'string' },
            derivationId: { type: 'string', description: 'The derivation node this computation evaluates or builds on.' },
            template: { type: 'string', enum: ['expression'], description: 'Evaluate the derivation’s closed form instead of code.' },
            code: { type: 'string', description: 'Python run in the sandbox with ureg, Q_, np, scipy, math and every input (a Pint quantity) in scope; it must set result = {name: quantity}.' },
            method: { type: 'string', description: 'One line on the method the code uses.' },
            inputs: { type: 'object', description: 'name → quantity; a derivation’s variables are the defaults.', additionalProperties: quantitySchema },
            outputs: { type: 'object', description: 'name → the units each result is checked against and reported in.' },
            crossCheck: { type: 'object', required: ['code'], description: 'An independent computation by a different method (e.g. numeric integration against a closed form), same inputs and outputs.', properties: { code: { type: 'string' }, method: { type: 'string' } } },
            tolerance: { type: 'number', description: 'Relative tolerance for the cross-check (default 0.001, at most 0.05).' },
            timeoutMs: { type: 'integer', minimum: 1000, maximum: 120000 },
          },
        },
        verifiers: ['physics.units', 'physics.rederive'],
        run: compute,
      },
      {
        name: 'physics.check',
        tags: ['physics'],
        // Re-running a stored computation runs model-written code.
        permission: 'run_generated_code',
        input: {
          type: 'object',
          required: ['nodeId'],
          properties: {
            nodeId: { type: 'string', description: 'A derivation or computation node.' },
            checks: { type: 'array', items: { type: 'string', enum: ['units', 'limits', 'rederive'] } },
          },
        },
        verifiers: [],
        run: check,
      },
    ],
    verifiers: [verifier('units'), verifier('limits'), verifier('rederive')],
  };
}

export default createPhysicsPlugin();
