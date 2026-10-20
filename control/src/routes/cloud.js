import { Router } from 'express';
import { platformCloudRefusal, resolvePlatformCredential } from '../billing/credential.js';
import { costUsd, describeError, failureKind, streamChat } from '../lib/anthropic.js';
import { sendError } from '../lib/errors.js';
import { requireDevice } from '../middleware/requireDevice.js';
import {
  allowanceWeekStart,
  answerFreesUpNext,
  answerMonthStart,
  freesUpNext,
  recordUsage,
  requestRecorded,
  usageSince,
} from '../models/ledger.js';

// Mounted at the root: routes here declare their full paths (see API.md).
const router = Router();

// Platform cloud: an answer the platform pays for, streamed back to a signed-in
// engine. The engine packs the prompt; everything that decides what the answer
// costs (model, effort, output ceiling) is decided here, from the plan and the
// ledger, and every answer that reaches the model is charged to the ledger.
//
// This route knows nothing about plug-ins. `sources` is a list of names the
// engine reports and the ledger stores, so a new plug-in is measured from the
// day it ships without a change here.

// What a request may carry. Anything else is refused rather than ignored, so a
// client cannot reach a model, effort or tool by guessing a field name, and an
// engine that sends one learns at once that it is not honoured.
const ACCEPTED_FIELDS = new Set(['requestId', 'messages', 'cacheMarker', 'hard', 'sources']);
const DECIDED_HERE = new Set(['model', 'max_tokens', 'maxTokens', 'effort', 'output_config', 'tools', 'tool_choice', 'webSearch', 'web_search', 'thinking']);
const ROLES = new Set(['system', 'user', 'assistant']);
// Prompts are text, plus the images a plug-in may attach, and each block may
// carry only the keys listed for its type. Everything else a block can hold
// upstream is a decision or a capability the client does not get: a
// cache_control key would let it place caching breakpoints (and the cache
// writes they bill) where the control plane did not, so caching is set only
// through cacheMarker; citations, documents and tool blocks reach features no
// plan here includes.
const BLOCK_KEYS = {
  text: new Set(['type', 'text']),
  image: new Set(['type', 'source']),
};
const IMAGE_SOURCE_KEYS = {
  base64: new Set(['type', 'media_type', 'data']),
  url: new Set(['type', 'url']),
};
const IMAGE_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const MAX_IMAGE_URL = 2048;
// Key and type names are echoed in errors only when they look like a name, so
// an error can never carry text the client put in a key.
const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const SOURCE_NAME = /^[a-z][a-z0-9_]{0,31}$/;
const MAX_SOURCES = 16;
const MAX_CACHE_MARKER = 256;

// Two answers at once covers a person with two windows open. The limit also
// bounds how far a burst can overshoot the week's allowance: every stream
// passed the allowance check before any of them was charged, so at most this
// many answers can land past the line. Counted per control plane instance.
export const MAX_STREAMS_PER_ACCOUNT = 2;
const streamsByAccount = new Map();
// Request ids streaming right now. The ledger only learns an id once its answer
// completes, so without this a retry sent mid-answer would stream twice and be
// charged once.
const requestsInFlight = new Set();

// The ledger's input count is everything the model read, cached or not, so the
// row says how big the prompt was. What each part cost is in cost_usd.
const inputTokensRead = (usage) =>
  usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens;

// Output tokens are only reported once the answer finishes. When a client hangs
// up first, the streamed text is the only measure of what the model wrote, and
// the estimate leans high (three characters a token, against about four for
// English) so platform spend is never under-counted.
const CHARS_PER_TOKEN_ESTIMATE = 3;

const REFUSALS = {
  cloud_not_in_plan: [403, 'Cloud answers paid by Scope Studio are part of the Student and Engineer plans.'],
  platform_cloud_unavailable: [503, 'Scope Studio cloud is unavailable right now. Your local model can still answer.'],
  duplicate_request: [409, 'This request has already been answered.'],
  answer_limit_reached: [402, "This month's cloud answers are used up. Your local model can still answer."],
  allowance_exhausted: [402, "This week's cloud allowance is used up. Your local model can still answer."],
  too_many_streams: [429, 'Two cloud answers are already streaming for this account. Try again when one finishes.'],
};

