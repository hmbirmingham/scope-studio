import KnowledgeGraphCanvas from './KnowledgeGraphCanvas';

function Diff({ search, replace }) {
  return (
    <pre className="diff">
      {search.split('\n').map((line, index) => (
        <div className="diff-line is-removed" key={`r${index}`}>
          <span className="diff-sign">-</span>
          {line}
        </div>
      ))}
      {replace.split('\n').map((line, index) => (
        <div className="diff-line is-added" key={`a${index}`}>
          <span className="diff-sign">+</span>
          {line}
        </div>
      ))}
    </pre>
  );
}

function EditCard({ edit, onDecide }) {
  return (
    <article className={`edit-card is-${edit.state}`}>
      <header className="edit-head">
        <span className="edit-path">{edit.path}</span>
        <span className="edit-project">{edit.project ?? 'unknown project'}</span>
      </header>
      <Diff search={edit.search} replace={edit.replace} />

      {edit.problem && <div className="edit-note is-warn">{edit.problem}</div>}
      {edit.state === 'proposed' && (
        <div className="edit-actions">
          <button type="button" className="edit-approve" onClick={() => onDecide(edit.id, 'approve')}>
            Approve — open a pull request
          </button>
          <button type="button" className="edit-reject" onClick={() => onDecide(edit.id, 'reject')}>
            Discard
          </button>
        </div>
      )}
      {edit.state === 'unverified' && (
        <div className="edit-note is-warn">
          Not applied: {edit.note}. Ask again and say "copy the exact lines".
        </div>
      )}
      {edit.state === 'unresolved' && (
        <div className="edit-note is-warn">
          This path is not in your map, so there is no repository to apply it to.
        </div>
      )}
      {edit.state === 'applied' && (
        <a className="edit-note is-good" href={edit.appliedTo} target="_blank" rel="noreferrer">
          Opened a pull request →
        </a>
      )}
      {edit.state === 'rejected' && <div className="edit-note">Discarded.</div>}
      {edit.state === 'failed' && <div className="edit-note is-warn">{edit.error}</div>}
    </article>
  );
}

function RunCard({ run, onDecide }) {
  return (
    <article className={`edit-card is-${run.state}`}>
      <header className="edit-head">
        <span className="edit-path">{run.command}</span>
        <span className="edit-project">{run.project ?? ''}</span>
      </header>
      {run.cwd && <div className="run-cwd">in {run.cwd}</div>}

      {run.problem && <div className="edit-note is-warn">{run.problem}</div>}
      {run.state === 'proposed' && (
        <div className="edit-actions">
          <button type="button" className="edit-approve" onClick={() => onDecide(run.id, 'approve')}>
            Approve — run it
          </button>
          <button type="button" className="edit-reject" onClick={() => onDecide(run.id, 'reject')}>
            Discard
          </button>
        </div>
      )}
      {run.state === 'running' && <div className="edit-note">Running…</div>}
      {run.state === 'unbound' && (
        <div className="edit-note is-warn">
          This project has no working copy on this machine yet — open its settings from the sidebar
          (⋮) and point it at the folder.
        </div>
      )}
      {run.state === 'undeclared' && (
        <div className="edit-note is-warn">
          This project does not declare that script.
          {run.available?.length > 0 && ` It has: ${run.available.join(', ')}.`}
        </div>
      )}
      {run.state === 'rejected' && <div className="edit-note">Discarded.</div>}
      {(run.state === 'succeeded' || run.state === 'failed') && (
        <>
          <div className={`edit-note ${run.state === 'failed' ? 'is-warn' : 'is-good'}`}>
            exit {run.exitCode} · {(run.durationMs / 1000).toFixed(1)}s
          </div>
          <pre className="run-output">{run.output || '(no output)'}</pre>
        </>
      )}
    </article>
  );
}

function Sources({ nodes }) {
  if (!nodes || nodes.length === 0) {
    return <p className="panel-empty">Ask something — the sources it reads appear here.</p>;
  }
  return (
    <ol className="panel-sources">
      {nodes.map((node, index) => (
        <li key={node.id}>
          <span className="context-index">[{index + 1}]</span>
          <span className="panel-source-label">{node.label ?? node.content?.split('\n')[0] ?? node.id}</span>
          <span className="panel-source-meta">
            {node.project}
            {node.privacy === 'local' && ' · local only'}
          </span>
        </li>
      ))}
    </ol>
  );
}

// The map, the sources and the proposed edits are outputs, not the workspace:
// they live in tabs beside the conversation and can be closed away entirely.
export default function OutputPanel({
  open,
  tab,
  onTab,
  onClose,
  canvasRef,
  graph,
  activeIds,
  traversedKeys,
  preferences,
  onSelectNode,
  spotlight,
  edits,
  runs,
  onDecideEdit,
  onDecideRun,
}) {
  if (!open) return null;
  const pending =
    edits.filter((edit) => edit.state === 'proposed').length +
    runs.filter((run) => run.state === 'proposed').length;

  const TABS = [
    { key: 'map', label: 'Map' },
    { key: 'sources', label: 'Sources' },
    { key: 'edits', label: pending > 0 ? `Actions · ${pending}` : 'Actions' },
  ];

  return (
    <aside className="output-panel">
      <header className="panel-tabs">
        {TABS.map((entry) => (
          <button
            type="button"
            key={entry.key}
            className={`panel-tab ${tab === entry.key ? 'is-on' : ''}`}
            onClick={() => onTab(entry.key)}
          >
            {entry.label}
          </button>
        ))}
        <button type="button" className="panel-close" onClick={onClose} aria-label="Close panel">
          ✕
        </button>
      </header>

      {/* The canvas stays mounted so the layout keeps its positions when you
          switch tabs; only its visibility changes. */}
      <div className={`panel-body is-map ${tab === 'map' ? '' : 'is-hidden'}`}>
        <KnowledgeGraphCanvas
          ref={canvasRef}
          nodes={graph.nodes}
          edges={graph.edges}
          activeIds={activeIds}
          traversedKeys={traversedKeys}
          preferences={preferences}
          onSelectNode={onSelectNode}
        />
      </div>

      {tab === 'sources' && (
        <div className="panel-body">
          <Sources nodes={spotlight} />
        </div>
      )}

      {tab === 'edits' && (
        <div className="panel-body">
          {edits.length === 0 && runs.length === 0 ? (
            <p className="panel-empty">
              Ask for a change — "add a docstring to quantify_colonies" — or ask it to run the tests.
              The diff or the command lands here for your approval. Nothing is written or run until
              you approve it.
            </p>
          ) : (
            <>
              {runs.map((run) => (
                <RunCard key={run.id} run={run} onDecide={onDecideRun} />
              ))}
              {edits.map((edit) => (
                <EditCard key={edit.id} edit={edit} onDecide={onDecideEdit} />
              ))}
            </>
          )}
        </div>
      )}
    </aside>
  );
}
