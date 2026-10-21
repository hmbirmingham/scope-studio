import { useCallback, useEffect, useState } from 'react';
import AgentDot from './AgentDot.jsx';
import ApprovalActions from './ApprovalActions.jsx';
import { useWorkspace } from './workspaceContext.js';
import { approvalSummary, capabilityLabel } from './permissions.js';

// Every approval waiting on the user, across all agents and runs, with the
// decision buttons; "All" shows decided ones too.
export default function ApprovalsInbox() {
  const { api, agents, approvals: pending, loadApprovals, openRun } = useWorkspace();
  const [filter, setFilter] = useState('pending');
  const [all, setAll] = useState([]);
  const [problem, setProblem] = useState(null);

  const loadAll = useCallback(async () => {
    try {
      setAll(await api.listApprovals());
      setProblem(null);
    } catch (failure) {
      setProblem(failure.message);
    }
  }, [api]);

  useEffect(() => {
    // Synchronising with the server; every setState here happens after an await.
    // oxlint-disable-next-line react/set-state-in-effect
    if (filter === 'all') loadAll();
    else loadApprovals();
  }, [filter, loadAll, loadApprovals]);

  const shown = filter === 'pending' ? pending : all;
  const agentFor = (agentId) => agents.find((agent) => agent.id === agentId);

  return (
    <div className="ws-panel">
      <header className="ws-panel-head">
        <h2>Approvals</h2>
        <div className="ws-segmented" role="radiogroup" aria-label="Show">
          {[
            ['pending', `Waiting (${pending.length})`],
            ['all', 'All'],
          ].map(([id, label]) => (
            <label key={id} className={filter === id ? 'is-on' : ''}>
              <input type="radio" name="approvals-filter" value={id} checked={filter === id} onChange={() => setFilter(id)} />
              {label}
            </label>
          ))}
        </div>
      </header>
      {problem && <p className="ws-error" role="alert">{problem}</p>}
      {shown.length === 0 ? (
        <p className="ws-hint">{filter === 'pending' ? 'Nothing is waiting for you.' : 'No approvals yet.'}</p>
      ) : (
        <ul className="ws-list" aria-label="Approvals">
          {shown.map((approval) => {
            const agent = agentFor(approval.agentId);
            return (
              <li key={approval.id} className={`ws-approval is-${approval.status}`}>
                <div className="ws-approval-head">
                  <AgentDot color={agent?.color} />
                  <span className="ws-agent-name">{agent?.name ?? 'Agent'}</span>
                  <span className="ws-hint">wants to</span>
                  <strong>{capabilityLabel(approval.capability)}</strong>
                </div>
                {approvalSummary(approval) && <p>{approvalSummary(approval)}</p>}
                {approval.detail && (
                  <details className="ws-approval-detail">
                    <summary>Details</summary>
                    <pre>{typeof approval.detail === 'string' ? approval.detail : JSON.stringify(approval.detail, null, 2)}</pre>
                  </details>
                )}
                <div className="ws-actions">
                  <ApprovalActions approval={approval} onResolved={filter === 'all' ? loadAll : undefined} />
                  {approval.runId && (
                    <button type="button" className="ws-link" onClick={() => openRun(approval.runId)}>
                      Open the run
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
