import { costUsd, streamChat as streamAnthropic } from '../lib/anthropic.js';
import { localChatModel, streamChat as streamOllama } from '../lib/ollama.js';

// One interface for every model a run can use (docs/architecture/agent-workspace.md,
// "ModelPort"). The runner asks `selectAdapter` which one a step gets, then
// calls `stream` on it; it never branches on the adapter, so adding or
// changing one cannot change how a run behaves.
//
// port.stream({ messages, maxTokens, signal, purpose, format })
//   yields { text } … then { done: true, usage, costUsd, model }
// `format: 'json'` asks for a single JSON reply where the adapter supports it;
// an adapter that cannot constrain its output ignores it, and the caller
// still validates what comes back.

export const ADAPTERS = ['local', 'own_key', 'platform'];
export const MODEL_POLICIES = ['local_only', 'local_cloud', 'own_key'];

// Which adapter a step uses, and why. The cloud is only ever for planning or a
// step marked hard; ordinary execution steps stay local, which is what keeps a
// long run cheap. Privacy and offline outrank everything.
export function selectAdapter({ policy = 'local_only', purpose = 'step', hard = false, online = true, plan = 'free', hasOwnKey = false, privateContext = false }) {
  if (privateContext) return { adapter: 'local', reason: 'private_context' };
  if (!online) return { adapter: 'local', reason: 'offline' };
  if (policy === 'local_only') return { adapter: 'local', reason: 'policy' };
  if (purpose !== 'plan' && !hard) return { adapter: 'local', reason: 'execution_step' };

  if (policy === 'own_key') {
    if (plan === 'key_pro' && hasOwnKey) return { adapter: 'own_key', reason: 'own_key' };
    return { adapter: 'local', reason: plan === 'key_pro' ? 'no_key' : 'own_key_requires_key_pro' };
  }
  // local_cloud: Key Pro brings its own key; Student and Engineer use the
  // platform's, metered by the control plane; Free has no cloud.
  if (plan === 'key_pro') {
    return hasOwnKey ? { adapter: 'own_key', reason: 'own_key' } : { adapter: 'local', reason: 'no_key' };
  }
  if (plan === 'student' || plan === 'engineer') return { adapter: 'platform', reason: 'platform' };
  return { adapter: 'local', reason: 'plan_has_no_cloud' };
}

export function localAdapter({ model = localChatModel(), stream = streamOllama } = {}) {
  return {
    name: 'local',
    offline: true,
    async *stream({ messages, maxTokens, signal, format }) {
      let usage = null;
      for await (const chunk of stream({ model, messages, options: maxTokens ? { num_predict: maxTokens } : undefined, format, signal })) {
        if (chunk.message?.content) yield { text: chunk.message.content };
        if (chunk.done) usage = { input_tokens: chunk.prompt_eval_count ?? 0, output_tokens: chunk.eval_count ?? 0 };
      }
      yield { done: true, usage, costUsd: 0, model };
    },
  };
}

export function ownKeyAdapter({ apiKey, model, effort, stream = streamAnthropic }) {
  if (!apiKey) throw new Error('own_key adapter needs the user’s key');
  return {
    name: 'own_key',
    offline: false,
    async *stream({ messages, maxTokens, signal }) {
      for await (const event of stream({ apiKey, model, effort, messages, maxTokens, signal })) {
        if (event.text) yield { text: event.text };
        if (event.done) yield { done: true, usage: event.usage, costUsd: costUsd(model, event.usage), model };
      }
    },
  };
}

// The platform adapter calls the control plane's /v1/cloud/messages with the
// device token (Wave 2, path F). Until that lands it refuses, and
// selectAdapter's caller falls back to local.
export function platformAdapter() {
  return {
    name: 'platform',
    offline: false,
    async *stream() {
      throw Object.assign(new Error('the platform model is not connected yet'), { code: 'platform_unavailable' });
    },
  };
}
