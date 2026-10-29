import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import requireAuth from '../middleware/requireAuth.js';
import { questionDifficulty } from '../routing/difficulty.js';
import { localChatModel, localModelStatus, streamChat as streamLocal } from '../lib/ollama.js';
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
  readsAsFollowUp,
  retrievalQuery,
  saveConversation,
  saveDraft,
} from '../routing/conversation.js';
import { buildFollowUp, buildMessages, composeMessages } from '../routing/prompt.js';
import { decideRoute, provisionalTier } from '../routing/route.js';
import { parseEdits, presentProposal, recordProposals } from '../editing/proposals.js';
import { declaredScripts, parseRuns, presentRun, recordRuns } from '../editing/commands.js';
import { autoOpens, openNow, parseActions, presentAction, recordActions } from '../editing/actions.js';
import { displayControlAllowed } from './actions.js';
import { getProjectSettings } from '../models/projectSettings.js';
import { beginGeneration, endGeneration, warmCache } from '../routing/warm.js';

// Room for the local context budget in real Qwen tokens (token_length is a
// chars/4 estimate and code tokenizes denser), the system prompt, and the answer.
const LOCAL_OPTIONS = { num_ctx: 8192 };

const router = Router();
router.use(requireAuth);

function describeLocalError(err) {
  return `The local model stopped answering: ${err.message}`;
}

function localFix(status, model) {
  return status.running
    ? `Run \`ollama pull ${model}\` to enable it.`
    : `Start Ollama with ${model} pulled to answer it.`;
}

function unavailableMessage(route, status, model) {
  // Choosing a cloud tier is not a missing API key any more — this engine has
  // no cloud at all. Cloud work goes through the scope CLI, which spends a
  // rationed daily budget on headless Claude Code.
  if (route.reason === 'user_override' && route.blocked === 'cloud_unavailable') {
    return `This engine answers with the local model only. Ask without choosing a tier. ${localFix(status, model)}`;
  }
  const lead =
    route.reason === 'privacy_flag'
      ? 'This question draws on private context, which is only ever sent to the local model.'
      : 'The local model was requested but is not available.';
  return `${lead} ${localFix(status, model)}`;
}

function invalid({ query, tier, displayControl }) {
  if (!query || typeof query !== 'string' || !query.trim()) return 'query is required';
  if (displayControl !== undefined && typeof displayControl !== 'boolean') return 'displayControl must be true or false';
  if (tier && !TIER_CONFIGS[tier]) return `tier must be one of: ${Object.keys(TIER_CONFIGS).join(', ')}`;
  return null;
}

// Everything both endpoints need: retrieval under the provisional tier, the
// routing decision from what was selected, and the exact messages to send —
// continuing an existing conversation when its context still covers the
// question, so the prefix stays cached.
// The local model is the only runner this engine has. Cloud work goes through
// the scope CLI, which spends a rationed daily budget on headless Claude Code
// rather than an API key.
async function* generate({ model, messages, signal }) {
  for await (const chunk of streamLocal({ model, messages, options: LOCAL_OPTIONS, signal })) {
    if (chunk.message?.content) yield { text: chunk.message.content };
    if (chunk.done) {
      yield { done: true, outputTokens: chunk.eval_count ?? null, promptTokens: chunk.prompt_eval_count ?? null };
    }
  }
}

