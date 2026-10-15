import Stripe from 'stripe';

// Stripe Managed Payments: Stripe is the merchant of record. It runs checkout,
// collects and remits sales tax, VAT and GST in more than 80 countries, and
// handles fraud, disputes and transaction support. Customers see the purchase
// as sold through Link. Nothing here stores card details.

// The one place a sellable thing meets its Stripe price: the key is what an
// account is entitled to, the value names the environment variable holding
// the price id. Checkout, webhooks and the price list all read this table, so
// a paid plug-in add-on later is a new row here, not a new branch elsewhere.
export const PLAN_PRICE_ENV = Object.freeze({
  key_pro: 'STRIPE_PRICE_KEY_PRO',
  student: 'STRIPE_PRICE_STUDENT',
  engineer: 'STRIPE_PRICE_ENGINEER',
});

export const PAID_PLANS = Object.freeze(Object.keys(PLAN_PRICE_ENV));

// Live charges are planned for the beta, so the mode is always stated rather
// than inferred from the key: a live key in a server someone believes is in
// test mode charges real cards, and a test key in production takes no money
// while granting real plans.
const KEY_PREFIXES = {
  test: ['sk_test_', 'rk_test_'],
  live: ['sk_live_', 'rk_live_'],
};

// Every variable that says someone meant to turn billing on. BASE_URL is left
// out because other parts of the control plane may set it on their own.
const BILLING_KEYS = ['STRIPE_MODE', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', ...Object.values(PLAN_PRICE_ENV)];
const REQUIRED = [...BILLING_KEYS, 'BASE_URL'];

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

// Configuration is read on every request, so a misconfigured server would
// otherwise repeat the same complaint for each one; each distinct problem is
// logged once per process instead.
const logged = new Set();
function logOnce(message) {
  if (logged.has(message)) return;
  logged.add(message);
  console.error(message);
}

// Every value billing needs, or null. There are no defaults: an unconfigured
// server says billing is unavailable rather than guessing a key, a price or a
// mode. Problems are reported by variable name; a key's value never reaches
// the log.
export function billingConfig(env = process.env, { log = logOnce } = {}) {
  if (!BILLING_KEYS.some((key) => env[key])) return null;

  const missing = REQUIRED.filter((key) => !env[key]);
  if (missing.length > 0) {
    log(`Billing is off: missing ${missing.join(', ')}. See control/.env.example.`);
    return null;
  }

  const mode = env.STRIPE_MODE;
  if (!Object.hasOwn(KEY_PREFIXES, mode)) {
    log('Billing is off: STRIPE_MODE must be "test" or "live".');
    return null;
  }
  if (!KEY_PREFIXES[mode].some((prefix) => env.STRIPE_SECRET_KEY.startsWith(prefix))) {
    const other = mode === 'live' ? 'test' : 'live';
    const kind = KEY_PREFIXES[other].some((prefix) => env.STRIPE_SECRET_KEY.startsWith(prefix)) ? `a ${other}-mode key` : 'not a Stripe secret or restricted key';
    log(`Billing is off: STRIPE_MODE is ${mode} but STRIPE_SECRET_KEY is ${kind}. Use a key starting ${KEY_PREFIXES[mode].join(' or ')}.`);
    return null;
  }

  let baseUrl;
  try {
    baseUrl = new URL(env.BASE_URL);
  } catch {
    baseUrl = null;
  }
  if (!baseUrl || !['http:', 'https:'].includes(baseUrl.protocol)) {
    log('Billing is off: BASE_URL must be the control plane\'s public http(s) URL.');
    return null;
  }

  // The stand-in API exists for tests. Pointing a real key anywhere else would
  // hand it to whoever answers, so only a loopback host is accepted, and never
  // in live mode.
  let apiBase = null;
  if (env.STRIPE_API_BASE) {
    try {
      apiBase = new URL(env.STRIPE_API_BASE);
    } catch {
      apiBase = null;
    }
    if (mode === 'live' || !apiBase || !LOOPBACK.has(apiBase.hostname)) {
      log('Billing is off: STRIPE_API_BASE is for tests only, on a loopback host, in test mode.');
      return null;
    }
  }

  return {
    mode,
    secretKey: env.STRIPE_SECRET_KEY,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET,
    prices: Object.fromEntries(PAID_PLANS.map((plan) => [plan, env[PLAN_PRICE_ENV[plan]]])),
    // Checkout and the portal send the person back here; the page tells them
    // to return to the app, where the plan is picked up from /v1/me.
    returnUrl: `${baseUrl.origin}${baseUrl.pathname.replace(/\/+$/, '')}/billing/done`,
    apiBase,
  };
}

export function stripeClient(config) {
  const options = { maxNetworkRetries: 1 };
  if (config.apiBase) {
    const base = config.apiBase;
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
    accountId: subscription.metadata?.account_id ?? null,
    customerId: typeof subscription.customer === 'string' ? subscription.customer : subscription.customer?.id ?? null,
    subscriptionId: subscription.id,
    status: subscription.status,
    priceId: item?.price?.id ?? null,
    renewsAt: toDate(item?.current_period_end ?? subscription.current_period_end),
    cancelAt: toDate(subscription.cancel_at),
    plan: entitledPlan(config, subscription),
  };
}

// Tags our checkouts in the Stripe Dashboard so this flow can be tracked and
// compared; Stripe asks for a fixed label ending in 8 random letters. It is
// the same label the engine used, so history in the Dashboard stays one line.
export const INTEGRATION_IDENTIFIER = 'scope-studio-plans-nviushko';

// The Stripe Customer is the account's billing identity: every webhook is
// resolved through it to our account, as Stripe recommends, with metadata kept
// only as a fallback. Created once, before the first checkout.
export async function createCustomer(config, { accountId, email }, client = stripeClient(config)) {
  const customer = await client.customers.create({ email, metadata: { account_id: accountId } });
  return customer.id;
}

// A hosted checkout for one plan with Managed Payments on, for the account's
// own Stripe Customer. The query on the return URL only chooses what the done
// page says; the plan itself arrives by webhook.
export async function createCheckout(config, { plan, accountId, customerId }, client = stripeClient(config)) {
  if (!PAID_PLANS.includes(plan)) throw new Error(`not a paid plan: ${plan}`);
  const session = await client.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: config.prices[plan], quantity: 1 }],
    managed_payments: { enabled: true },
    customer: customerId,
    client_reference_id: accountId,
    subscription_data: { metadata: { account_id: accountId } },
    integration_identifier: INTEGRATION_IDENTIFIER,
    success_url: `${config.returnUrl}?checkout=complete`,
    cancel_url: `${config.returnUrl}?checkout=canceled`,
  });
  return session.url;
}

// The subscription an invoice belongs to, on current API versions (the
// invoice's parent) or older ones (a top-level field). Null for one-off invoices.
export function invoiceSubscriptionId(invoice) {
  const fromParent = invoice?.parent?.subscription_details?.subscription;
  const id = fromParent ?? invoice?.subscription ?? null;
  return typeof id === 'string' ? id : id?.id ?? null;
}

// The subscription as it is now. Stripe does not deliver events in order, and
// two events can share a timestamp, so each event is a prompt to read the
// current state rather than a state to apply: order and duplicates stop
// mattering. (Stripe's own guidance for webhook handlers.)
export async function currentSubscription(config, subscriptionId, client = stripeClient(config)) {
  return client.subscriptions.retrieve(subscriptionId);
}

export async function customerPortalUrl(config, { customerId }, client = stripeClient(config)) {
  const session = await client.billingPortal.sessions.create({ customer: customerId, return_url: config.returnUrl });
  return session.url;
}

// Throws if the signature does not match the exact raw body.
export function verifyEvent(config, rawBody, signature, client = stripeClient(config)) {
  return client.webhooks.constructEvent(rawBody, signature, config.webhookSecret);
}
