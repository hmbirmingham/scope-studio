import { Router } from 'express';
import requireAuth from '../middleware/requireAuth.js';
import { execute, getRun, listRuns, presentRun } from '../editing/commands.js';
import { rememberRunOutput } from '../routing/conversation.js';

const router = Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const { conversationId } = req.query;
  res.json({ runs: listRuns(req.session.userId, { conversationId }).map(presentRun) });
});

// The only path that runs anything, and only a script the project declares.
router.post('/:id/approve', async (req, res) => {
  const run = getRun(req.session.userId, req.params.id);
  if (!run) return res.status(404).json({ error: 'command not found' });
  if (run.state !== 'proposed') {
    return res.status(409).json({ error: `this command is ${run.state}`, run: presentRun(run) });
  }

  run.state = 'running';
  const result = await execute(run);
  Object.assign(run, result, { state: result.exitCode === 0 ? 'succeeded' : 'failed' });

  // The next question sees what happened without re-reading the context.
  rememberRunOutput(run.conversationId, req.session.userId, run);
  res.json({ run: presentRun(run) });
});

router.post('/:id/reject', (req, res) => {
  const run = getRun(req.session.userId, req.params.id);
  if (!run) return res.status(404).json({ error: 'command not found' });
  run.state = 'rejected';
  res.json({ run: presentRun(run) });
});

export default router;
