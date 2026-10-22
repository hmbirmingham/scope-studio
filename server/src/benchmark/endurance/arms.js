import { randomUUID } from 'node:crypto';
import {
  splitSystem,
  streamChat as streamCloud,
  withBrevityNote,
  withCacheBreakpoint,
  costUsd,
} from '../../lib/anthropic.js';
import { ECONOMY_MAX_TOKENS, canAutoCloud, canChooseCloud, cloudEffortFor } from '../../billing/plans.js';
import { simulatePlatformCredential } from './platformRules.js';
import { localChatModel, localModelStatus, streamChat as streamLocal } from '../../lib/ollama.js';
import { getPool } from '../../db/pool.js';
import { gatherCandidates, packForTier } from '../../retrieval/retrieve.js';
import { resolveConfig } from '../../retrieval/score.js';
import { questionDifficulty } from '../../routing/difficulty.js';
import {
  continuation,
  getConversation,
  messagesFor,
  readsAsFollowUp,
  retrievalQuery,
  saveConversation,
} from '../../routing/conversation.js';
import { SYSTEM_PROMPTS, buildFollowUp, buildMessages } from '../../routing/prompt.js';
import { CLOUD_TIER, provisionalTier, routeAndPack, sendsPrivate } from '../../routing/route.js';
import {
  DRY,
  estimateTokens,
  priceRequest,
  promptTokens,
  worstCaseUsd,
} from './economics.js';
import { citeCoverage, describeNode, mentionScore } from './scenarios.js';

// The arms of the endurance benchmark. Each arm plays a scenario turn by turn
// and returns one row per turn in the same shape, so the report never needs to
// know which arm it is reading. A new arm (another baseline, another model) is
// one more entry in ARMS.

// These mirror routes/chat.js rather than importing it: the route keeps them
// private, and the parity test in test/integration/endurance.test.js fails the
// moment either side drifts from the other.
const LOCAL_OPTIONS = { num_ctx: 8192 };
const CACHE_MARKERS = { strict_xml: '<question>', markdown: '## Question' };
// streamChat's ceiling when no economy applies (lib/anthropic.js).
const MAX_TOKENS = 2048;

// The paste-everything baseline sends every candidate retrieval found for the
// turn, up to this many tokens of new context per turn.
export const BASELINE_CONTEXT_CAP_TOKENS = 100_000;
// The context window the baseline must fit in. Past it, the oldest pasted
// context is dropped the way a cloud app compacts a long conversation; a
// larger window would only make the baseline costlier, since more is re-read.
export const BASELINE_WINDOW_TOKENS = 200_000;

// What a dry run's fake models answer: a fixed-length placeholder, so the
// transcript a baseline re-sends grows the way a real one would.
export const DRY_OUTPUT_TOKENS = 250;
const FILLER = 'This is a fixed-length placeholder answer from the dry run. ';
export function dryAnswerChunks() {
  const text = FILLER.repeat(Math.ceil((DRY_OUTPUT_TOKENS * 4) / FILLER.length)).slice(0, DRY_OUTPUT_TOKENS * 4);
  return text.match(/.{1,80}/gs);
}

// A dry run must never reach a real model: the cloud client is pointed at a
// local stand-in, and anything else is refused before a request is built.
function assertDryEndpoint() {
  const base = process.env.ANTHROPIC_BASE_URL;
  const host = base ? new URL(base).hostname : null;
  if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) {
    throw new Error('a dry run sends cloud requests only to a local stand-in; ANTHROPIC_BASE_URL is not one');
  }
}

// What a live baseline sends in place of a private node. A private node never
// leaves the machine, not even to measure what a cloud app would have done
// with it, so a live request carries this instead of its text (and without its
// project, which names the private work too). The count of what a naive app
// would have pasted is still reported, as privateNodesWouldSend.
export const WITHHELD_PRIVATE_NODE = '[a private file was withheld here: private files never leave this machine]';

