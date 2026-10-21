// The engine's side of the control plane API (control/API.md). Every call the
// engine makes to the control plane goes through here, so the device token is
// handled in one place: it is put in the Authorization header and nowhere
// else, never logged and never part of an error.

// Long enough for a slow network, short enough that an unreachable control
// plane turns into local-only answers instead of a hanging request.
export const CONTROL_TIMEOUT_MS = 8000;

// CONTROL_URL is read on every call rather than once at start-up, so tests
// (and a person editing .env) can point the engine elsewhere without a
// restart. There is no default: without it the engine is simply signed out.
export function controlUrl(env = process.env) {
  const raw = env.CONTROL_URL?.trim();
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  return url.toString().replace(/\/+$/, '');
}

// A failure talking to the control plane. `status` is the HTTP status (0 when
// the control plane could not be reached at all) and `code` is the control
// plane's own snake_case code, or one of ours: `control_not_configured`,
// `control_unreachable`, `control_bad_response`.
export class ControlError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = 'ControlError';
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }

  get offline() {
    return this.status === 0;
  }
}

export function notConfigured() {
  return new ControlError(0, 'control_not_configured', 'No control plane is configured for this engine (CONTROL_URL).');
}

// One request to the control plane. A network failure or timeout becomes a
// ControlError with status 0 rather than a thrown TypeError, so callers can
// treat "offline" as an ordinary answer.
//
// The timeout covers the whole exchange for an ordinary JSON call. For a
// stream (`streaming: true`) it covers only the wait for the response headers:
// an answer may take longer than the timeout to finish, and the caller's own
// signal stops it.
export async function controlRequest(path, { method = 'GET', token, body, signal, fetchImpl = fetch, base = controlUrl(), timeoutMs = CONTROL_TIMEOUT_MS, streaming = false } = {}) {
  if (!base) throw notConfigured();
  const headers = { Accept: streaming ? 'text/event-stream' : 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const timer = new AbortController();
  const timeout = setTimeout(() => timer.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timer.signal]) : timer.signal,
      redirect: 'error',
    });
  } catch (err) {
    clearTimeout(timeout);
    if (signal?.aborted) throw err;
    throw new ControlError(0, 'control_unreachable', 'The Scope Studio control plane could not be reached.');
  }
  if (streaming) clearTimeout(timeout);
  else response.finished = () => clearTimeout(timeout);
  return response;
}

// The JSON body of a finished response, or a ControlError carrying the
// control plane's own code and sentence. Error text from the control plane is
// already written for a person (API.md: driver and upstream text never reach
// a response), so it is passed on.
export async function readJson(response) {
  let payload = null;
  let unreadable = false;
  if (response.status !== 204) {
    try {
      payload = await response.json();
    } catch {
      unreadable = true;
    }
  }
  if (response.ok) {
    if (unreadable) throw new ControlError(response.status, 'control_bad_response', 'The control plane sent an answer the engine could not read.');
    return payload;
  }
  const { error, code, ...extra } = payload && typeof payload === 'object' ? payload : {};
  throw new ControlError(
    response.status,
    typeof code === 'string' ? code : 'control_bad_response',
    typeof error === 'string' ? error : `The control plane answered ${response.status}.`,
    extra
  );
}

async function call(path, options) {
  const response = await controlRequest(path, options);
  try {
    return await readJson(response);
  } catch (err) {
    if (err instanceof ControlError) throw err;
    // The body stopped arriving (timeout or a dropped connection).
    throw new ControlError(0, 'control_unreachable', 'The Scope Studio control plane could not be reached.');
  } finally {
    response.finished?.();
  }
}

// POST /v1/auth/token: the one-time code from the browser and the verifier
// only this engine holds, for a device token.
export function exchangeCode({ code, verifier }, options = {}) {
  return call('/v1/auth/token', { ...options, method: 'POST', body: { code, code_verifier: verifier } });
}

export function fetchMe(token, options = {}) {
  return call('/v1/me', { ...options, token });
}

export function listDevices(token, options = {}) {
  return call('/v1/devices', { ...options, token });
}

export function revokeDevice(token, deviceId, options = {}) {
  return call(`/v1/devices/${encodeURIComponent(deviceId)}`, { ...options, method: 'DELETE', token });
}

export function getBilling(token, options = {}) {
  return call('/v1/billing', { ...options, token });
}

export function startCheckout(token, plan, options = {}) {
  return call('/v1/billing/checkout', { ...options, method: 'POST', token, body: { plan } });
}

export function openPortal(token, options = {}) {
  return call('/v1/billing/portal', { ...options, method: 'POST', token, body: {} });
}
