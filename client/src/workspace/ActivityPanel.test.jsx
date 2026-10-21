import { act, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ActivityPanel from './ActivityPanel.jsx';
import { FakeEventSource, workspaceEvent } from '../test/fakeEventSource.js';
import { AGENT, fakeApi, renderWithWorkspace } from '../test/workspace.jsx';

const RUN = { id: 'run-1', agentId: AGENT.id, instructions: 'Tidy the README', status: 'running', queuedAt: '2026-10-21T10:00:00.000Z' };

afterEach(() => FakeEventSource.reset());

const emit = (type, data) => act(() => FakeEventSource.latest().emit(workspaceEvent(type, { runId: 'run-1', agentId: AGENT.id, data })));

describe('ActivityPanel run list', () => {
  it('follows the runner through an approval: waiting, requeued, then running again', async () => {
    renderWithWorkspace(<ActivityPanel />, { api: fakeApi({ listAgents: vi.fn(async () => [AGENT]), listRuns: vi.fn(async () => [RUN]) }) });
    const list = await screen.findByRole('complementary', { name: 'Runs' });
    const item = await within(list).findByRole('button', { name: /Tidy the README/ });
    expect(item).toHaveTextContent('running');

    emit('approval.requested', { approvalId: 'p1', capability: 'edit_files', summary: 'Edit README.md' });
    emit('run.paused', { reason: 'waiting_approval', approvalId: 'p1' });
    expect(item).toHaveTextContent('waiting approval');
    expect(item).not.toHaveTextContent(/\bpaused\b/);

    emit('approval.resolved', { approvalId: 'p1', status: 'approved' });
    emit('run.queued', {});
    expect(item).toHaveTextContent('queued');
    emit('run.resumed', { attempt: 1 });
    expect(item).toHaveTextContent('running');
  });

  it('shows a run paused for another reason as paused', async () => {
    renderWithWorkspace(<ActivityPanel />, { api: fakeApi({ listAgents: vi.fn(async () => [AGENT]), listRuns: vi.fn(async () => [RUN]) }) });
    const item = await screen.findByRole('button', { name: /Tidy the README/ });
    emit('run.paused', { reason: 'agent_paused' });
    expect(item).toHaveTextContent('paused');
  });
});
