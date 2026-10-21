import { getPool } from '../../db/pool.js';
import { capabilitiesForTags, getCapability, getVerifier } from '../capabilities.js';
import { decide } from '../permissions.js';
import { effectiveBudget, exceededLimit, wallRemaining } from './budget.js';
import { chooserMessages, parseChoice, planMessages, validateInput } from './chooser.js';
import { stepTotals } from './ledger.js';
import { createModelRouter } from './models.js';
import { createRunSandbox, removeRunSandbox } from './sandbox.js';
import { packSlice } from './slice.js';
import {
  MAX_ATTEMPTS,
  TERMINAL_STATUSES,
  getStepAt,
  loadAgent,
  presentRun,
  presentStep,
  readControl,
  renewLease,
  startStep,
  transitionHeld,
  updateStep,
} from './store.js';
import { clipError, embedAll, notesFrom, outputText, planContent, stepContent, writePlanNode, writeStepNodes } from './writeBack.js';

// Executes one claimed run, step by step, following the run-step protocol in
// docs/architecture/agent-workspace.md: read → act → verify → write back →
// checkpoint, never skipping a stage. The run's position lives in the
// database, so a worker that dies mid-run loses at most the step in flight,
// and the next worker resumes from the last checkpoint.

// A model that keeps choosing invalid or failing steps would otherwise burn
// the whole step budget learning nothing.
export const MAX_CONSECUTIVE_FAILURES = 5;
// How many of the run's own node ids the checkpoint remembers for the slice.
const CHECKPOINT_NODES = 50;
const PLAN_MAX_TOKENS = 800;
const CHOOSER_MAX_TOKENS = 600;
const OUTPUT_EVENT_CHARS = 2000;
const CAPABILITY_EVENTS = new Set(['step.output', 'node.touched']);

// Thrown at a stage boundary when the run must stop: it was killed, paused or
// reclaimed elsewhere, or reached a budget limit.
class Stop extends Error {
  constructor(kind, detail = null) {
    super(kind);
    this.kind = kind;
    this.detail = detail;
  }
}

// Thrown when a test (or a dying process) abandons the worker: nothing more
// is written, exactly as if the process had crashed.
export class Abandoned extends Error {}

function abortError(signal) {
  const reason = signal.reason;
  return reason instanceof Stop ? reason : new Stop('killed');
}

// Settles with the capability's own promise, or rejects as soon as the step's
// signal aborts, so a capability that ignores its signal cannot hold a killed
// or over-budget run.
function untilAborted(promise, signal) {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      }
    );
  });
}

// Runs the claimed run, then removes its sandbox if the run ended. A run
// that parked, paused or was handed back keeps its sandbox for the resume.
export async function executeRun(claimed, deps) {
  const outcome = await executeSteps(claimed, deps);
  if (outcome === 'abandoned') return outcome;
  const db = deps.db ?? getPool();
  try {
    const { rows: [row] } = await db.query("SELECT status, checkpoint ? 'sandbox' AS has_sandbox FROM agent_runs WHERE id = $1", [claimed.id]);
    if (row && row.has_sandbox && TERMINAL_STATUSES.includes(row.status)) await removeRunSandbox(claimed.id, { db, env: deps.sandboxEnv });
  } catch (err) {
    // A sandbox that could not be removed now is removed by a later sweep.
    deps.onSandboxError?.(err);
  }
  return outcome;
}

