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

export const PLAN_TTL_MS = 5 * 60 * 1000;

// One /v1/me request in flight per user at a time: a burst of requests after
// the cache expires shares a single refresh.
const refreshing = new Map();

const knownPlan = (plan) => (typeof plan === 'string' && Object.hasOwn(PLANS, plan) ? plan : 'free');

function signedOut(reason) {
  return { configured: Boolean(controlUrl()), signedIn: false, online: false, stale: false, plan: 'free', reason, account: null, me: null, fetchedAt: null };
}

function stateFrom(link, { online, stale, reason = null }) {
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
  };
}

async function refresh(ownerId, link, { fetchImpl, store }) {
  try {
    const me = await fetchMe(link.token, fetchImpl ? { fetchImpl } : {});
    const fetchedAt = new Date();
    await store.saveMe(ownerId, me, fetchedAt);
    return stateFrom({ ...link, me, meFetchedAt: fetchedAt }, { online: true, stale: false });
  } catch (err) {
    if (!(err instanceof ControlError)) throw err;
    if (err.status === 401) {
      await store.deleteLink(ownerId);
      return signedOut('signed_out');
    }
    // Unreachable, unconfigured, or the control plane failed: run as Free and
    // keep the last answer for display only.
    return stateFrom(link, { online: false, stale: Boolean(link.me), reason: err.status === 0 && err.code === 'control_not_configured' ? 'not_configured' : 'offline' });
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

  const fresh = link.me && link.meFetchedAt && now - link.meFetchedAt.getTime() < PLAN_TTL_MS;
  if (fresh && !force) return stateFrom(link, { online: true, stale: false });

  let pending = refreshing.get(ownerId);
  if (!pending) {
    pending = refresh(ownerId, link, { fetchImpl, store }).finally(() => refreshing.delete(ownerId));
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
