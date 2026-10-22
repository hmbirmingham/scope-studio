import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

  it('starts a run in the project the agent may write to, unless another is chosen', async () => {
    const user = userEvent.setup();
    const startRun = vi.fn(async (body) => ({ ...RUN, id: 'run-2', ...body }));
    renderWithWorkspace(<ActivityPanel />, { api: fakeApi({ listAgents: vi.fn(async () => [AGENT]), listRuns: vi.fn(async () => []), startRun, getRun: vi.fn(async () => RUN) }) });
    const project = await screen.findByRole('combobox', { name: 'Project' });
    await screen.findByRole('option', { name: 'Ada' });
    expect(project).toHaveValue('alpha');
    await user.type(screen.getByRole('textbox', { name: 'What should it do?' }), 'Tidy the notes');
    await user.click(screen.getByRole('button', { name: 'Start run' }));
    expect(startRun).toHaveBeenCalledWith({ agentId: AGENT.id, instructions: 'Tidy the notes', project: 'alpha' });

    await user.selectOptions(project, '');
    await user.type(screen.getByRole('textbox', { name: 'What should it do?' }), 'Anything');
    await user.click(screen.getByRole('button', { name: 'Start run' }));
    expect(startRun).toHaveBeenLastCalledWith({ agentId: AGENT.id, instructions: 'Anything' });
  });
});
