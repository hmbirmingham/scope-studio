import { contextGrowth, costPerCompleted, meanCurve } from '../endurance/economics.js';

// Turns what an arm did on a task into the benchmark's row, and rolls rows up
// per arm. Kept free of I/O so every number can be tested from plain data.

const sum = (values) => values.reduce((total, value) => total + (Number(value) || 0), 0);

export function tokenTotals(calls) {
  return {
    input: sum(calls.map((call) => call.inputTokens)),
    cacheWrite: sum(calls.map((call) => call.cacheWriteTokens)),
    cacheRead: sum(calls.map((call) => call.cacheReadTokens)),
    output: sum(calls.map((call) => call.outputTokens)),
  };
}

// The calls that choose a step, in order: the context curve. Planning is a
// one-off call either arm may or may not make, so it is reported but kept out
// of the per-step curve.
export function stepPrompts(calls) {
  return calls.filter((call) => call.purpose !== 'plan').map((call) => call.promptTokens);
}

// What "steps" means differs by arm, so the row never reports one number
// for both. `actions` is the comparable count: capability calls the arm
// attempted (a Scope run's steps that named a capability, a baseline's tool
// calls). `runnerSteps` is every step the Scope runner executed, the plan and
// the closing "done" included, and is null for a baseline, which has no
// runner; its turns are its model calls.
export function actionsOf(result) {
  return result.stepRecord ? result.stepRecord.filter((step) => step.capability).length : result.toolCalls ?? 0;
}

// One task on one arm. `completed` is the objective check's verdict and
// nothing else; `claimedDone` (the model said it was done) is kept beside it
// so a run that claims success without achieving it is visible.
export function taskRow({ task, arm, result }) {
  const calls = result.calls ?? [];
  const prompts = stepPrompts(calls);
  return {
    task: task.id,
    kind: task.kind,
    arm: arm.name,
    armKind: arm.kind,
    completed: result.check.completed === true,
    claimedDone: result.claimedDone === true,
    runStatus: result.runStatus,
    runError: result.runError ?? null,
    check: { exitCode: result.check.exitCode, timedOut: result.check.timedOut, testsTampered: result.check.testsTampered },
    costUsd: sum(calls.map((call) => call.costUsd)),
    wallMs: result.wallMs,
    actions: actionsOf(result),
    runnerSteps: result.stepRecord ? result.runnerSteps ?? result.stepRecord.length : null,
    modelCalls: calls.length,
    cloudCalls: calls.filter((call) => call.adapter !== 'local').length,
    tokens: tokenTotals(calls),
    context: {
      firstStepPromptTokens: prompts[0] ?? null,
      lastStepPromptTokens: prompts.at(-1) ?? null,
      maxStepPromptTokens: prompts.length ? Math.max(...prompts) : null,
      growthTokensPerStep: contextGrowth(prompts),
    },
    perCall: calls.map((call) => ({
      call: call.index,
      purpose: call.purpose,
      adapter: call.adapter,
      model: call.model,
      promptTokens: call.promptTokens,
      inputTokens: call.inputTokens,
      cacheWriteTokens: call.cacheWriteTokens,
      cacheReadTokens: call.cacheReadTokens,
      outputTokens: call.outputTokens,
      costUsd: call.costUsd,
    })),
    ...(result.stepRecord ? { stepRecord: result.stepRecord } : {}),
    ...(result.ledger ? { ledger: result.ledger } : {}),
    ...(result.stopped ? { stopped: result.stopped } : {}),
  };
}

export function armSummary(rows) {
  const completed = rows.filter((row) => row.completed).length;
  const costUsd = sum(rows.map((row) => row.costUsd));
  const prompts = rows.map((row) => stepPrompts(row.perCall));
  return {
    tasks: rows.length,
    completed,
    completionRate: rows.length ? completed / rows.length : null,
    claimedDone: rows.filter((row) => row.claimedDone).length,
    claimedButFailed: rows.filter((row) => row.claimedDone && !row.completed).length,
    costUsd,
    costPerCompletedUsd: costPerCompleted(costUsd, completed),
    wallMs: sum(rows.map((row) => row.wallMs)),
    actions: sum(rows.map((row) => row.actions)),
    // Null for an arm with no runner (a baseline), never a sum of nothing.
    runnerSteps: rows.some((row) => row.runnerSteps != null) ? sum(rows.map((row) => row.runnerSteps)) : null,
    modelCalls: sum(rows.map((row) => row.modelCalls)),
    tokens: {
      input: sum(rows.map((row) => row.tokens.input)),
      cacheWrite: sum(rows.map((row) => row.tokens.cacheWrite)),
      cacheRead: sum(rows.map((row) => row.tokens.cacheRead)),
      output: sum(rows.map((row) => row.tokens.output)),
    },
    maxStepPromptTokens: rows.length ? Math.max(0, ...rows.map((row) => row.context.maxStepPromptTokens ?? 0)) : null,
    meanGrowthTokensPerStep: (() => {
      const slopes = rows.map((row) => row.context.growthTokensPerStep).filter((value) => typeof value === 'number');
      return slopes.length ? sum(slopes) / slopes.length : null;
    })(),
    // The mean prompt size at each step across tasks: the flat-versus-growing curve.
    contextCurve: meanCurve(prompts),
  };
}

export function summarize(rows, armNames) {
  return Object.fromEntries(armNames.map((name) => [name, armSummary(rows.filter((row) => row.arm === name))]));
}

// Each baseline against each Scope arm, on cost per completed task: how many
// times more a completed task cost on the baseline. Null when either side
// completed nothing; Infinity when Scope's completed tasks cost nothing.
export function comparisons(totals, arms) {
  const scopes = arms.filter((arm) => arm.kind === 'scope');
  const baselines = arms.filter((arm) => arm.kind === 'baseline');
  const out = {};
  for (const scope of scopes) {
    for (const baseline of baselines) {
      const s = totals[scope.name];
      const b = totals[baseline.name];
      if (!s || !b) continue;
      const ratio = s.costPerCompletedUsd == null || b.costPerCompletedUsd == null
        ? null
        : s.costPerCompletedUsd === 0
          ? (b.costPerCompletedUsd === 0 ? 1 : Infinity)
          : b.costPerCompletedUsd / s.costPerCompletedUsd;
      out[`${scope.name}_vs_${baseline.name}`] = {
        completed: { [scope.name]: s.completed, [baseline.name]: b.completed },
        baselineCostPerCompletedOverScope: ratio,
        maxStepPromptTokens: { [scope.name]: s.maxStepPromptTokens, [baseline.name]: b.maxStepPromptTokens },
        growthTokensPerStep: { [scope.name]: s.meanGrowthTokensPerStep, [baseline.name]: b.meanGrowthTokensPerStep },
      };
    }
  }
  return out;
}
