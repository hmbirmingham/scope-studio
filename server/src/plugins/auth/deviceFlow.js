import { Router } from 'express';

// The OAuth 2.0 device authorization grant (RFC 8628). The engine runs on the
// user's own machine, which can neither keep a client secret nor host a
// callback URL, so every plug-in that needs a login uses this flow: it needs
// only the public client id, and the user approves the request in their own
// browser on the provider's site. Nothing here is GitHub-specific; a provider
// is described by its two endpoints, its client id and the scope it asks for.

const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

// RFC 8628 section 3.2: when the provider leaves the interval out, clients
// wait five seconds between polls, and slow_down adds five more each time.
const DEFAULT_INTERVAL = 5;
const SLOW_DOWN_STEP = 5;

// A provider that never answers must not hold a request open indefinitely.
const REQUEST_TIMEOUT_MS = 10_000;

// Failures that say nothing about the sign-in itself, only that the provider
// could not be asked this time.
const TRANSIENT = new Set(['unreachable', 'bad_response']);

export class DeviceFlowError extends Error {
  constructor(code, description) {
    super(description ? `${code}: ${description}` : code);
    this.name = 'DeviceFlowError';
    this.code = code;
    this.description = description ?? null;
  }
}

// Providers differ in how they report a refusal: the RFC says 400 with an
// `error` field, GitHub answers 200 with the same field. Both are read the
// same way, and anything that is not JSON at all is a provider fault.
async function postForm(fetch, url, fields) {
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(fields).toString(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new DeviceFlowError('unreachable', err.message);
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new DeviceFlowError('bad_response', `expected JSON, got HTTP ${response.status}`);
  }
  if (!response.ok && !data?.error) {
    throw new DeviceFlowError('bad_response', `HTTP ${response.status}`);
  }
  return data ?? {};
}

// Step one: ask the provider for a device code and the short code the user
// types in. The device code is the secret half of the pair and must stay on
// the engine; only the user code and verification URI are for the browser.
export async function startDeviceFlow({ deviceCodeUrl, clientId, scope, fetch = globalThis.fetch }) {
  if (!clientId) throw new DeviceFlowError('missing_client_id', 'no client id configured');
  const fields = { client_id: clientId };
  if (scope) fields.scope = scope;

  const data = await postForm(fetch, deviceCodeUrl, fields);
  if (data.error) throw new DeviceFlowError(data.error, data.error_description);
  if (!data.device_code || !data.user_code || !data.verification_uri) {
    throw new DeviceFlowError('bad_response', 'device authorization response is missing fields');
  }
  return {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    verificationUriComplete: data.verification_uri_complete ?? null,
    expiresIn: Number(data.expires_in) || 0,
    interval: Number(data.interval) || DEFAULT_INTERVAL,
  };
}

// Step two, repeated: ask whether the user has approved yet. One call is one
// poll, because the caller decides when to poll again (the browser drives it
// here, so a closed tab simply stops asking). `interval` is the caller's
// current wait, needed to work out the slower pace slow_down demands.
export async function pollDeviceFlow({ tokenUrl, clientId, deviceCode, interval = DEFAULT_INTERVAL, fetch = globalThis.fetch }) {
  const data = await postForm(fetch, tokenUrl, {
    client_id: clientId,
    device_code: deviceCode,
    grant_type: GRANT_TYPE,
  });

  if (data.access_token) {
    return {
      status: 'connected',
      accessToken: data.access_token,
      tokenType: data.token_type ?? null,
      scope: data.scope ?? null,
    };
  }

  switch (data.error) {
    case 'authorization_pending':
      return { status: 'pending', interval };
    case 'slow_down':
      // The RFC adds five seconds to the wait for this and every later poll.
      // GitHub also sends the new interval; the larger of the two wins so a
      // provider that asks for more than five extra seconds gets it.
      return { status: 'slow_down', interval: Math.max(interval + SLOW_DOWN_STEP, Number(data.interval) || 0) };
    case 'expired_token':
      return { status: 'expired' };
    case 'access_denied':
      return { status: 'denied' };
    default:
      throw new DeviceFlowError(data.error ?? 'bad_response', data.error_description ?? 'no token and no error in response');
  }
}

