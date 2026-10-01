import { Router } from 'express';
import requireAuth from '../middleware/requireAuth.js';
import { PLANS } from '../billing/plans.js';
import { billingConfig, createCheckout, customerPortalUrl, entitledPlan, verifySignature } from '../billing/lemonsqueezy.js';
import { applySubscription, getUserBilling } from '../models/userStore.js';

const NOT_CONFIGURED = { error: 'Billing is not configured on this server.', code: 'billing_not_configured' };
const SUBSCRIPTION_EVENTS = new Set([
  'subscription_created', 'subscription_updated', 'subscription_cancelled', 'subscription_resumed',
  'subscription_expired', 'subscription_paused', 'subscription_unpaused',
  'subscription_payment_success', 'subscription_payment_failed', 'subscription_payment_recovered',
]);

// The webhook is called by Lemon Squeezy, not a signed-in user, so it is not
// behind requireAuth; the signature is its authentication. Mounted with a raw
// body parser ahead of express.json, because the signature covers exact bytes.
export async function billingWebhook(req, res) {
  const config = billingConfig();
  if (!config) return res.status(503).json(NOT_CONFIGURED);
  if (!Buffer.isBuffer(req.body) || !verifySignature(req.body, req.get('x-signature'), config.webhookSecret)) {
    return res.status(401).json({ error: 'invalid signature' });
  }

  let event;
  try {
    event = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'invalid JSON' });
  }
  const name = req.get('x-event-name') ?? event.meta?.event_name;
  // Acknowledged so Lemon Squeezy stops retrying; nothing to do for it.
  if (!SUBSCRIPTION_EVENTS.has(name) || event.data?.type !== 'subscriptions') return res.status(200).json({ ignored: name });

  const attributes = event.data.attributes ?? {};
  const plan = await applySubscription({
    userId: event.meta?.custom_data?.user_id ?? null,
    subscriptionId: String(event.data.id),
    customerId: attributes.customer_id != null ? String(attributes.customer_id) : null,
    status: attributes.status,
    variantId: attributes.variant_id != null ? String(attributes.variant_id) : null,
    renewsAt: attributes.renews_at ?? null,
    endsAt: attributes.ends_at ?? null,
    updatedAt: attributes.updated_at ?? new Date().toISOString(),
    plan: entitledPlan(config, attributes),
  });
  // No match is acknowledged too: an unknown or out-of-date event must not
  // trigger endless retries. It is logged for the owner to look into.
  if (plan === null) console.warn(`billing webhook ${name} for subscription ${event.data.id} matched no user, or was older than the last applied`);
  res.status(200).json({ applied: plan !== null, plan });
}

const router = Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  const user = await getUserBilling(req.session.userId);
  res.json({
    configured: Boolean(billingConfig()),
    plan: user.plan,
    status: user.billing_status,
    renewsAt: user.billing_renews_at,
    endsAt: user.billing_ends_at,
    hasSubscription: Boolean(user.billing_subscription_id),
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
      redirectUrl: `${process.env.BASE_URL}/?billing=done`,
    });
    res.json({ url });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.post('/portal', async (req, res) => {
  const config = billingConfig();
  if (!config) return res.status(503).json(NOT_CONFIGURED);
  const user = await getUserBilling(req.session.userId);
  if (!user.billing_subscription_id) return res.status(404).json({ error: 'no subscription on this account' });
  try {
    res.json({ url: await customerPortalUrl(config, user.billing_subscription_id) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

export default router;
