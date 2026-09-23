const STATUS_LABEL = {
  idle: 'ready',
  reading: 'reading your map',
  answering: 'answering',
};

function percent(ratio) {
  return `${Math.round((1 - ratio) * 100)}%`;
}

// The map payload carries a label; the chat payload carries the node itself,
// whose first line is that same label.
function sourceLabel(node) {
  return node.label ?? node.content?.split('\n')[0] ?? node.id;
}

function modelName(routing) {
  return routing?.model?.replace('ollama/', '') ?? 'local';
}

// The wait is the work: while the model prefills, the panel names the sources
// it is reading and what they cost, instead of showing a spinner.
const TIERS = [
  { value: null, label: 'Auto' },
  { value: 'local_7b', label: 'Local' },
  { value: 'cloud_frontier', label: 'Cloud' },
];

function money(usd) {
  return usd >= 0.01 ? `$${usd.toFixed(2)}` : `${(usd * 100).toFixed(2)}¢`;
}

function ContextStrip({ nodes, metrics, routing, ambiguity, onNarrow }) {
  if (!nodes || nodes.length === 0) return null;
  return (
    <div className="context-strip">
      <div className="context-head">
        <span>Reading {nodes.length} {nodes.length === 1 ? 'source' : 'sources'}</span>
        {metrics?.efficiencyRatio != null && (
          <span className="context-saving">{percent(metrics.efficiencyRatio)} fewer tokens</span>
        )}
      </div>
      <ol className="context-list">
        {nodes.map((node, index) => (
          <li key={node.id} className={node.privacy === 'local' ? 'is-local' : ''}>
            <span className="context-index">[{index + 1}]</span>
            <span className="context-label">{sourceLabel(node)}</span>
            {node.privacy === 'local' && <span className="context-flag">local only</span>}
          </li>
        ))}
      </ol>
      {routing?.decision === 'cloud' && (
        <div className="context-note">Answering in the cloud on your key · {routing.model?.replace('anthropic/', '')}</div>
      )}
      {routing?.contextReused && <div className="context-note">Continuing on the same context</div>}
      {routing?.prefilled && <div className="context-note">Already prefilled</div>}
      {ambiguity && (
        <div className="context-chips">
          <span className="context-chips-label">Narrow to</span>
          {ambiguity.map((entry) => (
            <button type="button" key={entry.project} onClick={() => onNarrow(entry.project)}>
              {entry.project.split('/').pop()}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Sources({ sources }) {
  if (!sources || sources.length === 0) return null;
  return (
    <ol className="answer-sources">
      {sources.map((node, index) => (
        <li key={node.id}>
          <span className="context-index">[{index + 1}]</span> {sourceLabel(node)}
        </li>
      ))}
    </ol>
  );
}

export default function ChatPanel({ project, chat, onNarrow, tier, onTierChange, hasKey, panelOpen, onOpenPanel }) {
  const { turns, draft, setDraft, send, status, error, preview, live, routing, metrics, ambiguity } = chat;
  const model = modelName(routing);

  function handleSubmit(event) {
    event.preventDefault();
    send();
  }

  return (
    <aside className="chat-panel">
      <header className="chat-head">
        <span className="chat-title">{project ?? 'All maps'}</span>
        <span className="chat-model">
          <span className={`model-dot ${status === 'idle' ? '' : 'is-busy'}`} />
          {status === 'idle' ? model : STATUS_LABEL[status]}
        </span>
      </header>

      <div className="tier-row">
        {TIERS.map((option) => (
          <button
            type="button"
            key={option.label}
            className={`tier-btn ${tier === option.value ? 'is-on' : ''}`}
            onClick={() => onTierChange(option.value)}
            title={option.value === 'cloud_frontier' && !hasKey ? 'Add your API key in Sources first' : undefined}
          >
            {option.label}
          </button>
        ))}
        {!hasKey && <span className="tier-hint">cloud needs your key</span>}
        {!panelOpen && (
          <button type="button" className="tier-btn panel-reopen" onClick={onOpenPanel}>
            Show map
          </button>
        )}
      </div>

      <div className="chat-log">
        {turns.length === 0 && !live && <p className="chat-empty">Ask your map.</p>}
        {turns.map((turn, index) => (
          <div className={`chat-message is-${turn.role}`} key={index}>
            <div className="chat-who">{turn.role === 'user' ? 'Hynes' : modelName(turn.routing)}</div>
            <div className={`chat-body ${turn.refused ? 'is-refused' : ''}`}>{turn.text}</div>
            {turn.role === 'assistant' && <Sources sources={turn.sources} />}
            {turn.metrics?.costUsd > 0 && (
              <div className="answer-cost">{money(turn.metrics.costUsd)} · {turn.metrics.outputTokens} tokens</div>
            )}
          </div>
        ))}
        {live && (
          <div className="chat-message is-assistant">
            <div className="chat-who">{model}</div>
            <div className="chat-body">
              {live.text || <span className="chat-waiting">reading the sources…</span>}
            </div>
          </div>
        )}
      </div>

      {(preview || live) && (
        <ContextStrip
          nodes={preview?.nodes ?? live?.sources}
          metrics={metrics}
          routing={routing}
          ambiguity={ambiguity}
          onNarrow={onNarrow}
        />
      )}
      {error && <div className="chat-error">{error}</div>}

      <form className="chat-input" onSubmit={handleSubmit}>
        <textarea
          rows={1}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) handleSubmit(event);
          }}
          placeholder="Ask your map"
        />
        <button type="submit" aria-label="Send" disabled={status !== 'idle'}>↑</button>
      </form>
    </aside>
  );
}
