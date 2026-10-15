import { Router } from 'express';
import { planFor } from '../billing/plans.js';
import {
  PAID_PLANS,
  billingConfig,
  createCheckout,
  createCustomer,
  currentSubscription,
  customerPortalUrl,
  invoiceSubscriptionId,
  subscriptionRecord,
  verifyEvent,
} from '../billing/stripe.js';
import { sendError } from '../lib/errors.js';
import { requireDevice } from '../middleware/requireDevice.js';
import { applySubscription, getAccountBilling, setBillingCustomer } from '../models/billing.js';

const SUBSCRIPTION_EVENTS = new Set([
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'customer.subscription.paused',
  'customer.subscription.resumed',
]);
// Renewals and failed payments arrive as invoice events; each one is a prompt
// to re-read the subscription it belongs to, like the subscription events.
const INVOICE_EVENTS = new Set(['invoice.paid', 'invoice.payment_failed']);

const notConfigured = (res) => sendError(res, 503, 'billing_not_configured', 'Billing is not configured on this server.');

// Called by Stripe, not a device, so it is not behind requireDevice; the
// signature is its authentication. app.js mounts it with a raw body parser
// ahead of express.json, because the signature covers the exact bytes sent.
export async function billingWebhook(req, res) {
  const config = billingConfig();
  if (!config) return notConfigured(res);

  let event;
  try {
    event = verifyEvent(config, req.body, req.get('stripe-signature'));
  } catch {
    return sendError(res, 401, 'invalid_signature', 'The Stripe signature does not match this request.');
  }
  // Acknowledged so Stripe stops retrying; nothing to do for it.
  if (!SUBSCRIPTION_EVENTS.has(event.type) && !INVOICE_EVENTS.has(event.type)) {
    return res.status(200).json({ ignored: event.type });
  }
  // This handler reads snapshot events. A thin-payload endpoint sends no
  // object; refusing loudly beats silently granting nothing.
  const object = event.data?.object;
  const subscriptionId = object && (INVOICE_EVENTS.has(event.type) ? invoiceSubscriptionId(object) : object.id);
  // An invoice that is not for a subscription (a one-off) changes no plan.
  if (object && !subscriptionId && INVOICE_EVENTS.has(event.type)) {
    return res.status(200).json({ ignored: 'invoice without a subscription' });
  }
  if (!subscriptionId) {
    console.error('billing webhook received a thin event; configure the endpoint with the Snapshot payload');
    return sendError(res, 400, 'snapshot_required', 'This endpoint needs snapshot events; configure it with the Snapshot payload.');
  }

  let subscription;
  try {
    subscription = await currentSubscription(config, subscriptionId);
  } catch (err) {
    // A 5xx makes Stripe retry later, which is what a transient failure needs.
    console.error(`billing webhook could not read ${subscriptionId}: ${err.message}`);
    return sendError(res, 502, 'stripe_unavailable', 'Could not read the subscription from Stripe.');
  }
  const record = subscriptionRecord(config, subscription);
  const plan = await applySubscription(record);
  // No match is acknowledged too: an unknown subscription must not trigger
  // endless retries. It is logged for the owner to look into.
  if (plan === null) console.warn(`billing webhook ${event.type} for ${subscriptionId} matched no account`);
  res.status(200).json({ applied: plan !== null, plan });
}

// Mounted at the root: routes here declare their full paths (see API.md).
const router = Router();

// Built on first use rather than at import, so the pool it holds is made
// after the process has its database URL (tests set it after importing the app).
let deviceAuth;
const device = (req, res, next) => (deviceAuth ??= requireDevice())(req, res, next);

// Stripe's own error text can name prices, customers or request ids, so it is
// logged here and the engine gets a sentence of its own.
function stripeFailed(res, action, err) {
  console.error(`billing ${action} failed: ${err.message}`);
  return sendError(res, 502, 'stripe_error', 'Stripe could not complete the request. Try again in a moment.');
}

