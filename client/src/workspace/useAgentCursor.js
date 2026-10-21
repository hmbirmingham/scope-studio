import { useContext } from 'react';
import { WorkspaceContext, useWorkspaceEvents } from './workspaceContext.js';

// Hands node.touched / node.written events straight to the graph engine, so
// the agent's cursor lights the map without a single React render: the
// engine keeps the marks and its own frame loop fades them. Outside a
// WorkspaceProvider (or before the engine exists) it does nothing.
export function useAgentCursor(engineRef) {
  const workspace = useContext(WorkspaceContext);
  const colorFor = workspace?.colorFor;
  useWorkspaceEvents((event) => {
    const engine = engineRef.current;
    if (!engine?.markAgentNodes || !colorFor) return;
    if (event.type === 'node.touched') {
      engine.markAgentNodes(event.data?.nodeIds ?? [], colorFor(event.agentId), 'touched');
    } else if (event.type === 'node.written' && event.data?.nodeId) {
      engine.markAgentNodes([event.data.nodeId], colorFor(event.agentId), 'written');
    }
  });
}
