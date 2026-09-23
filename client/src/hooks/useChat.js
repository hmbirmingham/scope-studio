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

export function useChat({ project, apiKey, tier }) {
  const [turns, setTurns] = useState([]);
  const [draft, setDraft] = useState('');
  // What the server would read for the question being typed, with its prefill
  // already running: the map lights up before anything is asked.
  const [preview, setPreview] = useState(null);
  const [live, setLive] = useState(null);
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState(null);

  const conversationRef = useRef(null);
  const answeringRef = useRef(false);

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

    const answer = { role: 'assistant', text: '', sources: [], routing: null, metrics: null };
    try {
      const { ok, body } = await postJson(
        '/api/chat',
        { query: text, project, tier, conversationId: conversationRef.current },
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
          setStatus('answering');
          setLive({ ...answer });
        } else if (line.type === 'token') {
          answer.text += line.text;
          setLive({ ...answer });
        } else if (line.type === 'done') {
          answer.metrics = { ...answer.metrics, ...line.metrics };
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
  }, [draft, project, tier, apiKey]);

  // What the canvas should light up right now: the question being typed wins,
  // then the answer being written, then the last answer given.
  const spotlight = preview?.nodes ?? live?.sources ?? turns.at(-1)?.sources ?? [];

  return {
    turns,
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
