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
