import { useState } from 'react';
import { useWorkspace } from './workspaceContext.js';

const STATUS_WORDS = { approved: 'Approved', rejected: 'Rejected', expired: 'Expired', pending: 'Waiting for you' };

// Approve / Reject for one approval. Used inline in a run's step stream and
// in the inbox; a decision made elsewhere first (409) is shown, not retried.
export default function ApprovalActions({ approval, label, onResolved }) {
  const { api, dropApproval } = useWorkspace();
  const [busy, setBusy] = useState(null);
  const [problem, setProblem] = useState(null);
  const [resolved, setResolved] = useState(null);

  const status = resolved ?? approval.status;
  if (status !== 'pending') {
    return (
      <span className={`ws-approval-status is-${status}`} role="status">
        {STATUS_WORDS[status] ?? status}
        {problem ? ` — ${problem}` : ''}
      </span>
    );
  }

  async function decide(decision) {
    setBusy(decision);
    setProblem(null);
    try {
      const result = await api.resolveApproval(approval.id, decision);
      setResolved(result.status);
      dropApproval(approval.id);
      onResolved?.(result);
    } catch (failure) {
      if (failure.status === 409) {
        setResolved(failure.body?.approval?.status ?? 'expired');
        dropApproval(approval.id);
        setProblem('This was already decided.');
      } else {
        setProblem(failure.message);
      }
    } finally {
      setBusy(null);
    }
  }

  const what = label ?? approval.summary ?? approval.capability;
  return (
    <div className="ws-approval-actions" role="group" aria-label={`Decision: ${what}`}>
      <button type="button" className="row-approve" disabled={Boolean(busy)} onClick={() => decide('approve')} aria-label={`Approve: ${what}`}>
        {busy === 'approve' ? 'Approving…' : 'Approve'}
      </button>
      <button type="button" className="row-reject" disabled={Boolean(busy)} onClick={() => decide('reject')} aria-label={`Reject: ${what}`}>
        {busy === 'reject' ? 'Rejecting…' : 'Reject'}
      </button>
      {problem && <span className="ws-error" role="alert">{problem}</span>}
    </div>
  );
}
