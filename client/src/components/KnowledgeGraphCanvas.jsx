import { useEffect, useImperativeHandle, useRef, useState } from 'react';
import { GraphEngine } from '../graph/GraphEngine';

function NodeTooltip({ hover }) {
  return (
    <div className="tooltip" style={{ left: hover.screen.x + 16, top: hover.screen.y - 10 }}>
      <div className="tooltip-type">{hover.node.type}</div>
      <div className="tooltip-meta">
        {hover.node.tokenLength} tokens
        {hover.node.privacy === 'local' && <span className="tooltip-local"> · local only</span>}
      </div>
    </div>
  );
}

export default function KnowledgeGraphCanvas({
  ref,
  nodes,
  edges,
  activeIds,
  traversedKeys,
  preferences,
  onSelectNode,
}) {
  const canvasRef = useRef(null);
  const engineRef = useRef(null);
  const zoomRef = useRef(null);
  const selectHandler = useRef(onSelectNode);

  const [hover, setHover] = useState(null);

  // Keeps the engine's callback current without making it an effect dependency,
  // so a new handler identity never tears down the render loop.
  useEffect(() => {
    selectHandler.current = onSelectNode;
  });

  useEffect(() => {
    const engine = new GraphEngine(canvasRef.current);
    engineRef.current = engine;
    engine.onHoverChange = setHover;
    // Written straight to the DOM: the camera changes every frame while it
    // lerps, and routing that through state would re-render at 60fps.
    engine.onCameraChange = (scale) => {
      if (zoomRef.current) zoomRef.current.textContent = `${Math.round(scale * 100)}%`;
    };
    engine.onSelect = (node) => selectHandler.current?.(node);
    engine.start();
    return () => {
      engine.dispose();
      engineRef.current = null;
    };
  }, []);

  useEffect(() => {
    engineRef.current?.syncNodes(nodes, edges);
  }, [nodes, edges]);

  useEffect(() => {
    engineRef.current?.setActive(activeIds ?? []);
  }, [activeIds]);

  useEffect(() => {
    engineRef.current?.setTraversed(traversedKeys ?? []);
  }, [traversedKeys]);

  useEffect(() => {
    if (!preferences) return;
    for (const [id, preference] of Object.entries(preferences)) {
      engineRef.current?.setPreference(id, preference);
    }
  }, [preferences]);

  useImperativeHandle(ref, () => ({
    focusProject: (project) => engineRef.current?.focusOnProject(project),
    focusNode: (id) => engineRef.current?.focusOnNode(id),
    select: (id) => engineRef.current?.setSelected(id),
  }));

  return (
    <div className="graph-wrap">
      <canvas ref={canvasRef} className="graph-canvas" />
      {hover && <NodeTooltip hover={hover} />}
      <div className="zoom-badge" ref={zoomRef}>100%</div>
    </div>
  );
}
