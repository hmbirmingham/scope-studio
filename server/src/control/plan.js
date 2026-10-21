import { PLANS } from '../billing/plans.js';
import { ControlError, controlUrl, fetchMe } from './client.js';
import * as linkStore from './linkStore.js';

// The plan this engine runs under comes from the control plane: GET /v1/me,
// cached per local user. The control plane is the billing authority; the
// engine keeps no billing tables of its own.
//
// The cache is fresh for PLAN_TTL_MS. Past that, the next read asks the
// control plane again. When it cannot be asked (no CONTROL_URL, offline, the
// control plane is down) the engine runs as Free: local answers only. That is
// never an error page, and nothing local stops working; the last answer is
// still shown, marked stale, so the person can see which plan they have.
// A 401 means the token was revoked elsewhere (another device removed this
// one), so the link is forgotten and the engine is signed out.
//
// Without CONTROL_URL the engine has no control plane at all, so a cached
// answer, however fresh, grants nothing: the plan is Free and the state says
// `not_configured`. The cache is kept for when CONTROL_URL comes back.

export const PLAN_TTL_MS = 5 * 60 * 1000;

// After a refresh fails (unreachable, timed out, or a 5xx), the engine does not
// ask again for this long. A control plane that hangs would otherwise cost
// every request the full client timeout; with this, one request in each window
// waits and the rest answer at once. A plan confirmed within PLAN_TTL_MS is
// still served during the window, since the failure says nothing new about it.
export const FAILURE_TTL_MS = 30 * 1000;

// One /v1/me request in flight per user at a time: a burst of requests after
// the cache expires shares a single refresh.
const refreshing = new Map();

// ownerId -> { at, token, reason } for the last failed refresh. Keyed by the
// token too, so signing in again (a new token) is never held back by a
// failure that belonged to the old link. In memory only: a restart retries.
const failures = new Map();

// For tests: forget every remembered failure.
export function forgetFailures() {
  failures.clear();
}

const knownPlan = (plan) => (typeof plan === 'string' && Object.hasOwn(PLANS, plan) ? plan : 'free');

function signedOut(reason) {
  return { configured: Boolean(controlUrl()), signedIn: false, online: false, stale: false, plan: 'free', reason, account: null, me: null, fetchedAt: null, refreshFailed: false };
}

// `refreshFailed` is true when the last attempt to reach the control plane
// for this link failed (now, or within FAILURE_TTL_MS): callers about to make
// another control-plane request of their own (billing) can skip it rather than
// wait for the same timeout. It is not shown to the client.
function stateFrom(link, { online, stale, reason = null, refreshFailed = false }) {
  const me = link.me;
  const account = { email: me?.account?.email ?? link.email, devMode: me?.account?.devMode ?? link.devMode, plan: knownPlan(me?.account?.plan) };
  return {
    configured: Boolean(controlUrl()),
    signedIn: true,
    online,
    stale,
    // Only a plan confirmed within the TTL grants anything beyond Free.
    plan: online ? account.plan : 'free',
    reason,
    account,
    me,
    fetchedAt: link.meFetchedAt?.toISOString() ?? null,
    refreshFailed,
  };
}

const isFresh = (link, now) => Boolean(link.me && link.meFetchedAt && now - link.meFetchedAt.getTime() < PLAN_TTL_MS);

// What a link is worth while the control plane cannot be asked: the cached
// plan if it is still within its TTL, otherwise Free with the last answer
// kept for display.
function unrefreshed(link, now, reason) {
  return isFresh(link, now)
    ? stateFrom(link, { online: true, stale: false, refreshFailed: true })
    : stateFrom(link, { online: false, stale: Boolean(link.me), reason, refreshFailed: true });
}

async function refresh(ownerId, link, { fetchImpl, store, now }) {
  try {
    const me = await fetchMe(link.token, fetchImpl ? { fetchImpl } : {});
    const fetchedAt = new Date();
    await store.saveMe(ownerId, me, fetchedAt);
    failures.delete(ownerId);
    return stateFrom({ ...link, me, meFetchedAt: fetchedAt }, { online: true, stale: false });
  } catch (err) {
    if (!(err instanceof ControlError)) throw err;
    if (err.status === 401) {
      failures.delete(ownerId);
      await store.deleteLink(ownerId);
      return signedOut('signed_out');
    }
    // Unreachable, or the control plane failed: remember it for a short while,
    // run as Free unless the cached plan is still within its TTL, and keep the
    // last answer for display.
    failures.set(ownerId, { at: now, token: link.token, reason: 'offline' });
    return unrefreshed(link, now, 'offline');
  }
}

// Everything the engine knows about the user's control-plane account, without
// the token. `plan` is what the plan rules use. `store` is the link table
// (linkStore.js); tests pass a stand-in.
export async function controlState(ownerId, { refresh: force = false, now = Date.now(), fetchImpl, store = linkStore } = {}) {
  const link = await store.getLink(ownerId);
  if (!link) return signedOut(controlUrl() ? 'signed_out' : 'not_configured');
  // A token that cannot be opened (SESSION_SECRET changed) is no sign-in.
  if (!link.token) return signedOut('signed_out');
  if (!controlUrl()) return stateFrom(link, { online: false, stale: Boolean(link.me), reason: 'not_configured' });

  if (isFresh(link, now) && !force) return stateFrom(link, { online: true, stale: false });

  const failed = failures.get(ownerId);
  if (failed && failed.token === link.token && now - failed.at < FAILURE_TTL_MS) return unrefreshed(link, now, failed.reason);

  let pending = refreshing.get(ownerId);
  if (!pending) {
    pending = refresh(ownerId, link, { fetchImpl, store, now }).finally(() => refreshing.delete(ownerId));
    refreshing.set(ownerId, pending);
  }
  return pending;
}

export async function currentPlan(ownerId, options) {
  return (await controlState(ownerId, options)).plan;
}

// The device token for a signed-in user, for the control client only. Never
// put it in a response, an event or a log line.
export async function deviceToken(ownerId, store = linkStore) {
  return (await store.getLink(ownerId))?.token ?? null;
}
