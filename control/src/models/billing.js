import { getPool } from '../db/pool.js';

// Billing state lives on the account row. Nothing here touches device
// tokens: a device's dev mode is its own business, and the only writer of
// accounts.plan in this file is Stripe's view of the subscription.

export async function getAccountBilling(id, pool = getPool()) {
  const { rows } = await pool.query(
    `SELECT id, email, plan, billing_customer_id, billing_subscription_id, billing_status,
            billing_renews_at, billing_cancel_at
     FROM accounts WHERE id = $1`,
    [id]
  );
  return rows[0] ?? null;
}

// Records the account's Stripe Customer the first time one is created. If two
// checkouts raced, the first id stored wins and is returned to both.
export async function setBillingCustomer(accountId, customerId, pool = getPool()) {
  const { rows } = await pool.query(
    `UPDATE accounts SET billing_customer_id = COALESCE(billing_customer_id, $2)
     WHERE id = $1 RETURNING billing_customer_id`,
    [accountId, customerId]
  );
  return rows[0]?.billing_customer_id ?? null;
}

// Applies a subscription's current state to the account it belongs to: by the
// Stripe Customer on file, as Stripe recommends; by the subscription; and only
// as a fallback, by the account id in the subscription's metadata, for an
// account that has no Customer recorded yet, so a forged metadata id cannot
// move a plan onto an account that already has one. The state is read fresh
// from Stripe for every event, so applying it twice, or after a later event,
// gives the same result. Returns the account's plan afterwards, or null if no
// account matched.
export async function applySubscription(
  { accountId, customerId, subscriptionId, status, priceId, renewsAt, cancelAt, plan },
  pool = getPool()
) {
  const { rows } = await pool.query(
    `UPDATE accounts SET
       plan = $4,
       billing_customer_id = COALESCE($2, billing_customer_id),
       billing_subscription_id = $3,
       billing_status = $5,
       billing_price_id = $6,
       billing_renews_at = $7,
       billing_cancel_at = $8,
       billing_updated_at = now()
     WHERE ($2::text IS NOT NULL AND billing_customer_id = $2)
        OR billing_subscription_id = $3
        OR (billing_customer_id IS NULL AND id::text = $1)
     RETURNING plan`,
    [accountId ?? '', customerId, subscriptionId, plan, status, priceId, renewsAt, cancelAt]
  );
  return rows[0]?.plan ?? null;
}
