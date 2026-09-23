import { useEffect, useState } from 'react';
import { useIngest } from '../hooks/useIngest';

function Progress({ job }) {
  if (!job) return null;
  const { progress, state, summary, error } = job;
  if (state === 'failed') return <div className="sources-error">{error}</div>;
  if (state === 'done') {
    return (
      <div className="sources-done">
        Added {summary.chunks} chunks from {summary.files} files across {summary.repos}{' '}
        {summary.repos === 1 ? 'repository' : 'repositories'}
        {summary.pruned > 0 && `, pruned ${summary.pruned}`}.
      </div>
    );
  }
  const done = progress.reposDone ?? 0;
  const total = progress.reposTotal ?? 0;
  return (
    <div className="sources-progress">
      <div className="sources-bar">
        <span style={{ width: total ? `${(done / total) * 100}%` : '10%' }} />
      </div>
      <div className="sources-progress-text">
        {progress.repo ? `Reading ${progress.repo}` : 'Listing repositories'}
        {total > 0 && ` · ${done}/${total}`}
        {progress.chunks > 0 && ` · ${progress.chunks} chunks`}
      </div>
    </div>
  );
}

function CloudKey({ apiKey, onApiKeyChange }) {
  return (
    <div className="inspector-block">
      <div className="inspector-block-title">Cloud model</div>
      <p className="key-note">
        Your own Anthropic key. It is kept for this session only — sent with each cloud
        request, never written to disk and never stored on the server.
      </p>
      <input
        className="key-input"
        type="password"
        autoComplete="off"
        spellCheck="false"
        placeholder="sk-ant-..."
        value={apiKey}
        onChange={(event) => onApiKeyChange(event.target.value)}
      />
      {apiKey && (
        <button type="button" className="key-clear" onClick={() => onApiKeyChange('')}>
          Forget key
        </button>
      )}
    </div>
  );
}

export default function SourcesOverlay({ open, onClose, onIngested, apiKey, onApiKeyChange }) {
  const { connected, repos, job, error, loadRepos, ingest } = useIngest(onIngested);
  const [selected, setSelected] = useState(() => new Set());

  useEffect(() => {
    if (open) loadRepos();
  }, [open, loadRepos]);

  if (!open) return null;
  const running = job?.state === 'running';

  function toggle(fullName) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(fullName)) next.delete(fullName);
      else next.add(fullName);
      return next;
    });
  }

  return (
    <div className="inspector-backdrop" onClick={onClose}>
      <section className="inspector sources" onClick={(event) => event.stopPropagation()}>
        <button type="button" className="inspector-close" onClick={onClose} aria-label="Close">
          ✕
        </button>
        <div className="inspector-head">
          <div className="inspector-type">sources</div>
          <div className="inspector-title">GitHub</div>
          <div className="inspector-sub">Private repositories stay on this machine.</div>
        </div>

        <CloudKey apiKey={apiKey} onApiKeyChange={onApiKeyChange} />

        {connected === false && (
          <div className="inspector-block">
            <a className="sources-connect" href="/api/plugins/github/authorize">
              Connect GitHub
            </a>
          </div>
        )}

        {error && <div className="sources-error">{error}</div>}

        {connected && (
          <div className="inspector-block">
            <div className="inspector-block-title">
              Repositories ({repos.length})
              <button
                type="button"
                className="sources-action"
                disabled={running || selected.size === 0}
                onClick={() => ingest([...selected])}
              >
                {running ? 'Ingesting…' : `Ingest ${selected.size || ''}`.trim()}
              </button>
            </div>
            <Progress job={job} />
            <div className="sources-list">
              {repos.map((repo) => (
                <label key={repo.id} className={`sources-row ${repo.ingested ? 'is-ingested' : ''}`}>
                  <input
                    type="checkbox"
                    checked={selected.has(repo.fullName)}
                    onChange={() => toggle(repo.fullName)}
                    disabled={running}
                  />
                  <span className="sources-name">{repo.fullName}</span>
                  {repo.privacy === 'local' && <span className="sources-flag">local only</span>}
                  {repo.ingested && <span className="sources-count">{repo.nodes} nodes</span>}
                </label>
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
