import { Router } from 'express';
import requireAuth from '../../middleware/requireAuth.js';
import { defaultCadQuery } from '../../plugins/cad/cadquery.js';
import { ingestCadProject, isDirectory } from '../../plugins/cad/ingest.js';
import { getJob, presentJob, runningJobFor, startJob } from '../../plugins/jobs.js';
import { getProjectSettings } from '../../models/projectSettings.js';

// CAD ingest reads the project's own folder (its configured local path), so
// there is nothing to sign in to. It runs as a background job like GitHub
// ingest, one ingest per owner at a time.
export function cadRouter({ cadquery = defaultCadQuery } = {}) {
  const router = Router();
  router.use(requireAuth);

  // Whether STEP geometry, solid interference and parametric edits are
  // available on this machine, so the client can say why they are not.
  router.get('/status', async (req, res, next) => {
    try {
      const state = await cadquery.status();
      res.json({ cadquery: { available: state.available, version: state.version ?? null, reason: state.reason ?? null } });
    } catch (err) {
      next(err);
    }
  });

  router.post('/ingest', async (req, res, next) => {
    const { project, privacy = 'local' } = req.body ?? {};
    if (typeof project !== 'string' || !project.trim()) return res.status(400).json({ error: 'invalid_input', message: 'project is required' });
    if (!['local', 'cloud'].includes(privacy)) return res.status(400).json({ error: 'invalid_input', message: 'privacy must be local or cloud' });
    try {
      const settings = await getProjectSettings(req.session.userId, project);
      if (!settings?.localPath) return res.status(400).json({ error: 'no_local_path', message: 'set the project’s local folder first' });
      if (!(await isDirectory(settings.localPath))) return res.status(400).json({ error: 'no_local_path', message: 'the project’s local folder does not exist' });

      const running = runningJobFor(req.session.userId);
      if (running) return res.status(409).json({ error: 'ingest_running', message: 'an ingest is already running', job: presentJob(running) });

      const ownerId = req.session.userId;
      const job = startJob(ownerId, 'cad.ingest', (report) =>
        ingestCadProject({ ownerId, project, localPath: settings.localPath, privacy, cadquery, onProgress: report })
      );
      res.status(202).json(presentJob(job));
    } catch (err) {
      next(err);
    }
  });

  router.get('/jobs/:id', (req, res) => {
    const job = getJob(req.session.userId, req.params.id);
    if (!job || !job.kind.startsWith('cad.')) return res.status(404).json({ error: 'not_found' });
    res.json(presentJob(job));
  });

  return router;
}

export default cadRouter();
