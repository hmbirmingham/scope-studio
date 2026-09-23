import { useMemo, useRef, useState } from 'react';
import ChatPanel from './components/ChatPanel';
import InspectorOverlay from './components/InspectorOverlay';
import KnowledgeGraphCanvas from './components/KnowledgeGraphCanvas';
import Sidebar from './components/Sidebar';
import { buildMockGraph } from './graph/mockGraph';
import './App.css';

export default function App() {
  // Stable identity matters: a new array each render would re-run syncNodes.
  const graph = useMemo(() => buildMockGraph(), []);
  const canvasRef = useRef(null);

  const [activeProject, setActiveProject] = useState(null);
  const [scope, setScope] = useState(null);
  const [preferences, setPreferences] = useState({});

  const projects = useMemo(
    () => [...new Set(graph.nodes.map((node) => node.project))],
    [graph]
  );
  const nodesById = useMemo(
    () => new Map(graph.nodes.map((node) => [node.id, node])),
    [graph]
  );

  function relationsFor(id) {
    return graph.edges
      .filter((edge) => edge.source === id || edge.target === id)
      .map((edge) => ({
        type: edge.type,
        direction: edge.source === id ? 'out' : 'in',
        node: nodesById.get(edge.source === id ? edge.target : edge.source),
      }))
      .filter((relation) => relation.node);
  }

  function projectStats(project) {
    const members = graph.nodes.filter((node) => node.project === project);
    return {
      nodes: members.length,
      tokens: members.reduce((sum, node) => sum + node.token_length, 0),
      byType: members.reduce((acc, node) => {
        acc[node.type] = (acc[node.type] ?? 0) + 1;
        return acc;
      }, {}),
    };
  }

  function handleSelectProject(project) {
    setActiveProject(project);
    canvasRef.current?.focusProject(project);
  }

  function handleFocusNode(id) {
    canvasRef.current?.select(id);
    canvasRef.current?.focusNode(id);
    setScope({ kind: 'node', node: nodesById.get(id) });
  }

  return (
    <div className="app">
      <Sidebar
        projects={projects}
        activeProject={activeProject}
        onSelectProject={handleSelectProject}
        onOpenProjectSettings={(project) => setScope({ kind: 'project', project })}
      />

      <main className="stage">
        <KnowledgeGraphCanvas
          ref={canvasRef}
          nodes={graph.nodes}
          edges={graph.edges}
          preferences={preferences}
          onSelectNode={(node) => setScope({ kind: 'node', node })}
        />
      </main>

      <ChatPanel project={activeProject} />

      <InspectorOverlay
        scope={scope}
        onClose={() => setScope(null)}
        relations={scope?.kind === 'node' ? relationsFor(scope.node.id) : []}
        stats={scope?.kind === 'project' ? projectStats(scope.project) : null}
        preference={scope?.kind === 'node' ? preferences[scope.node.id] ?? null : null}
        onSetPreference={(id, preference) =>
          setPreferences((prev) => ({ ...prev, [id]: preference }))
        }
        onFocusNode={handleFocusNode}
      />
    </div>
  );
}
