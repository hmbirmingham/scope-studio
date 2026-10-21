import { createContext, useContext, useEffect, useRef } from 'react';

// What every workspace view shares: the API client, the one event stream,
// the user's agents (for names and cursor colours), the pending approvals
// (for the badge), the plan, and the map's projects. WorkspaceProvider fills
// it; views read it through useWorkspace(), and the map reads it through
// useAgentCursor(), which tolerates its absence.

export const WorkspaceContext = createContext(null);

export function useWorkspace() {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('useWorkspace needs a WorkspaceProvider');
  return value;
}

// Subscribes to the shared stream for as long as the calling component is
// mounted. The handler is kept in a ref so a new identity never reconnects.
export function useWorkspaceEvents(handler, { onResync } = {}) {
  const workspace = useContext(WorkspaceContext);
  const stream = workspace?.stream ?? null;
  const handlerRef = useRef(handler);
  const resyncRef = useRef(onResync);
  useEffect(() => {
    handlerRef.current = handler;
    resyncRef.current = onResync;
  });
  useEffect(() => {
    if (!stream) return undefined;
    const unsubscribe = stream.subscribe((event) => handlerRef.current?.(event));
    const stopResync = stream.onResync(() => resyncRef.current?.());
    return () => {
      unsubscribe();
      stopResync();
    };
  }, [stream]);
}
