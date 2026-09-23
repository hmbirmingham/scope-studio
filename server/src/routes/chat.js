import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import requireAuth from '../middleware/requireAuth.js';
import { localChatModel, localModelStatus, streamChat } from '../lib/ollama.js';
import {
  gatherCandidates,
  packForTier,
  presentNode,
  recordRetrieval,
  summarizeRetrieval,
} from '../retrieval/retrieve.js';
import { TIER_CONFIGS, resolveConfig } from '../retrieval/score.js';
import { projectAmbiguity } from '../routing/ambiguity.js';
import {
  continuation,
  coveringDraft,
  draftKey,
  getConversation,
  retrievalQuery,
  saveConversation,
  saveDraft,
} from '../routing/conversation.js';
import { buildFollowUp, buildMessages, composeMessages } from '../routing/prompt.js';
import { decideRoute, provisionalTier } from '../routing/route.js';
import { beginGeneration, endGeneration, warmCache } from '../routing/warm.js';

// No cloud client until Sprint 6 brings the per-request user API key. The
// router still decides "cloud"; such requests are refused explicitly rather
// than silently answered somewhere else.
const CLOUD_AVAILABLE = false;

// Room for the local context budget in real Qwen tokens (token_length is a
// chars/4 estimate and code tokenizes denser), the system prompt, and the answer.
const LOCAL_OPTIONS = { num_ctx: 8192 };

const router = Router();
router.use(requireAuth);

function localFix(status, model) {
  return status.running
    ? `Run \`ollama pull ${model}\` to enable it.`
    : `Start Ollama with ${model} pulled to answer it.`;
}

function unavailableMessage(route, status, model) {
  if (route.blocked === 'cloud_unavailable') {
    return route.reason === 'user_override'
      ? 'Cloud routing needs an API key, which arrives with the cloud tier. Ask without choosing a tier to answer locally.'
      : `The local model is not available, and cloud routing needs an API key, which arrives with the cloud tier. ${localFix(status, model)}`;
  }
  const lead =
    route.reason === 'privacy_flag'
      ? 'This question draws on private context, which is only ever sent to the local model.'
      : 'The local model was requested but is not available.';
  return `${lead} ${localFix(status, model)}`;
}

function invalid({ query, tier }) {
  if (!query || typeof query !== 'string' || !query.trim()) return 'query is required';
  if (tier && !TIER_CONFIGS[tier]) return `tier must be one of: ${Object.keys(TIER_CONFIGS).join(', ')}`;
  return null;
}

// Everything both endpoints need: retrieval under the provisional tier, the
// routing decision from what was selected, and the exact messages to send —
// continuing an existing conversation when its context still covers the
// question, so the prefix stays cached.
async function planTurn(ownerId, sessionId, { query, project, tier, overrides, conversationId }) {
  const text = query.trim();
  const model = localChatModel();

  const probeStart = performance.now();
  const status = await localModelStatus(model);
  const probeMs = performance.now() - probeStart;
  const localAvailable = status.running && status.hasModel;

  const conversation = getConversation(conversationId, ownerId);
  const provisional = provisionalTier({ localAvailable, preferredTier: tier });
  const gathered = await gatherCandidates({
    ownerId,
    query: retrievalQuery(conversation, text),
    project,
    tier: provisional,
    overrides,
    embed: status.running,
  });

  const decideStart = performance.now();
  let packed = packForTier(gathered.candidates, provisional, overrides);
  const route = decideRoute({
    selected: packed.selected,
    preferredTier: tier,
    localAvailable,
    cloudAvailable: CLOUD_AVAILABLE,
  });
  if (route.tier !== provisional) packed = packForTier(gathered.candidates, route.tier, overrides);
  const routingDecisionMs = Math.round(probeMs + performance.now() - decideStart);

  const config = resolveConfig(route.tier, overrides);
  const continued = continuation(conversation, { selected: packed.selected, tier: route.tier });
  const prefilled = continued ? null : coveringDraft(draftKey(ownerId, sessionId), { selected: packed.selected, tier: route.tier });
  let messages;
  let sources;
  let contextBlock;
  let contextTokens;
  if (continued) {
    const { entry, added } = continued;
    const content = buildFollowUp(text, config, { sources: added, startIndex: entry.sources.length });
    messages = [...entry.messages, { role: 'user', content }];
    sources = [...entry.sources, ...added];
    contextTokens = entry.contextTokens + added.reduce((total, { node }) => total + node.token_length, 0);
  } else if (prefilled) {
    // Same block that was prefilled, new wording: the model re-reads only the question.
    messages = composeMessages(prefilled.contextBlock, text, config);
    ({ sources, contextBlock, contextTokens } = prefilled);
  } else {
    ({ messages, sources, contextBlock } = buildMessages({ query: text, selected: packed.selected, config }));
    contextTokens = packed.tokens;
  }

  const metrics = await summarizeRetrieval({
    ownerId,
    tier: route.tier,
    gathered,
    packed: { selected: sources, tokens: contextTokens },
  });

  return {
    text,
    model,
    status,
    route,
    gathered,
    messages,
    sources,
    contextBlock,
    contextTokens,
    metrics,
    routingDecisionMs,
    reused: Boolean(continued),
    routing: {
      decision: route.decision,
      tier: route.tier,
      reason: route.reason,
      provisionalTier: provisional,
      contextReused: Boolean(continued),
      prefilled: Boolean(prefilled),
      nodesAdded: continued ? continued.added.length : sources.length,
    },
  };
}

