import { effectivePlan } from '../auth/devMode.js';
import { hashToken, looksLikeDeviceToken } from '../auth/tokens.js';
import { getPool } from '../db/pool.js';
import { sendError } from '../lib/errors.js';

// Resolves `Authorization: Bearer <device token>` to the account behind it.
// Missing, malformed, unknown and revoked tokens all get the same answer, so
// a caller cannot tell which of them it hit.
export function requireDevice({ pool = getPool() } = {}) {
  return async function requireDeviceMiddleware(req, res, next) {
    const [scheme, token] = (req.get('authorization') || '').split(' ');
    if (scheme !== 'Bearer' || !looksLikeDeviceToken(token)) return unauthenticated(res);

    const { rows } = await pool.query(
      `UPDATE device_tokens d SET last_used_at = now()
       FROM accounts a
       WHERE d.token_hash = $1 AND d.revoked_at IS NULL AND a.id = d.account_id
       RETURNING d.id AS device_id, d.dev_mode, a.id, a.email, a.plan`,
      [hashToken(token)]
    );
    if (rows.length === 0) return unauthenticated(res);

    // A dev-mode device runs as Engineer only while its email is still on
    // DEV_MODE_EMAILS, checked here on every request; the stored plan is the
    // billed one and is never changed for dev mode.
    const { device_id: deviceId, dev_mode: deviceDevMode, id, email, plan } = rows[0];
    req.account = { id, email, ...effectivePlan({ plan, email, devMode: deviceDevMode }) };
    req.deviceId = deviceId;
    next();
  };
}

function unauthenticated(res) {
  return sendError(res, 401, 'unauthenticated', 'Sign in to Scope Studio again on this device.');
}
