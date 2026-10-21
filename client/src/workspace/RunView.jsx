import { useCallback, useEffect, useRef, useState } from 'react';
import AgentDot from './AgentDot.jsx';
import ApprovalActions from './ApprovalActions.jsx';
import BudgetMeter from './BudgetMeter.jsx';
import { useWorkspace, useWorkspaceEvents } from './workspaceContext.js';
import { CAPABILITIES } from './permissions.js';
import { TERMINAL_STATUSES, applyRunEvent, replayOverRecord, runViewFromHttp } from './runState.js';

const STATUS_WORDS = {
  queued: 'Queued',
  running: 'Running',
  waiting_approval: 'Waiting for approval',
  paused: 'Paused',
  succeeded: 'Succeeded',
  failed: 'Failed',
  budget_exceeded: 'Budget exceeded',
  killed: 'Stopped',
  rejected: 'Rejected',
  pending: 'Pending',
};
const LIMIT_WORDS = { maxTokens: 'token', maxUsd: 'cost', maxWallMs: 'time' };
// Node types a run writes that the user may want to open on the map.
const HIGHLIGHT_TYPES = new Set(['finding', 'artifact', 'decision', 'question']);
const LONG_OUTPUT = 600;

function capabilityLabel(name) {
  if (!name) return 'Step';
  return CAPABILITIES.find((capability) => capability.id === name)?.label ?? name;
}

function NodeLink({ entry }) {
  const { nodeLabel, focusNode } = useWorkspace();
  const known = nodeLabel(entry.nodeId);
  const type = entry.type ?? known?.type ?? 'node';
  const label = known?.label ?? `${type} ${entry.nodeId.slice(0, 8)}`;
  return (
    <li className={`ws-node is-${type}`}>
      <span className="ws-node-type">{type}</span>
      {focusNode ? (
        <button type="button" className="ws-link" onClick={() => focusNode(entry.nodeId)} aria-label={`Show ${type} “${label}” on the map`}>
          {label}
        </button>
      ) : (
        <span>{label}</span>
      )}
    </li>
  );
}

function StepOutput({ text }) {
  const [open, setOpen] = useState(false);
  if (!text) return null;
  const long = text.length > LONG_OUTPUT;
  return (
    <div className="ws-step-output">
      <pre>{long && !open ? `${text.slice(0, LONG_OUTPUT)}…` : text}</pre>
      {long && (
        <button type="button" className="ws-link" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? 'Show less' : 'Show all output'}
        </button>
      )}
    </div>
  );
}

function Step({ step, approvals, written }) {
  return (
    <li className={`ws-step is-${step.status}`} data-step-id={step.id}>
      <div className="ws-step-head">
        <span className="ws-step-index">#{step.index + 1}</span>
        <span className="ws-step-cap">{capabilityLabel(step.capability)}</span>
        <span className={`ws-status is-${step.status}`}>{STATUS_WORDS[step.status] ?? step.status}</span>
        {step.adapter && <span className="ws-hint">{step.adapter}</span>}
      </div>
      <StepOutput text={step.output} />
      {step.verifications.length > 0 && (
        <ul className="ws-verifications" aria-label="Verification">
          {step.verifications.map((check, index) => (
            <li key={`${check.verifier}-${index}`} className={check.ok ? 'is-ok' : 'is-failed'}>
              <span aria-hidden="true">{check.ok ? '✓' : '✗'}</span> {check.verifier}: {check.ok ? 'passed' : 'failed'}
              {check.detail ? <span className="ws-hint"> — {typeof check.detail === 'string' ? check.detail : JSON.stringify(check.detail)}</span> : null}
            </li>
          ))}
        </ul>
      )}
      {approvals.map((approval) => (
        <div key={approval.id} className={`ws-approval is-${approval.status}`}>
          <p>
            <strong>{capabilityLabel(approval.capability)}</strong>
            {approval.summary ? `: ${approval.summary}` : ''}
          </p>
          <ApprovalActions approval={approval} />
        </div>
      ))}
      {written.length > 0 && (
        <ul className="ws-nodes" aria-label="Written to the map">
          {written.map((entry) => (
            <NodeLink key={entry.nodeId} entry={entry} />
          ))}
        </ul>
      )}
    </li>
  );
}