export function isPrivate(node) {
  return node?.privacy === 'local';
}

function withheld(entry) {
  return { ...entry, node: { id: entry.node.id, type: entry.node.type, project: null, privacy: 'local', content: WITHHELD_PRIVATE_NODE } };
}

// The last check before any cloud request the benchmark builds from graph
// nodes: a private node among them means a bug upstream, and the request is
// refused rather than sent.
export function assertNoPrivateSources(entries, where) {
  const leaked = entries.filter(({ node }) => isPrivate(node));
  if (leaked.length) throw new Error(`${where} would send ${leaked.length} private node(s) to the cloud; refusing`);
}

// The same check against the nodes as they are now, not as they were read:
// a conversation carries node snapshots, and a node may have been marked
// private since. Used before a live request.
export async function assertNoPrivateSourcesNow(ownerId, entries, where, db = getPool()) {
  assertNoPrivateSources(entries, where);
  const ids = entries.map(({ node }) => node.id).filter(Boolean);
  if (!ids.length) return;
  const { rowCount } = await db.query(
    "SELECT 1 FROM nodes WHERE owner_id = $1 AND id = ANY($2::uuid[]) AND privacy = 'local'",
    [ownerId, ids]
  );
  if (rowCount) throw new Error(`${where} would send ${rowCount} private node(s) to the cloud; refusing`);
}

// The route's planTurn for an Auto question (no tier chosen, no web search,
// no draft): retrieval under the provisional tier, the routing decision from
// what was selected, a re-pack if the tier changed, and the exact messages —
// continuing the conversation when its context still covers the question.
export async function planScopeTurn({ ownerId, query, project, conversationId, cloudAvailable }) {
  const text = query.trim();
  const model = localChatModel();
  const status = await localModelStatus(model);
  const localAvailable = status.running && status.hasModel;

  const conversation = getConversation(conversationId, ownerId);
  const provisional = provisionalTier({ localAvailable, preferredTier: undefined });
  const gather = (asked) =>
    gatherCandidates({ ownerId, query: asked, project, tier: provisional, overrides: undefined, embed: status.running, cloudOnly: false });
  let asked = conversation && !readsAsFollowUp(text) ? text : null;
  let gathered = asked ? await gather(asked) : null;
  if (!gathered || gathered.candidates.length === 0) {
    asked = retrievalQuery(conversation, text);
    gathered = await gather(asked);
  }

  const difficulty = questionDifficulty(text);
  const { route, packed } = routeAndPack({
    pack: (packTier) => packForTier(gathered.candidates, packTier, undefined),
    provisional,
    preferredTier: undefined,
    localAvailable,
    cloudAvailable,
    hard: Boolean(difficulty),
  });

  const config = resolveConfig(route.tier, undefined);
  let continued = continuation(conversation, { selected: packed.selected, tier: route.tier, project });
  if (continued && sendsPrivate(route, [...continued.entry.sources, ...continued.added])) continued = null;
  let messages;
  let sources;
  let contextTokens;
  if (continued) {
    const { entry, added } = continued;
    const content = buildFollowUp(text, config, { sources: added, startIndex: entry.sources.length });
    messages = [...entry.messages, { role: 'user', content }];
    sources = [...entry.sources, ...added];
    contextTokens = entry.contextTokens + added.reduce((total, { node }) => total + node.token_length, 0);
  } else {
    ({ messages, sources } = buildMessages({ query: text, selected: packed.selected, config }));
    contextTokens = packed.tokens;
  }

  // Sent as the route sends it: a thread's local-only messages never reach
  // the cloud (routing/conversation.js messagesFor).
  return {
    text, model, status, route, config, gathered, messages: messagesFor(route.decision, messages), sources, contextTokens, difficulty,
    reused: Boolean(continued),
  };
}

