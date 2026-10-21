import { Router } from 'express';
import requireAuth from '../middleware/requireAuth.js';
import { controlUrl } from './client.js';
import { controlState } from './plan.js';
import { cancelSignIn, pendingSignIn, startSignIn } from './signin.js';
import { signOut } from './signout.js';

// /api/control: the local user's link to their Scope Studio account. Nothing
// here ever returns the device token; the status is what the plan overlay
// shows and what the composer's plan rules are derived from.

const router = Router();
router.use(requireAuth);

const NOT_CONFIGURED = {
  error: 'Accounts are not set up on this engine: CONTROL_URL is not configured. Local answers work as normal.',
  code: 'control_not_configured',
};

// The account as the engine knows it: who is signed in, whether the plan was
// confirmed within the cache's lifetime (`online`), and the last /v1/me
// answer's plan, limits and next model.
export function presentState(state, ownerId) {
  const me = state.me;
  return {
    configured: state.configured,
    signedIn: state.signedIn,
    online: state.online,
    stale: state.stale,
    reason: state.reason,
    plan: state.plan,
    account: state.account,
    capabilities: me?.capabilities ?? null,
    limits: me?.limits ?? null,
    nextModel: me?.nextModel ?? null,
    billing: me?.billing ?? null,
    fetchedAt: state.fetchedAt,
    pending: pendingSignIn(ownerId),
  };
}

router.get('/status', async (req, res) => {
  const state = await controlState(req.session.userId, { refresh: req.query.refresh === '1' });
  res.json(presentState(state, req.session.userId));
});

// Starts the browser sign-in. The client opens `url`; the engine finishes the
// sign-in itself when the browser comes back to its loopback port, and the
// client sees it in /status.
router.post('/signin', async (req, res) => {
  if (!controlUrl()) return res.status(503).json(NOT_CONFIGURED);
  const { url, expiresAt } = await startSignIn(req.session.userId);
  res.json({ url, expiresAt });
});

router.delete('/signin', (req, res) => {
  cancelSignIn(req.session.userId);
  res.status(204).end();
});

router.post('/signout', async (req, res) => {
  res.json(await signOut(req.session.userId));
});

export default router;
