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
import { buildMessages } from '../routing/prompt.js';
import { decideRoute, provisionalTier } from '../routing/route.js';

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

// Streams NDJSON: one `context` line (routing, the nodes in prompt order —
// citation [n] is nodes[n - 1] — and retrieval metrics), then `token` lines as
// the model emits them, then a terminal `done` or `error` line with the queryId.
router.post('/', async (req, res) => {
  const { query, project, tier, overrides } = req.body;
  if (!query || typeof query !== 'string' || !query.trim()) {
    return res.status(400).json({ error: 'query is required' });
  }
  if (tier && !TIER_CONFIGS[tier]) {
    return res.status(400).json({ error: `tier must be one of: ${Object.keys(TIER_CONFIGS).join(', ')}` });
  }

  const started = performance.now();
  // A client that disconnects, even mid-retrieval, stops generation instead of
  // leaving the model busy. A completed response has ended, so it never aborts.
  const upstream = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) upstream.abort();
  });
  const ownerId = req.session.userId;
  const text = query.trim();
  const model = localChatModel();

  const probeStart = performance.now();
  const status = await localModelStatus(model);
  const probeMs = performance.now() - probeStart;
  const localAvailable = status.running && status.hasModel;

  const provisional = provisionalTier({ localAvailable, preferredTier: tier });
  const gathered = await gatherCandidates({
    ownerId,
    query: text,
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
  const { messages, sources } = buildMessages({ query: text, selected: packed.selected, config });
  const metrics = await summarizeRetrieval({
    ownerId,
    tier: route.tier,
    gathered,
    packed: { selected: sources, tokens: packed.tokens },
  });

  const queryId = randomUUID();
  const routing = { decision: route.decision, tier: route.tier, reason: route.reason, provisionalTier: provisional };
  const record = (generation, served) =>
    recordRetrieval({
      queryId,
      ownerId,
      sessionId: req.sessionID,
      query: text,
      metrics,
      selected: sources,
      served,
      routing: {
        routingDecision: route.decision,
        routingDecisionMs,
        routingReason: route.reason,
        ...generation,
      },
    });

  if (route.blocked) {
    await record({}, false);
    return res.status(503).json({
      error: unavailableMessage(route, status, model),
      code: route.blocked,
      queryId,
      routing,
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
    routing: { ...routing, model: modelUsed },
    task: gathered.task,
    nodes: sources.map(presentNode),
    metrics,
  });

  let ttftMs = null;
  let outputTokens = null;
  let promptTokens = null;
  let failure = null;
  try {
    for await (const chunk of streamChat({ model, messages, options: LOCAL_OPTIONS, signal: upstream.signal })) {
      const token = chunk.message?.content;
      if (token) {
        ttftMs ??= Math.round(performance.now() - started);
        send({ type: 'token', text: token });
      }
      if (chunk.done) {
        outputTokens = chunk.eval_count ?? null;
        promptTokens = chunk.prompt_eval_count ?? null;
      }
    }
  } catch (err) {
    if (!upstream.signal.aborted) failure = err;
  }

  const totalResponseMs = Math.round(performance.now() - started);
  if (!upstream.signal.aborted) {
    if (failure) send({ type: 'error', queryId, error: failure.message });
    else send({ type: 'done', queryId, metrics: { ttftMs, totalResponseMs, outputTokens, promptTokens } });
    res.end();
  }

  // Written after the last token, so the metrics inserts never delay the answer.
  try {
    await record({ modelUsed, ttftMs, totalResponseMs, outputTokens }, true);
  } catch (err) {
    console.error(`failed to log metrics for query ${queryId}: ${err.message}`);
  }
});

export default router;