async function executeSteps(claimed, deps) {
  const {
    workerId,
    leaseMs,
    adapters,
    online,
    embed = true,
    events,
    gather,
    heartbeatMs = 1000,
    isAbandoned = () => false,
    shouldRelease = () => false,
    sandboxEnv,
    db = getPool(),
  } = deps;
  const run = claimed;
  const publish = (type, data = {}) => events.publish({ runId: run.id, agentId: run.agent_id, ownerId: run.owner_id, type, data });

  const state = {
    stepIndex: run.step_index,
    planNodeId: run.plan_node_id,
    checkpoint: { nodes: [], previousStepNodeId: null, failures: 0, lastSummary: null, ...(run.checkpoint ?? {}) },
    wallBase: Number(run.wall_ms),
    mark: Date.now(),
  };
  const wallNow = () => state.wallBase + (Date.now() - state.mark);

  async function finish(status, { error = null, limit = null } = {}) {
    const row = await transitionHeld(run.id, workerId, { status, error: clipError(error), wallMs: wallNow() }, db);
    if (!row) return null;
    if (status === 'budget_exceeded') publish('budget.exceeded', { limit });
    if (status === 'paused') publish('run.paused', { reason: error ?? 'paused' });
    else if (status === 'queued') publish('run.queued', { reason: 'released' });
    else publish('run.finished', { status });
    return row;
  }

  if (run.attempts > MAX_ATTEMPTS) {
    await finish('failed', { error: 'too_many_attempts' });
    return 'failed';
  }

  // Re-read at every step boundary, so a permission or budget the user
  // changes mid-run applies from the next step.
  let agent = await loadAgent(run.owner_id, run.agent_id, db);
  if (!agent) {
    await finish('failed', { error: 'agent_missing' });
    return 'failed';
  }
  let budget = effectiveBudget(agent.budget, run.budget);
  const { rows: [user] } = await db.query('SELECT plan FROM users WHERE id = $1', [run.owner_id]);
  const localPath = run.project
    ? (await db.query('SELECT local_path FROM project_settings WHERE owner_id = $1 AND project = $2', [run.owner_id, run.project])).rows[0]?.local_path ?? null
    : null;
  // The run's sandbox, made the first time a step needs it. Its record is
  // stored in the checkpoint at once (not at the next checkpoint), so a crash
  // right after making it still finds it.
  const sandboxes = createRunSandbox({
    runId: run.id,
    localPath,
    record: state.checkpoint.sandbox ?? null,
    env: sandboxEnv,
    persist: async (record) => {
      const { rowCount } = await db.query(
        `UPDATE agent_runs SET checkpoint = jsonb_set(checkpoint, '{sandbox}', $3::jsonb)
         WHERE id = $1 AND status = 'running' AND lease_owner = $2`,
        [run.id, workerId, JSON.stringify(record)]
      );
      if (rowCount !== 1) throw new Stop('lost');
      state.checkpoint = { ...state.checkpoint, sandbox: record };
    },
  });
  const stepAdapters = new Map();
  const models = createModelRouter({
    agent: () => agent,
    run,
    userPlan: user?.plan ?? 'free',
    online,
    adapters,
    publish,
    db,
    onCall: ({ stepId, adapter, fallbackFrom }) => {
      if (!stepId) return;
      const seen = stepAdapters.get(stepId) ?? { adapter: null, fallbacks: [] };
      seen.adapter = adapter;
      if (fallbackFrom) seen.fallbacks.push({ from: fallbackFrom, to: adapter });
      stepAdapters.set(stepId, seen);
    },
  });

  // The stage guard: the kill switch, pause and the budget are read before
  // every stage, from the database, so a change made by any module is seen.
  // A kill stops the step where it is; a pause lets the step in flight finish
  // (its work is checkpointed, not thrown away) and stops at the boundary.
  async function stage({ boundary = false } = {}) {
    if (isAbandoned()) throw new Abandoned();
    const control = await readControl(run.id, db);
    if (!control) throw new Stop('lost');
    if (control.status === 'killed') throw new Stop('killed');
    if (control.agent_state === 'killed') throw new Stop('agent_killed');
    const pausedUnderUs = !boundary && control.status === 'paused' && (control.lease_owner === workerId || control.lease_owner == null);
    if (!pausedUnderUs && (control.status !== 'running' || control.lease_owner !== workerId)) throw new Stop('lost');
    if (boundary && control.agent_state !== 'active') throw new Stop('agent_paused');
    const limit = exceededLimit(budget, { tokens: control.tokens_used, usd: Number(control.cost_usd), wallMs: wallNow(), steps: 0 });
    if (limit) throw new Stop('budget', limit);
  }

  // While a step runs, a heartbeat renews the lease (a long capability must
  // not look like a dead worker) and aborts the step's signal on kill. The
  // wall-clock limit aborts it too.
  function watch(controller) {
    const timers = [];
    const heartbeat = setInterval(async () => {
      if (isAbandoned()) return clearInterval(heartbeat);
      try {
        const control = await readControl(run.id, db);
        if (!control || control.status === 'killed') {
          controller.abort(new Stop('killed'));
        } else if (control.agent_state === 'killed') {
          controller.abort(new Stop('agent_killed'));
        } else if (control.status === 'running' && !(await renewLease(run.id, { workerId, leaseMs }, db))) {
          controller.abort(new Stop('lost'));
        }
      } catch {
        // A missed heartbeat is retried on the next tick; the lease is long
        // enough to survive one.
      }
    }, heartbeatMs);
    heartbeat.unref?.();
    timers.push(() => clearInterval(heartbeat));
    const remaining = wallRemaining(budget, wallNow());
    if (remaining != null) {
      const timer = setTimeout(() => controller.abort(new Stop('budget', 'wall')), remaining);
      timer.unref?.();
      timers.push(() => clearTimeout(timer));
    }
    return () => timers.forEach((clear) => clear());
  }

  function sourceIdsOf(slice) {
    return slice.nodes.map((node) => node.id);
  }

  async function sourcesById(ids) {
    if (!ids?.length) return [];
    const { rows } = await db.query('SELECT id, type, content, project, privacy FROM nodes WHERE owner_id = $1 AND id = ANY($2)', [run.owner_id, ids]);
    return rows;
  }

  // Write back and checkpoint in one transaction: the step's nodes, the step
  // row and the run's position land together or not at all. Conditional on
  // this worker still holding the run (or the run having been paused under
  // it, so finished work is kept), never on overwriting its status.
  async function checkpoint(step, { status, capability, input, output = null, verification = null, detail = {}, error = null, sources = [], summary = null, reason = null, notes = [], plan = null }) {
    const index = step.index;
    const content = plan ? planContent({ goal: run.instructions, plan }) : stepContent({ index, capability, status, summary, output, reason });
    const texts = [content, ...notes.map((note) => note.content)];
    const embeddings = await embedAll(texts, { embed });
    if (isAbandoned()) throw new Abandoned();

    const seen = stepAdapters.get(step.id);
    const client = await db.connect();
    let written = [];
    let planNodeId = state.planNodeId;
    let stepNodeId = state.checkpoint.previousStepNodeId;
    try {
      await client.query('BEGIN');
      if (plan) {
        const node = await writePlanNode(client, { ownerId: run.owner_id, project: run.project, sources, content, embedding: embeddings[0] });
        planNodeId = node.id;
        written = [node];
      } else {
        const result = await writeStepNodes(client, {
          ownerId: run.owner_id,
          project: run.project,
          planNodeId: state.planNodeId,
          previousStepNodeId: state.checkpoint.previousStepNodeId,
          sources,
          content,
          notes,
          embeddings,
        });
        stepNodeId = result.step.id;
        written = [result.step, ...result.notes];
      }
      const totals = await stepTotals(step.id, client);
      await client.query(
        `UPDATE agent_run_steps
         SET status = $2, capability = $3, input = $4, output = $5, verification = $6, adapter = $7, tokens = $8,
             cost_usd = $9, node_ids = $10, detail = $11, error = $12, finished_at = now()
         WHERE id = $1`,
        [
          step.id,
          status,
          capability ?? null,
          input ?? {},
          output == null ? null : JSON.stringify(output),
          verification == null ? null : JSON.stringify(verification),
          seen?.adapter ?? null,
          totals.tokens,
          totals.usd,
          written.map((node) => node.id),
          { ...detail, fallbacks: seen?.fallbacks ?? [] },
          clipError(error),
        ]
      );
      const failed = status === 'failed';
      const next = {
        ...state.checkpoint,
        nodes: [...written.map((node) => node.id).filter((id) => id !== planNodeId), ...state.checkpoint.nodes].slice(0, CHECKPOINT_NODES),
        previousStepNodeId: stepNodeId,
        failures: failed ? state.checkpoint.failures + 1 : 0,
        lastSummary: summary ?? state.checkpoint.lastSummary,
      };
      const { rowCount } = await client.query(
        `UPDATE agent_runs
         SET step_index = $3, checkpoint = $4, plan_node_id = $5, wall_ms = $6,
             attempts = 0,
             lease_until = CASE WHEN status = 'running' THEN now() + make_interval(secs => $7::float8 / 1000) ELSE lease_until END
         WHERE id = $1 AND (lease_owner = $2 OR (status = 'paused' AND lease_owner IS NULL))`,
        [run.id, workerId, index + 1, next, planNodeId, wallNow(), leaseMs]
      );
      if (rowCount !== 1) {
        await client.query('ROLLBACK');
        throw new Stop('lost');
      }
      await client.query('COMMIT');
      state.stepIndex = index + 1;
      state.planNodeId = planNodeId;
      state.checkpoint = next;
    } catch (err) {
      if (!(err instanceof Stop)) await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    for (const node of written) publish('node.written', { nodeId: node.id, type: node.type });
    publish('step.finished', { stepId: step.id, status });
    return { written, stepNodeId };
  }

  async function failStep(step, { reason, sources = [], capability = null, input = {}, output = null, verification = null, detail = {}, summary = null }) {
    await checkpoint(step, { status: 'failed', capability, input, output, verification, detail, error: reason, sources, summary, reason });
    if (state.checkpoint.failures >= MAX_CONSECUTIVE_FAILURES) {
      await finish('failed', { error: 'too_many_failed_steps' });
      return 'finished';
    }
    return 'continue';
  }

  // `ask`: the step waits for the user. The approval, the parked step and the
  // run's status change land together, and the lease is released so no
  // worker holds a run that is waiting on a person. On a re-queue the pending
  // approval is found again rather than duplicated (one pending per step).
  async function park(step, { capabilityName, permission, input, detail, summary }) {
    const client = await db.connect();
    let approval;
    let created = false;
    try {
      await client.query('BEGIN');
      const inserted = await client.query(
        `INSERT INTO agent_approvals (owner_id, agent_id, run_id, step_id, capability, summary, detail)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (step_id) WHERE status = 'pending' DO NOTHING
         RETURNING id`,
        [run.owner_id, agent.id, run.id, step.id, capabilityName, summary, { permission, input, stepIndex: step.index }]
      );
      if (inserted.rows[0]) {
        approval = inserted.rows[0];
        created = true;
      } else {
        approval = (await client.query("SELECT id FROM agent_approvals WHERE step_id = $1 AND status = 'pending'", [step.id])).rows[0];
      }
      await client.query(
        "UPDATE agent_run_steps SET status = 'waiting_approval', capability = $2, input = $3, detail = $4 WHERE id = $1",
        [step.id, capabilityName, input ?? {}, detail]
      );
      const { rowCount } = await client.query(
        `UPDATE agent_runs SET status = 'waiting_approval', lease_owner = NULL, lease_until = NULL, attempts = 0, wall_ms = $3
         WHERE id = $1 AND status = 'running' AND lease_owner = $2`,
        [run.id, workerId, wallNow()]
      );
      if (rowCount !== 1) {
        await client.query('ROLLBACK');
        throw new Stop('lost');
      }
      await client.query('COMMIT');
    } catch (err) {
      if (!(err instanceof Stop)) await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    if (created) publish('approval.requested', { approvalId: approval.id, capability: capabilityName, summary });
    publish('run.paused', { reason: 'waiting_approval', approvalId: approval.id });
    return 'parked';
  }

  // Act, verify, write back and checkpoint for an allowed capability.
  async function act(step, { capability, choice, sources, privateContext, signal }) {
    // Every capability sees the run's sandbox once it has one, so a read after
    // an edit reads the edited copy, not the user's checkout.
    const sandbox = await sandboxes.current();
    const emit = ({ type, data = {} } = {}) => {
      if (!CAPABILITY_EVENTS.has(type)) throw new Error(`a capability may not emit ${type}`);
      publish(type, { ...data, stepId: step.id });
    };
    const ctx = {
      ownerId: run.owner_id,
      agent,
      run: presentRun({ ...run, step_index: state.stepIndex, plan_node_id: state.planNodeId }),
      step: presentStep({ ...step, capability: capability.name, input: choice.input }),
      project: run.project,
      localPath,
      ...(sandbox ? { sandbox } : {}),
      model: models.portFor({ hard: choice.hard, privateContext, stepId: step.id }),
      signal,
      emit,
    };
    const detail = { choice, sourceIds: sources.map((node) => node.id), privateContext };
    const base = { capability: capability.name, input: choice.input, sources, detail, summary: choice.summary };

    let result;
    try {
      result = await untilAborted(Promise.resolve().then(() => capability.run(choice.input, ctx)), signal);
    } catch (err) {
      if (err instanceof Stop || err instanceof Abandoned) throw err;
      return failStep(step, { ...base, reason: `capability_error: ${err?.message ?? 'failed'}` });
    }
    const text = outputText(result?.output);
    if (text) publish('step.output', { stepId: step.id, text: text.slice(0, OUTPUT_EVENT_CHARS) });
    const touched = Array.isArray(result?.touchedNodeIds) ? result.touchedNodeIds.filter((id) => typeof id === 'string') : [];
    if (touched.length > 0) publish('node.touched', { nodeIds: touched });

    // Verify. A capability with no verifier is verified by its result shape.
    await stage();
    const verification = [];
    const shapeOk = result != null && typeof result === 'object' && !Array.isArray(result) && 'output' in result;
    verification.push({ verifier: 'result.schema', ok: shapeOk, detail: shapeOk ? null : 'a capability must return { output }' });
    publish('step.verified', { stepId: step.id, ...verification[0] });
    if (shapeOk) {
      for (const name of capability.verifiers ?? []) {
        const verifier = getVerifier(name);
        let outcome;
        try {
          outcome = verifier ? await untilAborted(Promise.resolve().then(() => verifier.verify(result, ctx)), signal) : { ok: false, detail: 'verifier not registered' };
        } catch (err) {
          if (err instanceof Stop || err instanceof Abandoned) throw err;
          outcome = { ok: false, detail: err?.message ?? 'verifier failed' };
        }
        const entry = { verifier: name, ok: outcome?.ok === true, detail: outcome?.detail ?? null };
        verification.push(entry);
        publish('step.verified', { stepId: step.id, ...entry });
      }
    }
    const verified = verification.every((entry) => entry.ok);

    // Write back and checkpoint. Only a verified step keeps its notes.
    await stage();
    if (!verified) {
      return failStep(step, { ...base, output: result?.output ?? null, verification, reason: 'verification_failed' });
    }
    await checkpoint(step, {
      ...base,
      status: 'done',
      output: result.output,
      verification,
      notes: notesFrom(result),
    });
    if (choice.done) {
      await finish('succeeded');
      return 'finished';
    }
    return 'continue';
  }

  async function planStep(step, { slice, signal }) {
    const capabilities = capabilitiesForTags(agent.role?.tags ?? []);
    const reply = await models.complete({
      purpose: 'plan',
      privateContext: slice.privateContext,
      stepId: step.id,
      messages: planMessages({ agent, goal: run.instructions, slice: slice.nodes, capabilities }),
      maxTokens: PLAN_MAX_TOKENS,
      signal,
    });
    await stage();
    const plan = reply.text.trim();
    const ok = plan.length > 0;
    const verification = [{ verifier: 'plan.nonempty', ok, detail: ok ? null : 'the planner returned nothing' }];
    publish('step.verified', { stepId: step.id, ...verification[0] });
    await stage();
    if (!ok) {
      await checkpoint(step, { status: 'failed', capability: null, input: {}, verification, error: 'plan_empty', sources: slice.nodes, reason: 'plan_empty' });
      await finish('failed', { error: 'plan_empty' });
      return 'finished';
    }
    await checkpoint(step, {
      status: 'done',
      capability: null,
      input: {},
      output: { plan },
      verification,
      sources: slice.nodes,
      plan,
      detail: { sourceIds: sourceIdsOf(slice), privateContext: slice.privateContext },
    });
    return 'continue';
  }

  // Writing the plan is the planning step's one act, so it asks can() like
  // any other: write_notes on the run's project.
  function planDecision(slice) {
    return decide(agent, 'write_notes', { project: run.project, online, privateContext: slice.privateContext, inSandbox: false });
  }

  // can() for a chosen capability. `inSandbox` is true only when the
  // capability will actually run in the run's sandbox.
  async function capabilityDecision(capability, privateContext) {
    const inSandbox = await sandboxes.applies(capability);
    return { inSandbox, ...decide(agent, capability.permission, { project: run.project, source: capability.source, inSandbox, online, privateContext }) };
  }

  // Makes (or finds) the sandbox an allowed capability runs in, then acts. A
  // sandbox that cannot be made fails the step, like any capability error.
  async function actAllowed(step, { capability, choice, sources, privateContext, signal, inSandbox }) {
    if (inSandbox) {
      try {
        await sandboxes.ensure();
      } catch (err) {
        if (err instanceof Stop || err instanceof Abandoned) throw err;
        return failStep(step, { reason: `sandbox_error: ${err?.message ?? 'failed'}`, sources, capability: capability.name, input: choice.input, detail: { choice }, summary: choice.summary });
      }
      await stage();
    }
    return act(step, { capability, choice, sources, privateContext, signal });
  }

  async function resumeParked(step, signal) {
    const { rows: [approval] } = await db.query(
      'SELECT id, status FROM agent_approvals WHERE step_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1',
      [step.id]
    );
    const detail = step.detail ?? {};
    const sources = await sourcesById(detail.sourceIds);
    // Recomputed from the nodes, not trusted from the row: a node made
    // private since the step parked keeps the step local.
    const privateContext = sources.some((node) => node.privacy === 'local') || detail.privateContext === true;

    if (!approval || approval.status === 'pending') {
      return park(step, { capabilityName: step.capability, permission: detail.permission, input: step.input, detail, summary: detail.summary ?? 'Approve this step' });
    }
    if (approval.status !== 'approved') {
      if (step.kind === 'plan') {
        await checkpoint(step, { status: 'rejected', capability: null, input: {}, error: 'plan_rejected', sources, reason: 'plan_rejected', detail });
        await finish('failed', { error: 'plan_rejected' });
        return 'finished';
      }
      // A rejection is recorded in the graph like any step, so the chooser
      // sees it and continues without it.
      await checkpoint(step, {
        status: 'rejected',
        capability: step.capability,
        input: step.input,
        error: `approval_${approval.status}`,
        sources,
        summary: detail.choice?.summary ?? null,
        reason: `the user ${approval.status === 'rejected' ? 'rejected' : 'did not approve'} this step`,
        detail,
      });
      return 'continue';
    }

    // The approval was given for the agent as it was then. can() is asked
    // again before acting, so a hard denial since (the agent's scope changed,
    // the context became private, the engine went offline) or an override
    // that now denies fails the step instead of running it. An `ask` stands:
    // that is what the user just approved.
    if (step.kind === 'plan') {
      const { decision, reason } = planDecision({ privateContext });
      if (decision === 'deny') {
        await checkpoint(step, { status: 'failed', capability: null, input: {}, error: `denied:${reason}`, sources, reason: `denied: ${reason}`, detail });
        await finish('failed', { error: `plan_denied:${reason}` });
        return 'finished';
      }
      return planStep(step, { slice: { nodes: sources, privateContext }, signal });
    }
    const capability = getCapability(step.capability);
    if (!capability) return failStep(step, { reason: 'unknown_capability', sources, capability: step.capability, input: step.input, detail });
    // The role may have been edited while the step waited.
    if (!capabilitiesForTags(agent.role?.tags ?? []).some((entry) => entry.name === capability.name)) {
      return failStep(step, { reason: 'capability_not_in_role', sources, capability: capability.name, input: step.input, detail });
    }
    const { decision, reason, inSandbox } = await capabilityDecision(capability, privateContext);
    if (decision === 'deny') {
      return failStep(step, { reason: `denied: ${reason}`, sources, capability: capability.name, input: step.input, detail, summary: detail.choice?.summary ?? null });
    }
    await stage();
    return actAllowed(step, { capability, choice: detail.choice, sources, privateContext, signal, inSandbox });
  }

  async function runStep(signal) {
    const index = state.stepIndex;
    const existing = await getStepAt(run.id, index, db);
    if (existing?.status === 'waiting_approval') return resumeParked(existing, signal);

    const kind = state.planNodeId ? 'act' : 'plan';
    const step = await startStep(run.id, { index, kind }, db);
    publish('step.started', { stepId: step.id, index, capability: null });

    // Read.
    const goal = state.checkpoint.lastSummary ? `${run.instructions}\n${state.checkpoint.lastSummary}` : run.instructions;
    const slice = await packSlice({
      ownerId: run.owner_id,
      agent,
      goal,
      project: run.project,
      planNodeId: state.planNodeId,
      runNodeIds: state.checkpoint.nodes,
      embed,
      ...(gather ? { gather } : {}),
      db,
    });
    await stage();

    if (kind === 'plan') {
      const { decision, reason } = planDecision(slice);
      if (decision === 'deny') {
        await checkpoint(step, { status: 'failed', capability: null, input: {}, error: `denied:${reason}`, sources: slice.nodes, reason: `denied: ${reason}` });
        await finish('failed', { error: `plan_denied:${reason}` });
        return 'finished';
      }
      if (decision === 'ask') {
        return park(step, {
          capabilityName: 'write_notes',
          permission: 'write_notes',
          input: {},
          summary: 'Let the agent write a plan for this run',
          detail: { permission: 'write_notes', sourceIds: sourceIdsOf(slice), privateContext: slice.privateContext, summary: 'Let the agent write a plan for this run' },
        });
      }
      return planStep(step, { slice, signal });
    }

    // Act: the chooser picks one capability.
    const capabilities = capabilitiesForTags(agent.role?.tags ?? []);
    const reply = await models.complete({
      purpose: 'step',
      hard: false,
      privateContext: slice.privateContext,
      stepId: step.id,
      messages: chooserMessages({ agent, goal: run.instructions, slice: slice.nodes, capabilities, stepIndex: index }),
      maxTokens: CHOOSER_MAX_TOKENS,
      format: 'json',
      signal,
    });
    await stage();
    const parsed = parseChoice(reply.text);
    if (!parsed.ok) return failStep(step, { reason: parsed.error, sources: slice.nodes });
    const choice = parsed.choice;

    if (choice.done && !choice.capability) {
      // The run's conclusion is something later runs should know, so its
      // summary is kept as a finding of the final step, derived from what
      // that step read.
      await checkpoint(step, {
        status: 'done',
        capability: null,
        input: {},
        output: { done: true, summary: choice.summary },
        sources: slice.nodes,
        summary: choice.summary ?? 'Run complete',
        detail: { choice },
        notes: notesFrom({ findings: choice.summary ? [choice.summary] : [] }),
      });
      await finish('succeeded');
      return 'finished';
    }

    const capability = capabilities.find((entry) => entry.name === choice.capability) ?? null;
    if (!capability) {
      return failStep(step, { reason: `unknown_capability: ${choice.capability}`, sources: slice.nodes, input: choice.input, detail: { choice } });
    }
    const invalid = validateInput(capability.input, choice.input);
    if (invalid) {
      return failStep(step, { reason: `invalid_input: ${invalid}`, sources: slice.nodes, capability: capability.name, input: choice.input, detail: { choice } });
    }
    await updateStep(step.id, { capability: capability.name, input: choice.input }, db);
    publish('step.started', { stepId: step.id, index, capability: capability.name });

    const { decision, reason, inSandbox } = await capabilityDecision(capability, slice.privateContext);
    if (decision === 'deny') {
      return failStep(step, { reason: `denied: ${reason}`, sources: slice.nodes, capability: capability.name, input: choice.input, detail: { choice }, summary: choice.summary });
    }
    if (decision === 'ask') {
      const summary = choice.summary ? `${capability.name}: ${choice.summary}` : `Run ${capability.name}`;
      return park(step, {
        capabilityName: capability.name,
        permission: capability.permission,
        input: choice.input,
        summary,
        detail: { choice, permission: capability.permission, sourceIds: sourceIdsOf(slice), privateContext: slice.privateContext, summary },
      });
    }
    return actAllowed(step, { capability, choice, sources: slice.nodes, privateContext: slice.privateContext, signal, inSandbox });
  }

  // Marks the step in flight when a stop interrupts it, so the record says
  // why it never finished. A paused or reclaimed step is left for the resume.
  async function interrupted(kind) {
    const step = await getStepAt(run.id, state.stepIndex, db);
    if (step?.status === 'running' && (kind === 'killed' || kind === 'agent_killed' || kind === 'budget')) {
      await updateStep(step.id, { status: 'failed', error: kind === 'budget' ? 'budget_exceeded' : 'killed', finished_at: new Date() }, db);
      publish('step.finished', { stepId: step.id, status: 'failed' });
    }
  }

  async function stopFor(err) {
    await interrupted(err.kind);
    switch (err.kind) {
      case 'budget':
        await finish('budget_exceeded', { limit: err.detail, error: `budget_exceeded:${err.detail}` });
        return 'budget_exceeded';
      case 'agent_killed': {
        // The agent's kill switch fired but this run had not been marked yet.
        const row = await finish('killed', { error: 'agent_killed' });
        if (row) await db.query("UPDATE agent_approvals SET status = 'expired', resolved_at = now() WHERE run_id = $1 AND status = 'pending'", [run.id]);
        return 'killed';
      }
      case 'agent_paused':
        await finish('paused', { error: 'agent_paused' });
        return 'paused';
      case 'released':
        await finish('queued');
        return 'released';
      default:
        // Killed, paused or reclaimed by someone else: they own the status.
        return err.kind;
    }
  }

  publish(claimed.was_started ? 'run.resumed' : 'run.started', { attempt: run.attempts });
  try {
    for (;;) {
      // A worker that is stopping hands the run back at a step boundary, so
      // nothing that ran is lost and nothing is repeated.
      if (shouldRelease()) throw new Stop('released');
      agent = (await loadAgent(run.owner_id, run.agent_id, db)) ?? agent;
      budget = effectiveBudget(agent.budget, run.budget);
      await stage({ boundary: true });
      const limit = exceededLimit(budget, { steps: state.stepIndex });
      if (limit) throw new Stop('budget', limit);
      if (!(await renewLease(run.id, { workerId, leaseMs }, db))) throw new Stop('lost');

      const controller = new AbortController();
      const unwatch = watch(controller);
      let outcome;
      try {
        outcome = await runStep(controller.signal);
      } catch (err) {
        // An abort surfaces as whatever the model client or capability threw;
        // the signal's reason says what actually happened.
        if (controller.signal.aborted && !(err instanceof Stop) && !(err instanceof Abandoned)) throw abortError(controller.signal);
        if (err instanceof Stop || err instanceof Abandoned) throw err;
        // A model or storage error inside the step fails the step, not the
        // run: the next step sees the failure in the graph and can recover.
        const step = await getStepAt(run.id, state.stepIndex, db);
        if (!step || step.status !== 'running') throw err;
        outcome = await failStep(step, { reason: `step_error: ${err?.message ?? 'failed'}` });
      } finally {
        unwatch();
      }
      if (outcome !== 'continue') return outcome;
    }
  } catch (err) {
    if (err instanceof Abandoned) return 'abandoned';
    if (err instanceof Stop) return stopFor(err);
    const row = await finish('failed', { error: `runner_error: ${err?.message ?? 'failed'}` }).catch(() => null);
    return row ? 'failed' : 'lost';
  }
}
