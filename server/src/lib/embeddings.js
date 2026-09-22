const EMBED_MODEL = 'nomic-embed-text';
const EMBED_TIMEOUT_MS = 10_000;
const BATCH_TIMEOUT_MS = 120_000;

// nomic-embed-text is trained with task prefixes; omitting them puts queries
// and documents in misaligned vector spaces and measurably hurts retrieval.
const QUERY_PREFIX = 'search_query: ';
const DOCUMENT_PREFIX = 'search_document: ';

function ollamaUrl() {
  return process.env.OLLAMA_URL || 'http://localhost:11434';
}

async function embed(input, timeoutMs) {
  const response = await fetch(`${ollamaUrl()}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, input }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Ollama embed failed: ${response.status} ${await response.text()}`);
  }
  const data = await response.json();
  return data.embeddings;
}

export async function embedQuery(text) {
  return (await embed(QUERY_PREFIX + text, EMBED_TIMEOUT_MS))[0];
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
