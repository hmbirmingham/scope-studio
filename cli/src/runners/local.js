// The local model does the volume: generation, extraction, classification,
// summarising. Cloud is for judgement only, and it is rationed, so anything
// that can run here should.

// qwen3 is a reasoning model and will emit a <think> block unless told not to.
// We ask it not to and strip the block anyway, because the gates run against
// the answer and a leaked think block would fail them for the wrong reason.
const THINK_BLOCK = /<think>[\s\S]*?<\/think>\s*/gi;

// Rough but sufficient: the point is to catch a prompt that is twice the window,
// not to predict the last token. Code and markup run denser than prose, so this
// under-counts slightly, which is the safe direction for a budget check.
export function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

/**
 * Does this prompt fit, leaving room for an answer?
 *
 * Ollama silently drops whatever overflows the window. A model that cannot see
 * half its source material will either fail its grounding gates for the wrong
 * reason or invent something plausible to fill the gap — both are failures that
 * look like model weakness and are actually a budget bug. So this is checked
 * before generating, and an overflow is refused rather than truncated.
 */
export function fitsContext(config, { system = '', prompt = '', reserveForAnswer = 1024 }) {
  const limit = config.ollama.contextTokens;
  const needed = estimateTokens(system) + estimateTokens(prompt) + reserveForAnswer;
  return { ok: needed <= limit, needed, limit, reserveForAnswer };
}

export function stripThinking(text) {
  return text.replace(THINK_BLOCK, '').trim();
}

export async function ollamaUp(config) {
  try {
    const res = await fetch(`${config.ollama.host}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return { up: false, reason: `HTTP ${res.status}` };
    const { models = [] } = await res.json();
    return { up: true, models: models.map((m) => m.name) };
  } catch (err) {
    return { up: false, reason: err.name === 'TimeoutError' ? 'timed out' : err.message };
  }
}

/**
 * One local generation. Returns the answer plus the token counts the ledger
 * needs — a run trace without numbers cannot tell you what got cheaper.
 */
export async function generate(config, { system, prompt, timeoutMs = 300_000 }) {
  const started = Date.now();
  let res;
  try {
    res = await fetch(`${config.ollama.host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.ollama.model,
        stream: false,
        think: false,
        // Set explicitly: Ollama's own default is smaller than this model can
        // take, and leaving it unset makes the real budget invisible.
        options: { num_ctx: config.ollama.contextTokens },
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: prompt },
        ],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err.name === 'TimeoutError') throw new Error(`ollama timed out after ${timeoutMs}ms`);
    throw new Error(`ollama unreachable at ${config.ollama.host}: ${err.message}`);
  }
  if (!res.ok) {
    throw new Error(`ollama returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = await res.json();
  return {
    output: stripThinking(data.message?.content ?? ''),
    model: `ollama/${config.ollama.model}`,
    tokensIn: data.prompt_eval_count ?? null,
    tokensOut: data.eval_count ?? null,
    ms: Date.now() - started,
  };
}
