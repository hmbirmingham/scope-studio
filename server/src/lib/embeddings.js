import { ollamaUrl } from './ollama.js';

const EMBED_MODEL = 'nomic-embed-text';
const EMBED_TIMEOUT_MS = 10_000;
// Long enough for a cold model load on a machine under memory pressure.
// Callers on a latency budget race this rather than shortening it: aborting
// the request cancels Ollama's load, so the next query would start over.
const QUERY_TIMEOUT_MS = 60_000;
const BATCH_TIMEOUT_MS = 120_000;
// 274 MB, used on nearly every query: keep it resident through a working
// session instead of reloading it after Ollama's 5-minute default.
const KEEP_ALIVE = '1h';

// nomic-embed-text is trained with task prefixes; omitting them puts queries
// and documents in misaligned vector spaces and measurably hurts retrieval.
const QUERY_PREFIX = 'search_query: ';
const DOCUMENT_PREFIX = 'search_document: ';

async function embed(input, timeoutMs) {
  const response = await fetch(`${ollamaUrl()}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, input, keep_alive: KEEP_ALIVE }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Ollama embed failed: ${response.status} ${await response.text()}`);
  }
  const data = await response.json();
  return data.embeddings;
}

export async function embedQuery(text) {
  return (await embed(QUERY_PREFIX + text, QUERY_TIMEOUT_MS))[0];
}

export async function embedDocument(text) {
  return (await embed(DOCUMENT_PREFIX + text, EMBED_TIMEOUT_MS))[0];
}

// One request for many documents: the model is loaded once and batched, which
// is several times faster than a call per document during ingestion.
export function embedDocuments(texts) {
  if (texts.length === 0) return Promise.resolve([]);
  return embed(texts.map((text) => DOCUMENT_PREFIX + text), BATCH_TIMEOUT_MS);
}

// Ingestion must not fail because Ollama is down; missing embeddings are
// backfilled later by `npm run embed`.
export async function tryEmbedDocument(text) {
  try {
    return await embedDocument(text);
  } catch {
    return null;
  }
}

export async function tryEmbedDocuments(texts) {
  try {
    return await embedDocuments(texts);
  } catch {
    return texts.map(() => null);
  }
}
