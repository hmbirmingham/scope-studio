import { useCallback, useEffect, useState } from 'react';

const EMPTY = { nodes: [], edges: [], projects: [] };

// One request carries the whole map; the engine diffs it in, so a refetch keeps
// node positions instead of relaying the graph.
export function useGraphData(enabled) {
  const [graph, setGraph] = useState(EMPTY);
  const [state, setState] = useState('loading');
  const [error, setError] = useState(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/graph');
      if (!response.ok) throw new Error(`map unavailable (${response.status})`);
      const data = await response.json();
      setGraph({ nodes: data.nodes, edges: data.edges, projects: data.projects });
      setState('ready');
      setError(null);
    } catch (err) {
      setError(err.message);
      setState('error');
    }
  }, []);

  useEffect(() => {
    // Synchronising with the server is what an effect is for; the rule cannot
    // see that every setState in refresh happens after an await.
    // oxlint-disable-next-line react/set-state-in-effect
    if (enabled) refresh();
  }, [enabled, refresh]);

  return { graph, state, error, refresh };
}
