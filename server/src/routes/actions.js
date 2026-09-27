import { Router } from 'express';
import requireAuth from '../middleware/requireAuth.js';
import { executeAction, getAction, listActions, presentAction } from '../editing/actions.js';

const router = Router();
router.use(requireAuth);

// An action opens something on the screen of the machine the server runs on.
// That is only the user's own screen when the server is local, so a request
// from anywhere else is refused outright.
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
export function isLocalRequest(req) {
  return LOOPBACK.has(req.socket.remoteAddress);
}

// Display mode is granted once per signed-in session, from this machine only,
// and signing out clears it with the session.
export function displayControlAllowed(req) {
  return req.session.displayControl === true && isLocalRequest(req) && process.platform === 'darwin';
}

router.get('/consent', (req, res) => {
  res.json({ displayControl: displayControlAllowed(req), available: isLocalRequest(req) && process.platform === 'darwin' });
});

router.put('/consent', (req, res) => {
  const { displayControl } = req.body ?? {};
  if (typeof displayControl !== 'boolean') return res.status(400).json({ error: 'displayControl must be true or false' });
  if (displayControl && !isLocalRequest(req)) {
    return res.status(403).json({ error: 'display control can only be granted on the machine running Scope Studio' });
  }
  req.session.displayControl = displayControl;
  res.json({ displayControl: displayControlAllowed(req) });
});

router.get('/', (req, res) => {
  const { conversationId } = req.query;
  res.json({ actions: listActions(req.session.userId, { conversationId }).map(presentAction) });
});

router.post('/:id/approve', async (req, res) => {
  const action = getAction(req.session.userId, req.params.id);
  if (!action) return res.status(404).json({ error: 'action not found' });
  if (!isLocalRequest(req)) {
    return res.status(403).json({ error: 'actions only open on the machine running Scope Studio' });
  }
  if (action.state !== 'proposed') {
    return res.status(409).json({ error: `this action is ${action.state}`, action: presentAction(action) });
  }

  action.state = 'opening';
  const result = await executeAction(action, { run: req.app.locals.openRunner });
  Object.assign(action, result.ok ? { state: 'opened' } : { state: 'failed', error: result.error });
  res.json({ action: presentAction(action) });
});

router.post('/:id/reject', (req, res) => {
  const action = getAction(req.session.userId, req.params.id);
  if (!action) return res.status(404).json({ error: 'action not found' });
  action.state = 'rejected';
  res.json({ action: presentAction(action) });
});

export default router;