// A plan change on an existing subscription goes through the portal; a second
// checkout would bill twice.
const subscribed = (account) => Boolean(account.billing_subscription_id) && account.plan !== 'free';

router.get('/v1/billing', device, async (req, res) => {
  if (!billingConfig()) return notConfigured(res);
  const account = await getAccountBilling(req.account.id);
  res.json({
    plan: account.plan,
    status: account.billing_status,
    renewsAt: account.billing_renews_at,
    cancelAt: account.billing_cancel_at,
    hasSubscription: subscribed(account),
    prices: Object.fromEntries(PAID_PLANS.map((plan) => [plan, planFor(plan).priceUsd])),
  });
});

router.post('/v1/billing/checkout', device, async (req, res) => {
  const config = billingConfig();
  if (!config) return notConfigured(res);
  const { plan } = req.body ?? {};
  if (!PAID_PLANS.includes(plan)) {
    return sendError(res, 400, 'invalid_plan', `Choose one of: ${PAID_PLANS.join(', ')}.`);
  }
  const account = await getAccountBilling(req.account.id);
  if (subscribed(account)) {
    return sendError(res, 409, 'already_subscribed', 'You already have a subscription. Change or cancel it from Manage billing.');
  }
  try {
    // The account's Stripe Customer, created once: events are matched by it.
    const customerId =
      account.billing_customer_id ??
      (await setBillingCustomer(account.id, await createCustomer(config, { accountId: account.id, email: account.email })));
    const url = await createCheckout(config, { plan, accountId: account.id, customerId });
    res.json({ url });
  } catch (err) {
    stripeFailed(res, 'checkout', err);
  }
});

router.post('/v1/billing/portal', device, async (req, res) => {
  const config = billingConfig();
  if (!config) return notConfigured(res);
  const account = await getAccountBilling(req.account.id);
  if (!account.billing_customer_id) {
    return sendError(res, 404, 'no_billing_account', 'There is no billing account to manage yet. Choose a plan first.');
  }
  try {
    res.json({ url: await customerPortalUrl(config, { customerId: account.billing_customer_id }) });
  } catch (err) {
    stripeFailed(res, 'portal', err);
  }
});

// Where Stripe sends the browser after checkout or the portal. It is static
// and holds nothing about the account, so it answers whether or not billing is
// configured: a person who just paid should never land on an error. The plan
// itself reaches the app by webhook and /v1/me, not through this page.
const DONE_MESSAGES = {
  complete: ['Purchase complete', 'Thank you. Your plan is active. Return to Scope Studio to keep working; it picks up the new plan on its own.'],
  canceled: ['Checkout canceled', 'Nothing was charged. Return to Scope Studio whenever you are ready.'],
  default: ['All done', 'Your billing changes are saved. Return to Scope Studio to keep working.'],
};

router.get('/billing/done', (req, res) => {
  const state = Object.hasOwn(DONE_MESSAGES, req.query.checkout) ? req.query.checkout : 'default';
  const [title, message] = DONE_MESSAGES[state];
  res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
  res.type('html').send(donePage(title, message));
});

// The control dashboard is a desktop page for now, so this is laid out for a
// desktop window and nothing more.
function donePage(title, message) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title} - Scope Studio</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         background: #f6f6f4; color: #1d1d1b; font: 16px/1.5 system-ui, -apple-system, sans-serif; }
  main { width: 480px; padding: 40px 48px; background: #fff; border: 1px solid #e2e2de; border-radius: 12px; }
  h1 { margin: 0 0 12px; font-size: 22px; font-weight: 600; }
  p { margin: 0; color: #4a4a46; }
</style>
</head>
<body>
<main>
<h1>${title}</h1>
<p>${message}</p>
<p style="margin-top: 16px; font-size: 14px;">You can close this window.</p>
</main>
</body>
</html>
`;
}

export default router;
