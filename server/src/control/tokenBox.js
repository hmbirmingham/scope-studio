import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

// The device token is what lets this machine spend a plan's cloud allowance,
// so it is not kept in the engine database as plain text: a copied database
// file or a backup should not be a working credential. It is sealed with
// AES-256-GCM under a key derived from SESSION_SECRET, which the engine
// already refuses to start without. Rotating SESSION_SECRET makes stored
// tokens unreadable, which reads as signed out: the person signs in again.

const VERSION = 'v1';
const INFO = 'scope-studio/control-device-token';

function keyFrom(secret) {
  if (!secret) throw new Error('SESSION_SECRET is required to store a control-plane token');
  return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), INFO, 32));
}

export function sealToken(token, secret = process.env.SESSION_SECRET) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFrom(secret), iv);
  const sealed = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  return [VERSION, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), sealed.toString('base64url')].join('.');
}

// The token, or null when the value cannot be opened (a different secret, or
// a damaged row). Null means "not signed in", never an error page.
export function openToken(value, secret = process.env.SESSION_SECRET) {
  if (typeof value !== 'string') return null;
  const [version, iv, tag, sealed] = value.split('.');
  if (version !== VERSION || !iv || !tag || !sealed) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', keyFrom(secret), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(sealed, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}
