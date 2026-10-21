import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { workspaceApi } from './api.js';
import { NEUTRAL_AGENT_COLOR } from './cursor.js';
import { WorkspaceEventStream } from './eventStream.js';
import { selectTab } from './tabs.js';
import { WorkspaceContext } from './workspaceContext.js';

const GRAPH_REFRESH_MS = 800;

// One stream for the whole page unless a test hands in its own.
let defaultStream = null;
function sharedStream() {
  defaultStream ??= new WorkspaceEventStream();
  return defaultStream;
}

export default function WorkspaceProvider({
  api = workspaceApi,
  stream,
  projects = [],
  sources = [],
  nodesById,
  onFocusNode,
  onGraphChanged,
  children,
}) {
  const eventStream = stream ?? sharedStream();
  const [agents, setAgents] = useState([]);
  const [agentsError, setAgentsError] = useState(null);
  const [approvals, setApprovals] = useState([]);
  const [plan, setPlan] = useState({ ownKey: false });
  const [connection, setConnection] = useState(eventStream.status);
  // The run the Activity tab shows; other tabs open a run through openRun.
  const [selectedRunId, setSelectedRunId] = useState(null);
  const openRun = useCallback((runId) => {
    setSelectedRunId(runId);
    selectTab('activity');
  }, []);

  const loadAgents = useCallback(async () => {
    try {
      setAgents(await api.listAgents());
      setAgentsError(null);
    } catch (error) {
      setAgentsError(error.message);
    }
  }, [api]);

  const loadApprovals = useCallback(async () => {
    try {
      setApprovals(await api.listApprovals('pending'));
    } catch {
      // The inbox shows its own error when opened; the badge just stays put.
    }
  }, [api]);

  useEffect(() => {
    // Synchronising with the server; every setState above happens after an await.
    // oxlint-disable-next-line react/set-state-in-effect
    loadAgents();
    loadApprovals();
    api.getPlan().then(setPlan).catch(() => {});
  }, [api, loadAgents, loadApprovals]);

  // Colours are read inside the map's animation path, so they come from a ref
  // that follows the agents list rather than from a value that re-renders it.
  const colors = useRef(new Map());
  useEffect(() => {
    colors.current = new Map(agents.map((agent) => [agent.id, agent.color]));
  }, [agents]);
  const colorFor = useCallback((agentId) => colors.current.get(agentId) ?? NEUTRAL_AGENT_COLOR, []);

  // App's handlers change identity on every render; holding them in refs
  // keeps the context value (and every workspace view) still while the
  // conversation streams.
  const graphChanged = useRef(onGraphChanged);
  const focusHandler = useRef(onFocusNode);
  useEffect(() => {
    graphChanged.current = onGraphChanged;
    focusHandler.current = onFocusNode;
  });
  const hasFocus = Boolean(onFocusNode);
  const focusNode = useCallback((nodeId) => focusHandler.current?.(nodeId), []);

  useEffect(() => {
    let refreshTimer = null;
    const unsubscribe = eventStream.subscribe((event) => {
      if (event.type === 'approval.requested' || event.type === 'approval.resolved') loadApprovals();
      // New nodes reach the map by refetching it, batched so a burst of
      // writes costs one request.
      if (event.type === 'node.written' && graphChanged.current) {
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => graphChanged.current?.(), GRAPH_REFRESH_MS);
      }
    });
    const stopResync = eventStream.onResync(() => {
      loadAgents();
      loadApprovals();
    });
    const stopStatus = eventStream.onStatus(setConnection);
    return () => {
      clearTimeout(refreshTimer);
      unsubscribe();
      stopResync();
      stopStatus();
    };
  }, [eventStream, loadAgents, loadApprovals]);

  const replaceAgent = useCallback((agent) => {
    setAgents((current) => {
      const exists = current.some((entry) => entry.id === agent.id);
      return exists ? current.map((entry) => (entry.id === agent.id ? agent : entry)) : [...current, agent];
    });
  }, []);
  const removeAgent = useCallback((agentId) => setAgents((current) => current.filter((agent) => agent.id !== agentId)), []);
  const dropApproval = useCallback((approvalId) => setApprovals((current) => current.filter((entry) => entry.id !== approvalId)), []);

  const nodeLabel = useCallback(
    (nodeId) => {
      const node = nodesById?.get(nodeId);
      return node ? { label: node.label ?? nodeId, type: node.type } : null;
    },
    [nodesById]
  );

  const value = useMemo(
    () => ({
      api,
      stream: eventStream,
      connection,
      agents,
      agentsError,
      loadAgents,
      replaceAgent,
      removeAgent,
      colorFor,
      approvals,
      loadApprovals,
      dropApproval,
      plan,
      projects,
      sources,
      nodeLabel,
      focusNode: hasFocus ? focusNode : null,
      selectedRunId,
      selectRun: setSelectedRunId,
      openRun,
    }),
    [api, eventStream, connection, agents, agentsError, loadAgents, replaceAgent, removeAgent, colorFor, approvals, loadApprovals, dropApproval, plan, projects, sources, nodeLabel, hasFocus, focusNode, selectedRunId, openRun]
  );

  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}
