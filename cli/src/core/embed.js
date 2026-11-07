// Local embeddings, for the dense half of selection.
//
// Ported contract from the server's retrieval layer, with its most useful
// property kept: embedding is allowed to fail. If the model is not pulled, or
// Ollama is down, or it is slower than the wait budget, selection runs
// lexical-only rather than the run failing. A degraded ranking is recoverable;
// a refused run is not.
//
// There is no vector store. The candidate set for one task is a few pages, so
// the vectors are computed per run and thrown away. A persistent index is a
// phase-5 concern, and building one now would mean keeping it in sync with a
// vault the user edits by hand.

const EMBED_MODEL = process.env.SCOPE_EMBED_MODEL ?? 'nomic-embed-text';
// Warm, one embedding is ~25 ms. This only bites on a cold model load, and
// what it protects is the run: past this, rank lexically and move on.
const EMBED_WAIT_MS = 20_000;

export function embedModel() {
  return EMBED_MODEL;
}

/**
 * Embed a batch of texts. Returns null — not an error — when embeddings are
 * unavailable, because every caller's fallback is the same and better than
 * stopping.
 * @returns {Promise<number[][]|null>}
 */
export async function embed(config, texts) {
  if (texts.length === 0) return [];
  let res;
  try {
    res = await fetch(`${config.ollama.host}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
      signal: AbortSignal.timeout(EMBED_WAIT_MS),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let data;
  try {
    data = await res.json();
  } catch {
    return null;
  }
  const vectors = data.embeddings;
  if (!Array.isArray(vectors) || vectors.length !== texts.length) return null;
  if (!vectors.every((v) => Array.isArray(v) && v.length > 0)) return null;
  return vectors;
}

export function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Similarity of every chunk to the question, or null if embeddings are
 * unavailable. One batched call: the question is embedded alongside the chunks
 * so a cold load is paid once.
 */
export async function denseScores(config, question, chunks) {
  const vectors = await embed(config, [question, ...chunks.map((c) => c.text)]);
  if (!vectors) return null;
  const [query, ...rest] = vectors;
  return rest.map((vector, i) => ({ chunk: chunks[i], similarity: cosine(query, vector) }));
}
