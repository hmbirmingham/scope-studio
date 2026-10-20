import Anthropic from '@anthropic-ai/sdk';

// The platform's side of the cloud: answers paid for out of a plan's budget,
// on the platform's key. It is the engine's server/src/lib/anthropic.js cut
// down to what a platform answer may do. There is no web search here: that is
// Key Pro only, on the user's own key, called from the engine. Prompt and
// answer text pass through this module and nowhere else: nothing here logs or
// keeps them.

// USD per million tokens. A platform answer is charged against the week's
// allowance at the price it ran at, and input and output are priced
// differently, so the split cannot be recovered from a total later.
const PRICES = {
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-opus-5': { input: 5, output: 25 },
};

// Measured answers run 40-280 tokens. This is headroom, not a target: it
// bounds what a single runaway answer can cost.
export const MAX_TOKENS = 2048;

// Cache writes cost 1.25x input, reads 0.1x, so a context block read twice has
// already paid for itself. The engine keeps that block byte-identical across
// turns, which is exactly the shape caching rewards.
const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

// Haiku 4.5 rejects the effort parameter outright (400), so it is sent only to
// models that take it. Found live on the engine: every answer that stepped
// down to Haiku failed until this was gated.
const EFFORT_MODELS = new Set(['claude-sonnet-5', 'claude-opus-5']);

// Unlike the engine, there is no environment override for effort: the plan
// (billing/plans.js) is the only authority on what a platform answer may spend.
export function effortConfig(model, effort) {
  return EFFORT_MODELS.has(model) && effort ? { output_config: { effort } } : {};
}

export function priceFor(model) {
  return PRICES[model] ?? null;
}

export function costUsd(model, usage) {
  const price = priceFor(model);
  if (!price || !usage) return null;
  const fresh = usage.input_tokens ?? 0;
  const written = usage.cache_creation_input_tokens ?? 0;
  const read = usage.cache_read_input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  return (
    (fresh * price.input +
      written * price.input * CACHE_WRITE_MULTIPLIER +
      read * price.input * CACHE_READ_MULTIPLIER +
      output * price.output) /
    1_000_000
  );
}

// The token counts an answer is charged on, with every field present, so the
// ledger and the engine never have to guess at a missing one.
export function tokenUsage(usage) {
  return {
    input_tokens: usage?.input_tokens ?? 0,
    output_tokens: usage?.output_tokens ?? 0,
    cache_creation_input_tokens: usage?.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: usage?.cache_read_input_tokens ?? 0,
  };
}

// The stream reports usage twice: input (and cache) counts when the message
// starts, then running totals when it ends. Each report is cumulative, so a
// later value replaces an earlier one rather than adding to it.
export function mergeUsage(seen, reported) {
  if (!reported) return seen;
  const merged = { ...tokenUsage(seen) };
  for (const key of Object.keys(merged)) {
    if (typeof reported[key] === 'number') merged[key] = reported[key];
  }
  return merged;
}

// The context block is the expensive, stable part of the prompt and the
// question is the cheap, volatile one. Splitting the first user turn between
// them puts the cache breakpoint after the context, so every later turn on the
// same context pays a tenth of its input price.
export function withCacheBreakpoint(messages, marker) {
  const first = messages.findIndex((message) => message.role === 'user');
  if (first === -1 || !marker) return messages;
  const content = messages[first].content;
  if (typeof content !== 'string') return messages;
  const at = content.indexOf(marker);
  if (at <= 0) return messages;

  const copy = [...messages];
  copy[first] = {
    role: 'user',
    content: [
      { type: 'text', text: content.slice(0, at), cache_control: { type: 'ephemeral' } },
      { type: 'text', text: content.slice(at) },
    ],
  };
  return copy;
}

// Asks for a shorter answer by appending to the latest question, after the
// cache breakpoint, so the cached context block is untouched. Paired with a
// lower max_tokens; the note is what keeps the answer from being cut off.
// The engine may send content blocks here, so a block list gets the note as a
// block of its own rather than going without it.
export const BREVITY_NOTE = '\n\nKeep this answer under about 250 words unless the question asks for detail.';

export function withBrevityNote(messages) {
  const last = messages.findLastIndex((message) => message.role === 'user');
  if (last === -1) return messages;
  const { content } = messages[last];
  const copy = [...messages];
  copy[last] = {
    ...copy[last],
    content: typeof content === 'string' ? content + BREVITY_NOTE : [...content, { type: 'text', text: BREVITY_NOTE.trim() }],
  };
  return copy;
}

// The engine's prompts carry the system instruction as the first message; the
// Messages API takes it as its own parameter.
export function splitSystem(messages) {
  const system = messages.find((message) => message.role === 'system');
  return {
    system: system?.content,
    rest: messages.filter((message) => message.role !== 'system'),
  };
}

export function createClient(apiKey) {
  return new Anthropic({
    apiKey,
    // Lets the tests point the SDK at a local stand-in; unset in production.
    baseURL: process.env.ANTHROPIC_BASE_URL || undefined,
    maxRetries: 1,
  });
}

// Yields `{ text }` per delta and finally `{ done: true, usage, stopReason }`,
// the shape the engine's streamChat yields. `onUsage` is told the usage seen
// so far each time the stream reports it, so a caller whose client hangs up
// mid-answer can still charge for what the platform was billed.
export async function* streamChat({ apiKey, model, effort, messages, cacheMarker, signal, maxTokens = MAX_TOKENS, brevity = false, onUsage }) {
  const client = createClient(apiKey);
  const { system, rest } = splitSystem(withCacheBreakpoint(brevity ? withBrevityNote(messages) : messages, cacheMarker));
  const stream = client.messages.stream(
    {
      model,
      max_tokens: maxTokens,
      ...(system ? { system } : {}),
      messages: rest,
      ...effortConfig(model, effort),
    },
    { signal }
  );

  let usage = null;
  for await (const event of stream) {
    if (event.type === 'message_start') {
      usage = mergeUsage(null, event.message?.usage);
      onUsage?.(usage);
    }
    if (event.type === 'message_delta') {
      usage = mergeUsage(usage, event.usage);
      onUsage?.(usage);
    }
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      yield { text: event.delta.text };
    }
  }

  const final = await stream.finalMessage();
  yield { done: true, usage: tokenUsage(final.usage), stopReason: final.stop_reason };
}

// What the engine is told when an answer fails. Upstream error text can echo
// the request, so it never goes out: only a sentence chosen from the kind of
// failure. A rejected platform key is the platform's problem, not the user's,
// and reads that way.
export function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return 'Scope Studio cloud is unavailable right now. Your local model can still answer.';
  }
  if (err instanceof Anthropic.RateLimitError) return 'Scope Studio cloud is busy. Try again shortly.';
  if (err instanceof Anthropic.APIConnectionError) return 'The cloud model could not be reached. Try again shortly.';
  if (err instanceof Anthropic.APIError && err.status) return `The cloud model returned an error (${err.status}). Try again shortly.`;
  return 'The cloud answer stopped partway through. Try again shortly.';
}

// A short, content-free label for a failure, safe for a log line: a status
// code or an error class, never a message.
export function failureKind(err) {
  if (err instanceof Anthropic.APIError && err.status) return `status ${err.status}`;
  return err?.constructor?.name ?? 'unknown';
}
