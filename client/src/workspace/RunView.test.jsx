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

// The run's own status badge, in its heading (approvals have status badges too).
const runStatus = () => within(screen.getByRole('heading', { name: /Ada/ })).getByRole('status');

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

  it('names plug-in steps, shows the code a step wants to run, and reads a saved artifact in place', async () => {
    const user = userEvent.setup();
    const code = 'console.log(4 * Math.PI ** 2 / 4.035);';
    const { api } = renderRun({
      getApproval: vi.fn(async (id) => ({ id, runId: 'run-1', stepId: 's2', capability: 'code.run_generated', summary: 'code.run_generated: Recompute g', detail: { input: { language: 'node', code } }, status: 'pending' })),
      getNode: vi.fn(async (id) => ({ id, type: 'artifact', content: 'Lab report check\n\n1. Put the 0.80 m row back.' })),
    });
    await screen.findByText('Summarise the sensor notes');
    emit('step.started', { stepId: 's2', index: 1, capability: 'code.run_generated' });
    emit('approval.requested', { approvalId: 'p2', capability: 'code.run_generated', summary: 'code.run_generated: Recompute g' });
    emit('run.paused', { reason: 'waiting_approval', approvalId: 'p2' });

    const steps = screen.getByRole('list', { name: 'Steps' });
    expect(within(steps).getAllByText('Run code in the sandbox').length).toBeGreaterThan(0);
    expect(screen.queryByText(/code\.run_generated:/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve: Recompute g' })).toBeInTheDocument();
    // The code arrives with the approval's record, fetched once.
    expect(await screen.findByText('Read the code before it runs')).toBeInTheDocument();
    expect(screen.getByText(code)).toBeInTheDocument();
    expect(api.getApproval).toHaveBeenCalledTimes(1);
    expect(api.getApproval).toHaveBeenCalledWith('p2');

    emit('step.started', { stepId: 's3', index: 2, capability: 'graph.write_artifact' });
    emit('node.written', { nodeId: 'n9', type: 'artifact' });
    emit('step.finished', { stepId: 's3', status: 'done' });
    expect(within(steps).getByText('Save to the map')).toBeInTheDocument();
    const highlights = screen.getByRole('region', { name: 'Findings and artifacts' });
    await user.click(within(highlights).getByRole('button', { name: 'Read' }));
    expect(api.getNode).toHaveBeenCalledWith('n9');
    expect(await within(highlights).findByText(/Put the 0\.80 m row back/)).toBeInTheDocument();
    await user.click(within(highlights).getByRole('button', { name: 'Hide' }));
    expect(within(highlights).queryByText(/Put the 0\.80 m row back/)).not.toBeInTheDocument();
  });

  it('reads the record again when a step finishes, so the plan shows without a reload', async () => {
    const getRun = vi.fn(async () => RUN);
    renderRun({ getRun });
    await screen.findByText('Summarise the sensor notes');
    expect(getRun).toHaveBeenCalledTimes(1);
    getRun.mockImplementation(async () => ({ ...RUN, steps: [{ id: 'p', index: 0, kind: 'plan', capability: null, status: 'done', output: { plan: '1. Read the notes' }, nodeIds: [] }] }));
    emit('step.started', { stepId: 'p', index: 0, capability: null });
    emit('step.finished', { stepId: 'p', status: 'done' });
    expect(await screen.findByText('1. Read the notes')).toBeInTheDocument();
    expect(getRun).toHaveBeenCalledTimes(2);
  });

  it('shows long instructions clamped, and all of them on request', async () => {
    const user = userEvent.setup();
    const long = `Recompute g from the data. ${'Then check every number. '.repeat(10)}`;
    renderRun({ getRun: vi.fn(async () => ({ ...RUN, instructions: long })) });
    const text = await screen.findByText(/Recompute g from the data/);
    expect(text).toHaveClass('is-clamped');
    await user.click(screen.getByRole('button', { name: 'Show all instructions' }));
    expect(text).not.toHaveClass('is-clamped');
    expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('labels the plan and the closing step of a run', async () => {
    renderRun({
      getRun: vi.fn(async () => ({
        ...RUN,
        status: 'succeeded',
        steps: [
          { id: 'a', index: 0, kind: 'plan', capability: null, status: 'done', output: { plan: '1. Do it' }, nodeIds: [] },
          { id: 'b', index: 1, kind: 'act', capability: null, status: 'done', output: { done: true, summary: 'All done' }, nodeIds: [] },
        ],
      })),
    });
    const steps = await screen.findByRole('list', { name: 'Steps' });
    expect(within(steps).getByText('Plan')).toBeInTheDocument();
    expect(within(steps).getByText('Wrap-up')).toBeInTheDocument();
  });

  it('shows an approval inline and approves it', async () => {
    const user = userEvent.setup();
    const { api } = renderRun();
    await screen.findByText('Summarise the sensor notes');
    emit('step.started', { stepId: 's2', index: 1, capability: 'edit_files' });
    emit('approval.requested', { approvalId: 'p1', capability: 'edit_files', summary: 'Edit README.md' });
    emit('run.paused', { reason: 'waiting_approval', approvalId: 'p1' });

    expect(runStatus()).toHaveTextContent('Waiting for approval');
    expect(screen.queryByText('Paused')).not.toBeInTheDocument();
    expect(screen.getAllByText('Waiting for approval').length).toBeGreaterThan(0);
    await user.click(screen.getByRole('button', { name: 'Approve: Edit README.md' }));
    expect(api.resolveApproval).toHaveBeenCalledWith('p1', 'approve');
    expect(await screen.findByText('Approved')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve: Edit README.md' })).not.toBeInTheDocument();

    // The runner's own sequence after a decision: resolved, requeued, resumed.
    emit('approval.resolved', { approvalId: 'p1', status: 'approved' });
    emit('run.queued', {});
    expect(runStatus()).toHaveTextContent('Queued');
    emit('run.resumed', { attempt: 1 });
    expect(runStatus()).toHaveTextContent('Running');
    const steps = screen.getByRole('list', { name: 'Steps' });
    expect(within(steps).queryByText('Waiting for approval')).not.toBeInTheDocument();
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

  it('does not show twice what arrived while the record was loading and is already in it', async () => {
    let answer;
    const getRun = vi.fn(() => new Promise((resolve) => (answer = resolve)));
    renderRun({ getRun });
    await waitFor(() => expect(getRun).toHaveBeenCalled());
    emit('step.started', { stepId: 's1', index: 0, capability: 'read_graph' });
    emit('step.output', { stepId: 's1', text: 'Reading 12 notes' });
    emit('step.verified', { stepId: 's1', verifier: 'result.schema', ok: true, detail: null });
    emit('node.written', { nodeId: 'n7', type: 'finding' });
    emit('cost', { tokens: 400, usd: 0.1, adapter: 'local' });
    emit('step.finished', { stepId: 's1', status: 'succeeded' });
    await act(async () =>
      answer({
        ...RUN,
        tokensUsed: 400,
        costUsd: 0.1,
        steps: [{ id: 's1', index: 0, capability: 'read_graph', status: 'succeeded', output: 'Reading 12 notes', verification: [{ verifier: 'result.schema', ok: true, detail: null }], nodeIds: ['n7'] }],
      })
    );
    const steps = await screen.findByRole('list', { name: 'Steps' });
    expect(within(steps).getAllByText('Reading 12 notes')).toHaveLength(1);
    expect(within(steps).getAllByText(/result.schema: passed/)).toHaveLength(1);
    expect(screen.getByLabelText('Tokens used')).toHaveAttribute('aria-valuetext', '400 of 1000');
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
