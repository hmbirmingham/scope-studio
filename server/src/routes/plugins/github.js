import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import requireAuth from '../../middleware/requireAuth.js';
import githubPlugin from '../../plugins/github/index.js';

const router = Router();
router.use(requireAuth);

router.get('/status', (req, res) => {
  res.json({ connected: Boolean(req.session.githubToken) });
});

router.get('/authorize', (req, res, next) => {
  try {
    const state = randomBytes(16).toString('hex');
    req.session.githubOAuthState = state;
    res.redirect(githubPlugin.authenticate.getAuthorizeUrl(state));
  } catch (err) {
    next(err);
  }
});

router.get('/callback', async (req, res, next) => {
  try {
    const { code, state } = req.query;
    if (!state || state !== req.session.githubOAuthState) {
      return res.status(400).json({ error: 'invalid or missing OAuth state' });
    }
    delete req.session.githubOAuthState;

    const token = await githubPlugin.authenticate.exchangeCodeForToken(code);
    req.session.githubToken = token;
    res.json({ connected: true });
  } catch (err) {
    next(err);
  }
});

router.post('/ingest', async (req, res, next) => {
  if (!req.session.githubToken) {
    return res.status(400).json({ error: 'GitHub not connected — call /authorize first' });
  }
  try {
    res.json(await githubPlugin.ingest(req.session.githubToken, req.session.userId));
  } catch (err) {
    next(err);
  }
});

router.post('/sync', async (req, res, next) => {
  if (!req.session.githubToken) {
    return res.status(400).json({ error: 'GitHub not connected — call /authorize first' });
  }
  const since = req.body.since ? new Date(req.body.since) : null;
  try {
    res.json(await githubPlugin.sync(req.session.githubToken, since, req.session.userId));
  } catch (err) {
    next(err);
  }
});

export default router;
