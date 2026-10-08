import Stripe from 'stripe';

// Stripe Managed Payments: Stripe is the merchant of record. It runs checkout,
// collects and remits sales tax, VAT and GST in more than 80 countries, and
// handles fraud, disputes and transaction support. Customers see the purchase
// as sold through Link. Nothing here stores card details.

const PAID_PLANS = ['key_pro', 'student', 'engineer'];

// Every value billing needs, or null. There are no defaults: an unconfigured
// server says billing is unavailable rather than guessing a key or a price.
export function billingConfig(env = process.env) {
  const config = {
    secretKey: env.STRIPE_SECRET_KEY,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET,
    prices: {
      key_pro: env.STRIPE_PRICE_KEY_PRO,
      student: env.STRIPE_PRICE_STUDENT,
      engineer: env.STRIPE_PRICE_ENGINEER,
    },
  };
  const complete = config.secretKey && config.webhookSecret && Object.values(config.prices).every(Boolean);
  return complete ? config : null;
}

// STRIPE_API_BASE points the client at a local stand-in in tests only.
export function stripeClient(config, env = process.env) {
  const options = { maxNetworkRetries: 1 };
  if (env.STRIPE_API_BASE) {
    const base = new URL(env.STRIPE_API_BASE);
    Object.assign(options, { host: base.hostname, port: Number(base.port), protocol: base.protocol.replace(':', '') });
  }
  return new Stripe(config.secretKey, options);
}

export function planForPrice(config, priceId) {
  return PAID_PLANS.find((plan) => config.prices[plan] === priceId) ?? null;
}

// Statuses that keep the plan. A scheduled cancellation stays `active` until
// the period ends, then the subscription is deleted (status `canceled`); a
// failed renewal (`past_due`) keeps access while Stripe retries.
const ENTITLED = new Set(['active', 'trialing', 'past_due']);

export function entitledPlan(config, subscription) {
  if (!ENTITLED.has(subscription.status)) return 'free';
  return planForPrice(config, subscription.items?.data?.[0]?.price?.id) ?? 'free';
}

const toDate = (seconds) => (seconds ? new Date(seconds * 1000).toISOString() : null);

// The billing columns for one subscription. The period end moved onto
// subscription items in recent API versions; both places are read.
export function subscriptionRecord(config, subscription) {
  const item = subscription.items?.data?.[0];
  return {
    userId: subscription.metadata?.user_id ?? null,
    customerId: typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id ?? null,
    subscriptionId: subscription.id,
    status: subscription.status,
    priceId: item?.price?.id ?? null,
    renewsAt: toDate(item?.current_period_end ?? subscription.current_period_end),
    cancelAt: toDate(subscription.cancel_at),
    plan: entitledPlan(config, subscription),
  };
}

// A hosted checkout for one plan with Managed Payments on, carrying our user
// id on the session and on the subscription it creates, so every later
// subscription event can find the account.
export async function createCheckout(config, { plan, userId, email, customerId, returnUrl }, client = stripeClient(config)) {
  if (!PAID_PLANS.includes(plan)) throw new Error(`not a paid plan: ${plan}`);
  const session = await client.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: config.prices[plan], quantity: 1 }],
    managed_payments: { enabled: true },
    client_reference_id: userId,
    ...(customerId ? { customer: customerId } : { customer_email: email }),
    subscription_data: { metadata: { user_id: userId } },
    success_url: `${returnUrl}?billing=done`,
    cancel_url: returnUrl,
  });
  return session.url;
}

export async function customerPortalUrl(config, { customerId, returnUrl }, client = stripeClient(config)) {
  const session = await client.billingPortal.sessions.create({ customer: customerId, return_url: returnUrl });
  return session.url;
}

// Throws if the signature does not match the exact raw body.
export function verifyEvent(config, rawBody, signature, client = stripeClient(config)) {
  return client.webhooks.constructEvent(rawBody, signature, config.webhookSecret);
}
