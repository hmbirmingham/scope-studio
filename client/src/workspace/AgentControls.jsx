import { useState } from 'react';
import { useWorkspace } from './workspaceContext.js';

// Pause / resume and the kill switch for one agent. Killing stops every run
// and expires its approvals, so it takes a second, explicit press.
export default function AgentControls({ agent }) {
  const { api, replaceAgent } = useWorkspace();
  const [busy, setBusy] = useState(null);
  const [confirmKill, setConfirmKill] = useState(false);
  const [problem, setProblem] = useState(null);

  async function act(action, call) {
    setBusy(action);
    setProblem(null);
    try {
      replaceAgent(await call(agent.id));
      setConfirmKill(false);
    } catch (error) {
      setProblem(error.message);
    } finally {
      setBusy(null);
    }
  }

  const name = agent.name;
  return (
    <div className="ws-controls" role="group" aria-label={`${name} controls`}>
      {agent.state === 'active' && (
        <button type="button" className="ws-btn" disabled={Boolean(busy)} onClick={() => act('pause', api.pauseAgent)} aria-label={`Pause ${name}`}>
          {busy === 'pause' ? 'Pausing…' : 'Pause'}
        </button>
      )}
      {agent.state === 'paused' && (
        <button type="button" className="ws-btn" disabled={Boolean(busy)} onClick={() => act('resume', api.resumeAgent)} aria-label={`Resume ${name}`}>
          {busy === 'resume' ? 'Resuming…' : 'Resume'}
        </button>
      )}
      {agent.state === 'killed' ? (
        <button type="button" className="ws-btn" disabled={Boolean(busy)} onClick={() => act('reactivate', api.reactivateAgent)} aria-label={`Reactivate ${name}`}>
          {busy === 'reactivate' ? 'Reactivating…' : 'Reactivate'}
        </button>
      ) : confirmKill ? (
        <>
          <button type="button" className="ws-btn is-danger" disabled={Boolean(busy)} onClick={() => act('kill', api.killAgent)} aria-label={`Confirm: stop every run of ${name}`}>
            {busy === 'kill' ? 'Stopping…' : 'Stop every run'}
          </button>
          <button type="button" className="ws-btn is-quiet" disabled={Boolean(busy)} onClick={() => setConfirmKill(false)}>
            Keep running
          </button>
        </>
      ) : (
        <button type="button" className="ws-btn is-danger" disabled={Boolean(busy)} onClick={() => setConfirmKill(true)} aria-label={`Kill switch for ${name}`}>
          Kill
        </button>
      )}
      {problem && <span className="ws-error" role="alert">{problem}</span>}
    </div>
  );
}
