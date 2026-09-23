const STATUS_TIMEOUT_MS = 500;

// Qwen3 8B (Apache-2.0, 5.2 GB at Q4_K_M). A plain transformer on purpose: its
// KV cache can be rewound to where a prompt diverges, so a reworded question
// over an already-prefilled context costs 0.12 s against 2.95 s on qwen3.5:9b,
// whose hybrid layers can only append. Measured cold TTFT is also better
// (9.7 s vs 15.3 s). qwen3.5:9b answers in more detail — set OLLAMA_CHAT_MODEL
// to prefer it.
export const DEFAULT_CHAT_MODEL = 'qwen3:8b';

export function ollamaUrl() {
  return process.env.OLLAMA_URL || 'http://localhost:11434';
}

export function localChatModel() {
  return process.env.OLLAMA_CHAT_MODEL || DEFAULT_CHAT_MODEL;
}

// Ollama resolves an untagged name to `:latest`; match the way it does.
function withTag(name) {
  return name.includes(':') ? name : `${name}:latest`;
}

// One short probe answers both routing questions: is the server up, and is
// the chat model pulled. A running Ollama without the model cannot serve.
export async function localModelStatus(model = localChatModel()) {
  try {
    const response = await fetch(`${ollamaUrl()}/api/tags`, {
      signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
    });
    if (!response.ok) return { running: false, hasModel: false };
    const { models = [] } = await response.json();
    const wanted = withTag(model);
    return { running: true, hasModel: models.some((entry) => withTag(entry.name) === wanted) };
  } catch {
    return { running: false, hasModel: false };
  }
}

export async function isRunning() {
  return (await localModelStatus()).running;
}

// Splits an NDJSON byte stream into parsed objects as each line completes,
// so a token is forwarded the moment Ollama emits it — never accumulated.
export async function* parseNdjson(byteStream) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of byteStream) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) yield JSON.parse(line);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) yield JSON.parse(buffer);
}

export async function* streamChat({ model = localChatModel(), messages, options, signal }) {
  const response = await fetch(`${ollamaUrl()}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Thinking off: a grounded answer over retrieved context gains little from
    // it on a 9B model, and it would add seconds before the first visible token.
    body: JSON.stringify({ model, messages, options, stream: true, think: false }),
    signal,
  });
  if (!response.ok) {
    throw new Error(`Ollama chat failed: ${response.status} ${await response.text()}`);
  }
  for await (const chunk of parseNdjson(response.body)) {
    if (chunk.error) throw new Error(`Ollama chat failed: ${chunk.error}`);
    yield chunk;
  }
}
