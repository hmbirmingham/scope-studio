import { useEffect, useState } from 'react';
import { useWorkspace } from './workspaceContext.js';
import { CAPABILITIES, DECISION_LABELS, OVERRIDE_CHOICES, expectedDecision, reasonText } from './permissions.js';

// One row per capability: what the level and override make of it, what the
// server's can() actually answers for the saved agent in a chosen situation,
// and the override control. The server's answer includes the hard denials
// (scope, sandbox, offline, private context) that no setting can lift.
export default function CapabilityGrid({ agent, level, overrides, onOverride, dirty, projects, error }) {
  const { api } = useWorkspace();
  const [context, setContext] = useState(() => ({
    project: agent?.scopes?.write?.projects?.find((project) => project !== '*') ?? projects[0] ?? '',
    inSandbox: true,
    online: true,
    privateContext: false,
  }));
  const [decisions, setDecisions] = useState({});
  const [loadError, setLoadError] = useState(null);

  const agentId = agent?.id ?? null;
  const version = agent?.updatedAt ?? null;
  const state = agent?.state ?? null;
  useEffect(() => {
    if (!agentId) return undefined;
    let cancelled = false;
    const query = { project: context.project || undefined, inSandbox: context.inSandbox, online: context.online, privateContext: context.privateContext };
    Promise.all(CAPABILITIES.map((capability) => api.can(agentId, capability.id, query).then((answer) => [capability.id, answer])))
      .then((entries) => {
        if (cancelled) return;
        setDecisions(Object.fromEntries(entries));
        setLoadError(null);
      })
      .catch((failure) => {
        if (!cancelled) setLoadError(failure.message);
      });
    return () => {
      cancelled = true;
    };
  }, [api, agentId, version, state, context]);

  const situation = (
    <fieldset className="ws-situation">
      <legend>Check against</legend>
      <label>
        Project
        <select value={context.project} onChange={(event) => setContext({ ...context, project: event.target.value })}>
          <option value="">No project</option>
          {projects.map((project) => (
            <option key={project} value={project}>
              {project}
            </option>
          ))}
        </select>
      </label>
      {[
        ['inSandbox', 'In a sandbox'],
        ['online', 'Online'],
        ['privateContext', 'Holds private nodes'],
      ].map(([key, label]) => (
        <label key={key} className="ws-check">
          <input type="checkbox" checked={context[key]} onChange={(event) => setContext({ ...context, [key]: event.target.checked })} />
          {label}
        </label>
      ))}
    </fieldset>
  );

  return (
    <div className="ws-grid-wrap">
      {agentId ? situation : <p className="ws-hint">Save the agent to see what the server decides in each situation.</p>}
      {agentId && dirty && <p className="ws-hint">Decisions reflect the saved agent; save to check your changes.</p>}
      {loadError && <p className="ws-error" role="alert">Could not check permissions: {loadError}</p>}
      <table className="ws-grid" aria-describedby={error ? 'agent-error-overrides' : undefined}>
        <caption className="ws-visually-hidden">Capabilities and decisions</caption>
        <thead>
          <tr>
            <th scope="col">Capability</th>
            <th scope="col">By setting</th>
            {agentId && <th scope="col">Effective now</th>}
            <th scope="col">Override</th>
          </tr>
        </thead>
        <tbody>
          {CAPABILITIES.map((capability) => {
            const expected = expectedDecision(level, overrides, capability.id);
            const effective = decisions[capability.id];
            const override = overrides[capability.id] ?? 'inherit';
            return (
              <tr key={capability.id} data-capability={capability.id}>
                <th scope="row">
                  <span className="ws-cap-name">{capability.label}</span>
                  <span className="ws-cap-blurb">{capability.blurb}</span>
                </th>
                <td>
                  <span className={`ws-decision is-${expected.decision}`}>{DECISION_LABELS[expected.decision]}</span>
                  {expected.note && expected.note !== 'override' && <span className="ws-cap-note"> ({expected.note})</span>}
                </td>
                {agentId && (
                  <td data-testid={`effective-${capability.id}`}>
                    {effective ? (
                      <>
                        <span className={`ws-decision is-${effective.decision}`}>{DECISION_LABELS[effective.decision] ?? effective.decision}</span>
                        <span className="ws-cap-note"> {reasonText(effective.reason)}</span>
                      </>
                    ) : (
                      <span className="ws-cap-note">…</span>
                    )}
                  </td>
                )}
                <td>
                  <select
                    aria-label={`Override for ${capability.label}`}
                    value={override}
                    onChange={(event) => onOverride(capability.id, event.target.value)}
                  >
                    {OVERRIDE_CHOICES.map((choice) => (
                      <option key={choice.id} value={choice.id}>
                        {choice.label}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {error && (
        <p className="ws-error" id="agent-error-overrides" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
