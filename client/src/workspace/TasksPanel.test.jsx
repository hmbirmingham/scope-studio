import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import CronField from './CronField.jsx';
import TasksPanel from './TasksPanel.jsx';
import { ApiError } from './api.js';
import { AGENT, fakeApi, renderWithWorkspace } from '../test/workspace.jsx';

const NOW = new Date(Date.UTC(2026, 9, 21, 8, 30));

describe('CronField', () => {
  function Harness({ initial = '0 9 * * *', error }) {
    const [value, setValue] = [initial, vi.fn()];
    return <CronField value={value} onChange={setValue} error={error} now={NOW} />;
  }

  it('previews a preset in words with the next runs', () => {
    render(<Harness />);
    expect(screen.getByLabelText('Repeat')).toHaveValue('daily');
    expect(screen.getByText('Every day at 09:00 UTC')).toBeInTheDocument();
    expect(screen.getByText(/^Next: /).textContent.split(' · ')).toHaveLength(3);
  });

  it('marks a bad expression invalid and says why', () => {
    render(<Harness initial="0 25 * * *" />);
    expect(screen.getByLabelText('Repeat')).toHaveValue('custom');
    expect(screen.getByLabelText('Cron expression')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('invalid hour "25"')).toBeInTheDocument();
  });

  it('shows the server’s error over its own preview', () => {
    render(<Harness error="a schedule must be a string" />);
    expect(screen.getByText('a schedule must be a string')).toBeInTheDocument();
  });

  it('applies a preset', () => {
    const onChange = vi.fn();
    render(<CronField value="0 9 * * *" onChange={onChange} now={NOW} />);
    fireEvent.change(screen.getByLabelText('Repeat'), { target: { value: 'weekdays' } });
    expect(onChange).toHaveBeenCalledWith('0 9 * * 1-5');
  });
});

describe('TasksPanel', () => {
  const TASK = { id: 't1', agentId: AGENT.id, title: 'Nightly sweep', instructions: 'Sweep', project: 'alpha', schedule: '0 2 * * *', nextRunAt: '2026-10-22T02:00:00.000Z', enabled: true };

  it('creates a recurring task with the chosen schedule', async () => {
    const user = userEvent.setup();
    const api = fakeApi({ listAgents: vi.fn(async () => [AGENT]) });
    renderWithWorkspace(<TasksPanel />, { api });
    const form = await screen.findByRole('form', { name: 'New task' });
    await user.type(within(form).getByLabelText('Title'), 'Weekly digest');
    await user.type(within(form).getByLabelText('Instructions'), 'Summarise new findings');
    await user.selectOptions(within(form).getByLabelText('Project'), 'beta');
    await user.click(within(form).getByLabelText('On a schedule'));
    await user.selectOptions(within(form).getByLabelText('Repeat'), 'weekly');
    expect(within(form).getByText('At 09:00 UTC on Monday')).toBeInTheDocument();
    await user.click(within(form).getByRole('button', { name: 'Save task' }));
    await waitFor(() => expect(api.createTask).toHaveBeenCalled());
    expect(api.createTask.mock.calls[0][0]).toEqual({ agentId: AGENT.id, title: 'Weekly digest', instructions: 'Summarise new findings', project: 'beta', schedule: '0 9 * * 1' });
    expect(await screen.findByText('Weekly digest')).toBeInTheDocument();
  });

  it('creates a one-off task and runs it now', async () => {
    const user = userEvent.setup();
    const onRunStarted = vi.fn();
    const api = fakeApi({ listAgents: vi.fn(async () => [AGENT]), startRun: vi.fn(async (body) => ({ id: 'run-9', ...body })) });
    renderWithWorkspace(<TasksPanel onRunStarted={onRunStarted} />, { api });
    const form = await screen.findByRole('form', { name: 'New task' });
    await user.type(within(form).getByLabelText('Title'), 'Check build');
    await user.type(within(form).getByLabelText('Instructions'), 'Run the tests');
    await user.click(within(form).getByRole('button', { name: 'Save and run now' }));
    await waitFor(() => expect(onRunStarted).toHaveBeenCalledWith(expect.objectContaining({ id: 'run-9' })));
    expect(api.createTask.mock.calls[0][0].schedule).toBeNull();
    expect(api.startRun).toHaveBeenCalledWith({ taskId: 'task-1' });
  });

  it('surfaces missing fields and a server cron rejection', async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      listAgents: vi.fn(async () => [AGENT]),
      createTask: vi.fn(async () => {
        throw new ApiError(400, 'invalid_schedule', 'this schedule never matches a date');
      }),
    });
    renderWithWorkspace(<TasksPanel />, { api });
    const form = await screen.findByRole('form', { name: 'New task' });
    await user.click(within(form).getByRole('button', { name: 'Save task' }));
    expect(within(form).getByText('Give the task a title.')).toBeInTheDocument();
    expect(within(form).getByText('Say what the agent should do.')).toBeInTheDocument();
    expect(api.createTask).not.toHaveBeenCalled();

    await user.type(within(form).getByLabelText('Title'), 'T');
    await user.type(within(form).getByLabelText('Instructions'), 'I');
    await user.click(within(form).getByLabelText('On a schedule'));
    await user.click(within(form).getByRole('button', { name: 'Save task' }));
    expect(await within(form).findByText('this schedule never matches a date')).toBeInTheDocument();
  });

  it('enables, disables, runs and deletes existing tasks', async () => {
    const user = userEvent.setup();
    const onRunStarted = vi.fn();
    const api = fakeApi({
      listAgents: vi.fn(async () => [AGENT]),
      listTasks: vi.fn(async () => [TASK]),
      updateTask: vi.fn(async (id, body) => ({ ...TASK, ...body })),
      startRun: vi.fn(async () => ({ id: 'run-3' })),
    });
    renderWithWorkspace(<TasksPanel onRunStarted={onRunStarted} />, { api });
    expect(await screen.findByText('Nightly sweep')).toBeInTheDocument();
    expect(screen.getByText(/Every day at 02:00 UTC/)).toBeInTheDocument();

    await user.click(screen.getByLabelText('Enabled'));
    expect(api.updateTask).toHaveBeenCalledWith('t1', { enabled: false });
    await waitFor(() => expect(screen.getByLabelText('Enabled')).not.toBeChecked());

    await user.click(screen.getByRole('button', { name: 'Run Nightly sweep now' }));
    expect(api.startRun).toHaveBeenCalledWith({ taskId: 't1' });
    await waitFor(() => expect(onRunStarted).toHaveBeenCalledWith({ id: 'run-3' }));

    await user.click(screen.getByRole('button', { name: 'Delete Nightly sweep' }));
    await waitFor(() => expect(screen.queryByText('Nightly sweep')).not.toBeInTheDocument());
  });
});
