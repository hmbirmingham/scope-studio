import { Router } from 'express';
import requireAuth from '../../middleware/requireAuth.js';
import physicsPlugin from '../../plugins/physics/index.js';
import { ingestProblems, validateProblems } from '../../plugins/physics/ingest.js';
import { getJob, presentJob, runningJobFor, startJob } from '../../plugins/jobs.js';

// The physics vertical's HTTP side: whether the sandboxed Python toolchain is
// usable here, and ingest of problem statements as a background job, the way
// GitHub ingest runs (plugins/jobs.js).

const router = Router();
router.use(requireAuth);

// The UI uses this to say why physics checks are off instead of failing a run.
router.get('/status', async (req, res, next) => {
  try {
    const state = await physicsPlugin.toolchain.availability();
    res.json({ available: state.available, reason: state.reason, versions: state.versions });
  } catch (err) {
    next(err);
  }
});

router.post('/ingest', (req, res) => {
  try {
    validateProblems(req.body);
  } catch (err) {
    return res.status(400).json({ error: err.code ?? 'invalid_input', message: err.message });
  }
  const ownerId = req.session.userId;
  const running = runningJobFor(ownerId);
  if (running) return res.status(409).json({ error: 'an ingest is already running', job: presentJob(running) });
  const body = req.body;
  const job = startJob(ownerId, 'physics.ingest', (report) =>
    // The node ids stay out of the polled summary, like GitHub's.
    ingestProblems(ownerId, body, { onProgress: report }).then(({ nodes, ...summary }) => summary)
  );
  res.status(202).json(presentJob(job));
});

router.get('/jobs/:id', (req, res) => {
  const job = getJob(req.session.userId, req.params.id);
  if (!job || !job.kind.startsWith('physics.')) return res.status(404).json({ error: 'job not found' });
  res.json(presentJob(job));
});

export default router;
