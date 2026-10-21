import { getPool } from '../db/pool.js';
import { openToken, sealToken } from './tokenBox.js';

// control_links (migration 031): which control-plane account a local user is
// signed in to, the sealed device token, and the cached GET /v1/me answer.

function present(row) {
  if (!row) return null;
  return {
    ownerId: row.owner_id,
    // Opened here and handed only to the control client; null when the row
    // cannot be opened (see tokenBox.js), which callers treat as signed out.
    token: openToken(row.token_sealed),
    accountId: row.account_id,
    email: row.email,
    devMode: row.dev_mode,
    me: row.me ?? null,
    meFetchedAt: row.me_fetched_at ? new Date(row.me_fetched_at) : null,
  };
}

export async function getLink(ownerId, pool = getPool()) {
  const { rows } = await pool.query('SELECT * FROM control_links WHERE owner_id = $1', [ownerId]);
  return present(rows[0]);
}

// A fresh sign-in replaces whatever link the user had: one account per local
// user, and the cache starts empty so the first read asks the control plane.
export async function saveLink({ ownerId, token, account }, pool = getPool()) {
  await pool.query(
    `INSERT INTO control_links (owner_id, token_sealed, account_id, email, dev_mode, me, me_fetched_at)
     VALUES ($1, $2, $3, $4, $5, NULL, NULL)
     ON CONFLICT (owner_id) DO UPDATE SET
       token_sealed = EXCLUDED.token_sealed, account_id = EXCLUDED.account_id, email = EXCLUDED.email,
       dev_mode = EXCLUDED.dev_mode, me = NULL, me_fetched_at = NULL, created_at = now(), updated_at = now()`,
    [ownerId, sealToken(token), String(account.id), account.email, account.devMode === true]
  );
}

// Writes the cache only while the link it was fetched for still exists, so a
// /v1/me answer that lands after a sign-out cannot bring the link back.
export async function saveMe(ownerId, me, fetchedAt = new Date(), pool = getPool()) {
  await pool.query(
    `UPDATE control_links SET me = $2, me_fetched_at = $3, email = COALESCE($4, email),
       dev_mode = COALESCE($5, dev_mode), updated_at = now()
     WHERE owner_id = $1`,
    [ownerId, JSON.stringify(me), fetchedAt, me?.account?.email ?? null, typeof me?.account?.devMode === 'boolean' ? me.account.devMode : null]
  );
}

// Marks the cache stale without forgetting it, so the next read refreshes.
export async function expireMe(ownerId, pool = getPool()) {
  await pool.query('UPDATE control_links SET me_fetched_at = NULL WHERE owner_id = $1', [ownerId]);
}

export async function deleteLink(ownerId, pool = getPool()) {
  const { rowCount } = await pool.query('DELETE FROM control_links WHERE owner_id = $1', [ownerId]);
  return rowCount > 0;
}
