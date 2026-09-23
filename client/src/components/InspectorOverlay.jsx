import { useState } from 'react';
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

function WorkingCopy({ project, settings, error, onBindPath }) {
  const [path, setPath] = useState(settings?.localPath ?? '');

  return (
    <div className="inspector-block">
      <div className="inspector-block-title">Working copy</div>
      <p className="key-note">
        Where this project lives on this machine. Scripts it declares can then be run — after you
        approve each one.
      </p>
      <input
        className="key-input"
        type="text"
        spellCheck="false"
        placeholder="/Users/you/code/project"
        value={path}
        onChange={(event) => setPath(event.target.value)}
      />
      <div className="edit-actions" style={{ padding: '10px 0 0', borderTop: 'none' }}>
        <button type="button" className="edit-approve" onClick={() => onBindPath(project, path.trim())}>
          Use this folder
        </button>
        {settings?.localPath && (
          <button type="button" className="edit-reject" onClick={() => { setPath(''); onBindPath(project, null); }}>
            Unlink
          </button>
        )}
      </div>
      {error && <div className="edit-note is-warn">{error}</div>}
      {settings?.scripts?.length > 0 && (
        <div className="inspector-sub" style={{ marginTop: 10 }}>
          scripts: {settings.scripts.join(', ')}
        </div>
      )}
    </div>
  );
}

function ProjectScope({ project, stats, settings, settingsError, onBindPath }) {
  return (
    <>
      <div className="inspector-head">
        <div className="inspector-type">project</div>
        <div className="inspector-title">{project}</div>
        <div className="inspector-sub">
          {stats.nodes} nodes · {stats.tokens.toLocaleString()} tokens
        </div>
      </div>

      <WorkingCopy project={project} settings={settings} error={settingsError} onBindPath={onBindPath} />

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