// The two routes every plug-in login needs, mounted under the plug-in's own
// router so a new plug-in gets sign-in with one line:
//
//   router.use('/device', deviceFlowRouter({ provider, tokenKey: 'zoteroToken' }));
//
// `provider.config()` returns { deviceCodeUrl, tokenUrl, clientId, scope } or
// throws an error carrying `status` when the plug-in is not configured.
// `provider.describeError(err)` may turn a provider error code into advice.
// The pending device code lives in the session under `${tokenKey}Device` and
// the token, once granted, under `tokenKey`; neither is ever sent to the
// browser, which only ever sees the user code and the verification URI.
export function deviceFlowRouter({ provider, tokenKey, fetch, now = Date.now }) {
  const pendingKey = `${tokenKey}Device`;
  const router = Router();

  function fail(res, err) {
    const status = err.status ?? 502;
    const message = provider.describeError?.(err) ?? err.message;
    return res.status(status).json({ error: message });
  }

  router.post('/start', async (req, res) => {
    let config;
    try {
      config = provider.config();
    } catch (err) {
      return fail(res, err);
    }
    try {
      const started = await startDeviceFlow({ ...config, fetch: fetch ?? globalThis.fetch });
      const at = now();
      req.session[pendingKey] = {
        deviceCode: started.deviceCode,
        interval: started.interval,
        expiresAt: at + started.expiresIn * 1000,
        // The first poll waits one interval too: the user cannot have typed
        // the code yet, and asking early only earns a slow_down.
        nextPollAt: at + started.interval * 1000,
      };
      res.json({
        userCode: started.userCode,
        verificationUri: started.verificationUri,
        expiresIn: started.expiresIn,
        interval: started.interval,
      });
    } catch (err) {
      fail(res, err);
    }
  });

  router.post('/poll', async (req, res) => {
    const pending = req.session[pendingKey];
    if (!pending) {
      // Nothing in flight: either it already finished or it was never begun.
      // A connected session says so, so a late poll from a second tab is not
      // mistaken for a failure.
      if (req.session[tokenKey]) return res.json({ status: 'connected' });
      return res.status(400).json({ error: 'no sign-in in progress — start one first' });
    }

    const at = now();
    if (at >= pending.expiresAt) {
      delete req.session[pendingKey];
      return res.json({ status: 'expired' });
    }
    // Polling faster than the provider allows earns slow_down and, if it
    // keeps up, a refusal. The engine holds the pace itself so a browser
    // that polls early (a second tab, a reconnect) costs the provider nothing.
    if (at < pending.nextPollAt) {
      return res.json({ status: 'pending', interval: pending.interval });
    }

    let config;
    try {
      config = provider.config();
    } catch (err) {
      return fail(res, err);
    }
    try {
      const result = await pollDeviceFlow({
        tokenUrl: config.tokenUrl,
        clientId: config.clientId,
        deviceCode: pending.deviceCode,
        interval: pending.interval,
        fetch: fetch ?? globalThis.fetch,
      });

      if (result.status === 'connected') {
        delete req.session[pendingKey];
        req.session[tokenKey] = result.accessToken;
        return res.json({ status: 'connected' });
      }
      if (result.status === 'expired' || result.status === 'denied') {
        delete req.session[pendingKey];
        return res.json({ status: result.status });
      }
      // pending or slow_down: the browser only needs to know to keep waiting,
      // and how long, so slow_down is reported as pending with the new pace.
      pending.interval = result.interval;
      pending.nextPollAt = at + result.interval * 1000;
      req.session[pendingKey] = pending;
      res.json({ status: 'pending', interval: result.interval });
    } catch (err) {
      // An unexpected refusal (a disabled flow, a bad client id) will not fix
      // itself by polling again, so the attempt is dropped. A provider that
      // was briefly unreachable might answer next time, so that keeps it.
      if (!TRANSIENT.has(err.code)) delete req.session[pendingKey];
      fail(res, err);
    }
  });

  return router;
}