function refuse(res, code, extra = {}) {
  const [status, error] = REFUSALS[code];
  return res.status(status).json({ error, code, ...extra });
}

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function invalid(code, message) {
  return { error: { code, message } };
}

const nameOf = (value, otherwise) => (NAME.test(value) ? value : otherwise);

// A key the client may not send is refused as field_not_allowed, like a
// top-level field; a known key with a malformed value is invalid_request.
function unknownKey(object, allowed, at) {
  const key = Object.keys(object).find((name) => !allowed.has(name));
  if (key === undefined) return null;
  return invalid('field_not_allowed', `${at} may not carry ${nameOf(key, 'that key')}.`);
}

function imageSourceProblem(source, at) {
  if (!isPlainObject(source) || typeof source.type !== 'string') {
    return invalid('invalid_request', `${at}.source must be an object with a type.`);
  }
  const allowed = IMAGE_SOURCE_KEYS[source.type];
  if (!allowed) {
    return invalid('field_not_allowed', `${at}.source may be base64 or url, not ${nameOf(source.type, 'that type')}.`);
  }
  const extra = unknownKey(source, allowed, `${at}.source`);
  if (extra) return extra;
  if (source.type === 'base64') {
    if (!IMAGE_MEDIA_TYPES.has(source.media_type)) {
      return invalid('invalid_request', `${at}.source.media_type must be image/jpeg, image/png, image/gif or image/webp.`);
    }
    if (typeof source.data !== 'string' || source.data.length % 4 !== 0 || !BASE64.test(source.data)) {
      return invalid('invalid_request', `${at}.source.data must be base64.`);
    }
    return null;
  }
  if (!isHttpsUrl(source.url)) {
    return invalid('invalid_request', `${at}.source.url must be an https URL of at most ${MAX_IMAGE_URL} characters.`);
  }
  return null;
}

