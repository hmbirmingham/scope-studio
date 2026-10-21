import { Router } from 'express';
import requireAuth from '../middleware/requireAuth.js';
import { PLANS } from '../billing/plans.js';
import { ControlError, controlUrl, getBilling, openPortal, startCheckout } from '../control/client.js';
import { deleteLink, expireMe } from '../control/linkStore.js';
import { controlState, deviceToken } from '../control/plan.js';

// Billing lives on the control plane (control/API.md, "Billing"): Stripe,
// its webhook and the subscription record are all there, and this engine has
// no Stripe client, key or price of its own. These routes keep the plan
// overlay's shape and forward to /v1/billing* with the signed-in user's device
// token. Signed out or offline, the overlay still shows the plans and says
// what is needed; nothing here is an error page.

const PAID_PLANS = ['key_pro', 'student', 'engineer'];
const listPrices = () => Object.fromEntries(Object.entries(PLANS).map(([name, plan]) => [name, plan.priceUsd]));

const router = Router();
router.use(requireAuth);

const SIGNED_OUT = { error: 'Sign in to your Scope Studio account to choose or manage a plan.', code: 'signed_out' };
const NOT_CONFIGURED = { error: 'Accounts are not set up on this engine: CONTROL_URL is not configured.', code: 'control_not_configured' };

// A control-plane refusal passed on with its own status, code and sentence; an
// unreachable control plane is a 503 the overlay can show. A revoked token
// signs this engine out, like a 401 from /v1/me does.
async function forward(res, ownerId, err) {
  if (!(err instanceof ControlError)) throw err;
  if (err.status === 401) {
    await deleteLink(ownerId);
    return res.status(401).json(SIGNED_OUT);
  }
  if (err.status === 0) {
    return res.status(503).json({ error: 'The Scope Studio account service could not be reached. Try again shortly.', code: 'control_unreachable' });
  }
  return res.status(err.status).json({ error: err.message, code: err.code });
}

router.get('/', async (req, res) => {
  const ownerId = req.session.userId;
  // Re-read on every visit: this is where a person looks right after paying.
  const state = await controlState(ownerId, { refresh: true });
  const base = {
    accountsConfigured: Boolean(controlUrl()),
    signedIn: state.signedIn,
    online: state.online,
    email: state.account?.email ?? null,
    plan: state.signedIn ? state.account.plan : 'free',
    status: null,
    renewsAt: null,
    cancelAt: null,
    hasSubscription: false,
    prices: listPrices(),
  };
  const token = state.signedIn ? await deviceToken(ownerId) : null;
  if (!token || !state.online) return res.json({ ...base, configured: false });

  try {
    const billing = await getBilling(token);
    res.json({
      ...base,
      configured: true,
      plan: billing.plan ?? base.plan,
      status: billing.status ?? null,
      renewsAt: billing.renewsAt ?? null,
      cancelAt: billing.cancelAt ?? null,
      hasSubscription: billing.hasSubscription === true,
      prices: billing.prices ?? base.prices,
    });
  } catch (err) {
    if (err instanceof ControlError && err.code === 'billing_not_configured') return res.json({ ...base, configured: false });
    if (err instanceof ControlError && err.status !== 401) return res.json({ ...base, configured: false, online: false });
    return forward(res, ownerId, err);
  }
});

async function withToken(req, res, fn) {
  if (!controlUrl()) return res.status(503).json(NOT_CONFIGURED);
  const ownerId = req.session.userId;
  const token = await deviceToken(ownerId);
  if (!token) return res.status(401).json(SIGNED_OUT);
  try {
    const { url } = await fn(token);
    // The plan may change once the person pays or cancels; the next read of
    // the plan asks the control plane rather than trusting the cache.
    await expireMe(ownerId);
    res.json({ url });
  } catch (err) {
    return forward(res, ownerId, err);
  }
}

router.post('/checkout', async (req, res) => {
  const { plan } = req.body ?? {};
  if (!PAID_PLANS.includes(plan)) {
    return res.status(400).json({ error: 'plan must be key_pro, student or engineer', code: 'invalid_plan' });
  }
  return withToken(req, res, (token) => startCheckout(token, plan));
});

router.post('/portal', (req, res) => withToken(req, res, (token) => openPortal(token)));

export default router;
