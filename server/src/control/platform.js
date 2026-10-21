import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { ControlError, controlRequest, controlUrl, readJson } from './client.js';

// Platform-paid cloud answers: POST /v1/cloud/messages on the control plane
// with the device token, its server-sent events read back into the ModelPort
// shape ({ text } … then { done, usage, costUsd, model }). The control plane
// decides the model, effort and output ceiling from the plan and its ledger;
// the engine sends only the packed messages and says whether the question is
// hard.
//
// Every attempt carries a fresh requestId, retries included. The control
// plane records each id it answers (even a failed answer is charged), so a
// reused id is refused as a duplicate: an id names one attempt, not one
// question.

// Up to this many attempts in all. Only failures before any text arrived are
// retried; once text has been streamed, a retry would repeat the answer.
export const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [250, 1000];

// Statuses worth another attempt with a new id: the control plane was busy,
// restarting, or its answer failed upstream. A refusal on plan or allowance
// grounds will be the same a moment later, so it is not retried.
const RETRYABLE = new Set([409, 429, 500, 502, 503, 504]);
// A 503 with this code is a configuration state, not a blip.
const NOT_TRANSIENT = new Set(['platform_cloud_unavailable']);

// Why the platform cannot answer this call. `code` is always
// `platform_unavailable` (the runner's cue to answer locally, see the
// ModelPort contract); `reason` says which: `signed_out`, `offline`,
// `not_configured`, or the control plane's own refusal code
// (`allowance_exhausted`, `answer_limit_reached`, `cloud_not_in_plan`, …).
export class PlatformUnavailable extends Error {
  constructor(reason, message, extra = {}) {
    super(message);
    this.name = 'PlatformUnavailable';
    this.code = 'platform_unavailable';
    this.reason = reason;
    Object.assign(this, extra);
  }
}

// An answer that started and then failed. Not `platform_unavailable`: some of
// it may already be on screen.
export class PlatformAnswerFailed extends Error {
  constructor(message) {
    super(message);
    this.name = 'PlatformAnswerFailed';
    this.code = 'upstream_error';
  }
}

const SOURCE_NAME = /^[a-z][a-z0-9_]{0,31}$/;
const MAX_SOURCES = 16;

// The plug-in names the control plane may record against an answer, from the
// packed nodes' sources: valid names only, each once, at most 16.
export function sourcesOf(nodes = []) {
  const names = new Set();
  for (const node of nodes) {
    const source = node?.source;
    if (typeof source === 'string' && SOURCE_NAME.test(source)) names.add(source);
    if (names.size === MAX_SOURCES) break;
  }
  return [...names];
}

// Server-sent events from a byte stream: each event's `data:` lines joined
// and parsed as JSON. Comment lines and other fields are ignored; a final
// event without its blank line still counts.
export async function* parseSse(byteStream) {
  const decoder = new TextDecoder();
  let buffer = '';
  let data = [];
  const flush = function* () {
    if (data.length === 0) return;
    const text = data.join('\n');
    data = [];
    yield JSON.parse(text);
  };
  const take = function* (line) {
    if (line === '') {
      yield* flush();
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
  };
  for await (const chunk of byteStream) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffer.search(/\r\n|\r|\n/)) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + (buffer.startsWith('\r\n', newline) ? 2 : 1));
      yield* take(line);
    }
  }
  buffer += decoder.decode();
  if (buffer) yield* take(buffer);
  yield* flush();
}

function refusal(err) {
  if (err.status === 0) {
    return err.code === 'control_not_configured'
      ? new PlatformUnavailable('not_configured', err.message)
      : new PlatformUnavailable('offline', 'The Scope Studio cloud could not be reached. Your local model can still answer.');
  }
  if (err.status === 401) return new PlatformUnavailable('signed_out', 'Sign in to Scope Studio again to use cloud answers.');
  const extra = err.freesUpNext !== undefined ? { freesUpNext: err.freesUpNext } : {};
  return new PlatformUnavailable(err.code, err.message, extra);
}

// One platform answer, with retries. `open()` makes the request and resolves
// once the control plane has accepted it (status 200), or throws
// PlatformUnavailable: the chat route opens first so a refusal can still be
// answered as JSON. `stream()` yields the answer, opening first if needed.
// `requestIds` lists the id of every attempt, in order.
export function platformCall({
  token,
  messages,
  cacheMarker,
  hard = false,
  sources = [],
  signal,
  fetchImpl,
  base = controlUrl(),
  newRequestId = randomUUID,
  maxAttempts = MAX_ATTEMPTS,
  delays = RETRY_DELAYS_MS,
}) {
  const requestIds = [];
  let events = null;

  async function pause() {
    const delay = delays[Math.min(requestIds.length - 1, delays.length - 1)] ?? 0;
    if (delay > 0) await sleep(delay, undefined, signal ? { signal } : undefined);
  }

  async function open() {
    // Refused before anything leaves the machine.
    if (!token) throw new PlatformUnavailable('signed_out', 'Sign in to Scope Studio to use cloud answers.');
    if (!base) throw new PlatformUnavailable('not_configured', 'No control plane is configured for this engine.');
    let last = null;
    while (requestIds.length < maxAttempts) {
      if (last) await pause();
      const requestId = newRequestId();
      requestIds.push(requestId);
      const body = { requestId, messages, hard: hard === true, sources };
      if (cacheMarker) body.cacheMarker = cacheMarker;
      try {
        const response = await controlRequest('/v1/cloud/messages', { method: 'POST', token, body, signal, fetchImpl, base, streaming: true });
        if (response.ok) {
          events = parseSse(response.body);
          return requestId;
        }
        await readJson(response);
      } catch (err) {
        if (!(err instanceof ControlError)) throw err;
        last = err;
        const transient = err.status === 0 || (RETRYABLE.has(err.status) && !NOT_TRANSIENT.has(err.code));
        if (!transient || err.status === 401) break;
      }
    }
    throw last ? refusal(last) : new PlatformUnavailable('offline', 'The Scope Studio cloud could not be reached.');
  }

  async function* stream() {
    if (!events) await open();
    let yielded = false;
    for (;;) {
      let failure;
      try {
        for await (const event of events) {
          if (typeof event?.text === 'string') {
            yielded = true;
            yield { text: event.text };
          } else if (event?.done) {
            yield { done: true, usage: event.usage ?? null, costUsd: event.costUsd ?? null, model: event.model ?? null, economy: event.economy === true, stopReason: event.stopReason ?? null };
            return;
          } else if (event?.error) {
            failure = new PlatformAnswerFailed(typeof event.error === 'string' ? event.error : 'The cloud answer failed.');
            break;
          }
        }
        failure ??= new PlatformAnswerFailed('The cloud answer stopped partway through. Try again shortly.');
      } catch (err) {
        if (signal?.aborted) throw err;
        failure = new PlatformAnswerFailed('The cloud answer stopped partway through. Try again shortly.');
      }
      events = null;
      // Text already shown cannot be taken back, so only a failure before the
      // first word is retried, on a new id.
      if (yielded || requestIds.length >= maxAttempts) throw failure;
      try {
        await pause();
        await open();
      } catch (err) {
        if (err instanceof PlatformUnavailable) throw failure;
        throw err;
      }
    }
  }

  return { open, stream, requestIds };
}

// A platform answer as one stream, for callers that do not need to open first.
export function streamPlatform(options) {
  return platformCall(options).stream();
}
