// The live view of one run: the durable record loaded over HTTP, then folded
// forward with activity events. Pure functions, so the run view can be tested
// without a server and a reconnect can rebuild the whole thing from HTTP.

export const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'budget_exceeded', 'killed']);

// The run status a lifecycle event implies, or null for any other event. The
// run view and the run list both read status this way so they cannot drift.
// The runner parks a step by publishing approval.requested and then
// run.paused with reason 'waiting_approval'; that is a run waiting on the
// user, not one the user paused. run.resumed is published by the worker that
// has reclaimed a started run and is running it again, so it means running.
export function runStatusForEvent(event) {
  const data = event?.data ?? {};
  switch (event?.type) {
    case 'run.queued':
      return 'queued';
    case 'run.started':
    case 'run.resumed':
      return 'running';
    case 'run.paused':
      return data.reason === 'waiting_approval' ? 'waiting_approval' : 'paused';
    case 'run.finished':
      return data.status ?? 'succeeded';
    default:
      return null;
  }
}

// Step output is whatever the capability returned. Text is shown as is; a
// structured result is shown as compact JSON so nothing is hidden.
export function outputText(output) {
  if (output === null || output === undefined) return '';
  if (typeof output === 'string') return output;
  if (typeof output.text === 'string') return output.text;
  if (typeof output.summary === 'string') return output.summary;
  // A plan step's plan, and what a program printed (code.run_generated, a
  // script): the part a person reads, rather than the record around it.
  if (typeof output.plan === 'string') return output.plan;
  if (typeof output.output === 'string') return output.output;
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
}

// A step.output event carries the capability's output as the runner stored
// it: a structured result arrives as its JSON text. That text is read back
// and shown the way the HTTP record's output is, so the live view and a
// reload agree. Plain text, and JSON cut short by the event's size limit,
// are shown as they came.
export function eventOutputText(text) {
  if (typeof text !== 'string' || !text.startsWith('{')) return text ?? '';
  try {
    return outputText(JSON.parse(text));
  } catch {
    return text;
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

function hasPendingApproval(view, stepId) {
  return Object.values(view.approvals).some((approval) => approval.stepId === stepId && approval.status === 'pending');
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
      if (TERMINAL_STATUSES.has(view.run.status)) return view;
      return { ...view, run: { ...view.run, status: 'queued' } };
    case 'run.started':
    case 'run.resumed': {
      if (TERMINAL_STATUSES.has(view.run.status)) return view;
      // A parked step does not announce itself again when its run resumes
      // (the runner goes straight to acting on the decision), so a step
      // whose approvals are all decided is running again from here.
      const steps = view.steps.map((step) =>
        step.status === 'waiting_approval' && !hasPendingApproval(view, step.id) ? { ...step, status: 'running' } : step
      );
      return { ...view, steps, run: { ...view.run, status: 'running' } };
    }
    case 'run.paused': {
      if (TERMINAL_STATUSES.has(view.run.status)) return view;
      const status = runStatusForEvent(event);
      if (status !== 'waiting_approval') return { ...view, run: { ...view.run, status } };
      const stepId = view.approvals[data.approvalId]?.stepId ?? currentStepId(view);
      const parked = stepId ? updateStep(view, stepId, () => ({ status: 'waiting_approval' })) : view;
      return { ...parked, run: { ...view.run, status } };
    }
    case 'run.finished':
      return { ...view, run: { ...view.run, status: runStatusForEvent(event), finishedAt: event.at ?? view.run.finishedAt } };
    case 'step.started': {
      const exists = view.steps.some((step) => step.id === data.stepId);
      const steps = exists
        ? view.steps.map((step) => (step.id === data.stepId ? { ...step, status: 'running', capability: data.capability ?? step.capability } : step))
        : [...view.steps, { ...stepFromHttp({ id: data.stepId, index: data.index, capability: data.capability }), status: 'running' }];
      steps.sort((a, b) => a.index - b.index);
      return { ...view, steps, run: { ...view.run, status: 'running', stepIndex: data.index ?? view.run.stepIndex } };
    }
    case 'step.output':
      return updateStep(view, data.stepId, (step) => ({ output: (step.output ?? '') + eventOutputText(data.text) }));
    case 'step.verified':
      return updateStep(view, data.stepId, (step) => ({
        verifications: [...(step.verifications ?? []), ...verificationList({ verifier: data.verifier, ok: data.ok, detail: data.detail })],
      }));
    case 'step.finished':
      return updateStep(view, data.stepId, () => ({ status: data.status ?? 'succeeded' }));
    case 'approval.requested': {
      // Already known (from the HTTP record, say): keep that fuller record.
      if (view.approvals[data.approvalId]) return view;
      // A request alone does not stop the run: a cloud_model request is
      // run-scoped and the runner carries on locally while it is open. Only
      // the run.paused{reason:'waiting_approval'} that follows a step's
      // request parks the run and the step, so status changes wait for it.
      const stepId = data.capability === 'cloud_model' ? null : (data.stepId ?? currentStepId(view));
      const approvals = {
        ...view.approvals,
        [data.approvalId]: { id: data.approvalId, stepId, capability: data.capability, summary: data.summary ?? '', detail: null, status: 'pending' },
      };
      return { ...view, approvals };
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

const LIVE_STEP_STATUSES = new Set(['pending', 'running', 'waiting_approval']);

// Folds the events that arrived while the HTTP record was loading. Some of
// them are already in the record and must not be counted twice:
// - a step's output and verification are stored when the step finishes, so
//   for a step the record shows finished they are already there;
// - a written node is in the record's step once that step checkpointed;
// - a cost event is published after the call is recorded on the run, so one
//   that reached the page before the record did is almost always in its
//   totals. Skipping it may leave the meter a call behind until the next
//   reload; adding it could double it, and the record is the durable truth.
// Status changes are idempotent and are all applied.
export function replayOverRecord(view, events) {
  const settled = new Set(view.steps.filter((step) => !LIVE_STEP_STATUSES.has(step.status)).map((step) => step.id));
  const written = new Set(view.written.map((entry) => entry.nodeId));
  let next = view;
  for (const event of events) {
    if (!event || event.runId !== view.run.id) continue;
    const data = event.data ?? {};
    if ((event.type === 'step.output' || event.type === 'step.verified') && settled.has(data.stepId)) continue;
    if (event.type === 'node.written' && written.has(data.nodeId)) continue;
    if (event.type === 'cost') continue;
    next = applyRunEvent(next, event);
  }
  return next;
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
