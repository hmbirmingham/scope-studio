import { Router } from 'express';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { createUser, findUserByEmail } from '../models/userStore.js';

const router = Router();

const normalizeEmail = (email) => (typeof email === 'string' ? email.trim().toLowerCase() : '');

router.post('/register', async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const { password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }

  try {
    const user = await createUser({ email, passwordHash: hashPassword(password) });
    req.session.userId = user.id;
    res.status(201).json({ id: user.id, email: user.email });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'user already exists' });
    throw err;
  }
});

router.post('/login', async (req, res) => {
  const email = normalizeEmail(req.body.email);
  const { password } = req.body;
  const user = email && password ? await findUserByEmail(email) : null;
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'invalid credentials' });
  }

  req.session.userId = user.id;
  res.json({ id: user.id, email: user.email });
});

// Local mode: an engine started for one person on their own machine (the
// demo launcher does this) names that person's account in SCOPE_LOCAL_USER,
// and the browser on the same machine is signed in to it without a password.
// It answers only when every one of these holds, so it cannot be reached from
// anywhere but this machine's own browser:
// - the engine is not running in production;
// - the request arrived over loopback (the dev and preview proxies connect
//   from loopback too, which is why the Host check below also matters);
// - the Host header names loopback, so a page on another site that resolves
//   its own name to 127.0.0.1 (DNS rebinding) is refused, as is a proxy that
//   was opened up to the network;
// - the request carries a custom header, which a cross-site form cannot send
//   and a cross-site script can only send after a CORS preflight this engine
//   never grants.
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
export const LOCAL_SIGNIN_HEADER = 'x-scope-local-signin';

function hostName(host) {
  if (typeof host !== 'string' || !host) return null;
  if (host.startsWith('[')) return host.slice(0, host.indexOf(']') + 1).toLowerCase();
  return host.split(':')[0].toLowerCase();
}

export function localSigninAllowed(req, env = process.env) {
  if (!env.SCOPE_LOCAL_USER || env.NODE_ENV === 'production') return false;
  if (!LOOPBACK_ADDRESSES.has(req.socket?.remoteAddress)) return false;
  if (!LOOPBACK_HOSTS.has(hostName(req.get('host')))) return false;
  return req.get(LOCAL_SIGNIN_HEADER) === '1';
}

router.post('/local', async (req, res) => {
  const user = localSigninAllowed(req) ? await findUserByEmail(normalizeEmail(process.env.SCOPE_LOCAL_USER)) : null;
  if (!user) return res.status(404).json({ error: 'local_signin_unavailable' });
  req.session.userId = user.id;
  res.json({ id: user.id, email: user.email });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.status(204).end());
});

router.get('/session', (req, res) => {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'not authenticated' });
  }
  res.json({ userId: req.session.userId });
});

export default router;
