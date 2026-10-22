import { Router } from 'express';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { LOCAL_DEMO_EMAIL, localSigninAllowed } from '../config/localMode.js';
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

// Local mode (config/localMode.js): the demo's own browser is signed in to
// the demo account without a password, under every condition listed there.
router.post('/local', async (req, res) => {
  const user = localSigninAllowed(req) ? await findUserByEmail(LOCAL_DEMO_EMAIL) : null;
  if (!user) return res.status(404).json({ error: 'local_signin_unavailable' });
  req.session.userId = user.id;
  res.json({ id: user.id, email: user.email });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.status(204).end());
});

router.get('/session', (req, res) => {
  if (!req.session.userId) {
    // Says whether local sign-in would be granted to this browser, so the
    // client asks for it only from an engine started in local mode.
    const body = { error: 'not authenticated' };
    if (localSigninAllowed(req, process.env, { header: false })) body.localSignin = true;
    return res.status(401).json(body);
  }
  res.json({ userId: req.session.userId });
});

export default router;
