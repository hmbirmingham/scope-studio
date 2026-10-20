import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const KEY_LENGTH = 64;

// The same scrypt scheme as the local engine (server/src/lib/password.js), so
// the two can be compared line for line and neither drifts on its own.
export function hashPassword(plain) {
  const salt = randomBytes(16).toString('hex');
  const derivedKey = scryptSync(plain, salt, KEY_LENGTH).toString('hex');
  return `${salt}:${derivedKey}`;
}

export function verifyPassword(plain, stored) {
  const [salt, key] = typeof stored === 'string' ? stored.split(':') : [];
  // A malformed stored value is a wrong password, not a crash in the login
  // route; the hash still runs so the answer takes the same time either way.
  const keyBuffer = Buffer.from(key || '', 'hex');
  const derivedKey = scryptSync(plain, salt || '', KEY_LENGTH);
  return keyBuffer.length === KEY_LENGTH && timingSafeEqual(keyBuffer, derivedKey);
}
