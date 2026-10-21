// Registers the agent workspace's tabs beside the conversation. Imported once
// by App; the strip itself (WorkspaceTabs) knows nothing about these tabs.
// The panels load on first open, so the conversation's first paint does not
// wait for the agent builder; the badge is small and always shown.
import { lazy } from 'react';
import ApprovalsBadge from './ApprovalsBadge.jsx';
import { listTabs, registerTab } from './tabs.js';
import './workspace.css';

// Hot reload re-runs this module; the registry refuses duplicates.
if (!listTabs().some((tab) => tab.id === 'agents')) {
  registerTab({ id: 'agents', label: 'Agents', order: 10, Component: lazy(() => import('./AgentsPanel.jsx')) });
  registerTab({ id: 'activity', label: 'Activity', order: 20, Component: lazy(() => import('./ActivityPanel.jsx')) });
  registerTab({ id: 'approvals', label: 'Approvals', order: 30, Component: lazy(() => import('./ApprovalsInbox.jsx')), Badge: ApprovalsBadge });
}
