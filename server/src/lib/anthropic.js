import Anthropic from '@anthropic-ai/sdk';

// The cloud tier runs on the user's own key, sent per request and never
// stored: it does not touch the session, the database, or a log line.

export const DEFAULT_CLOUD_MODEL = 'claude-opus-5';

// USD per million tokens. Metered tiers need the cost of a query at the time
// it ran, and input and output are priced differently, so the split cannot be
// recovered from a total later.
const PRICES = {
  'claude-opus-5': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

// Answers are grounded in retrieved context and run against a weekly budget,
// so the ceiling is deliberately low; the Sprint 7 benchmark is what should
// tune this and the effort level against measured answer quality.
const MAX_TOKENS = 8192;

export function cloudChatModel() {
  return process.env.CLOUD_CHAT_MODEL || DEFAULT_CLOUD_MODEL;
}

export function cloudEffort() {
  return process.env.CLOUD_EFFORT || 'medium';
}

export function priceFor(model) {
  return PRICES[model] ?? null;
}

// Cache reads are cheaper than fresh input, but they are counted as input
// here rather than guessed at — the number stays honest, if slightly high.
export function costUsd(model, usage) {
  const price = priceFor(model);
  if (!price || !usage) return null;
  const input = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
  const output = usage.output_tokens ?? 0;
  return (input * price.input + output * price.output) / 1_000_000;
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
// same way.
export async function* streamChat({ apiKey, model = cloudChatModel(), messages, signal }) {
  const client = createClient(apiKey);
  const { system, rest } = splitSystem(messages);

  const stream = client.messages.stream(
    {
      model,
      max_tokens: MAX_TOKENS,
      system,
      messages: rest,
      output_config: { effort: cloudEffort() },
    },
    { signal }
  );

  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      yield { text: event.delta.text };
    }
  }

  const final = await stream.finalMessage();
  yield { done: true, usage: final.usage, stopReason: final.stop_reason };
}

// A refusal or an auth failure should read as a sentence, not a stack trace.
export function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) return 'That API key was rejected by Anthropic.';
  if (err instanceof Anthropic.RateLimitError) return 'Anthropic rate-limited this key — try again shortly.';
  if (err instanceof Anthropic.APIError) return `Anthropic returned ${err.status}: ${err.message}`;
  return err.message;
}
