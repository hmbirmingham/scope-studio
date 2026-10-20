import { getPool } from '../db/pool.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Returns null when the email is taken, so the route can answer 409 without
// knowing Postgres error codes.
export async function createAccount({ email, passwordHash }, pool = getPool()) {
  try {
    const { rows } = await pool.query(
      `INSERT INTO accounts (email, password_hash) VALUES ($1, $2) RETURNING id, email, plan`,
      [email, passwordHash]
    );
    return rows[0];
  } catch (err) {
    if (err.code === '23505') return null;
    throw err;
  }
}

export async function findAccountByEmail(email, pool = getPool()) {
  const { rows } = await pool.query(
    `SELECT id, email, plan, password_hash FROM accounts WHERE email = $1`,
    [email]
  );
  return rows[0] ?? null;
}

export async function findAccountById(id, pool = getPool()) {
  if (!UUID.test(String(id))) return null;
  const { rows } = await pool.query(
    `SELECT id, email, plan, billing_status, billing_renews_at, billing_cancel_at
     FROM accounts WHERE id = $1`,
    [id]
  );
  return rows[0] ?? null;
}

// Codes live five minutes; anything a day past that is cleared on the next
// issue, so the table stays small without a scheduled job.
export async function createAuthCode(
  { codeHash, accountId, codeChallenge, redirectUri, label, devMode, expiresAt },
  pool = getPool()
) {
  await pool.query(`DELETE FROM auth_codes WHERE expires_at < now() - interval '1 day'`);
  await pool.query(
    `INSERT INTO auth_codes (code_hash, account_id, code_challenge, redirect_uri, label, dev_mode, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [codeHash, accountId, codeChallenge, redirectUri, label, devMode, expiresAt]
  );
}

// Marks a code used and returns it, in one statement, so two exchanges racing
// on the same code cannot both win. A used, expired or unknown code returns
// null. The code is spent even if the caller then rejects the verifier: a
// stolen code gets one guess, not unlimited ones.
export async function consumeAuthCode(codeHash, pool = getPool()) {
  const { rows } = await pool.query(
    `UPDATE auth_codes c SET used_at = now()
     FROM accounts a
     WHERE c.code_hash = $1 AND c.used_at IS NULL AND c.expires_at > now() AND a.id = c.account_id
     RETURNING c.account_id, c.code_challenge, c.redirect_uri, c.label, c.dev_mode, a.email, a.plan`,
    [codeHash]
  );
  return rows[0] ?? null;
}

// A new signed-in device. A dev-mode device and its audit row are written in
// one transaction, so there is never an unbilled Engineer device without a
// record of who signed it in, from where and when.
export async function createDevice({ accountId, tokenHash, label, devMode, audit }, pool = getPool()) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO device_tokens (account_id, token_hash, label, dev_mode)
       VALUES ($1, $2, $3, $4) RETURNING id, created_at`,
      [accountId, tokenHash, label, devMode]
    );
    if (devMode) {
      await client.query(
        `INSERT INTO dev_logins (account_id, device_token_id, email, label, ip, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [accountId, rows[0].id, audit.email, label, audit.ip, rows[0].created_at]
      );
    }
    await client.query('COMMIT');
    return rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function listDevices(accountId, pool = getPool()) {
  const { rows } = await pool.query(
    `SELECT id, label, created_at, last_used_at FROM device_tokens
     WHERE account_id = $1 AND revoked_at IS NULL
     ORDER BY created_at ASC, id ASC`,
    [accountId]
  );
  return rows;
}

// Revokes only a device that belongs to the account and is still live; any
// other id (someone else's, already revoked, not a UUID) reports false, so
// the route answers 404 alike and never confirms another account's device.
export async function revokeDevice(accountId, deviceId, pool = getPool()) {
  if (!UUID.test(String(deviceId))) return false;
  const { rowCount } = await pool.query(
    `UPDATE device_tokens SET revoked_at = now()
     WHERE id = $1 AND account_id = $2 AND revoked_at IS NULL`,
    [deviceId, accountId]
  );
  return rowCount === 1;
}