// One run, live: loaded over HTTP (the durable record) and folded forward
// with activity events; reloaded over HTTP after any reconnect.
export default function RunView({ runId }) {
  const { api, agents, nodeLabel } = useWorkspace();
  const [view, setView] = useState(null);
  const [problem, setProblem] = useState(null);
  const [cancelling, setCancelling] = useState(false);
  // Events that arrive while the record is loading are applied after it,
  // minus those the record already holds (see replayOverRecord).
  const pending = useRef([]);
  const loading = useRef(false);

  const load = useCallback(async () => {
    loading.current = true;
    try {
      const [run, approvals] = await Promise.all([api.getRun(runId), api.listApprovals().catch(() => [])]);
      setView(replayOverRecord(runViewFromHttp(run, approvals), pending.current));
      setProblem(null);
    } catch (failure) {
      setProblem(failure.message);
    } finally {
      pending.current = [];
      loading.current = false;
    }
  }, [api, runId]);

  useEffect(() => {
    // Synchronising with the server; every setState in load happens after an await.
    // oxlint-disable-next-line react/set-state-in-effect
    setView(null);
    load();
  }, [load]);

  useWorkspaceEvents(
    (event) => {
      if (event.runId !== runId) return;
      if (loading.current) {
        pending.current.push(event);
        return;
      }
      setView((current) => (current ? applyRunEvent(current, event) : current));
    },
    { onResync: load }
  );

  async function cancel() {
    setCancelling(true);
    try {
      const run = await api.cancelRun(runId);
      setView((current) => (current ? { ...current, run: { ...current.run, ...run } } : current));
    } catch (failure) {
      setProblem(failure.message);
    } finally {
      setCancelling(false);
    }
  }

  if (!view) {
    return <div className="ws-run">{problem ? <p className="ws-error" role="alert">{problem}</p> : <p className="ws-hint">Loading the run…</p>}</div>;
  }

  const { run } = view;
  const agent = agents.find((entry) => entry.id === run.agentId);
  const live = !TERMINAL_STATUSES.has(run.status);
  const approvals = Object.values(view.approvals);
  const unplaced = approvals.filter((approval) => !approval.stepId || !view.steps.some((step) => step.id === approval.stepId));
  const highlights = view.written.filter((entry) => HIGHLIGHT_TYPES.has(entry.type ?? nodeLabel(entry.nodeId)?.type));

  return (
    <article className="ws-run" aria-labelledby={`run-${run.id}-title`}>
      <header className="ws-run-head">
        <div>
          <h3 id={`run-${run.id}-title`}>
            <AgentDot color={agent?.color} /> {agent?.name ?? 'Agent'}
            <span className={`ws-status is-${run.status}`} role="status">
              {STATUS_WORDS[run.status] ?? run.status}
            </span>
          </h3>
          <p className="ws-run-instructions">{run.instructions}</p>
          {run.project && <p className="ws-hint">Project: {run.project}</p>}
        </div>
        {live && (
          <button type="button" className="ws-btn is-danger" disabled={cancelling} onClick={cancel}>
            {cancelling ? 'Stopping…' : 'Stop run'}
          </button>
        )}
      </header>
      {problem && <p className="ws-error" role="alert">{problem}</p>}
      {view.budgetExceeded && (
        <p className="ws-error" role="alert">
          Stopped at the {LIMIT_WORDS[view.budgetExceeded] ?? view.budgetExceeded} limit.
        </p>
      )}
      {run.error && run.status === 'failed' && <p className="ws-error">{run.error}</p>}
      <BudgetMeter run={run} exceeded={view.budgetExceeded} live={live} />

      {unplaced.map((approval) => (
        <div key={approval.id} className={`ws-approval is-${approval.status}`}>
          <p>
            <strong>{capabilityLabel(approval.capability)}</strong>
            {approval.summary ? `: ${approval.summary}` : ''}
          </p>
          <ApprovalActions approval={approval} />
        </div>
      ))}

      {view.steps.length === 0 ? (
        <p className="ws-hint">{live ? 'Waiting for the first step…' : 'This run has no steps.'}</p>
      ) : (
        <ol className="ws-steps" aria-label="Steps" aria-live="polite">
          {view.steps.map((step) => (
            <Step
              key={step.id}
              step={step}
              approvals={approvals.filter((approval) => approval.stepId === step.id)}
              written={view.written.filter((entry) => entry.stepId === step.id)}
            />
          ))}
        </ol>
      )}

      {highlights.length > 0 && (
        <section className="ws-highlights" aria-label="Findings and artifacts">
          <h4>Findings and artifacts</h4>
          <ul className="ws-nodes">
            {highlights.map((entry) => (
              <NodeLink key={`h-${entry.nodeId}`} entry={entry} />
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}