async function runLocal({ model, messages }) {
  let answer = '';
  let outputTokens = null;
  let promptTokensUsed = null;
  for await (const chunk of streamLocal({ model, messages, options: LOCAL_OPTIONS })) {
    if (chunk.message?.content) answer += chunk.message.content;
    if (chunk.done) {
      outputTokens = chunk.eval_count ?? null;
      promptTokensUsed = chunk.prompt_eval_count ?? null;
    }
  }
  return { answer, outputTokens, promptTokens: promptTokensUsed };
}

// A cloud request that failed on the provider's side: a 429, a 529, a dropped
// connection. It is not a fault in the harness, so the runner stops the arm it
// hit and keeps every turn already paid for instead of losing the run.
export class UpstreamError extends Error {
  constructor(cause) {
    super(cause?.message ?? String(cause), { cause });
    this.name = 'UpstreamError';
    this.status = cause?.status ?? null;
  }
}

async function runCloud({ apiKey, model, effort, messages, cacheMarker, economy }) {
  let answer = '';
  let usage = null;
  try {
    for await (const event of streamCloud({
      apiKey, model, effort, messages, cacheMarker,
      ...(economy ? { maxTokens: ECONOMY_MAX_TOKENS, brevity: true } : {}),
    })) {
      if (event.text) answer += event.text;
      if (event.done) usage = event.usage;
    }
  } catch (err) {
    throw new UpstreamError(err);
  }
  return { answer, usage };
}

// Builds the per-turn row every arm returns.
function turnRow({ arm, index, turn, live, answer, nodes, base }) {
  const mention = live ? mentionScore(answer, turn.mustMention) : { score: DRY, matched: [] };
  return {
    arm,
    turn: index + 1,
    kind: turn.kind,
    ask: turn.ask,
    ...base,
    quality: mention.score,
    mentionsMatched: mention.matched,
    citeCoverage: citeCoverage(nodes, turn.mustCite),
    selected: nodes.map(describeNode),
  };
}

