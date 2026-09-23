import KnowledgeGraphCanvas from './KnowledgeGraphCanvas';

// The map is the only thing that still wants a panel: it is a picture, not a
// line of work. Sources and proposals live in the conversation now.
export default function OutputPanel({
  open,
  onClose,
  canvasRef,
  graph,
  activeIds,
  traversedKeys,
  preferences,
  onSelectNode,
}) {
  if (!open) return null;

  return (
    <aside className="output-panel">
      <header className="panel-tabs">
        <span className="panel-title">Map</span>
        <button type="button" className="panel-close" onClick={onClose} aria-label="Close map">
          ✕
        </button>
      </header>
      <div className="panel-body is-map">
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
    </aside>
  );
}
