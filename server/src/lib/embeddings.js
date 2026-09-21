const EMBED_MODEL = 'nomic-embed-text';
const EMBED_TIMEOUT_MS = 10_000;

// nomic-embed-text is trained with task prefixes; omitting them puts queries
// and documents in misaligned vector spaces and measurably hurts retrieval.
const QUERY_PREFIX = 'search_query: ';
const DOCUMENT_PREFIX = 'search_document: ';

function ollamaUrl() {
  return process.env.OLLAMA_URL || 'http://localhost:11434';
}

async function embed(text) {
  const response = await fetch(`${ollamaUrl()}/api/embed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: EMBED_MODEL, input: text }),
    signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Ollama embed failed: ${response.status} ${await response.text()}`);
  }
  const data = await response.json();
  return data.embeddings[0];
}

export function embedQuery(text) {
  return embed(QUERY_PREFIX + text);
}

export function embedDocument(text) {
  return embed(DOCUMENT_PREFIX + text);
}

// Node creation must not fail because Ollama is down; missing embeddings are
// backfilled later by `npm run embed`.
export async function tryEmbedDocument(text) {
  try {
    return await embedDocument(text);
  } catch {
    return null;
  }
}
