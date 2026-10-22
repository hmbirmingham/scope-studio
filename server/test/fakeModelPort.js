// A scripted ModelPort for runner tests: replies come from a queue, every call
// is recorded, and nothing leaves the process. A reply is a string, an object
// (sent as JSON), a function of the request returning either, or an Error
// (thrown, e.g. one with code 'platform_unavailable'). When the queue is empty
// `fallback` answers, so a long run need not script every step. `usage` may
// be a function of the request, to report what a particular call cost, and
// so may `stopReason` (why the reply ended, as an adapter reports it).
export function createFakeModelPort({ name = 'local', responses = [], fallback = null, usage = { input_tokens: 100, output_tokens: 20 }, costUsd = 0, model = `fake-${name}`, delayMs = 0, stopReason = null } = {}) {
  const queue = [...responses];
  const calls = [];

  function reply(request) {
    const next = queue.length > 0 ? queue.shift() : fallback;
    if (next == null) throw new Error(`fake ${name} model has no scripted reply for call ${calls.length}`);
    const value = typeof next === 'function' ? next(request, calls.length - 1) : next;
    if (value instanceof Error) throw value;
    return typeof value === 'string' ? value : JSON.stringify(value);
  }

  return {
    name,
    offline: name === 'local',
    calls,
    push(...more) {
      queue.push(...more);
    },
    remaining: () => queue.length,
    async *stream({ messages, maxTokens, signal, purpose, format }) {
      const request = { messages, maxTokens, purpose, format };
      calls.push(request);
      if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      const text = reply(request);
      if (delayMs) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, delayMs);
          signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          }, { once: true });
        });
      }
      // Two chunks, so callers must reassemble the reply.
      const cut = Math.floor(text.length / 2);
      if (text.slice(0, cut)) yield { text: text.slice(0, cut) };
      if (text.slice(cut)) yield { text: text.slice(cut) };
      yield {
        done: true,
        usage: typeof usage === 'function' ? usage(request, text) : usage,
        costUsd,
        model,
        stopReason: typeof stopReason === 'function' ? stopReason(request, text) : stopReason,
      };
    },
  };
}

export function platformUnavailable() {
  return Object.assign(new Error('the platform model is not connected yet'), { code: 'platform_unavailable' });
}
