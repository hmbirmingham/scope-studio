import { useState } from 'react';
import AgentBuilder from './AgentBuilder.jsx';
import AgentControls from './AgentControls.jsx';
import AgentDot from './AgentDot.jsx';
import TasksPanel from './TasksPanel.jsx';
import { useWorkspace } from './workspaceContext.js';
import { LEVELS, MODEL_POLICIES } from './permissions.js';

const STATE_LABELS = { active: 'Active', paused: 'Paused', killed: 'Stopped' };

// The Agents tab: every agent with its controls, the builder, and the tasks
// that put agents to work.
export default function AgentsPanel() {
  const { agents, agentsError, openRun } = useWorkspace();
  // `null` closed, `'new'` for a new agent, else the agent being edited.
  const [editing, setEditing] = useState(null);

  return (
    <div className="ws-panel">
      <header className="ws-panel-head">
        <h2>Agents</h2>
        <button type="button" className="ws-btn is-primary" onClick={() => setEditing('new')}>
          New agent
        </button>
      </header>
      {agentsError && <p className="ws-error" role="alert">{agentsError}</p>}
      {agents.length === 0 ? (
        <p className="ws-hint">No agents yet. An agent works on your map with the permissions you give it, and asks before anything else.</p>
      ) : (
        <ul className="ws-list" aria-label="Your agents">
          {agents.map((agent) => (
            <li key={agent.id} className={`ws-agent is-${agent.state}`}>
              <div className="ws-agent-main">
                <AgentDot color={agent.color} />
                <div>
                  <span className="ws-agent-name">{agent.name}</span>
                  <span className="ws-hint">
                    {agent.role?.title} · {LEVELS.find((level) => level.id === agent.level)?.label ?? agent.level} ·{' '}
                    {MODEL_POLICIES.find((policy) => policy.id === agent.modelPolicy)?.label ?? agent.modelPolicy}
                  </span>
                </div>
                <span className={`ws-state is-${agent.state}`}>{STATE_LABELS[agent.state] ?? agent.state}</span>
              </div>
              <div className="ws-actions">
                <button type="button" className="ws-btn" onClick={() => setEditing(agent)} aria-label={`Edit ${agent.name}`}>
                  Edit
                </button>
                <AgentControls agent={agent} />
              </div>
            </li>
          ))}
        </ul>
      )}

      <TasksPanel onRunStarted={(run) => openRun(run.id)} />

      {editing && (
        <AgentBuilder
          agent={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => setEditing(null)}
        />
      )}
    </div>
  );
}
