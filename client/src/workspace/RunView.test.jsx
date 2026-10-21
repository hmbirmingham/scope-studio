import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import RunView from './RunView.jsx';
import { ApiError } from './api.js';
import { FakeEventSource, workspaceEvent } from '../test/fakeEventSource.js';
import { AGENT, fakeApi, renderWithWorkspace } from '../test/workspace.jsx';

const RUN = {
  id: 'run-1',
  agentId: AGENT.id,
  taskId: null,
  instructions: 'Summarise the sensor notes',
  project: 'alpha',
  status: 'running',
  stepIndex: 0,
  tokensUsed: 0,
  costUsd: 0,
  wallMs: 0,
  budget: { maxTokens: 1000, maxUsd: 0.5, maxWallMs: 600000 },
  error: null,
  queuedAt: '2026-10-21T10:00:00.000Z',
  startedAt: '2026-10-21T10:00:00.000Z',
  finishedAt: null,
  planNodeId: null,
  steps: [],
};

afterEach(() => FakeEventSource.reset());

const emit = (type, data) => act(() => FakeEventSource.latest().emit(workspaceEvent(type, { runId: 'run-1', agentId: AGENT.id, data })));

function renderRun(overrides = {}) {
  const api = fakeApi({
    listAgents: vi.fn(async () => [AGENT]),
    getRun: vi.fn(async () => RUN),
    ...overrides,
  });
  const focus = vi.fn();
  const result = renderWithWorkspace(<RunView runId="run-1" />, { api, onFocusNode: focus, nodesById: new Map([['n7', { id: 'n7', label: 'Drift is thermal', type: 'finding' }]]) });
  return { ...result, focus };
}

describe('RunView', () => {
  it('streams steps, verification, cost and written nodes live', async () => {
    const user = userEvent.setup();
    const { focus } = renderRun();
    await screen.findByText('Summarise the sensor notes');
    act(() => FakeEventSource.latest().open());

    emit('step.started', { stepId: 's1', index: 0, capability: 'read_graph' });
    emit('step.output', { stepId: 's1', text: 'Reading 12 notes' });
    emit('step.verified', { stepId: 's1', verifier: 'result.schema', ok: true, detail: null });
    emit('node.written', { nodeId: 'n7', type: 'finding' });
    emit('cost', { tokens: 400, usd: 0.1, adapter: 'local' });
    emit('step.finished', { stepId: 's1', status: 'succeeded' });

    const steps = screen.getByRole('list', { name: 'Steps' });
    expect(within(steps).getByText('Read the map')).toBeInTheDocument();
    expect(within(steps).getByText('Reading 12 notes')).toBeInTheDocument();
    expect(within(steps).getByText(/result.schema: passed/)).toBeInTheDocument();
    expect(within(steps).getByText('Succeeded')).toBeInTheDocument();
    expect(screen.getByLabelText('Tokens used')).toHaveAttribute('aria-valuetext', '400 of 1000');
    expect(screen.getByLabelText('Cost used')).toHaveAttribute('aria-valuetext', '$0.100 of $0.500');

    const links = screen.getAllByRole('button', { name: 'Show finding “Drift is thermal” on the map' });
    expect(links.length).toBeGreaterThan(0);
    await user.click(links[0]);
    expect(focus).toHaveBeenCalledWith('n7');
    expect(screen.getByRole('region', { name: 'Findings and artifacts' })).toBeInTheDocument();
  });

  it('shows an approval inline and approves it', async () => {
    const user = userEvent.setup();
    const { api } = renderRun();
    await screen.findByText('Summarise the sensor notes');
    emit('step.started', { stepId: 's2', index: 1, capability: 'edit_files' });
    emit('approval.requested', { approvalId: 'p1', capability: 'edit_files', summary: 'Edit README.md' });

    expect(screen.getAllByText('Waiting for approval').length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: 'Approve: Edit README.md' }));
    expect(api.resolveApproval).toHaveBeenCalledWith('p1', 'approve');
    expect(await screen.findByText('Approved')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve: Edit README.md' })).not.toBeInTheDocument();
  });

  it('shows an approval already pending when the page loads, and rejects it', async () => {
    const user = userEvent.setup();
    const { api } = renderRun({
      getRun: vi.fn(async () => ({ ...RUN, status: 'waiting_approval', steps: [{ id: 's1', index: 0, capability: 'web', status: 'waiting_approval', nodeIds: [] }] })),
      listApprovals: vi.fn(async () => [{ id: 'p5', runId: 'run-1', stepId: 's1', agentId: AGENT.id, capability: 'web', summary: 'Search arXiv', status: 'pending' }]),
    });
    await user.click(await screen.findByRole('button', { name: 'Reject: Search arXiv' }));
    expect(api.resolveApproval).toHaveBeenCalledWith('p5', 'reject');
    expect(await screen.findByText('Rejected')).toBeInTheDocument();
  });

  it('says so when someone else decided first', async () => {
    const user = userEvent.setup();
    renderRun({
      resolveApproval: vi.fn(async () => {
        throw new ApiError(409, 'already_resolved', 'this approval is approved', { approval: { id: 'p1', status: 'approved' } });
      }),
    });
    await screen.findByText('Summarise the sensor notes');
    emit('approval.requested', { approvalId: 'p1', capability: 'web', summary: 'Search' });
    await user.click(screen.getByRole('button', { name: 'Approve: Search' }));
    expect(await screen.findByText(/Approved — This was already decided/)).toBeInTheDocument();
  });

  it('reloads the run over HTTP after a reconnect', async () => {
    const getRun = vi
      .fn()
      .mockResolvedValueOnce(RUN)
      .mockResolvedValueOnce({ ...RUN, status: 'succeeded', finishedAt: '2026-10-21T10:05:00.000Z', steps: [{ id: 's1', index: 0, capability: 'web', status: 'succeeded', output: 'done offline', nodeIds: [] }] });
    renderRun({ getRun });
    await screen.findByText('Summarise the sensor notes');
    const source = FakeEventSource.latest();
    act(() => source.open());
    act(() => source.drop());
    act(() => source.open());
    await waitFor(() => expect(getRun).toHaveBeenCalledTimes(2));
    expect(await screen.findByText('done offline')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop run' })).not.toBeInTheDocument();
  });

  it('stops a live run', async () => {
    const user = userEvent.setup();
    const { api } = renderRun({ cancelRun: vi.fn(async () => ({ ...RUN, status: 'killed' })) });
    await user.click(await screen.findByRole('button', { name: 'Stop run' }));
    expect(api.cancelRun).toHaveBeenCalledWith('run-1');
    expect(await screen.findByText('Stopped')).toBeInTheDocument();
  });

  it('names the limit a run ran into', async () => {
    renderRun();
    await screen.findByText('Summarise the sensor notes');
    emit('budget.exceeded', { limit: 'maxTokens' });
    emit('run.finished', { status: 'budget_exceeded' });
    expect(screen.getByText('Stopped at the token limit.')).toBeInTheDocument();
    expect(screen.getByText('Budget exceeded')).toBeInTheDocument();
  });
});
