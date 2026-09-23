import { useCallback, useEffect, useRef, useState } from 'react';

// Ingestion runs as a job on the server; this polls it so the picker can show
// which repository is being read and how far along it is.
const POLL_MS = 700;

async function problemFrom(response, fallback) {
  try {
    return (await response.json()).error ?? fallback;
  } catch {
    return `${fallback} (${response.status})`;
  }
}

export function useIngest(onFinished) {
  const [connected, setConnected] = useState(null);
  const [repos, setRepos] = useState([]);
  const [job, setJob] = useState(null);
  const [error, setError] = useState(null);
  const finishedRef = useRef(onFinished);

  // Keeps the callback current without making it a dependency of the poll,
  // which would restart the interval on every render.
  useEffect(() => {
    finishedRef.current = onFinished;
  });

  const loadRepos = useCallback(async () => {
    setError(null);
    const status = await fetch('/api/plugins/github/status').then((response) => response.json());
    setConnected(status.connected);
    if (!status.connected) return;
    const response = await fetch('/api/plugins/github/repos');
    if (!response.ok) {
      setConnected(false);
      setRepos([]);
      setError(await problemFrom(response, 'could not list repositories'));
      return;
    }
    setRepos((await response.json()).repos);
  }, []);

  const ingest = useCallback(async (fullNames) => {
    setError(null);
    const response = await fetch('/api/plugins/github/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repos: fullNames }),
    });
    if (!response.ok && response.status !== 409) {
      setError(await problemFrom(response, 'ingest failed to start'));
      return;
    }
    const body = await response.json();
    setJob(response.status === 409 ? body.job : body);
  }, []);

  useEffect(() => {
    if (!job || job.state !== 'running') return undefined;
    const timer = setInterval(async () => {
      const response = await fetch(`/api/plugins/github/jobs/${job.id}`);
      if (!response.ok) return;
      const next = await response.json();
      setJob(next);
      if (next.state !== 'running') {
        clearInterval(timer);
        if (next.state === 'done') {
          finishedRef.current?.();
          loadRepos();
        }
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [job, loadRepos]);

  return { connected, repos, job, error, loadRepos, ingest };
}
