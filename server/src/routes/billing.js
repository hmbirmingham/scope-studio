import { Router } from 'express';
import requireAuth from '../middleware/requireAuth.js';
import { PLANS } from '../billing/plans.js';
import { billingConfig, createCheckout, customerPortalUrl, subscriptionRecord, verifyEvent } from '../billing/stripe.js';
import { applySubscription, getUserBilling } from '../models/userStore.js';

const NOT_CONFIGURED = { error: 'Billing is not configured on this server.', code: 'billing_not_configured' };
const SUBSCRIPTION_EVENTS = new Set([
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
]);

// Called by Stripe, not a signed-in user, so it is not behind requireAuth; the
// signature is its authentication. Mounted with a raw body parser ahead of
// express.json, because the signature covers the exact bytes sent.
export async function billingWebhook(req, res) {
  const config = billingConfig();
  if (!config) return res.status(503).json(NOT_CONFIGURED);

  let event;
  try {
    event = verifyEvent(config, req.body, req.get('stripe-signature'));
  } catch {
    return res.status(401).json({ error: 'invalid signature' });
  }
  // Acknowledged so Stripe stops retrying; nothing to do for it.
  if (!SUBSCRIPTION_EVENTS.has(event.type)) return res.status(200).json({ ignored: event.type });

  const record = subscriptionRecord(config, event.data.object);
  const plan = await applySubscription({ ...record, eventAt: new Date(event.created * 1000).toISOString() });
  // No match is acknowledged too: an unknown or out-of-date event must not
  // trigger endless retries. It is logged for the owner to look into.
  if (plan === null) console.warn(`billing webhook ${event.type} for ${record.subscriptionId} matched no user, or was older than the last applied`);
  res.status(200).json({ applied: plan !== null, plan });
}

const router = Router();
router.use(requireAuth);

const returnUrl = () => `${process.env.BASE_URL}/`;

router.get('/', async (req, res) => {
  const user = await getUserBilling(req.session.userId);
  res.json({
    configured: Boolean(billingConfig()),
    plan: user.plan,
    status: user.billing_status,
    renewsAt: user.billing_renews_at,
    cancelAt: user.billing_cancel_at,
    hasSubscription: Boolean(user.billing_subscription_id) && user.plan !== 'free',
    prices: Object.fromEntries(Object.entries(PLANS).map(([name, plan]) => [name, plan.priceUsd])),
  });
});

router.post('/checkout', async (req, res) => {
  const config = billingConfig();
  if (!config) return res.status(503).json(NOT_CONFIGURED);
  const { plan } = req.body ?? {};
  if (!['key_pro', 'student', 'engineer'].includes(plan)) {
    return res.status(400).json({ error: 'plan must be key_pro, student or engineer' });
  }
  const user = await getUserBilling(req.session.userId);
  // A second subscription would bill twice; plan changes go through the portal.
  if (user.billing_subscription_id && user.plan !== 'free') {
    return res.status(409).json({ error: 'You already have a subscription. Change or cancel it from Manage billing.', code: 'already_subscribed' });
  }
  try {
    const url = await createCheckout(config, {
      plan,
      userId: user.id,
      email: user.email,
      customerId: user.billing_customer_id,
      returnUrl: returnUrl(),
    });
    res.json({ url });
  } catch (err) {
    res.status(502).json({ error: `Stripe: ${err.message}` });
  }
});

router.post('/portal', async (req, res) => {
  const config = billingConfig();
  if (!config) return res.status(503).json(NOT_CONFIGURED);
  const user = await getUserBilling(req.session.userId);
  if (!user.billing_customer_id) return res.status(404).json({ error: 'no billing account on this user' });
  try {
    res.json({ url: await customerPortalUrl(config, { customerId: user.billing_customer_id, returnUrl: returnUrl() }) });
  } catch (err) {
    res.status(502).json({ error: `Stripe: ${err.message}` });
  }
});

export default router;
