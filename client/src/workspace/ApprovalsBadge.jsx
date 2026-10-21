import { useWorkspace } from './workspaceContext.js';

// The pending count beside the Approvals tab's label. Hidden at zero.
export default function ApprovalsBadge() {
  const { approvals } = useWorkspace();
  const count = approvals.length;
  if (count === 0) return null;
  return (
    <span className="ws-badge" aria-label={`${count} pending`}>
      {count}
    </span>
  );
}
