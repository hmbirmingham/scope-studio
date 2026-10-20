import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

// PKCE (RFC 7636) with S256 only. "plain" would put the verifier itself in
// the browser's address bar, which is the thing PKCE exists to keep out of it.
export const CODE_CHALLENGE_METHOD = 'S256';
export const AUTH_CODE_TTL_MS = 5 * 60 * 1000;

// A SHA-256 digest in base64url is always 43 characters.
export function isCodeChallenge(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
}

// RFC 7636 section 4.1: 43 to 128 unreserved characters.
export function isCodeVerifier(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._~-]{43,128}$/.test(value);
}

export function challengeFor(verifier) {
  return createHash('sha256').update(verifier).digest('base64url');
}

export function verifierMatches(verifier, challenge) {
  if (!isCodeVerifier(verifier) || !isCodeChallenge(challenge)) return false;
  return timingSafeEqual(Buffer.from(challengeFor(verifier)), Buffer.from(challenge));
}

// A one-time code: 32 random bytes, stored only as a hash (see tokens.js).
export function newAuthCode() {
  return randomBytes(32).toString('base64url');
}
