import { useCallback, useEffect, useRef, useState } from 'react';
import { readNdjson } from '../lib/ndjson';

// Long enough that a pause means a pause, short enough that the prefill is
// usually finished by the time the question is sent.
const PREPARE_DEBOUNCE_MS = 400;
const MIN_DRAFT = 8;

// The key is the user's: held in memory for this session, sent per request,
// never written to storage here or on the server.
async function postJson(path, body, { apiKey, signal } = {}) {
  const response = await fetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { 'x-anthropic-api-key': apiKey } : {}),
    },
    body: JSON.stringify(body),
    signal,
  });
  return { ok: response.ok, status: response.status, body: response };
}

// One conversation per thread — a project, or "all maps". Switching threads
// puts the other one away and brings this one back; it does not carry the last
// project's work into the next question.
export function useChat({ project, apiKey, tier, webSearch = false, displayControl = false, cloudModel, onEdits }) {
  const threadKey = project ?? 'all';
  const [turns, setTurns] = useState([]);
  const [draft, setDraft] = useState('');
  // What the server would read for the question being typed, with its prefill
  // already running: the map lights up before anything is asked.
  const [preview, setPreview] = useState(null);
  const [live, setLive] = useState(null);
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState(null);
  const [edits, setEdits] = useState([]);
  const [runs, setRuns] = useState([]);
  const [actions, setActions] = useState([]);

  const conversationRef = useRef(null);
  const answeringRef = useRef(false);
  const threadsRef = useRef(new Map());
  const currentThread = useRef(threadKey);
  const latest = useRef(null);
  const onEditsRef = useRef(onEdits);

  useEffect(() => {
    onEditsRef.current = onEdits;
  });

  useEffect(() => {
    latest.current = { turns, edits, runs, actions, conversationId: conversationRef.current };
  });

  // Switching thread: keep what was there, show what belongs here.
  useEffect(() => {
    if (currentThread.current === threadKey) return;
    threadsRef.current.set(currentThread.current, latest.current);

    const next = threadsRef.current.get(threadKey) ?? { turns: [], edits: [], runs: [], actions: [], conversationId: null };
    setTurns(next.turns);
    setEdits(next.edits);
    setRuns(next.runs);
    setActions(next.actions ?? []);
    setPreview(null);
    setLive(null);
    setError(null);
    conversationRef.current = next.conversationId;
    currentThread.current = threadKey;
  }, [threadKey]);

  useEffect(() => {
    const text = draft.trim();
    if (text.length < MIN_DRAFT || answeringRef.current) return undefined;

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const { ok, body } = await postJson(
          '/api/chat/prepare',
          { query: text, project, tier, conversationId: conversationRef.current },
          { apiKey, signal: controller.signal }
        );
        if (ok && !answeringRef.current) setPreview(await body.json());
      } catch {
        // A superseded or failed preview is never worth surfacing: the answer
        // path reports its own errors.
      }
    }, PREPARE_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [draft, project, tier, apiKey]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || answeringRef.current) return;

    answeringRef.current = true;
    setStatus('reading');
    setError(null);
    setPreview(null);
    setDraft('');
    setTurns((prev) => [...prev, { role: 'user', text }]);

    const answer = { role: 'assistant', text: '', sources: [], routing: null, metrics: null, searches: [], web: [] };
    try {
      const { ok, body } = await postJson(
        '/api/chat',
        { query: text, project, tier, webSearch, displayControl, cloudModel, conversationId: conversationRef.current },
        { apiKey }
      );
      if (!ok) {
        // The refusal is shown as the answer to that question; repeating it in
        // the error bar would say the same thing twice.
        const problem = await body.json();
        setTurns((prev) => [...prev, { ...answer, refused: problem.code, text: problem.error, routing: problem.routing }]);
        return;
      }

      for await (const line of readNdjson(body.body)) {
        if (line.type === 'context') {
          conversationRef.current = line.conversationId;
          answer.sources = line.nodes;
          answer.routing = line.routing;
          answer.metrics = line.metrics;
          answer.ambiguity = line.ambiguity;
          answer.omittedPrivate = line.omittedPrivate ?? 0;
          setStatus('answering');
          setLive({ ...answer });
        } else if (line.type === 'token') {
          answer.text += line.text;
          setLive({ ...answer });
        } else if (line.type === 'searching') {
          answer.searches = [...answer.searches, line.query];
          setLive({ ...answer });
        } else if (line.type === 'edits') {
          // Proposed, not applied: the panel shows them for approval, and the
          // arrival itself is what opens that tab.
          setEdits((prev) => [...prev, ...line.edits]);
          onEditsRef.current?.(line.edits);
        } else if (line.type === 'runs') {
          setRuns((prev) => [...prev, ...line.runs]);
          onEditsRef.current?.(line.runs);
        } else if (line.type === 'actions') {
          setActions((prev) => [...prev, ...line.actions]);
        } else if (line.type === 'done') {
          answer.metrics = { ...answer.metrics, ...line.metrics };
          answer.web = line.web ?? [];
          answer.searches = line.searches ?? answer.searches;
        } else if (line.type === 'error') {
          setError(line.error);
        }
      }
      setTurns((prev) => [...prev, answer]);
    } catch (err) {
      setError(err.message);
    } finally {
      setLive(null);
      setStatus('idle');
      answeringRef.current = false;
    }
  }, [draft, project, tier, webSearch, displayControl, cloudModel, apiKey]);

  // What the canvas should light up right now: the question being typed wins,
  // then the answer being written, then the last answer given.
  const spotlight = preview?.nodes ?? live?.sources ?? turns.at(-1)?.sources ?? [];

  // Approving is what writes; the server re-checks the file before it does.
  const decideEdit = useCallback(async (id, decision) => {
    const response = await fetch(`/api/edits/${id}/${decision}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const body = await response.json().catch(() => ({}));
    // A refusal belongs on the edit it refused, not in a general error bar.
    const problem = response.ok ? null : body.error ?? `could not ${decision} that edit`;
    setEdits((prev) =>
      prev.map((edit) => (edit.id === id ? { ...(body.edit ?? edit), problem } : edit))
    );
  }, []);

  // Approving is what runs it; the server only allows scripts the project declares.
  const decideRun = useCallback(async (id, decision) => {
    setRuns((prev) => prev.map((run) => (run.id === id ? { ...run, state: decision === 'approve' ? 'running' : run.state } : run)));
    const response = await fetch(`/api/runs/${id}/${decision}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const body = await response.json().catch(() => ({}));
    const problem = response.ok ? null : body.error ?? `could not ${decision} that command`;
    setRuns((prev) => prev.map((run) => (run.id === id ? { ...(body.run ?? run), problem } : run)));
  }, []);

  // A new question, with nothing behind it.
  // Approving is what opens it; the server re-checks the rule for its kind.
  const decideAction = useCallback(async (id, decision) => {
    setActions((prev) => prev.map((a) => (a.id === id ? { ...a, state: decision === 'approve' ? 'opening' : a.state } : a)));
    const response = await fetch(`/api/actions/${id}/${decision}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const body = await response.json().catch(() => ({}));
    const error = response.ok ? null : body.error ?? `could not ${decision} that`;
    setActions((prev) => prev.map((a) => (a.id === id ? { ...(body.action ?? a), error: error ?? body.action?.error ?? null } : a)));
  }, []);

  const newThread = useCallback(() => {
    setTurns([]);
    setEdits([]);
    setRuns([]);
    setActions([]);
    setPreview(null);
    setLive(null);
    setError(null);
    setDraft('');
    conversationRef.current = null;
  }, []);

  return {
    turns,
    edits,
    runs,
    actions,
    newThread,
    decideEdit,
    decideRun,
    decideAction,
    draft,
    setDraft,
    send,
    status,
    error,
    preview,
    live,
    spotlight,
    routing: live?.routing ?? preview?.routing ?? null,
    metrics: live?.metrics ?? preview?.metrics ?? null,
    ambiguity: preview?.ambiguity ?? null,
  };
}
