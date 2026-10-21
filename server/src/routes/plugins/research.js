import { Router } from 'express';
import { isAbsolute } from 'node:path';
import requireAuth from '../../middleware/requireAuth.js';
import { getJob, presentJob, runningJobFor, startJob } from '../../plugins/jobs.js';
import researchPlugin from '../../plugins/research/index.js';
import { PRIVACY } from '../../plugins/research/ingest.js';
import { defaultPdfText } from '../../plugins/research/pdf.js';

// Ingest of a local reference library (zotero.sqlite or a Better BibTeX JSON
// export). The engine runs on the user's machine and reads the path it is
// given, as project settings do for a checkout; the file is only ever read.
// Ingest takes a while (PDF text, embeddings), so it runs as a background job
// the client polls, like GitHub ingest.

const router = Router();
router.use(requireAuth);

// Whether PDFs can be read, so the client can say so before an ingest
// rather than after it.
router.get('/status', async (req, res) => {
  const pdf = await defaultPdfText.status();
  res.json({ pdftotext: pdf.available ? { available: true, version: pdf.version } : { available: false, reason: pdf.reason } });
});

function checkPath(value, name) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !isAbsolute(value) || value.length > 4096 || value.includes('\0')) return `${name} must be an absolute path`;
  return null;
}

router.post('/ingest', (req, res) => {
  const { path, project, privacy, storageDir } = req.body ?? {};
  const problem =
    (typeof path !== 'string' ? 'path is required: an absolute path to zotero.sqlite or a Better BibTeX JSON export' : checkPath(path, 'path')) ??
    checkPath(storageDir, 'storageDir') ??
    (project !== undefined && (typeof project !== 'string' || !project.trim() || project.length > 200) ? 'project must be a non-empty name of at most 200 characters' : null) ??
    (privacy !== undefined && !PRIVACY.includes(privacy) ? `privacy must be one of ${PRIVACY.join(', ')}` : null);
  if (problem) return res.status(400).json({ error: 'invalid_input', message: problem });

  const running = runningJobFor(req.session.userId);
  if (running) return res.status(409).json({ error: 'ingest_running', message: 'an ingest is already running', job: presentJob(running) });

  const ownerId = req.session.userId;
  const job = startJob(ownerId, 'research.ingest', (report) =>
    researchPlugin.ingest({ ownerId, path, project: project?.trim(), privacy, storageDir, onProgress: report })
  );
  res.status(202).json(presentJob(job));
});

router.get('/jobs/:id', (req, res) => {
  const job = getJob(req.session.userId, req.params.id);
  if (!job) return res.status(404).json({ error: 'not_found', message: 'job not found' });
  res.json(presentJob(job));
});

export default router;
