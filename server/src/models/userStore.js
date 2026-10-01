import { getPool } from '../db/pool.js';

export async function createUser({ email, passwordHash }) {
  const { rows } = await getPool().query(
    `INSERT INTO users (email, password_hash)
     VALUES ($1, $2)
     RETURNING id, email, created_at`,
    [email, passwordHash]
  );
  return rows[0];
}

export async function findUserByEmail(email) {
  const { rows } = await getPool().query(
    'SELECT id, email, password_hash FROM users WHERE email = $1',
    [email]
  );
  return rows[0] ?? null;
}

export async function getUserPlan(id) {
  const { rows } = await getPool().query('SELECT plan FROM users WHERE id = $1', [id]);
  return rows[0]?.plan ?? 'free';
}

export async function getUserBilling(id) {
  const { rows } = await getPool().query(
    `SELECT id, email, plan, billing_subscription_id, billing_status, billing_renews_at, billing_ends_at
     FROM users WHERE id = $1`,
    [id]
  );
  return rows[0] ?? null;
}

// Applies one subscription event to the user it belongs to: by the user id the
// checkout carried, else by a subscription already on file. An event older
// than the last one applied changes nothing, so retries and out-of-order
// deliveries are harmless. Returns the user's plan afterwards, or null if no
// user matched.
export async function applySubscription({ userId, subscriptionId, customerId, status, variantId, renewsAt, endsAt, updatedAt, plan }) {
  const { rows } = await getPool().query(
    `UPDATE users SET
       plan = $3,
       billing_subscription_id = $2,
       billing_customer_id = $4,
       billing_status = $5,
       billing_variant_id = $6,
       billing_renews_at = $7,
       billing_ends_at = $8,
       billing_updated_at = $9
     WHERE (id::text = $1 OR billing_subscription_id = $2)
       AND (billing_updated_at IS NULL OR billing_updated_at <= $9)
     RETURNING plan`,
    [userId ?? '', subscriptionId, plan, customerId, status, variantId, renewsAt, endsAt, updatedAt]
  );
  return rows[0]?.plan ?? null;
}
