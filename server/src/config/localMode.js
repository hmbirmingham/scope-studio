import { DEMO_EMAIL } from '../demo/content.js';

// Local mode: the demo launcher (`npm run demo`, docs/demo.md) starts an
// engine for one person on their own laptop, and that laptop's browser is
// signed in to the demo account without a password. Because this skips the
// password, it is held to the demo and to this machine by every one of these:
//
// Configuration (checked when the engine starts, and again per request):
// - NODE_ENV is exactly `development` (unset is not enough: the engine
//   otherwise treats unset as development);
// - SCOPE_LOCAL_USER names the demo account and nothing else, so local mode
//   can never sign anyone in to a real account, whatever a .env file says;
// - the engine listens on loopback only (SCOPE_HOST): the engine refuses to
//   start otherwise, and the route also reads the address it is bound to.
//
// Request:
// - it arrived over loopback, with a loopback Host header (DNS rebinding);
// - it carries no proxy forwarding headers: a proxy on this machine that was
//   opened to the network would make the two checks above meaningless;
// - any Origin header names a loopback origin (a page on another site);
// - it carries a custom header, which a cross-site form cannot send and a
//   cross-site script can only send after a CORS preflight that is never
//   granted.
//
// What is left (a proxy on this machine opened to the network that strips
// forwarding headers, reached with a forged Host) yields a session for the
// demo account and its demo data only.

export const LOCAL_SIGNIN_HEADER = 'x-scope-local-signin';
export const LOCAL_DEMO_EMAIL = DEMO_EMAIL;

const LOOPBACK_BINDS = new Set(['127.0.0.1', '::1', 'localhost']);
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const FORWARDING_HEADERS = ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-real-ip'];

const normalize = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : '');

function hostName(host) {
  if (typeof host !== 'string' || !host) return null;
  if (host.startsWith('[')) return host.slice(0, host.indexOf(']') + 1).toLowerCase();
  return host.split(':')[0].toLowerCase();
}

function loopbackOrigin(origin) {
  try {
    const url = new URL(origin);
    return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function isLoopbackBind(host) {
  return LOOPBACK_BINDS.has(normalize(host));
}

// Whether local mode is asked for at all.
export function localModeRequested(env = process.env) {
  return Boolean(env.SCOPE_LOCAL_USER);
}

// Why this configuration may not run local mode, or null when it may. The
// engine refuses to start on an answer (server/src/index.js).
export function localModeConfigError(env = process.env) {
  if (!localModeRequested(env)) return null;
  if (env.NODE_ENV !== 'development') return 'SCOPE_LOCAL_USER needs NODE_ENV=development exactly';
  if (normalize(env.SCOPE_LOCAL_USER) !== LOCAL_DEMO_EMAIL) return `SCOPE_LOCAL_USER may only name the demo account (${LOCAL_DEMO_EMAIL})`;
  if (!isLoopbackBind(env.SCOPE_HOST)) return 'SCOPE_LOCAL_USER needs SCOPE_HOST set to 127.0.0.1, ::1 or localhost';
  return null;
}

// Whether this request may be signed in to the demo account. `header: false`
// asks whether it could be (the session check advertises local sign-in with it).
export function localSigninAllowed(req, env = process.env, { header = true } = {}) {
  if (!localModeRequested(env) || localModeConfigError(env)) return false;
  const bound = req.socket?.server?.address?.();
  if (!bound || !LOOPBACK_ADDRESSES.has(bound.address)) return false;
  if (!LOOPBACK_ADDRESSES.has(req.socket?.remoteAddress)) return false;
  if (!LOOPBACK_HOSTS.has(hostName(req.get('host')))) return false;
  if (FORWARDING_HEADERS.some((name) => req.get(name) !== undefined)) return false;
  const origin = req.get('origin');
  if (origin !== undefined && !loopbackOrigin(origin)) return false;
  return !header || req.get(LOCAL_SIGNIN_HEADER) === '1';
}
