import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ApprovalsBadge from './ApprovalsBadge.jsx';
import ApprovalsInbox from './ApprovalsInbox.jsx';
import { FakeEventSource, workspaceEvent } from '../test/fakeEventSource.js';
import { AGENT, fakeApi, renderWithWorkspace } from '../test/workspace.jsx';

const pending = (id, summary) => ({ id, agentId: AGENT.id, runId: 'run-1', stepId: 's1', capability: 'open_pr', summary, detail: { branch: 'fix' }, status: 'pending', createdAt: '2026-10-21T10:00:00.000Z', resolvedAt: null });

afterEach(() => FakeEventSource.reset());

describe('approvals inbox and badge', () => {
  it('lists pending approvals with their agent and counts them on the badge', async () => {
    const api = fakeApi({ listAgents: vi.fn(async () => [AGENT]), listApprovals: vi.fn(async () => [pending('p1', 'Open PR for the fix'), pending('p2', 'Open PR for docs')]) });
    renderWithWorkspace(
      <>
        <ApprovalsBadge />
        <ApprovalsInbox />
      </>,
      { api }
    );
    expect(await screen.findByLabelText('2 pending')).toHaveTextContent('2');
    expect(screen.getByText('Open PR for the fix')).toBeInTheDocument();
    expect(screen.getAllByText('Open pull requests')).toHaveLength(2);
    expect(await screen.findAllByText('Ada')).toHaveLength(2);
    expect(api.listApprovals).toHaveBeenCalledWith('pending');
  });

  it('approving drops the count; the badge hides at zero', async () => {
    const user = userEvent.setup();
    const api = fakeApi({ listApprovals: vi.fn(async () => [pending('p1', 'Open PR for the fix')]) });
    renderWithWorkspace(
      <>
        <ApprovalsBadge />
        <ApprovalsInbox />
      </>,
      { api }
    );
    await user.click(await screen.findByRole('button', { name: 'Approve: Open PR for the fix' }));
    expect(api.resolveApproval).toHaveBeenCalledWith('p1', 'approve');
    await waitFor(() => expect(screen.queryByLabelText(/pending/)).not.toBeInTheDocument());
    expect(screen.getByText('Nothing is waiting for you.')).toBeInTheDocument();
  });

  it('refreshes the count when an approval is requested live', async () => {
    const listApprovals = vi.fn().mockResolvedValueOnce([]).mockResolvedValue([pending('p3', 'Merge it')]);
    renderWithWorkspace(<ApprovalsBadge />, { api: fakeApi({ listApprovals }) });
    await waitFor(() => expect(listApprovals).toHaveBeenCalledTimes(1));
    expect(screen.queryByLabelText(/pending/)).not.toBeInTheDocument();
    act(() => FakeEventSource.latest().emit(workspaceEvent('approval.requested', { data: { approvalId: 'p3', capability: 'apply_merge', summary: 'Merge it' } })));
    expect(await screen.findByLabelText('1 pending')).toBeInTheDocument();
  });

  it('shows decided approvals under All', async () => {
    const user = userEvent.setup();
    const listApprovals = vi.fn(async (status) => (status === 'pending' ? [] : [{ ...pending('p9', 'Old one'), status: 'rejected' }]));
    renderWithWorkspace(<ApprovalsInbox />, { api: fakeApi({ listApprovals }) });
    await user.click(screen.getByLabelText('All'));
    expect(await screen.findByText('Old one')).toBeInTheDocument();
    expect(screen.getByText('Rejected')).toBeInTheDocument();
  });
});
