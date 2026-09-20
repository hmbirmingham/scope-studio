import { Router } from 'express';
import { hashPassword, verifyPassword } from '../lib/password.js';
import { createUser, findUserByEmail } from '../models/userStore.js';

const router = Router();

router.post('/register', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }
  if (findUserByEmail(email)) {
    return res.status(409).json({ error: 'user already exists' });
  }

  const user = createUser({ email, passwordHash: hashPassword(password) });
  req.session.userId = user.id;
  res.status(201).json({ id: user.id, email: user.email });
});

router.post('/login', (req, res) => {
  const { email, password } = req.body;
  const user = findUserByEmail(email);
  if (!user || !verifyPassword(password, user.passwordHash)) {
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