// Scope: the engine's own pipeline for every turn, on the plan's rules. The
// week starts empty, and the arm's own spend is what the allowance is checked
// against, so economy mode and the allowance cut-over happen when they would.
export function createScopeArm({ scenario, ownerId, mode, cap, platformKey }) {
  const live = mode === 'live';
  const conversationId = randomUUID();
  const cache = new Set();
  let spentUsd = 0;
  let platformAnswers = 0;

  return {
    name: 'scope',
    async turn(turn, index) {
      const plan = scenario.plan;
      const meters = !canChooseCloud(plan) && canAutoCloud(plan);
      const credential = simulatePlatformCredential({
        plan,
        headerKey: null,
        explicit: false,
        modelChoice: undefined,
        weeklySpentUsd: meters ? spentUsd : 0,
        monthlyAnswersUsed: meters ? platformAnswers : 0,
        platformKey,
      });
      const project = turn.project ?? scenario.project;
      const planned = await planScopeTurn({
        ownerId, query: turn.ask, project, conversationId, cloudAvailable: Boolean(credential.apiKey),
      });
      const { route } = planned;
      const base = {
        decision: route.decision,
        routeReason: route.reason,
        tier: route.tier,
        difficulty: planned.difficulty,
        contextReused: planned.reused,
        economy: route.decision === 'cloud' ? credential.economy : false,
        blocked: route.blocked ?? null,
      };

      if (route.blocked) {
        return turnRow({
          arm: 'scope', index, turn, live, answer: '', nodes: planned.sources.map(({ node }) => node),
          base: { ...base, model: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, latencyMs: 0 },
        });
      }

      const started = performance.now();
      let answer;
      let usage = null;
      let cost = 0;
      let model;
      let inputTokens;
      let outputTokens;
      if (route.decision === 'local') {
        model = planned.model;
        const local = await runLocal({ model, messages: planned.messages });
        answer = local.answer;
        // A stand-in model's own counts mean nothing; a dry run counts the prompt itself.
        inputTokens = live ? local.promptTokens ?? promptTokens({ messages: planned.messages }) : promptTokens({ messages: planned.messages });
        outputTokens = live ? local.outputTokens ?? estimateTokens(answer) : estimateTokens(answer);
      } else {
        model = credential.modelFor(Boolean(planned.difficulty));
        const cacheMarker = CACHE_MARKERS[planned.config.prompt_structure];
        // The payload exactly as streamChat will send it, for pricing and the cap.
        const payload = splitSystem(
          withCacheBreakpoint(credential.economy ? withBrevityNote(planned.messages) : planned.messages, cacheMarker)
        );
        const sent = { system: payload.system, messages: payload.rest };
        const maxTokens = credential.economy ? ECONOMY_MAX_TOKENS : MAX_TOKENS;
        if (!cap.allows(worstCaseUsd(model, promptTokens(sent), maxTokens))) return { stopped: cap.stopped };
        if (!live) assertDryEndpoint();
        // The route already keeps a private node off a cloud turn; this is
        // the benchmark refusing to be the one place that forgets.
        if (live) await assertNoPrivateSourcesNow(ownerId, planned.sources, 'the Scope arm');
        else assertNoPrivateSources(planned.sources, 'the Scope arm');
        const cloud = await runCloud({
          apiKey: credential.apiKey, model, effort: credential.effort, messages: planned.messages, cacheMarker, economy: credential.economy,
        });
        answer = cloud.answer;
        if (live) {
          usage = cloud.usage;
          cost = costUsd(model, usage) ?? 0;
        } else {
          ({ usage, costUsd: cost } = priceRequest({ model, ...sent, outputTokens: estimateTokens(answer), cache }));
        }
        cap.settle(cost);
        spentUsd += cost;
        if (credential.billedTo === 'platform') platformAnswers += 1;
        inputTokens = usage?.input_tokens ?? 0;
        outputTokens = usage?.output_tokens ?? 0;
      }
      const latencyMs = Math.round(performance.now() - started);

      // As the route does: keeping the answer makes the next question a pure
      // append, which is what lets follow-ups reuse the cached context.
      if (answer) {
        saveConversation(conversationId, ownerId, {
          tier: route.tier,
          project: project ?? null,
          sources: planned.sources,
          messages: [...planned.messages, { role: 'assistant', content: answer }],
          contextTokens: planned.contextTokens,
          lastQuestion: planned.text,
        });
      }

      return turnRow({
        arm: 'scope', index, turn, live, answer, nodes: planned.sources.map(({ node }) => node),
        base: {
          ...base,
          model: route.decision === 'local' ? `ollama/${model}` : `anthropic/${model}`,
          inputTokens,
          outputTokens,
          cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
          cacheWriteTokens: usage?.cache_creation_input_tokens ?? 0,
          costUsd: cost,
          latencyMs,
        },
      });
    },
  };
}

// Marks the last block of the previous user turn (where the cache is read
// from) and of the new one (where it is written to), the way a cloud app
// caches a growing conversation.
export function withTranscriptBreakpoints(messages) {
  const users = messages.map((message, i) => (message.role === 'user' ? i : -1)).filter((i) => i >= 0);
  const marked = new Set(users.slice(-2));
  return messages.map((message, i) =>
    marked.has(i)
      ? { role: message.role, content: [{ type: 'text', text: message.content, cache_control: { type: 'ephemeral' } }] }
      : { role: message.role, content: message.content }
  );
}

