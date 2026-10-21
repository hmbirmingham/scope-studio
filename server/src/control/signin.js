import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { hostname } from 'node:os';
import { ControlError, controlUrl, exchangeCode } from './client.js';
import { saveLink } from './linkStore.js';

// Signing the engine in to the control plane (control/API.md, "Accounts and
// sign-in"), the way a native app signs in (RFC 8252 with PKCE, RFC 7636):
//
// 1. The engine makes a PKCE verifier and a state, and listens on a fresh
//    loopback port, 127.0.0.1 only.
// 2. The person's browser opens the control plane's /signin page with the
//    loopback redirect, the state and the S256 challenge, and signs in there.
//    Their password never passes through the engine.
// 3. The control plane redirects the browser to the loopback port with a
//    one-time code and the state. The engine checks the state, exchanges the
//    code and its verifier for a device token, stores the token for the local
//    user who started the flow, and stops listening.
//
// The verifier never leaves the engine until the exchange, so a code seen by
// anything else on the machine (another tab, a browser extension, a process
// that raced for the port) cannot be turned into a token.

// How long a started sign-in waits for the browser. The control plane's code
// itself lives five minutes; this covers typing a password and a slow page.
export const SIGNIN_TTL_MS = 10 * 60 * 1000;
const CALLBACK_PATH = '/callback';

export function newVerifier() {
  return randomBytes(32).toString('base64url');
}

export function challengeFor(verifier) {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function newState() {
  return randomBytes(32).toString('base64url');
}

// Constant-time, and false for anything that is not a string of the same length.
export function stateMatches(expected, received) {
  if (typeof received !== 'string' || received.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}

export function signinUrl(base, { redirectUri, state, challenge, label }) {
  const url = new URL(`${base}/signin`);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (label) url.searchParams.set('label', label);
  return url.toString();
}

export function deviceLabel() {
  return `Scope Studio on ${hostname()}`.slice(0, 100);
}

// The page the browser lands on at the end. Static text only: nothing from the
// request is reflected into it, and it loads nothing.
function page(res, status, title, message) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#222}</style></head>
<body><h1>${title}</h1><p>${message}</p></body></html>`);
}

const flows = new Map();

// The sign-in a local user has under way, if any, without its secrets.
export function pendingSignIn(ownerId) {
  const flow = flows.get(ownerId);
  return flow ? { url: flow.url, expiresAt: new Date(flow.expiresAt).toISOString() } : null;
}

export function cancelSignIn(ownerId) {
  const flow = flows.get(ownerId);
  if (flow) flow.close();
}

// Starts a sign-in for one local user and resolves with the URL the browser
// should open. Starting again replaces an unfinished one. `onComplete` is told
// how the flow ended ({ ok: true } or { ok: false, reason }), for tests and
// logs; `save` stores the link (linkStore.saveLink unless a test says otherwise).
export async function startSignIn(ownerId, { base = controlUrl(), label = deviceLabel(), ttlMs = SIGNIN_TTL_MS, fetchImpl, onComplete, save = saveLink } = {}) {
  if (!base) throw new ControlError(0, 'control_not_configured', 'No control plane is configured for this engine (CONTROL_URL).');
  cancelSignIn(ownerId);

  const verifier = newVerifier();
  const state = newState();
  const server = http.createServer();
  let settled = false;
  const flow = { expiresAt: Date.now() + ttlMs };

  const finish = (outcome) => {
    if (settled) return;
    settled = true;
    clearTimeout(flow.timer);
    if (flows.get(ownerId) === flow) flows.delete(ownerId);
    server.close();
    // Lets the page's response reach the browser, then drops idle keep-alives
    // so the port is free at once.
    setImmediate(() => server.closeIdleConnections?.());
    onComplete?.(outcome);
  };
  flow.close = () => finish({ ok: false, reason: 'cancelled' });

  server.on('request', async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method !== 'GET' || url.pathname !== CALLBACK_PATH) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
      return;
    }
    // A request without this flow's state is not the control plane's redirect
    // (a stale tab, or something probing the port), and does not end the flow.
    if (settled || flow.consumed || !stateMatches(state, url.searchParams.get('state'))) {
      page(res, 400, 'Sign-in link not recognised', 'This page does not belong to the sign-in Scope Studio is waiting for. Start signing in again from the app.');
      return;
    }
    const code = url.searchParams.get('code');
    if (!code) {
      finish({ ok: false, reason: 'no_code' });
      page(res, 400, 'Sign-in did not finish', 'Scope Studio did not receive a sign-in code. Start signing in again from the app.');
      return;
    }
    // The state is spent from here on, whatever the exchange says: a second
    // redirect carrying it is refused like a stranger's.
    flow.consumed = true;
    try {
      const grant = await exchangeCode({ code, verifier }, { base, ...(fetchImpl ? { fetchImpl } : {}) });
      const account = grant?.account;
      if (typeof grant?.token !== 'string' || !account?.id || !account?.email) {
        throw new ControlError(502, 'control_bad_response', 'The control plane sent an incomplete sign-in.');
      }
      // A flow cancelled while the exchange was under way stores nothing.
      if (settled) throw new ControlError(0, 'cancelled', 'The sign-in was cancelled.');
      await save({ ownerId, token: grant.token, account });
      page(res, 200, 'Signed in to Scope Studio', 'You can close this tab and return to the app.');
      finish({ ok: true, account: { email: account.email, plan: account.plan, devMode: account.devMode === true } });
    } catch (err) {
      page(res, 502, 'Sign-in did not finish', 'Scope Studio could not complete the sign-in. Start signing in again from the app.');
      finish({ ok: false, reason: err instanceof ControlError ? err.code : 'exchange_failed' });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const redirectUri = `http://127.0.0.1:${server.address().port}${CALLBACK_PATH}`;
  flow.url = signinUrl(base, { redirectUri, state, challenge: challengeFor(verifier), label });
  flow.redirectUri = redirectUri;
  flow.timer = setTimeout(() => finish({ ok: false, reason: 'expired' }), ttlMs);
  flow.timer.unref?.();
  flows.set(ownerId, flow);
  return { url: flow.url, redirectUri, expiresAt: new Date(flow.expiresAt).toISOString() };
}
