import { useMemo, useRef, useState } from 'react';
import ChatPanel from './components/ChatPanel';
import InspectorOverlay from './components/InspectorOverlay';
import LoginGate from './components/LoginGate';
import OutputPanel from './components/OutputPanel';
import Sidebar from './components/Sidebar';
import SourcesOverlay from './components/SourcesOverlay';
import { edgeKey } from './graph/GraphEngine';
import { useChat } from './hooks/useChat';
import { useProjectSettings } from './hooks/useProjectSettings';
import { useGraphData } from './hooks/useGraphData';
import './App.css';

function Studio() {
  const { graph, state, error, refresh } = useGraphData(true);
  const canvasRef = useRef(null);

  const [activeProject, setActiveProject] = useState(null);
  const [scope, setScope] = useState(null);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  // Held in memory for this session only: never localStorage, never the server.
  const [apiKey, setApiKey] = useState('');
  const [tier, setTier] = useState(null);
  const [preferences, setPreferences] = useState({});

  const projectSettings = useProjectSettings(true);

  const chat = useChat({
    project: activeProject,
    apiKey,
    tier,
  });

  const nodesById = useMemo(
    () => new Map(graph.nodes.map((node) => [node.id, node])),
    [graph]
  );

  // Retrieval hands back the nodes it chose and the edge it reached each one
  // through, which is exactly what the canvas lights up.
  const activeIds = useMemo(() => chat.spotlight.map((node) => node.id), [chat.spotlight]);
  const traversedKeys = useMemo(
    () => chat.spotlight.filter((node) => node.via).map((node) => edgeKey(node.via.from, node.id)),
    [chat.spotlight]
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
      tokens: members.reduce((sum, node) => sum + node.tokenLength, 0),
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
        projects={graph.projects}
        activeProject={activeProject}
        onSelectProject={handleSelectProject}
        onOpenProjectSettings={(project) => setScope({ kind: 'project', project })}
        onOpenSources={() => setSourcesOpen(true)}
      />

      {/* The conversation is the workspace; outputs sit beside it. */}
      <main className="stage">
        <ChatPanel
          project={activeProject}
          chat={chat}
          onNarrow={handleSelectProject}
          tier={tier}
          onTierChange={setTier}
          hasKey={Boolean(apiKey)}
        />
        {!panelOpen && (
          <button
            type="button"
            className="map-open"
            onClick={() => setPanelOpen(true)}
            aria-label="Show map"
            title="Show map"
          >
            🌐
          </button>
        )}
        {state === 'loading' && <div className="stage-note">Loading your map…</div>}
        {state === 'error' && <div className="stage-note is-error">{error}</div>}
      </main>

      <OutputPanel
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
        canvasRef={canvasRef}
        graph={graph}
        activeIds={activeIds}
        traversedKeys={traversedKeys}
        preferences={preferences}
        onSelectNode={(node) => setScope({ kind: 'node', node })}
      />

      <SourcesOverlay
        open={sourcesOpen}
        onClose={() => setSourcesOpen(false)}
        onIngested={refresh}
        apiKey={apiKey}
        onApiKeyChange={setApiKey}
      />

      <InspectorOverlay
        scope={scope}
        onClose={() => setScope(null)}
        relations={scope?.kind === 'node' ? relationsFor(scope.node.id) : []}
        stats={scope?.kind === 'project' ? projectStats(scope.project) : null}
        settings={scope?.kind === 'project' ? projectSettings.settingsFor(scope.project) : null}
        settingsError={projectSettings.error}
        onBindPath={projectSettings.bind}
        preference={scope?.kind === 'node' ? preferences[scope.node.id] ?? null : null}
        onSetPreference={(id, preference) =>
          setPreferences((prev) => ({ ...prev, [id]: preference }))
        }
        onFocusNode={handleFocusNode}
      />
    </div>
  );
}

export default function App() {
  return (
    <LoginGate>
      <Studio />
    </LoginGate>
  );
}
