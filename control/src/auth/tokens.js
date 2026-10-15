import { createHash, randomBytes } from 'node:crypto';

const PREFIX = 'sst_';

// A device token: 32 random bytes, prefixed so a leaked one is recognisable
// in logs and secret scanners. Only its hash is ever stored.
export function newDeviceToken() {
  return PREFIX + randomBytes(32).toString('base64url');
}

// SHA-256 is enough here, unlike for passwords: the token is 256 bits of
// randomness, so there is nothing to guess and no need for a slow hash.
export function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function looksLikeDeviceToken(value) {
  return typeof value === 'string' && /^sst_[A-Za-z0-9_-]{43}$/.test(value);
}
