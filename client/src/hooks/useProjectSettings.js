import { useCallback, useEffect, useState } from 'react';

// Where each project lives on this machine. Nothing can be run until the user
// says, and the server confirms the directory exists.
export function useProjectSettings(enabled) {
  const [settings, setSettings] = useState([]);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    const response = await fetch('/api/projects/settings');
    if (!response.ok) return;
    setSettings((await response.json()).projects);
  }, []);

  useEffect(() => {
    // Synchronising with the server; every setState here happens after an await.
    // oxlint-disable-next-line react/set-state-in-effect
    if (enabled) load();
  }, [enabled, load]);

  const bind = useCallback(
    async (project, localPath) => {
      setError(null);
      const response = await fetch('/api/projects/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project, localPath }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        setError(body.error ?? 'could not use that folder');
        return null;
      }
      setSettings((prev) => [...prev.filter((entry) => entry.project !== project), body]);
      return body;
    },
    []
  );

  const settingsFor = useCallback(
    (project) => settings.find((entry) => entry.project === project) ?? null,
    [settings]
  );

  return { settings, settingsFor, bind, error };
}
