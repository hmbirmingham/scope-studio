import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  // Key Pro's model choice, for this session; other plans never send one.
  const [cloudModel, setCloudModel] = useState('claude-sonnet-5');
  const [tier, setTier] = useState(null);
  const [webSearch, setWebSearch] = useState(false);
  // Display mode: granted once through the privacy prompt, held by the server
  // in this signed-in session, withdrawn by turning it off or signing out.
  const [displayControl, setDisplayControl] = useState(false);
  // What this plan may do with the cloud. The server enforces it; this only
  // lets the composer say so before a request is refused.
  const [cloudPlan, setCloudPlan] = useState({ chooseCloud: true, autoCloud: true, remainingUsd: null });

  useEffect(() => {
    fetch('/api/usage?days=7')
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        if (!body) return;
        setCloudPlan({ chooseCloud: body.chooseCloud, autoCloud: body.autoCloud, remainingUsd: body.weekly?.remainingUsd ?? null });
        if (!body.chooseCloud) {
          setTier((current) => (current === 'cloud_frontier' ? null : current));
          setWebSearch(false);
        }
      })
      .catch(() => {});
  }, []);
  const [displayAvailable, setDisplayAvailable] = useState(false);

  useEffect(() => {
    fetch('/api/actions/consent')
      .then((response) => (response.ok ? response.json() : null))
      .then((body) => {
        if (!body) return;
        setDisplayControl(body.displayControl);
        setDisplayAvailable(body.available);
      })
      .catch(() => {});
  }, []);

  const changeDisplayControl = useCallback(async (next) => {
    const response = await fetch('/api/actions/consent', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayControl: next }),
    });
    const body = await response.json().catch(() => ({}));
    setDisplayControl(response.ok ? body.displayControl : false);
    return response.ok ? null : body.error ?? 'could not change display control';
  }, []);
  const [preferences, setPreferences] = useState({});

  const projectSettings = useProjectSettings(true);

  const chat = useChat({
    project: activeProject,
    apiKey,
    tier,
    webSearch,
    displayControl,
    cloudModel: cloudPlan.chooseCloud ? cloudModel : undefined,
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
    if (project) canvasRef.current?.focusProject(project);
    else canvasRef.current?.fit();
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
        onNewThread={() => chat.newThread()}
      />

      {/* The conversation is the workspace; outputs sit beside it. */}
      <main className="stage">
        <ChatPanel
          project={activeProject}
          chat={chat}
          onNarrow={handleSelectProject}
          tier={tier}
          onTierChange={setTier}
          webSearch={webSearch}
          onWebSearchChange={setWebSearch}
          cloudPlan={cloudPlan}
          displayControl={displayControl}
          displayAvailable={displayAvailable}
          onDisplayControlChange={changeDisplayControl}
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
        cloudModel={cloudModel}
        onCloudModelChange={setCloudModel}
        chooseCloud={cloudPlan.chooseCloud}
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