// Retrieval plus a background prefill, for a question still being typed. It
// answers in ~100 ms with the nodes it would read — which the UI can show
// while the model reads them — and records nothing: a draft is not a query.
router.post('/prepare', async (req, res) => {
  const problem = invalid(req.body);
  if (problem) return res.status(400).json({ error: problem });

  const plan = await planTurn(req.session.userId, req.sessionID, req.body);
  if (plan.contextBlock) {
    saveDraft(draftKey(req.session.userId, req.sessionID), {
      tier: plan.route.tier,
      sources: plan.sources,
      contextBlock: plan.contextBlock,
      contextTokens: plan.contextTokens,
    });
  }
  const warm =
    plan.route.blocked || plan.route.decision !== 'local'
      ? { warming: false, reason: plan.route.blocked ?? 'not_local' }
      : warmCache({ model: plan.model, messages: plan.messages, options: LOCAL_OPTIONS });

  res.json({
    routing: { ...plan.routing, model: `ollama/${plan.model}`, blocked: plan.route.blocked ?? null },
    nodes: plan.sources.map(presentNode),
    metrics: plan.metrics,
    ambiguity: projectAmbiguity(plan.gathered.candidates),
    warming: warm.warming,
    warmReason: warm.reason ?? null,
  });
});

// Streams NDJSON: one `context` line (routing, the nodes in prompt order —
// citation [n] is nodes[n - 1] — and retrieval metrics), then `token` lines as
// the model emits them, then a terminal `done` or `error` line with the queryId.
router.post('/', async (req, res) => {
  const problem = invalid(req.body);
  if (problem) return res.status(400).json({ error: problem });

  const started = performance.now();
  // A client that disconnects, even mid-retrieval, stops generation instead of
  // leaving the model busy. A completed response has ended, so it never aborts.
  const upstream = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) upstream.abort();
  });

  const ownerId = req.session.userId;
  const plan = await planTurn(ownerId, req.sessionID, req.body);
  const { route, model, sources, metrics } = plan;
  const conversationId = req.body.conversationId ?? randomUUID();

  const queryId = randomUUID();
  const record = (generation, served) =>
    recordRetrieval({
      queryId,
      ownerId,
      sessionId: req.sessionID,
      query: plan.text,
      metrics,
      selected: sources,
      served,
      routing: {
        routingDecision: route.decision,
        routingDecisionMs: plan.routingDecisionMs,
        routingReason: route.reason,
        ...generation,
      },
    });

  if (route.blocked) {
    await record({}, false);
    return res.status(503).json({
      error: unavailableMessage(route, plan.status, model),
      code: route.blocked,
      queryId,
      routing: plan.routing,
      nodes: sources.map(({ node }) => ({ id: node.id, type: node.type, project: node.project, privacy: node.privacy })),
    });
  }

  const modelUsed = `ollama/${model}`;
  res.status(200).set({
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  const send = (line) => res.write(`${JSON.stringify(line)}\n`);
  send({
    type: 'context',
    queryId,
    conversationId,
    routing: { ...plan.routing, model: modelUsed },
    task: plan.gathered.task,
    nodes: sources.map(presentNode),
    ambiguity: projectAmbiguity(plan.gathered.candidates),
    metrics,
  });

  let ttftMs = null;
  let outputTokens = null;
  let promptTokens = null;
  let failure = null;
  let answer = '';
  beginGeneration();
  try {
    for await (const chunk of streamChat({ model, messages: plan.messages, options: LOCAL_OPTIONS, signal: upstream.signal })) {
      const token = chunk.message?.content;
      if (token) {
        ttftMs ??= Math.round(performance.now() - started);
        answer += token;
        send({ type: 'token', text: token });
      }
      if (chunk.done) {
        outputTokens = chunk.eval_count ?? null;
        promptTokens = chunk.prompt_eval_count ?? null;
      }
    }
  } catch (err) {
    if (!upstream.signal.aborted) failure = err;
  } finally {
    endGeneration();
  }

  const totalResponseMs = Math.round(performance.now() - started);
  if (!upstream.signal.aborted) {
    if (failure) send({ type: 'error', queryId, error: failure.message });
    else send({ type: 'done', queryId, conversationId, metrics: { ttftMs, totalResponseMs, outputTokens, promptTokens } });
    res.end();
  }

  // Keeping the answer in the conversation makes the next question a pure
  // append, which the model's cache serves without re-reading the context.
  if (!failure && answer) {
    saveConversation(conversationId, ownerId, {
      tier: route.tier,
      sources,
      messages: [...plan.messages, { role: 'assistant', content: answer }],
      contextTokens: plan.contextTokens,
      lastQuestion: plan.text,
    });
  }

  // Written after the last token, so the metrics inserts never delay the answer.
  try {
    await record({ modelUsed, ttftMs, totalResponseMs, outputTokens }, true);
  } catch (err) {
    console.error(`failed to log metrics for query ${queryId}: ${err.message}`);
  }
});

export default router;
