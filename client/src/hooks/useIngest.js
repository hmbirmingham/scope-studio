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

// The pace GitHub asks for when the engine's answer leaves it out.
const DEFAULT_SIGN_IN_INTERVAL_S = 5;

export function useIngest(onFinished) {
  const [connected, setConnected] = useState(null);
  const [configured, setConfigured] = useState(true);
  const [repos, setRepos] = useState([]);
  const [job, setJob] = useState(null);
  const [error, setError] = useState(null);
  // GitHub sign-in, by the device flow: null when none is in progress, else
  // { state: 'starting' | 'waiting' | 'connected' | 'expired' | 'denied' |
  // 'failed', userCode, verificationUri, interval, error }.
  const [signIn, setSignIn] = useState(null);
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
    // Older engines do not report it; assume configured and let start say.
    setConfigured(status.configured !== false);
    // A "connected" note from an earlier sign-in must not outlive the token.
    const forgetSignIn = () => setSignIn((prev) => (prev?.state === 'connected' ? null : prev));
    if (!status.connected) {
      forgetSignIn();
      return;
    }
    const response = await fetch('/api/plugins/github/repos');
    if (!response.ok) {
      setConnected(false);
      forgetSignIn();
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

  // The engine asks GitHub for a code and keeps the device half to itself;
  // the browser only shows the short code and where to type it.
  // Every way this can go wrong ends as a 'failed' attempt, which the panel
  // shows with a Try again button; a rejection here would leave it stuck on
  // "Asking GitHub…" with nothing to press.
  const connect = useCallback(async () => {
    setError(null);
    setSignIn({ state: 'starting' });
    try {
      const response = await fetch('/api/plugins/github/device/start', { method: 'POST' });
      if (!response.ok) {
        setSignIn({ state: 'failed', error: await problemFrom(response, 'could not start GitHub sign-in') });
        return;
      }
      const started = await response.json();
      // The panel renders both, so an answer without them is a failure here
      // rather than a crash there.
      if (!started?.userCode || !started?.verificationUri) {
        setSignIn({ state: 'failed', error: 'The engine gave an incomplete answer to GitHub sign-in. Try again.' });
        return;
      }
      setSignIn({
        state: 'waiting',
        userCode: started.userCode,
        verificationUri: started.verificationUri,
        interval: started.interval || DEFAULT_SIGN_IN_INTERVAL_S,
      });
    } catch {
      setSignIn({ state: 'failed', error: 'Could not reach the engine to start GitHub sign-in. Check it is running, then try again.' });
    }
  }, []);

  // Forgetting the attempt here is enough: the engine drops the device code
  // when it expires, and the next Connect replaces it.
  const cancelSignIn = useCallback(() => setSignIn(null), []);

  // One poll per interval, rescheduled after each answer rather than on a
  // fixed timer, so a slow_down from GitHub stretches the wait at once.
  useEffect(() => {
    if (signIn?.state !== 'waiting') return undefined;
    let cancelled = false;
    const timer = setTimeout(async () => {
      let next;
      try {
        const response = await fetch('/api/plugins/github/device/poll', { method: 'POST' });
        next = response.ok
          ? await response.json()
          : { status: 'failed', error: await problemFrom(response, 'GitHub sign-in failed') };
      } catch {
        // The engine was unreachable for a moment; ask again next interval.
        next = { status: 'pending' };
      }
      if (cancelled) return;
      if (next.status === 'pending') {
        setSignIn((prev) => prev && { ...prev, interval: next.interval || prev.interval, polls: (prev.polls ?? 0) + 1 });
        return;
      }
      setSignIn((prev) => prev && { ...prev, state: next.status, error: next.error ?? null });
      if (next.status === 'connected') loadRepos();
    }, signIn.interval * 1000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [signIn, loadRepos]);

  return { connected, configured, repos, job, error, loadRepos, ingest, signIn, connect, cancelSignIn };
}