async function planTurn(ownerId, sessionId, { query, project, tier, overrides, conversationId }) {
  const text = query.trim();
  const model = localChatModel();

  const probeStart = performance.now();
  const status = await localModelStatus(model);
  const probeMs = performance.now() - probeStart;
  const localAvailable = status.running && status.hasModel;

  const conversation = getConversation(conversationId, ownerId);
  const provisional = provisionalTier({ localAvailable, preferredTier: tier });
  const gather = (query) =>
    gatherCandidates({ ownerId, query, project, tier: provisional, overrides, embed: status.running, cloudOnly: false });
  // A question that stands on its own is retrieved on its own, so a change of
  // subject finds its own sources; only when that finds nothing, or the wording
  // leans on the previous turn, does the previous question join the query.
  let asked = conversation && !readsAsFollowUp(text) ? text : null;
  let gathered = asked ? await gather(asked) : null;
  if (!gathered || gathered.candidates.length === 0) {
    asked = retrievalQuery(conversation, text);
    gathered = await gather(asked);
  }

  const decideStart = performance.now();
  let packed = packForTier(gathered.candidates, provisional, overrides);
  // Only Auto weighs difficulty; a chosen tier is the user's call.
  const difficulty = tier ? null : questionDifficulty(text);
  const route = decideRoute({
    selected: packed.selected,
    preferredTier: tier,
    localAvailable,
    cloudAvailable: false,
    hard: Boolean(difficulty),
  });
  if (route.tier !== provisional) packed = packForTier(gathered.candidates, route.tier, overrides);
  const routingDecisionMs = Math.round(probeMs + performance.now() - decideStart);

  const config = resolveConfig(route.tier, overrides);
  const continued = continuation(conversation, { selected: packed.selected, tier: route.tier, project });
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
    config,
    gathered,
    messages,
    sources,
    contextBlock,
    contextTokens,
    metrics,
    routingDecisionMs,
    difficulty,
    reused: Boolean(continued),
    routing: {
      decision: route.decision,
      tier: route.tier,
      reason: route.reason,
      provisionalTier: provisional,
      contextReused: Boolean(continued),
      prefilled: Boolean(prefilled),
      nodesAdded: continued ? continued.added.length : sources.length,
      // Why Auto judged the question hard, when it did: wording, length, or
      // multi_part.
      difficulty,
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
  const { route, sources, metrics } = plan;
  const model = plan.model;
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
      // Always the local model here: the hint is about what to install.
      error: unavailableMessage(route, plan.status, plan.model),
      code: route.blocked,
      queryId,
      routing: plan.routing,
      nodes: sources.map(({ node }) => ({ id: node.id, type: node.type, project: node.project, privacy: node.privacy })),
    });
  }

  const modelUsed = route.decision === 'local' ? `ollama/${model}` : `anthropic/${model}`;
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
  // Asked for on this request, and granted for this session, from this machine.
  const displayControl = req.body.displayControl === true && displayControlAllowed(req);
  beginGeneration();
  try {
    for await (const event of generate({
      model,
      messages: plan.messages,
      signal: upstream.signal,
    })) {
      if (event.text) {
        ttftMs ??= Math.round(performance.now() - started);
        answer += event.text;
        send({ type: 'token', text: event.text });
      }
      if (event.done) {
        outputTokens = event.outputTokens;
        promptTokens = event.promptTokens;
      }
    }
  } catch (err) {
    if (!upstream.signal.aborted) failure = err;
  } finally {
    endGeneration();
  }

  // Edits are parsed from the finished answer and held for approval; the model
  // never writes to a repository itself.
  const edits = failure ? [] : parseEdits(answer);
  const proposed = edits.length
    ? recordProposals({ ownerId, queryId, conversationId, edits, sources })
    : [];

  const names = failure ? [] : parseRuns(answer);
  const proposedRuns = [];
  if (names.length) {
    // A script runs in the project's working copy; without one bound there is
    // nowhere to run it, and the card says so rather than guessing a directory.
    const runProject = req.body.project ?? sources[0]?.node.project ?? null;
    const settings = runProject ? await getProjectSettings(ownerId, runProject) : null;
    proposedRuns.push(
      ...recordRuns({
        ownerId,
        conversationId,
        project: runProject,
        localPath: settings?.localPath ?? null,
        scripts: settings?.localPath ? await declaredScripts(settings.localPath) : [],
        names,
      })
    );
  }

  // Actions open things on screen; like runs they are held for approval, and a
  // file action needs the project's working copy to resolve its path against.
  const found = failure ? [] : parseActions(answer);
  let proposedActions = [];
  if (found.length) {
    const actionProject = req.body.project ?? sources[0]?.node.project ?? null;
    const settings = actionProject ? await getProjectSettings(ownerId, actionProject) : null;
    proposedActions = await recordActions({
      ownerId,
      conversationId,
      project: actionProject,
      localPath: settings?.localPath ?? null,
      found,
    });
    // In display mode an action opens by itself. A url never does: autoOpens
    // only cleared one that a web search had cited, and with no web search
    // there is nothing to vouch for an address the model wrote, so every url
    // waits for approval.
    if (displayControl) {
      for (const action of proposedActions) {
        if (autoOpens(action)) await openNow(action, { run: req.app.locals.openRunner });
      }
    }
  }

  const totalResponseMs = Math.round(performance.now() - started);
  if (!upstream.signal.aborted) {
    if (proposed.length) send({ type: 'edits', queryId, edits: proposed.map(presentProposal) });
    if (proposedRuns.length) send({ type: 'runs', queryId, runs: proposedRuns.map(presentRun) });
    if (proposedActions.length) send({ type: 'actions', queryId, actions: proposedActions.map(presentAction) });
    if (failure) send({ type: 'error', queryId, error: describeLocalError(failure) });
    else {
      send({
        type: 'done',
        queryId,
        conversationId,
        metrics: { ttftMs, totalResponseMs, outputTokens, promptTokens },
      });
    }
    res.end();
  }

  // Keeping the answer in the conversation makes the next question a pure
  // append, which the model's cache serves without re-reading the context.
  if (!failure && answer) {
    saveConversation(conversationId, ownerId, {
      tier: route.tier,
      project: req.body.project ?? null,
      sources,
      messages: [...plan.messages, { role: 'assistant', content: answer }],
      contextTokens: plan.contextTokens,
      lastQuestion: plan.text,
    });
  }

  // Written after the last token, so the metrics inserts never delay the answer.
  try {
    await record(
      {
        modelUsed,
        ttftMs,
        totalResponseMs,
        outputTokens,
      },
      true
    );
  } catch (err) {
    console.error(`failed to log metrics for query ${queryId}: ${err.message}`);
  }
});

export default router;
