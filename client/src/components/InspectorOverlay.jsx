const PREFERENCES = [
  { key: 'pin', label: 'Pin', glyph: '★' },
  { key: 'boost', label: 'Boost', glyph: '↑' },
  { key: 'suppress', label: 'Suppress', glyph: '↓' },
  { key: 'local', label: 'Local only', glyph: '■' },
];

function NodeScope({ node, relations, preference, onSetPreference, onFocusNode }) {
  return (
    <>
      <div className="inspector-head">
        <div className="inspector-type">{node.type}</div>
        <div className="inspector-title">{node.label ?? node.id}</div>
        <div className="inspector-sub">
          {node.project} · {node.tokenLength} tokens
          {node.privacy === 'local' && ' · local only'}
        </div>
      </div>

      <div className="inspector-block">
        <div className="inspector-block-title">Controls</div>
        <div className="pref-row">
          {PREFERENCES.map((item) => (
            <button
              type="button"
              key={item.key}
              className={`pref-btn pref-${item.key} ${preference === item.key ? 'is-on' : ''}`}
              onClick={() => onSetPreference(node.id, preference === item.key ? null : item.key)}
            >
              <span aria-hidden="true">{item.glyph}</span> {item.label}
            </button>
          ))}
        </div>
      </div>

      <div className="inspector-block">
        <div className="inspector-block-title">Relations ({relations.length})</div>
        {relations.length === 0 && <div className="inspector-empty">No relationships yet.</div>}
        {relations.map((relation) => (
          <button
            type="button"
            className="relation-row"
            key={`${relation.type}-${relation.node.id}`}
            onClick={() => onFocusNode(relation.node.id)}
          >
            <span className="relation-type">{relation.direction === 'out' ? '→' : '←'} {relation.type}</span>
            <span className="relation-name">{relation.node.label ?? relation.node.id}</span>
          </button>
        ))}
      </div>
    </>
  );
}

function ProjectScope({ project, stats }) {
  return (
    <>
      <div className="inspector-head">
        <div className="inspector-type">project</div>
        <div className="inspector-title">{project}</div>
        <div className="inspector-sub">
          {stats.nodes} nodes · {stats.tokens.toLocaleString()} tokens
        </div>
      </div>

      <div className="inspector-block">
        <div className="inspector-block-title">Composition</div>
        {Object.entries(stats.byType).map(([type, count]) => (
          <div className="stat-row" key={type}>
            <span>{type}</span>
            <span className="stat-count">{count}</span>
          </div>
        ))}
      </div>
    </>
  );
}

export default function InspectorOverlay({ scope, onClose, ...rest }) {
  if (!scope) return null;

  return (
    <div className="inspector-backdrop" onClick={onClose}>
      <section className="inspector" onClick={(event) => event.stopPropagation()}>
        <button type="button" className="inspector-close" onClick={onClose} aria-label="Close">
          ✕
        </button>
        {scope.kind === 'node' ? <NodeScope {...rest} node={scope.node} /> : <ProjectScope {...rest} project={scope.project} />}
      </section>
    </div>
  );
}
