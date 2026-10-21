import { useCallback, useEffect, useId, useState } from 'react';
import CronField from './CronField.jsx';
import { useWorkspace } from './workspaceContext.js';
import { describeCron } from './cron.js';
import { defaultProjectFor } from './permissions.js';

// `project: null` means not chosen yet: the agent's own project is offered.
const EMPTY = { agentId: '', title: '', instructions: '', project: null, recurring: false, schedule: '0 9 * * *' };

function TaskForm({ agents, projects, onCreated }) {
  const { api } = useWorkspace();
  const [form, setForm] = useState(() => ({ ...EMPTY, agentId: agents[0]?.id ?? '' }));
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const id = useId();

  const set = (patch) => setForm((current) => ({ ...current, ...patch }));
  const agentId = form.agentId || agents[0]?.id || '';
  const project = form.project ?? defaultProjectFor(agents.find((agent) => agent.id === agentId), projects);

  async function submit(event, runAfter) {
    event.preventDefault();
    const problems = {};
    if (!agentId) problems.agentId = 'Choose an agent.';
    if (!form.title.trim()) problems.title = 'Give the task a title.';
    if (!form.instructions.trim()) problems.instructions = 'Say what the agent should do.';
    setErrors(problems);
    if (Object.keys(problems).length) return;
    setBusy(true);
    try {
      const task = await api.createTask({
        agentId,
        title: form.title.trim(),
        instructions: form.instructions,
        project: project || null,
        schedule: form.recurring ? form.schedule.trim() : null,
      });
      setForm({ ...EMPTY, agentId });
      onCreated(task, runAfter);
    } catch (failure) {
      const field = { invalid_schedule: 'schedule', invalid_title: 'title', invalid_instructions: 'instructions', invalid_agent: 'agentId', agent_not_found: 'agentId', invalid_project: 'project' }[failure.code] ?? 'form';
      setErrors({ [field]: failure.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="ws-form ws-task-form" onSubmit={(event) => submit(event, false)} noValidate aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`}>New task</h3>
      <div className="ws-row">
        <label className="ws-field">
          Agent
          <select value={agentId} onChange={(event) => set({ agentId: event.target.value })} aria-invalid={Boolean(errors.agentId)}>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        </label>
        <label className="ws-field">
          Project
          <select value={project} onChange={(event) => set({ project: event.target.value })}>
            <option value="">None</option>
            {projects.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
      </div>
      {errors.agentId && <p className="ws-error" role="alert">{errors.agentId}</p>}
      <label className="ws-field">
        Title
        <input value={form.title} onChange={(event) => set({ title: event.target.value })} aria-invalid={Boolean(errors.title)} />
      </label>
      {errors.title && <p className="ws-error" role="alert">{errors.title}</p>}
      <label className="ws-field">
        Instructions
        <textarea rows={3} value={form.instructions} onChange={(event) => set({ instructions: event.target.value })} aria-invalid={Boolean(errors.instructions)} />
      </label>
      {errors.instructions && <p className="ws-error" role="alert">{errors.instructions}</p>}
      <fieldset className="ws-radios is-row">
        <legend>When</legend>
        <label className="ws-check">
          <input type="radio" name={`${id}-when`} checked={!form.recurring} onChange={() => set({ recurring: false })} />
          Once, when I run it
        </label>
        <label className="ws-check">
          <input type="radio" name={`${id}-when`} checked={form.recurring} onChange={() => set({ recurring: true })} />
          On a schedule
        </label>
      </fieldset>
      {form.recurring && <CronField value={form.schedule} onChange={(schedule) => set({ schedule })} error={errors.schedule} />}
      {errors.form && <p className="ws-error" role="alert">{errors.form}</p>}
      <div className="ws-actions">
        <button type="submit" className="ws-btn is-primary" disabled={busy || agents.length === 0}>
          {busy ? 'Saving…' : 'Save task'}
        </button>
        {!form.recurring && (
          <button type="button" className="ws-btn" disabled={busy || agents.length === 0} onClick={(event) => submit(event, true)}>
            Save and run now
          </button>
        )}
      </div>
    </form>
  );
}

// Tasks and schedules: create one-off or recurring work for an agent, turn a
// schedule on or off, or run any task now.
export default function TasksPanel({ onRunStarted }) {
  const { api, agents, projects } = useWorkspace();
  const [tasks, setTasks] = useState([]);
  const [problem, setProblem] = useState(null);
  const [busy, setBusy] = useState(null);
  const projectNames = projects.map((entry) => (typeof entry === 'string' ? entry : entry.project));

  const load = useCallback(async () => {
    try {
      setTasks(await api.listTasks());
      setProblem(null);
    } catch (failure) {
      setProblem(failure.message);
    }
  }, [api]);

  useEffect(() => {
    // Synchronising with the server; every setState in load happens after an await.
    // oxlint-disable-next-line react/set-state-in-effect
    load();
  }, [load]);

  const replace = (task) => setTasks((current) => current.map((entry) => (entry.id === task.id ? task : entry)));

  async function act(task, label, call) {
    setBusy(`${task.id}:${label}`);
    setProblem(null);
    try {
      await call();
    } catch (failure) {
      setProblem(failure.message);
    } finally {
      setBusy(null);
    }
  }

  const runNow = (task) =>
    act(task, 'run', async () => {
      const run = await api.startRun({ taskId: task.id });
      onRunStarted?.(run);
    });

  const agentName = (agentId) => agents.find((agent) => agent.id === agentId)?.name ?? 'Unknown agent';

  return (
    <section className="ws-tasks" aria-labelledby="ws-tasks-title">
      <h2 id="ws-tasks-title">Tasks and schedules</h2>
      {problem && <p className="ws-error" role="alert">{problem}</p>}
      {tasks.length === 0 ? (
        <p className="ws-hint">No tasks yet.</p>
      ) : (
        <ul className="ws-list">
          {tasks.map((task) => (
            <li key={task.id} className="ws-task">
              <div className="ws-task-main">
                <span className="ws-task-title">{task.title}</span>
                <span className="ws-hint">
                  {agentName(task.agentId)}
                  {task.project ? ` · ${task.project}` : ''}
                  {' · '}
                  {task.schedule ? describeCron(task.schedule) ?? task.schedule : 'One-off'}
                  {task.schedule && task.enabled && task.nextRunAt ? ` · next ${new Date(task.nextRunAt).toLocaleString()}` : ''}
                </span>
              </div>
              <div className="ws-actions">
                {task.schedule && (
                  <label className="ws-check">
                    <input
                      type="checkbox"
                      checked={task.enabled}
                      disabled={busy !== null}
                      onChange={(event) =>
                        act(task, 'toggle', async () => replace(await api.updateTask(task.id, { enabled: event.target.checked })))
                      }
                    />
                    Enabled
                  </label>
                )}
                <button type="button" className="ws-btn" disabled={busy !== null} onClick={() => runNow(task)} aria-label={`Run ${task.title} now`}>
                  {busy === `${task.id}:run` ? 'Starting…' : 'Run now'}
                </button>
                <button
                  type="button"
                  className="ws-btn is-quiet"
                  disabled={busy !== null}
                  onClick={() =>
                    act(task, 'delete', async () => {
                      await api.deleteTask(task.id);
                      setTasks((current) => current.filter((entry) => entry.id !== task.id));
                    })
                  }
                  aria-label={`Delete ${task.title}`}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {agents.length > 0 ? (
        <TaskForm
          agents={agents}
          projects={projectNames}
          onCreated={(task, runAfter) => {
            setTasks((current) => [...current, task]);
            if (runAfter) runNow(task);
          }}
        />
      ) : (
        <p className="ws-hint">Create an agent to give it tasks.</p>
      )}
    </section>
  );
}