// The cloud-app baseline: every turn re-sends the whole conversation so far,
// with broad context pasted in — every candidate retrieval found for the turn
// that the conversation does not already hold — and prompt caching on the
// transcript prefix, so re-reading it costs the cache rate. It is given the
// same retrieval as Scope, the same system prompt and the plan's effort, so
// what differs is only how much context is carried and on which model.
//
// A naive cloud app would paste private files too, and each row counts them
// (privateNodesWouldSend): that is the privacy half of the comparison. Only a
// dry run, whose requests go to a local stand-in, simulates that paste in
// full. A live run makes a real cloud call, so before every request the
// privacy of everything pasted so far is read again, and every private node,
// new or already in the transcript, is sent as WITHHELD_PRIVATE_NODE instead
// (privateNodesWithheld counts each node once, on the turn it was first
// withheld). That changes the comparison in both directions: the request is
// a little cheaper than the naive app's, and the answer may be worse for
// lacking the file. So a live turn whose request carried a withheld node has
// no quality or citation coverage, and is left out of the quality comparison;
// citation coverage is only ever computed from the nodes actually sent.
export function createBaselineArm({ name, model, scenario, ownerId, mode, cap, platformKey }) {
  const live = mode === 'live';
  const config = resolveConfig(CLOUD_TIER, undefined);
  const system = SYSTEM_PROMPTS[config.prompt_structure];
  const effort = cloudEffortFor(scenario.plan);
  const cache = new Set();
  // Each user entry keeps what it was built from, so it can be rebuilt when
  // a node it carries has become private since it was first sent.
  const transcript = [];
  const pasted = new Map();
  // Ids of pasted nodes that are private now, as last read (live only).
  const withheldIds = new Set();
  let numbered = 0;
  let lastQuestion = null;

  const sendable = (entry) => (live && (isPrivate(entry.node) || withheldIds.has(entry.node.id)) ? withheld(entry) : entry);
  function render(entry) {
    if (entry.role !== 'user') return entry.content;
    if (!entry.sources.length) return entry.question;
    return buildFollowUp(entry.text, config, { sources: entry.sources.map(sendable), startIndex: entry.startIndex });
  }

  // Reads again which pasted nodes are private: a node may have been marked
  // private since it was pasted, and the transcript re-sends it every turn.
  async function refreshPrivacy(ids) {
    if (!live || ids.length === 0) return 0;
    const { rows } = await getPool().query(
      "SELECT id FROM nodes WHERE owner_id = $1 AND id = ANY($2::uuid[]) AND privacy = 'local'",
      [ownerId, ids]
    );
    let added = 0;
    for (const { id } of rows) {
      if (!withheldIds.has(id)) added += 1;
      withheldIds.add(id);
    }
    return added;
  }

  // Drops the oldest pasted context until the request fits the window. The
  // questions and answers stay; the nodes they carried may be pasted again.
  function compact(pending) {
    let dropped = false;
    const size = () => promptTokens({ system, messages: [...transcript, pending] });
    for (const entry of transcript) {
      if (size() <= BASELINE_WINDOW_TOKENS) break;
      if (entry.role !== 'user' || !entry.sources.length) continue;
      for (const { node } of entry.sources) pasted.delete(node.id);
      entry.sources = [];
      entry.content = entry.question;
      dropped = true;
    }
    return dropped;
  }

  return {
    name,
    async turn(turn, index) {
      const text = turn.ask.trim();
      const project = turn.project ?? scenario.project;
      // The same query rule Scope uses, so the baseline is never handicapped
      // by retrieving a bare "now change that" on its own.
      const gather = (asked) => gatherCandidates({ ownerId, query: asked, project, tier: CLOUD_TIER, embed: true, cloudOnly: false });
      let gathered = lastQuestion && !readsAsFollowUp(text) ? await gather(text) : null;
      if (!gathered || gathered.candidates.length === 0) gathered = await gather(lastQuestion ? `${lastQuestion} ${text}` : text);

      const fresh = [];
      let tokens = 0;
      for (const entry of gathered.candidates) {
        if (pasted.has(entry.node.id)) continue;
        if (tokens + entry.node.token_length > BASELINE_CONTEXT_CAP_TOKENS) continue;
        fresh.push(entry);
        tokens += entry.node.token_length;
      }
      const wouldSend = fresh.filter(({ node }) => isPrivate(node)).length;
      const known = new Set(withheldIds);
      await refreshPrivacy([...pasted.keys()]);
      // Every node this turn withholds for the first time: fresh private
      // ones, and earlier ones that have become private since they were sent.
      let newlyWithheld = 0;
      if (live) {
        for (const { node } of fresh) {
          if (isPrivate(node)) withheldIds.add(node.id);
        }
        newlyWithheld = [...withheldIds].filter((id) => !known.has(id)).length;
      }

      const pending = {
        role: 'user',
        text,
        question: buildFollowUp(text, config),
        sources: fresh,
        startIndex: numbered,
      };
      numbered += fresh.length;
      for (const { node } of fresh) pasted.set(node.id, node);
      // The transcript as it will be sent: in a live run, never a private
      // node's text, however long ago it was pasted.
      for (const entry of transcript) entry.content = render(entry);
      pending.content = render(pending);
      const compacted = compact(pending);

      const messages = withTranscriptBreakpoints([...transcript, pending]);
      const sent = { system, messages };
      if (!cap.allows(worstCaseUsd(model, promptTokens(sent), MAX_TOKENS))) return { stopped: cap.stopped };
      if (!live) assertDryEndpoint();

      const started = performance.now();
      const cloud = await runCloud({ apiKey: platformKey, model, effort, messages: [{ role: 'system', content: system }, ...messages] });
      const latencyMs = Math.round(performance.now() - started);
      let usage;
      let cost;
      if (live) {
        usage = cloud.usage;
        cost = costUsd(model, usage) ?? 0;
      } else {
        ({ usage, costUsd: cost } = priceRequest({ model, ...sent, outputTokens: estimateTokens(cloud.answer), cache }));
      }
      cap.settle(cost);

      transcript.push(pending, { role: 'assistant', content: cloud.answer });
      lastQuestion = text;
      // What the model actually had in front of it: citation coverage is
      // computed from these, never from a node it was not sent.
      const inRequest = [...pasted.values()];
      const visible = live ? inRequest.filter((node) => !isPrivate(node) && !withheldIds.has(node.id)) : inRequest;
      const withheldInRequest = inRequest.length - visible.length;

      const row = turnRow({
        arm: name, index, turn, live, answer: cloud.answer, nodes: visible,
        base: {
          decision: 'cloud',
          routeReason: 'baseline',
          tier: CLOUD_TIER,
          difficulty: null,
          contextReused: index > 0,
          economy: false,
          blocked: null,
          compacted,
          nodesPasted: fresh.length,
          // A cloud app sends whatever is pasted, private or not; Scope would
          // have kept these on the local model. A live run withholds them.
          privateNodesWouldSend: wouldSend,
          privateNodesWithheld: newlyWithheld,
          withheldInRequest,
          model: `anthropic/${model}`,
          inputTokens: usage?.input_tokens ?? 0,
          outputTokens: usage?.output_tokens ?? 0,
          cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
          cacheWriteTokens: usage?.cache_creation_input_tokens ?? 0,
          costUsd: cost,
          latencyMs,
        },
      });
      // The answer was given without a file the naive app would have had, so
      // it says nothing about how the baseline compares on quality.
      if (withheldInRequest > 0) Object.assign(row, { quality: null, citeCoverage: null, excludedFromQuality: 'private_nodes_withheld' });
      return row;
    },
  };
}

export const ARMS = {
  scope: (options) => createScopeArm(options),
  baseline_sonnet: (options) => createBaselineArm({ ...options, name: 'baseline_sonnet', model: 'claude-sonnet-5' }),
  baseline_opus: (options) => createBaselineArm({ ...options, name: 'baseline_opus', model: 'claude-opus-5' }),
};
export const DEFAULT_ARMS = Object.keys(ARMS);
export const BASELINE_ARMS = DEFAULT_ARMS.filter((name) => name !== 'scope');
