// The live view of one run: the durable record loaded over HTTP, then folded
// forward with activity events. Pure functions, so the run view can be tested
// without a server and a reconnect can rebuild the whole thing from HTTP.

export const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'budget_exceeded', 'killed']);

const RUN_STATUS_BY_EVENT = {
  'run.queued': 'queued',
  'run.started': 'running',
  'run.paused': 'paused',
  // Resuming puts a run back in the queue; the worker starts it again.
  'run.resumed': 'queued',
};

// Step output is whatever the capability returned. Text is shown as is; a
// structured result is shown as compact JSON so nothing is hidden.
export function outputText(output) {
  if (output === null || output === undefined) return '';
  if (typeof output === 'string') return output;
  if (typeof output.text === 'string') return output.text;
  if (typeof output.summary === 'string') return output.summary;
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
}

function verificationList(verification) {
  if (!verification) return [];
  const list = Array.isArray(verification) ? verification : [verification];
  return list
    .filter((entry) => entry && typeof entry === 'object')
    .map((entry) => ({ verifier: entry.verifier ?? 'result', ok: entry.ok === true, detail: entry.detail ?? null }));
}

function stepFromHttp(step) {
  return {
    id: step.id,
    index: step.index ?? 0,
    kind: step.kind ?? null,
    capability: step.capability ?? null,
    status: step.status ?? 'pending',
    output: outputText(step.output),
    verifications: verificationList(step.verification),
    adapter: step.adapter ?? null,
    tokens: step.tokens ?? 0,
    costUsd: step.costUsd ?? 0,
    nodeIds: [...(step.nodeIds ?? [])],
  };
}

export function emptyRunView(run) {
  return { run: { ...run }, steps: [], approvals: {}, written: [], touched: 0, budgetExceeded: null };
}

// `approvals` are the approval records for this run (any status), so a step
// parked before the page loaded still shows its Approve / Reject buttons.
export function runViewFromHttp(run, approvals = []) {
  const view = emptyRunView(run);
  view.steps = (run.steps ?? []).map(stepFromHttp).sort((a, b) => a.index - b.index);
  delete view.run.steps;
  for (const approval of approvals) {
    if (approval.runId !== run.id) continue;
    view.approvals[approval.id] = {
      id: approval.id,
      stepId: approval.stepId ?? null,
      capability: approval.capability,
      summary: approval.summary ?? '',
      detail: approval.detail ?? null,
      status: approval.status,
    };
  }
  for (const step of view.steps) {
    for (const nodeId of step.nodeIds) view.written.push({ nodeId, type: null, stepId: step.id });
  }
  if (run.status === 'budget_exceeded') view.budgetExceeded = run.error ?? 'budget';
  return view;
}

function currentStepId(view) {
  for (let i = view.steps.length - 1; i >= 0; i -= 1) {
    if (view.steps[i].status === 'running' || view.steps[i].status === 'waiting_approval') return view.steps[i].id;
  }
  return view.steps.at(-1)?.id ?? null;
}

function updateStep(view, stepId, change) {
  let found = false;
  const steps = view.steps.map((step) => {
    if (step.id !== stepId) return step;
    found = true;
    return { ...step, ...change(step) };
  });
  if (!found) {
    // An event for a step this view has not seen (it started before a
    // reconnect, say): make a placeholder rather than lose the event.
    steps.push({ ...stepFromHttp({ id: stepId, index: steps.length, status: 'running' }), ...change(stepFromHttp({ id: stepId })) });
  }
  return { ...view, steps };
}

