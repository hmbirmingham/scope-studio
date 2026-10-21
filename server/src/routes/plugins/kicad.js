import { Router } from 'express';
import requireAuth from '../../middleware/requireAuth.js';
import kicadPlugin from '../../plugins/kicad/index.js';
import { ingestProject } from '../../plugins/kicad/ingest.js';
import { getJob, presentJob, runningJobFor, startJob } from '../../plugins/jobs.js';
import { getProjectSettings } from '../../models/projectSettings.js';

// KiCad ingest. A KiCad project lives in a folder on this machine, so the
// folder is the one the user bound to the project (PUT /api/projects/settings)
// and nothing is fetched from anywhere. Ingest runs as a background job, like
// GitHub's, and the client polls it.

const router = Router();
router.use(requireAuth);

// Whether ERC and DRC can run here, so the client can say why they are not.
router.get('/status', async (req, res, next) => {
  try {
    const tool = await kicadPlugin.probe();
    res.json({ kicadCli: { available: tool.available, version: tool.version ?? null, reason: tool.reason ?? null } });
  } catch (err) {
    next(err);
  }
});

router.post('/ingest', async (req, res, next) => {
  const { project, privacy = 'local' } = req.body ?? {};
  if (typeof project !== 'string' || !project.trim() || project.length > 500) {
    return res.status(400).json({ error: 'invalid_project', message: 'project is required' });
  }
  if (!['local', 'cloud'].includes(privacy)) {
    return res.status(400).json({ error: 'invalid_privacy', message: 'privacy must be local or cloud' });
  }
  try {
    const settings = await getProjectSettings(req.session.userId, project);
    if (!settings?.localPath) {
      return res.status(400).json({ error: 'no_local_path', message: 'bind the project to a folder on this machine first' });
    }
    // One ingest at a time per owner, whatever its kind: two would fight
    // over the same upserts.
    const running = runningJobFor(req.session.userId);
    if (running) return res.status(409).json({ error: 'ingest_running', message: 'an ingest is already running', job: presentJob(running) });

    const ownerId = req.session.userId;
    const job = startJob(ownerId, 'kicad.ingest', (report) =>
      ingestProject({ ownerId, project, localPath: settings.localPath, privacy, onProgress: report })
    );
    res.status(202).json(presentJob(job));
  } catch (err) {
    next(err);
  }
});

router.get('/jobs/:id', (req, res) => {
  const job = getJob(req.session.userId, req.params.id);
  if (!job || !job.kind.startsWith('kicad.')) return res.status(404).json({ error: 'not_found', message: 'job not found' });
  res.json(presentJob(job));
});

export default router;
