import { useCallback, useEffect, useId, useRef, useState } from 'react';
import AgentDot from './AgentDot.jsx';
import RunView from './RunView.jsx';
import { defaultProjectFor } from './permissions.js';
import { runStatusForEvent } from './runState.js';
import { useWorkspace, useWorkspaceEvents } from './workspaceContext.js';

const CONNECTION_WORDS = { open: 'Live', connecting: 'Connecting…', reconnecting: 'Reconnecting…', idle: 'Offline', unavailable: 'Live updates unavailable' };

function NewRunForm({ onStarted }) {
  const { api, agents, projects } = useWorkspace();
  const [agentId, setAgentId] = useState('');
  const [instructions, setInstructions] = useState('');
  // `null` until the user picks one: then the agent's own project is offered.
  const [project, setProject] = useState(null);
  const [problem, setProblem] = useState(null);
  const [busy, setBusy] = useState(false);
  const id = useId();
  const chosen = agentId || agents.find((agent) => agent.state === 'active')?.id || agents[0]?.id || '';
  const projectNames = projects.map((entry) => (typeof entry === 'string' ? entry : entry.project));
  const chosenProject = project ?? defaultProjectFor(agents.find((agent) => agent.id === chosen), projectNames);

  async function submit(event) {
    event.preventDefault();
    if (!chosen) return setProblem('Create an agent first.');
    if (!instructions.trim()) return setProblem('Say what the agent should do.');
    setBusy(true);
    setProblem(null);
    try {
      const run = await api.startRun({ agentId: chosen, instructions: instructions.trim(), ...(chosenProject ? { project: chosenProject } : {}) });
      setInstructions('');
      onStarted(run);
    } catch (failure) {
      setProblem(failure.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="ws-form ws-new-run" onSubmit={submit} noValidate aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`}>Start a run</h3>
      <div className="ws-row">
        <label className="ws-field">
          Agent
          <select value={chosen} onChange={(event) => setAgentId(event.target.value)}>
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id} disabled={agent.state !== 'active'}>
                {agent.name}
                {agent.state !== 'active' ? ` (${agent.state})` : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="ws-field">
          Project
          <select value={chosenProject} onChange={(event) => setProject(event.target.value)}>
            <option value="">None</option>
            {projectNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="ws-field">
        What should it do?
        <textarea rows={2} value={instructions} onChange={(event) => setInstructions(event.target.value)} />
      </label>
      {problem && <p className="ws-error" role="alert">{problem}</p>}
      <button type="submit" className="ws-btn is-primary" disabled={busy || agents.length === 0}>
        {busy ? 'Starting…' : 'Start run'}
      </button>
    </form>
  );
}

// The Activity tab: recent runs, a form to start one, and the selected run's
// live step stream.
export default function ActivityPanel() {
  const { api, agents, connection, selectedRunId, selectRun } = useWorkspace();
  const [runs, setRuns] = useState([]);
  const [problem, setProblem] = useState(null);

  const load = useCallback(async () => {
    try {
      setRuns(await api.listRuns());
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

  const known = useRef(new Set());
  useEffect(() => {
    known.current = new Set(runs.map((run) => run.id));
  }, [runs]);

  useWorkspaceEvents(
    (event) => {
      if (!event.type.startsWith('run.')) return;
      if (!known.current.has(event.runId)) {
        // A run started elsewhere (a schedule, another tab): fetch the list.
        load();
        return;
      }
      const status = runStatusForEvent(event);
      if (!status) return;
      setRuns((current) => current.map((run) => (run.id === event.runId ? { ...run, status } : run)));
    },
    { onResync: load }
  );

  const agentFor = (agentId) => agents.find((agent) => agent.id === agentId);
  const sorted = [...runs].sort((a, b) => (b.queuedAt ?? '').localeCompare(a.queuedAt ?? ''));

  return (
    <div className="ws-panel ws-activity">
      <header className="ws-panel-head">
        <h2>Activity</h2>
        <span className={`ws-connection is-${connection}`} role="status">
          {CONNECTION_WORDS[connection] ?? connection}
        </span>
      </header>
      <div className="ws-activity-body">
        <aside className="ws-runs" aria-label="Runs">
          <NewRunForm
            onStarted={(run) => {
              setRuns((current) => [run, ...current.filter((entry) => entry.id !== run.id)]);
              selectRun(run.id);
            }}
          />
          {problem && <p className="ws-error" role="alert">{problem}</p>}
          {sorted.length === 0 ? (
            <p className="ws-hint">No runs yet.</p>
          ) : (
            <ul className="ws-list ws-run-list">
              {sorted.map((run) => {
                const agent = agentFor(run.agentId);
                return (
                  <li key={run.id}>
                    <button type="button" className={`ws-run-item ${run.id === selectedRunId ? 'is-selected' : ''}`} aria-current={run.id === selectedRunId ? 'true' : undefined} onClick={() => selectRun(run.id)}>
                      <AgentDot color={agent?.color} />
                      <span className="ws-run-item-text">
                        <span className="ws-run-item-title">{run.instructions || 'Run'}</span>
                        <span className="ws-hint">
                          {agent?.name ?? 'Agent'} · <span className={`ws-status is-${run.status}`}>{run.status.replaceAll('_', ' ')}</span>
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </aside>
        <section className="ws-run-detail" aria-label="Selected run">
          {selectedRunId ? <RunView key={selectedRunId} runId={selectedRunId} /> : <p className="ws-hint">Choose a run to follow it live.</p>}
        </section>
      </div>
    </div>
  );
}