// Folds one activity event into the view. Events for another run, and types
// this view does not show, leave it unchanged (the same object), so a caller
// can skip a render.
export function applyRunEvent(view, event) {
  if (!view || !event || event.runId !== view.run.id) return view;
  const data = event.data ?? {};
  switch (event.type) {
    case 'run.queued':
    case 'run.started':
    case 'run.paused':
    case 'run.resumed':
      if (TERMINAL_STATUSES.has(view.run.status)) return view;
      return { ...view, run: { ...view.run, status: RUN_STATUS_BY_EVENT[event.type] } };
    case 'run.finished':
      return { ...view, run: { ...view.run, status: data.status ?? 'succeeded', finishedAt: event.at ?? view.run.finishedAt } };
    case 'step.started': {
      const exists = view.steps.some((step) => step.id === data.stepId);
      const steps = exists
        ? view.steps.map((step) => (step.id === data.stepId ? { ...step, status: 'running', capability: data.capability ?? step.capability } : step))
        : [...view.steps, { ...stepFromHttp({ id: data.stepId, index: data.index, capability: data.capability }), status: 'running' }];
      steps.sort((a, b) => a.index - b.index);
      return { ...view, steps, run: { ...view.run, status: 'running', stepIndex: data.index ?? view.run.stepIndex } };
    }
    case 'step.output':
      return updateStep(view, data.stepId, (step) => ({ output: (step.output ?? '') + (data.text ?? '') }));
    case 'step.verified':
      return updateStep(view, data.stepId, (step) => ({
        verifications: [...(step.verifications ?? []), ...verificationList({ verifier: data.verifier, ok: data.ok, detail: data.detail })],
      }));
    case 'step.finished':
      return updateStep(view, data.stepId, () => ({ status: data.status ?? 'succeeded' }));
    case 'approval.requested': {
      const stepId = currentStepId(view);
      const approvals = {
        ...view.approvals,
        [data.approvalId]: { id: data.approvalId, stepId, capability: data.capability, summary: data.summary ?? '', detail: null, status: 'pending' },
      };
      const parked = stepId ? updateStep(view, stepId, () => ({ status: 'waiting_approval' })) : view;
      return { ...parked, approvals, run: { ...view.run, status: 'waiting_approval' } };
    }
    case 'approval.resolved': {
      const known = view.approvals[data.approvalId];
      if (!known) return view;
      return { ...view, approvals: { ...view.approvals, [data.approvalId]: { ...known, status: data.status } } };
    }
    case 'node.written': {
      const stepId = currentStepId(view);
      const written = [...view.written, { nodeId: data.nodeId, type: data.type ?? null, stepId }];
      const withNode = stepId ? updateStep(view, stepId, (step) => ({ nodeIds: [...step.nodeIds, data.nodeId] })) : view;
      return { ...withNode, written };
    }
    case 'node.touched':
      return { ...view, touched: view.touched + (data.nodeIds?.length ?? 0) };
    case 'cost':
      // Each cost event is one model call's spend, so the run's totals grow by it.
      return {
        ...view,
        run: {
          ...view.run,
          tokensUsed: (view.run.tokensUsed ?? 0) + (Number(data.tokens) || 0),
          costUsd: (view.run.costUsd ?? 0) + (Number(data.usd) || 0),
        },
      };
    case 'budget.exceeded':
      return { ...view, budgetExceeded: data.limit ?? 'budget' };
    default:
      return view;
  }
}

// How far a run is through each budget limit, as fractions for the meter.
// Wall clock runs from the start until the finish (or now, while running).
export function budgetUsage(run, now = Date.now()) {
  const budget = run.budget ?? {};
  const started = run.startedAt ? Date.parse(run.startedAt) : null;
  // While a run is live its stored wallMs lags (it is written at checkpoints),
  // so the clock is read from startedAt instead.
  const live = started !== null && !run.finishedAt && !TERMINAL_STATUSES.has(run.status);
  const wallMs = live ? Math.max(now - started, 0) : (run.wallMs ?? (started && run.finishedAt ? Math.max(Date.parse(run.finishedAt) - started, 0) : 0));
  const fraction = (used, limit) => (limit > 0 ? Math.min(used / limit, 1) : 0);
  return {
    tokens: { used: run.tokensUsed ?? 0, limit: budget.maxTokens ?? null, fraction: fraction(run.tokensUsed ?? 0, budget.maxTokens) },
    usd: { used: run.costUsd ?? 0, limit: budget.maxUsd ?? null, fraction: fraction(run.costUsd ?? 0, budget.maxUsd) },
    wall: { used: wallMs, limit: budget.maxWallMs ?? null, fraction: fraction(wallMs, budget.maxWallMs) },
  };
}
