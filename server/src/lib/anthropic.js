import Anthropic from '@anthropic-ai/sdk';

// The cloud tier runs on the user's own key, sent per request and never
// stored: it does not touch the session, the database, or a log line.

// USD per million tokens. Metered tiers need the cost of a query at the time
// it ran, and input and output are priced differently, so the split cannot be
// recovered from a total later. Opus is priced here for accounting only — no
// plan routes to it (billing/plans.js).
const PRICES = {
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-opus-5': { input: 5, output: 25 },
};

// Measured answers run 40-280 tokens. This is headroom, not a target: it
// bounds what a single runaway answer can cost.
const MAX_TOKENS = 2048;

// Cache writes cost 1.25x input, reads 0.1x, so a context block read twice has
// already paid for itself. Our conversations keep that block byte-identical
// across turns, which is exactly the shape caching rewards.
const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.1;

// Web search is billed per search on top of tokens: $10 per thousand.
const WEB_SEARCH_USD = 0.01;
// Bounds what one question can spend on searching, and how long it can run.
const WEB_SEARCH_MAX_USES = 3;
// A server-side search can pause a long turn; the request is re-sent to let it
// finish. Past this many continuations the answer ends where it is.
const MAX_CONTINUATIONS = 3;

// The dynamic-filtering search runs on the newer models only; Haiku keeps the
// basic tool.
const WEB_SEARCH_TOOL = {
  'claude-sonnet-5': 'web_search_20260209',
  'claude-opus-5': 'web_search_20260209',
  'claude-haiku-4-5': 'web_search_20250305',
};

// Haiku 4.5 rejects the effort parameter outright (400), so it is sent only to
// models that take it. Found live: every platform answer past half the week's
// allowance switches to Haiku and failed until this was gated.
const EFFORT_MODELS = new Set(['claude-sonnet-5', 'claude-opus-5']);

export function effortConfig(model, effort) {
  const level = process.env.CLOUD_EFFORT || effort;
  return EFFORT_MODELS.has(model) && level ? { output_config: { effort: level } } : {};
}

export function webSearchTool(model) {
  return { type: WEB_SEARCH_TOOL[model] ?? 'web_search_20250305', name: 'web_search', max_uses: WEB_SEARCH_MAX_USES };
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
  const searches = usage.server_tool_use?.web_search_requests ?? 0;
  return (
    (fresh * price.input +
      written * price.input * CACHE_WRITE_MULTIPLIER +
      read * price.input * CACHE_READ_MULTIPLIER +
      output * price.output) /
      1_000_000 +
    searches * WEB_SEARCH_USD
  );
}

// Usage from several requests (a paused search turn is re-sent) summed into one.
export function addUsage(total, usage) {
  if (!usage) return total;
  const sum = (key) => (total?.[key] ?? 0) + (usage[key] ?? 0);
  return {
    input_tokens: sum('input_tokens'),
    output_tokens: sum('output_tokens'),
    cache_creation_input_tokens: sum('cache_creation_input_tokens'),
    cache_read_input_tokens: sum('cache_read_input_tokens'),
    server_tool_use: {
      web_search_requests:
        (total?.server_tool_use?.web_search_requests ?? 0) + (usage.server_tool_use?.web_search_requests ?? 0),
    },
  };
}

// The pages an answer actually cited, deduplicated by URL, in citation order.
export function webCitations(content) {
  const seen = new Map();
  for (const block of content ?? []) {
    if (block.type !== 'text') continue;
    for (const citation of block.citations ?? []) {
      if (citation.type !== 'web_search_result_location' || seen.has(citation.url)) continue;
      seen.set(citation.url, { url: citation.url, title: citation.title ?? citation.url });
    }
  }
  return [...seen.values()];
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

// Our prompts carry the system instruction as the first message; the Messages
// API takes it as its own parameter.
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
// matching the shape the local client yields so the route streams either the
// same way. With `webSearch`, also `{ searching: query }` as each search runs
// and `{ citations }` before done.
export async function* streamChat({ apiKey, model, effort, messages, cacheMarker, signal, webSearch = false }) {
  const client = createClient(apiKey);
  const { system, rest } = splitSystem(withCacheBreakpoint(messages, cacheMarker));
  const conversation = [...rest];
  const content = [];
  let usage = null;
  let final;

  for (let turn = 0; turn <= MAX_CONTINUATIONS; turn++) {
    const stream = client.messages.stream(
      {
        model,
        max_tokens: MAX_TOKENS,
        system,
        messages: conversation,
        ...effortConfig(model, effort),
        ...(webSearch ? { tools: [webSearchTool(model)] } : {}),
      },
      { signal }
    );

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield { text: event.delta.text };
      }
      if (event.type === 'content_block_stop') {
        const block = stream.currentMessage?.content?.[event.index];
        if (block?.type === 'server_tool_use' && block.name === 'web_search' && block.input?.query) {
          yield { searching: block.input.query };
        }
      }
    }

    final = await stream.finalMessage();
    usage = addUsage(usage, final.usage);
    content.push(...final.content);
    // A paused server-tool turn is resumed by sending it back as it stands.
    if (final.stop_reason !== 'pause_turn') break;
    conversation.push({ role: 'assistant', content: final.content });
  }

  if (webSearch) yield { citations: webCitations(content) };
  yield { done: true, usage, stopReason: final.stop_reason };
}

// A refusal or an auth failure should read as a sentence, not a stack trace.
export function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) return 'That API key was rejected by Anthropic.';
  if (err instanceof Anthropic.RateLimitError) return 'Anthropic rate-limited this key — try again shortly.';
  if (err instanceof Anthropic.APIError) return `Anthropic returned ${err.status}: ${err.message}`;
  return err.message;
}
