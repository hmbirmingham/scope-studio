import { costUsd, streamChat as streamAnthropic } from '../lib/anthropic.js';
import { localChatModel, streamChat as streamOllama } from '../lib/ollama.js';
import { deviceToken } from '../control/plan.js';
import { streamPlatform } from '../control/platform.js';

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

// The context window a run's local calls ask for: the same as chat's
// (routes/chat.js), so the model is not reloaded at another size between a
// chat answer and a run step, and large enough for a chooser prompt plus a
// code-writing reply, which Ollama's 4,096-token default could truncate.
export const LOCAL_NUM_CTX = 8192;

export function localAdapter({ model = localChatModel(), stream = streamOllama } = {}) {
  return {
    name: 'local',
    offline: true,
    async *stream({ messages, maxTokens, signal, format }) {
      let usage = null;
      let stopReason = null;
      const options = { num_ctx: LOCAL_NUM_CTX, ...(maxTokens ? { num_predict: maxTokens } : {}) };
      for await (const chunk of stream({ model, messages, options, format, signal })) {
        if (chunk.message?.content) yield { text: chunk.message.content };
        if (chunk.done) {
          usage = { input_tokens: chunk.prompt_eval_count ?? 0, output_tokens: chunk.eval_count ?? 0 };
          // Ollama says 'length' when the reply hit num_predict.
          stopReason = chunk.done_reason ?? null;
        }
      }
      yield { done: true, usage, costUsd: 0, model, stopReason };
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
        if (event.done) yield { done: true, usage: event.usage, costUsd: costUsd(model, event.usage), model, stopReason: event.stopReason ?? null };
      }
    },
  };
}

// The platform adapter: the control plane's POST /v1/cloud/messages with this
// user's device token (control/platform.js). The control plane picks the
// model, effort and output ceiling from the plan, so `maxTokens` is not sent.
// A planning call or a step marked hard asks for the plan's hard-question
// model. Without a token, or when the control plane refuses (signed out,
// offline, allowance spent), `stream` throws `code: 'platform_unavailable'`
// before yielding anything, and the runner answers locally instead.
//
// `ownerId` is the local user whose sign-in pays; `sources` are the plug-ins
// whose nodes are in the context, which the control plane records per answer.
export function platformAdapter({ ownerId, token, sources = [], getToken = deviceToken, fetchImpl, base } = {}) {
  return {
    name: 'platform',
    offline: false,
    async *stream({ messages, signal, purpose, hard }) {
      const bearer = token ?? (ownerId ? await getToken(ownerId) : null);
      yield* streamPlatform({
        token: bearer,
        messages,
        hard: hard === true || purpose === 'plan',
        sources,
        signal,
        ...(fetchImpl ? { fetchImpl } : {}),
        ...(base ? { base } : {}),
      });
    },
  };
}
