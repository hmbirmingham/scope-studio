import Disclosure from './Disclosure';

const TIERS = [
  { value: null, label: 'Auto' },
  { value: 'local_7b', label: 'Local' },
  { value: 'cloud_frontier', label: 'Cloud' },
];

const WORKING = { reading: 'Reading your map', answering: 'Answering' };

function money(usd) {
  return usd >= 0.01 ? `$${usd.toFixed(2)}` : `${(usd * 100).toFixed(2)}¢`;
}

function sourceLabel(node) {
  return node.label ?? node.content?.split('\n')[0] ?? node.id;
}

function modelName(routing) {
  return routing?.model?.replace(/^(ollama|anthropic)\//, '') ?? null;
}

function SourceList({ nodes }) {
  return (
    <ol className="source-list">
      {nodes.map((node, index) => (
        <li key={node.id}>
          <span className="source-index">[{index + 1}]</span>
          <span className="source-label">{sourceLabel(node)}</span>
          {node.privacy === 'local' && <span className="source-flag">local only</span>}
        </li>
      ))}
    </ol>
  );
}

// Pages the answer cited, and while it works, what it is searching for.
function WebSources({ searches, web, omittedPrivate }) {
  const skipped =
    omittedPrivate > 0 ? (
      <span className="web-omitted" title="Private sources never leave this machine, so web answers leave them out.">
        Left out {omittedPrivate} private {omittedPrivate === 1 ? 'source' : 'sources'}
      </span>
    ) : null;
  if (!web?.length && !searches?.length) return skipped && <div className="web-sources">{skipped}</div>;
  return (
    <div className="web-sources">
      {skipped}
      {web?.length > 0
        ? web.map((page, i) => (
            <a key={page.url} href={page.url} target="_blank" rel="noreferrer noopener" title={page.url}>
              <span className="web-index">{i + 1}</span>
              {page.title}
            </a>
          ))
        : searches.map((query, i) => (
            <span key={i} className="web-searching">
              Searching “{query}”
            </span>
          ))}
    </div>
  );
}

function Sources({ nodes, metrics, routing }) {
  if (!nodes || nodes.length === 0) return null;
  const saved = metrics?.efficiencyRatio != null ? `${Math.round((1 - metrics.efficiencyRatio) * 100)}% fewer tokens` : null;
  const note = routing?.contextReused ? 'same context' : routing?.prefilled ? 'prefilled' : null;

  return (
    <Disclosure
      summary={`Read ${nodes.length} ${nodes.length === 1 ? 'source' : 'sources'}`}
      detail={[saved, note].filter(Boolean).join(' · ')}
    >
      <SourceList nodes={nodes} />
    </Disclosure>
  );
}

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

const EDIT_TONE = { proposed: 'pending', applied: 'good', failed: 'warn', unresolved: 'warn', unverified: 'warn' };

function EditRow({ edit, onDecide }) {
  const detail = {
    proposed: 'needs your approval',
    applied: 'pull request opened',
    rejected: 'discarded',
    failed: 'not applied',
    unresolved: 'no project',
    unverified: 'not verified',
  }[edit.state];

  return (
    <Disclosure
      summary={`Proposed an edit to ${edit.path}`}
      detail={detail}
      tone={EDIT_TONE[edit.state]}
      open={edit.state === 'proposed'}
    >
      <Diff search={edit.search} replace={edit.replace} />
      {edit.problem && <div className="row-note is-warn">{edit.problem}</div>}
      {edit.state === 'unverified' && (
        <div className="row-note is-warn">Not applied: {edit.note}. Ask again and say "copy the exact lines".</div>
      )}
      {edit.state === 'unresolved' && (
        <div className="row-note is-warn">That path is not in your map, so there is no repository to apply it to.</div>
      )}
      {edit.state === 'failed' && <div className="row-note is-warn">{edit.error}</div>}
      {edit.state === 'applied' && (
        <a className="row-note is-good" href={edit.appliedTo} target="_blank" rel="noreferrer">
          Opened a pull request →
        </a>
      )}
      {edit.state === 'proposed' && (
        <div className="row-actions">
          <button type="button" className="row-approve" onClick={() => onDecide(edit.id, 'approve')}>
            Approve — open a pull request
          </button>
          <button type="button" className="row-reject" onClick={() => onDecide(edit.id, 'reject')}>
            Discard
          </button>
        </div>
      )}
    </Disclosure>
  );
}

const RUN_TONE = { proposed: 'pending', succeeded: 'good', failed: 'warn', unbound: 'warn', undeclared: 'warn' };

function RunRow({ run, onDecide }) {
  const detail = {
    proposed: 'needs your approval',
    running: 'running…',
    succeeded: `exit 0 · ${(run.durationMs / 1000).toFixed(1)}s`,
    failed: `exit ${run.exitCode}`,
    rejected: 'discarded',
    unbound: 'no working copy',
    undeclared: 'not a script here',
  }[run.state];

  return (
    <Disclosure
      summary={run.command}
      detail={detail}
      tone={RUN_TONE[run.state]}
      open={run.state === 'proposed' || run.state === 'failed'}
    >
      {run.cwd && <div className="row-note">in {run.cwd}</div>}
      {run.problem && <div className="row-note is-warn">{run.problem}</div>}
      {run.state === 'unbound' && (
        <div className="row-note is-warn">
          This project has no working copy yet — open its settings from the sidebar (⋮) and point it
          at the folder.
        </div>
      )}
      {run.state === 'undeclared' && (
        <div className="row-note is-warn">
          This project does not declare that script.
          {run.available?.length > 0 && ` It has: ${run.available.join(', ')}.`}
        </div>
      )}
      {run.state === 'proposed' && (
        <div className="row-actions">
          <button type="button" className="row-approve" onClick={() => onDecide(run.id, 'approve')}>
            Approve — run it
          </button>
          <button type="button" className="row-reject" onClick={() => onDecide(run.id, 'reject')}>
            Discard
          </button>
        </div>
      )}
      {run.output && <pre className="run-output">{run.output}</pre>}
    </Disclosure>
  );
}

export default function ChatPanel({ project, chat, onNarrow, tier, onTierChange, webSearch, onWebSearchChange, hasKey }) {
  const { turns, edits, runs, draft, setDraft, send, status, error, preview, live, routing, metrics, ambiguity } = chat;
  const model = modelName(routing) ?? (tier === 'cloud_frontier' ? 'cloud' : 'local');
  const pendingEdits = edits.filter((edit) => !['applied', 'rejected'].includes(edit.state));
  const pendingRuns = runs.filter((run) => run.state !== 'rejected');

  function handleSubmit(event) {
    event.preventDefault();
    send();
  }

  return (
    <section className="chat">
      <div className="chat-log">
        {turns.length === 0 && !live && (
          <p className="chat-empty">Ask your map. Nothing is written or run without your approval.</p>
        )}

        {turns.map((turn, index) =>
          turn.role === 'user' ? (
            <div className="turn is-user" key={index}>
              <div className="bubble">{turn.text}</div>
            </div>
          ) : (
            <div className="turn is-assistant" key={index}>
              {turn.sources?.length > 0 && (
                <Sources nodes={turn.sources} metrics={turn.metrics} routing={turn.routing} />
              )}
              <div className={`answer ${turn.refused ? 'is-refused' : ''}`}>{turn.text}</div>
              <WebSources web={turn.web} omittedPrivate={turn.omittedPrivate} />
              {turn.metrics?.costUsd > 0 && (
                <div className="answer-meta">
                  {money(turn.metrics.costUsd)} · {turn.metrics.outputTokens} tokens
                </div>
              )}
            </div>
          )
        )}

        {live && (
          <div className="turn is-assistant">
            <Sources nodes={live.sources} metrics={live.metrics} routing={live.routing} />
            <WebSources searches={live.searches} omittedPrivate={live.omittedPrivate} />
            <div className="answer">
              {live.text}
              <span className="caret" />
            </div>
          </div>
        )}

        {/* Proposals live in the conversation, where they were made. */}
        {pendingRuns.map((run) => (
          <RunRow key={run.id} run={run} onDecide={chat.decideRun} />
        ))}
        {pendingEdits.map((edit) => (
          <EditRow key={edit.id} edit={edit} onDecide={chat.decideEdit} />
        ))}

        {status !== 'idle' && !live?.text && (
          <div className="working">
            <span className="working-dot" />
            {WORKING[status]}
            {preview?.nodes?.length > 0 && ` · ${preview.nodes.length} sources`}
          </div>
        )}
        {!live && preview?.nodes?.length > 0 && status === 'idle' && (
          <Sources nodes={preview.nodes} metrics={metrics} routing={routing} />
        )}
        {ambiguity && status === 'idle' && (
          <div className="narrow">
            <span>Narrow to</span>
            {ambiguity.map((entry) => (
              <button type="button" key={entry.project} onClick={() => onNarrow(entry.project)}>
                {entry.project.split('/').pop()}
              </button>
            ))}
          </div>
        )}
        {error && <div className="row-note is-warn">{error}</div>}
      </div>

      <form className="composer" onSubmit={handleSubmit}>
        <textarea
          rows={1}
          value={draft}
          // Grows with what is written, like a composer rather than a field.
          ref={(node) => {
            if (!node) return;
            node.style.height = 'auto';
            node.style.height = `${Math.min(node.scrollHeight, 200)}px`;
          }}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) handleSubmit(event);
          }}
          placeholder={project ? `Ask about ${project.split('/').pop()}` : 'Ask your map'}
        />
        <div className="composer-bar">
          <div className="tiers">
            {TIERS.map((option) => (
              <button
                type="button"
                key={option.label}
                className={`tier ${tier === option.value ? 'is-on' : ''}`}
                onClick={() => onTierChange(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className={`tier web-toggle ${webSearch ? 'is-on' : ''}`}
            aria-pressed={webSearch}
            title="Search the web for this answer. Runs on the cloud tier with your key; sources marked private are left out."
            onClick={() => onWebSearchChange(!webSearch)}
          >
            Web
          </button>
          <span className="composer-model">{model}</span>
          {!hasKey && (tier === 'cloud_frontier' || webSearch) && <span className="composer-hint">needs your key</span>}
          <button type="submit" className="composer-send" aria-label="Send" disabled={status !== 'idle'}>
            ⏎
          </button>
        </div>
      </form>
    </section>
  );
}
