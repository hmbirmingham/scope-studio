import { createHmac, timingSafeEqual } from 'node:crypto';

// Lemon Squeezy is the merchant of record: it runs checkout, collects and
// remits sales tax and VAT, and tells us what happened through signed
// webhooks. Nothing here stores card details or a payment method.

const API_URL = () => process.env.LEMONSQUEEZY_API_URL || 'https://api.lemonsqueezy.com';
const PAID_PLANS = ['key_pro', 'student', 'engineer'];

// Every value billing needs, or null. There are no defaults: an unconfigured
// server says billing is unavailable rather than guessing a store or variant.
export function billingConfig(env = process.env) {
  const config = {
    apiKey: env.LEMONSQUEEZY_API_KEY,
    storeId: env.LEMONSQUEEZY_STORE_ID,
    webhookSecret: env.LEMONSQUEEZY_WEBHOOK_SECRET,
    variants: {
      key_pro: env.LEMONSQUEEZY_VARIANT_KEY_PRO,
      student: env.LEMONSQUEEZY_VARIANT_STUDENT,
      engineer: env.LEMONSQUEEZY_VARIANT_ENGINEER,
    },
  };
  const complete = config.apiKey && config.storeId && config.webhookSecret && Object.values(config.variants).every(Boolean);
  return complete ? config : null;
}

export function planForVariant(config, variantId) {
  const id = String(variantId);
  return PAID_PLANS.find((plan) => String(config.variants[plan]) === id) ?? null;
}

// Statuses that keep the plan. A cancelled subscription runs to the end of the
// period it paid for (Lemon Squeezy sends subscription_expired then); a failed
// renewal (past_due) keeps access while payment is retried.
const ENTITLED = new Set(['active', 'on_trial', 'past_due', 'cancelled']);

export function entitledPlan(config, attributes) {
  if (!ENTITLED.has(attributes.status)) return 'free';
  return planForVariant(config, attributes.variant_id) ?? 'free';
}

// HMAC-SHA256 of the raw body, hex, in X-Signature. Compared in constant time.
export function verifySignature(rawBody, signature, secret) {
  if (!signature || !secret) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(rawBody).digest('hex'), 'utf8');
  const given = Buffer.from(String(signature), 'utf8');
  return expected.length === given.length && timingSafeEqual(expected, given);
}

async function api(config, method, path, body) {
  const response = await fetch(`${API_URL()}${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.api+json',
      'Content-Type': 'application/vnd.api+json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = payload.errors?.[0]?.detail ?? `HTTP ${response.status}`;
    throw new Error(`Lemon Squeezy: ${detail}`);
  }
  return payload;
}

// A hosted checkout for one plan, carrying our user id so the webhook can tie
// the subscription back to the account that bought it.
export async function createCheckout(config, { plan, userId, email, redirectUrl }) {
  if (!PAID_PLANS.includes(plan)) throw new Error(`not a paid plan: ${plan}`);
  const payload = await api(config, 'POST', '/v1/checkouts', {
    data: {
      type: 'checkouts',
      attributes: {
        product_options: { redirect_url: redirectUrl },
        checkout_data: { email, custom: { user_id: userId } },
      },
      relationships: {
        store: { data: { type: 'stores', id: String(config.storeId) } },
        variant: { data: { type: 'variants', id: String(config.variants[plan]) } },
      },
    },
  });
  return payload.data.attributes.url;
}

// The customer portal link is pre-signed and short-lived, so it is fetched when
// the user asks for it rather than stored.
export async function customerPortalUrl(config, subscriptionId) {
  const payload = await api(config, 'GET', `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`);
  return payload.data.attributes.urls?.customer_portal ?? null;
}
