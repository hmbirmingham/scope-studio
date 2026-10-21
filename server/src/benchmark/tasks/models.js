import { costUsd, streamChat as streamAnthropic } from '../../lib/anthropic.js';
import { platformModel } from '../../billing/plans.js';
import { localAdapter } from '../../workspace/modelPort.js';
import { estimateTokens, promptTokens, worstCaseUsd } from '../endurance/economics.js';

// The models each arm talks to, behind the ModelPort interface the runner
// already uses. A dry run gets scripted ports: deterministic replies from the
// task's `dry` script, token counts measured from the prompts actually built,
// and cloud calls priced from those counts. Nothing in a dry run opens a
// socket to a model. A live run gets the real local model and, only with the
// platform key and a spend cap, the real cloud.

// What a dry run's cloud calls are priced as: the model the platform would
// pick for this plan and kind of call (billing/plans.js), so a dry local+cloud
// run costs what the same calls would.
export const SCOPE_CLOUD_PLAN = 'engineer';
export function scopeCloudModel({ purpose, hard }) {
  return platformModel(SCOPE_CLOUD_PLAN, { hard: hard === true || purpose === 'plan' });
}

// The scripted agent behind every dry arm. Planning calls get the task's plan;
// every other call gets the next scripted action as the chooser's JSON, then
// `done` once the script is spent. Both arms read from their own copy of the
// same script, so they do the same work.
export function createScript(task) {
  const actions = [...task.dry.actions];
  let next = 0;
  return {
    reply({ purpose }) {
      if (purpose === 'plan') return task.dry.plan;
      if (next < actions.length) {
        const { capability, input, summary } = actions[next];
        next += 1;
        return JSON.stringify({ capability, input, hard: false, done: false, summary });
      }
      return JSON.stringify({ done: true, summary: task.dry.summary ?? 'Done' });
    },
    remaining: () => actions.length - next,
  };
}

// Every model call an arm makes, with its prompt size and the usage split the
// way the bill splits it. This is where the per-step context curve comes from.
export function createCallLog() {
  const calls = [];
  return {
    calls,
    record(entry) {
      calls.push({ index: calls.length + 1, ...entry });
    },
  };
}

function usageEntry({ purpose, adapter, model, prompt, usage, usd, ms }) {
  return {
    purpose,
    adapter,
    model,
    promptTokens: prompt,
    inputTokens: usage?.input_tokens ?? 0,
    cacheWriteTokens: usage?.cache_creation_input_tokens ?? 0,
    cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    costUsd: usd ?? 0,
    ms,
  };
}

// A scripted ModelPort. `name` is the adapter it stands in for; a 'local'
// port costs nothing, any other is priced as the platform's model for the
// call. Two chunks, so the runner must reassemble the reply as it would a
// real stream.
export function scriptedPort({ name, script, log }) {
  return {
    name,
    offline: name === 'local',
    async *stream({ messages, purpose = 'step', hard = false, signal }) {
      if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      const started = performance.now();
      const text = script.reply({ purpose });
      const prompt = promptTokens({ messages });
      const usage = { input_tokens: prompt, output_tokens: estimateTokens(text) };
      const model = name === 'local' ? 'scripted-local' : scopeCloudModel({ purpose, hard });
      const usd = name === 'local' ? 0 : costUsd(model, usage) ?? 0;
      const cut = Math.floor(text.length / 2);
      yield { text: text.slice(0, cut) };
      yield { text: text.slice(cut) };
      log.record(usageEntry({ purpose, adapter: name, model, prompt, usage, usd, ms: Math.round(performance.now() - started) }));
      yield { done: true, usage, costUsd: usd, model };
    },
  };
}

// The real local model (Ollama), recorded. Allowed in a live-local run; no
// key, no spend.
export function recordedLocalPort({ log, adapter = localAdapter() }) {
  return {
    name: 'local',
    offline: true,
    async *stream(request) {
      const started = performance.now();
      let done = null;
      for await (const chunk of adapter.stream(request)) {
        if (chunk.done) done = chunk;
        else yield chunk;
      }
      const prompt = done?.usage?.input_tokens || promptTokens({ messages: request.messages });
      log.record(usageEntry({ purpose: request.purpose ?? 'step', adapter: 'local', model: done?.model ?? null, prompt, usage: done?.usage, usd: 0, ms: Math.round(performance.now() - started) }));
      yield { ...(done ?? { done: true, usage: null, costUsd: 0, model: null }) };
    },
  };
}

// A live cloud call is refused before it is sent when its worst case could
// cross the run's cap. For the Scope arm the refusal is `platform_unavailable`,
// which the runner answers locally, exactly as it does when the real platform
// says the allowance is spent.
export function capRefusal(cap) {
  return Object.assign(new Error('the benchmark spend cap would be crossed'), { code: 'platform_unavailable', reason: 'benchmark_cap', cap: cap.stopped });
}

const LIVE_MAX_TOKENS = 1024;

// The platform's cloud for a live Scope run, called with the platform key
// directly (the benchmark has no device sign-in). The model is the one the
// control plane would pick for this plan and kind of call.
export function livePlatformPort({ apiKey, cap, log, stream = streamAnthropic }) {
  if (!apiKey) throw new Error('a live cloud port needs the platform key');
  return {
    name: 'platform',
    offline: false,
    async *stream({ messages, purpose = 'step', hard = false, signal, maxTokens = LIVE_MAX_TOKENS }) {
      const model = scopeCloudModel({ purpose, hard });
      const ceiling = Math.min(maxTokens ?? LIVE_MAX_TOKENS, LIVE_MAX_TOKENS);
      if (!cap.allows(worstCaseUsd(model, promptTokens({ messages }), ceiling))) throw capRefusal(cap);
      const started = performance.now();
      let usage = null;
      for await (const event of stream({ apiKey, model, messages, maxTokens: ceiling, signal })) {
        if (event.text) yield { text: event.text };
        if (event.done) usage = event.usage;
      }
      const usd = costUsd(model, usage) ?? 0;
      cap.settle(usd);
      log.record(usageEntry({ purpose, adapter: 'platform', model, prompt: promptTokens({ messages }), usage, usd, ms: Math.round(performance.now() - started) }));
      yield { done: true, usage, costUsd: usd, model };
    },
  };
}