function isHttpsUrl(value) {
  if (typeof value !== 'string' || value.length > MAX_IMAGE_URL) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function contentProblem(content, role, at) {
  if (typeof content === 'string') return null;
  if (!Array.isArray(content) || content.length === 0) {
    return invalid('invalid_request', `${at} must be a string or a non-empty array of content blocks.`);
  }
  for (const [index, block] of content.entries()) {
    const blockAt = `${at}[${index}]`;
    if (!isPlainObject(block) || typeof block.type !== 'string') {
      return invalid('invalid_request', `${blockAt} is a content block without a type.`);
    }
    const allowed = BLOCK_KEYS[block.type];
    if (!allowed) {
      return invalid('field_not_allowed', `${blockAt} is a ${nameOf(block.type, 'different')} block; only text and image blocks are accepted.`);
    }
    const extra = unknownKey(block, allowed, blockAt);
    if (extra) return extra;
    if (role === 'system' && block.type !== 'text') {
      return invalid('invalid_request', `${blockAt} is in a system message, which may only hold text.`);
    }
    if (block.type === 'text' && typeof block.text !== 'string') {
      return invalid('invalid_request', `${blockAt} is a text block without text.`);
    }
    if (block.type === 'image') {
      const problem = imageSourceProblem(block.source, blockAt);
      if (problem) return problem;
    }
  }
  return null;
}

// Checks the request against API.md and returns the parts the route uses.
// Error text names the field that is wrong, never echoes its content.
export function parseCloudRequest(body) {
  if (!isPlainObject(body)) return invalid('invalid_request', 'Send a JSON object.');

  for (const field of Object.keys(body)) {
    if (ACCEPTED_FIELDS.has(field)) continue;
    return invalid(
      'field_not_allowed',
      DECIDED_HERE.has(field)
        ? `${field} is decided by Scope Studio for your plan and cannot be sent.`
        : `${nameOf(field, 'That field')} is not part of a cloud request.`
    );
  }

  const { requestId, messages, cacheMarker = null, hard = false, sources = [] } = body;
  if (typeof requestId !== 'string' || requestId.length < 8 || requestId.length > 128) {
    return invalid('invalid_request', 'requestId must be a string of 8 to 128 characters.');
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    return invalid('invalid_request', 'messages must be a non-empty array.');
  }
  let systems = 0;
  for (const [index, message] of messages.entries()) {
    if (!isPlainObject(message) || !ROLES.has(message.role)) {
      return invalid('invalid_request', `messages[${index}] needs a role of system, user or assistant.`);
    }
    if (Object.keys(message).some((key) => key !== 'role' && key !== 'content')) {
      return invalid('invalid_request', `messages[${index}] may only have a role and content.`);
    }
    const problem = contentProblem(message.content, message.role, `messages[${index}].content`);
    if (problem) return problem;
    if (message.role === 'system') systems += 1;
  }
  if (systems > 1) return invalid('invalid_request', 'messages may hold at most one system message.');
  if (!messages.some((message) => message.role === 'user')) {
    return invalid('invalid_request', 'messages needs at least one user message.');
  }

  if (cacheMarker !== null && (typeof cacheMarker !== 'string' || cacheMarker.length > MAX_CACHE_MARKER)) {
    return invalid('invalid_request', `cacheMarker must be a string of at most ${MAX_CACHE_MARKER} characters.`);
  }
  if (typeof hard !== 'boolean') return invalid('invalid_request', 'hard must be true or false.');

  if (
    !Array.isArray(sources) ||
    sources.length > MAX_SOURCES ||
    !sources.every((name) => typeof name === 'string' && SOURCE_NAME.test(name))
  ) {
    return invalid(
      'invalid_sources',
      `sources must be at most ${MAX_SOURCES} plug-in names of lowercase letters, digits and underscores.`
    );
  }

  return { value: { requestId, messages, cacheMarker, hard, sources: [...new Set(sources)] } };
}

// The auth middleware is built on first use, so the database pool it holds is
// created after the environment is loaded, not when this module is imported.
let deviceAuth;
const device = (req, res, next) => (deviceAuth ??= requireDevice())(req, res, next);

router.post('/v1/cloud/messages', device, async (req, res) => {
  const parsed = parseCloudRequest(req.body);
  if (parsed.error) return sendError(res, 400, parsed.error.code, parsed.error.message);
  const request = parsed.value;
  const { id: accountId, plan } = req.account;

  // Refusals, cheapest first, all before anything reaches the model.
  const refusal = platformCloudRefusal(plan);
  if (refusal) return refuse(res, refusal);
  if (requestsInFlight.has(request.requestId) || (await requestRecorded(request.requestId))) {
    return refuse(res, 'duplicate_request');
  }

  const now = new Date();
  const [month, week] = await Promise.all([
    usageSince(accountId, answerMonthStart(now)),
    usageSince(accountId, allowanceWeekStart(now)),
  ]);
  const credential = resolvePlatformCredential({ plan, weeklySpentUsd: week.spentUsd, monthlyAnswersUsed: month.answers });
  if (credential.blocked === 'answer_limit_reached') {
    return refuse(res, credential.blocked, { freesUpNext: await answerFreesUpNext(accountId, now) });
  }
  if (credential.blocked === 'allowance_exhausted') {
    return refuse(res, credential.blocked, { freesUpNext: await freesUpNext(accountId, now) });
  }
  if (credential.blocked) return refuse(res, credential.blocked);

  // From here to the bookkeeping below there is no await, so two requests
  // cannot both pass these checks on the same slot.
  if (requestsInFlight.has(request.requestId)) return refuse(res, 'duplicate_request');
  const open = streamsByAccount.get(accountId) ?? 0;
  if (open >= MAX_STREAMS_PER_ACCOUNT) return refuse(res, 'too_many_streams');
  requestsInFlight.add(request.requestId);
  streamsByAccount.set(accountId, open + 1);

  try {
    await streamAnswer(req, res, { accountId, request, credential });
  } finally {
    // Released only after the ledger write, so the next request is checked
    // against a ledger that already holds this answer.
    requestsInFlight.delete(request.requestId);
    const left = (streamsByAccount.get(accountId) ?? 1) - 1;
    if (left > 0) streamsByAccount.set(accountId, left);
    else streamsByAccount.delete(accountId);
  }
});

async function streamAnswer(req, res, { accountId, request, credential }) {
  // A client that left while the ledger was being checked would never see the
  // close event below; nothing is sent upstream for it.
  if (res.destroyed || req.socket?.destroyed) return;
  const model = credential.modelFor(request.hard);
  const upstream = new AbortController();
  // A client that hangs up stops the answer upstream, so the platform is not
  // billed for text nobody will read.
  res.on('close', () => {
    if (!res.writableEnded) upstream.abort();
  });

  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  const send = (event) => {
    if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  let seen = null;
  let streamedChars = 0;
  let finished = null;
  let failure = null;
  try {
    for await (const event of streamChat({
      apiKey: credential.apiKey,
      model,
      effort: credential.effort,
      messages: request.messages,
      cacheMarker: request.cacheMarker,
      signal: upstream.signal,
      maxTokens: credential.maxTokens,
      brevity: credential.brevity,
      onUsage: (usage) => {
        seen = usage;
      },
    })) {
      if (event.text) {
        streamedChars += event.text.length;
        send({ text: event.text });
      }
      if (event.done) finished = event;
    }
  } catch (err) {
    failure = err;
  }

  // The answer is charged whether it finished or not: a cancelled or failed
  // answer was still billed for whatever the model read and wrote. Only a
  // failure upstream spares the person one of their monthly answers: it is the
  // platform's fault they got none. A client that hung up was being answered,
  // and leaving it uncounted would make hanging up near the end a free answer.
  const cancelled = upstream.signal.aborted;
  const failedUpstream = Boolean(failure) && !cancelled;
  const usage = finished?.usage ?? partialUsage(seen, streamedChars);
  const cost = usage ? costUsd(model, usage) : null;
  if (usage) {
    await charge({
      accountId,
      requestId: request.requestId,
      model,
      hard: request.hard,
      inputTokens: inputTokensRead(usage),
      outputTokens: usage.output_tokens,
      costUsd: cost,
      sources: request.sources,
      completed: !failedUpstream,
    });
  }

  if (failure) {
    // A status or an error class only: the error's own text can quote the prompt.
    const how = cancelled ? 'cancelled by the client' : 'failed upstream';
    console.warn(`cloud: request ${request.requestId} ${how} (${failureKind(failure)}); usage ${usage ? 'recorded' : 'not reported'}`);
  }

  if (finished) {
    send({ done: true, usage: finished.usage, stopReason: finished.stopReason, model, costUsd: cost, economy: credential.economy });
  } else if (!cancelled) {
    send({ error: describeError(failure), code: 'upstream_error' });
  }
  if (!res.writableEnded) res.end();
}

// What an unfinished answer was billed for: the input counts from the start of
// the stream, and the larger of the reported and estimated output.
function partialUsage(seen, streamedChars) {
  if (!seen) return null;
  return {
    ...seen,
    output_tokens: Math.max(seen.output_tokens, Math.ceil(streamedChars / CHARS_PER_TOKEN_ESTIMATE)),
  };
}

// Writes the ledger row, retrying once: an answer the platform paid for but
// the ledger missed would let the account spend past its allowance.
async function charge(entry) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      if (!(await recordUsage(entry))) {
        console.warn(`cloud: request ${entry.requestId} was already in the ledger; this answer was not charged`);
      }
      return;
    } catch (err) {
      if (attempt === 2) console.error(`cloud: could not record usage for request ${entry.requestId} (${failureKind(err)})`);
    }
  }
}

export default router;
