import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { Router } from 'express';
import requireAuth from '../middleware/requireAuth.js';
import { declaredScripts } from '../editing/commands.js';
import { listProjectSettings, setProjectPath } from '../models/projectSettings.js';

const router = Router();
router.use(requireAuth);

router.get('/settings', async (req, res) => {
  const projects = await listProjectSettings(req.session.userId);
  res.json({
    projects: await Promise.all(
      projects.map(async (entry) => ({
        ...entry,
        scripts: entry.localPath ? await declaredScripts(entry.localPath) : [],
      })),
    ),
  });
});

// Binding a working copy is the user saying "this directory is that project on
// this machine". Scripts can only run inside one, and only the ones it declares.
router.put('/settings', async (req, res) => {
  const { project, localPath } = req.body ?? {};
  if (!project || typeof project !== 'string') {
    return res.status(400).json({ error: 'project is required' });
  }
  if (localPath === null || localPath === '') {
    await setProjectPath(req.session.userId, project, null);
    return res.json({ project, localPath: null, scripts: [] });
  }
  if (typeof localPath !== 'string' || !isAbsolute(localPath)) {
    return res.status(400).json({ error: 'localPath must be an absolute path' });
  }

  try {
    const entry = await stat(localPath);
    if (!entry.isDirectory()) return res.status(400).json({ error: `${localPath} is not a directory` });
  } catch {
    return res.status(400).json({ error: `${localPath} does not exist or cannot be read` });
  }

  const saved = await setProjectPath(req.session.userId, project, localPath);
  res.json({ ...saved, scripts: await declaredScripts(saved.localPath) });
});

export default router;
