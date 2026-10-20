import { Router } from 'express';
import requireAuth from '../../middleware/requireAuth.js';
import { deviceFlowRouter } from '../../plugins/auth/deviceFlow.js';
import githubPlugin from '../../plugins/github/index.js';
import { getJob, presentJob, runningJobFor, startJob } from '../../plugins/jobs.js';
import { listProjects } from '../../models/nodeStore.js';

// GitHub answers 401 for a revoked or expired token. Dropping it here means
// the client is told to reconnect instead of staring at an empty list.
function handleGitHubError(err, req, res, next) {
  if (err.status === 401) {
    delete req.session.githubToken;
    return res.status(401).json({ error: 'GitHub access expired — reconnect GitHub to continue' });
  }
  next(err);
}

function requireConnection(req, res) {
  if (req.session.githubToken) return true;
  res.status(400).json({ error: 'GitHub not connected — connect GitHub first' });
  return false;
}

const router = Router();
router.use(requireAuth);

// `configured` lets the client say the engine has no GitHub app set up,
// rather than offering a Connect button that can only fail.
router.get('/status', (req, res) => {
  res.json({ connected: Boolean(req.session.githubToken), configured: Boolean(process.env.GITHUB_CLIENT_ID) });
});

// Sign-in: POST /device/start, then POST /device/poll until it settles. The
// device code stays in the session; see plugins/auth/deviceFlow.js.
router.use('/device', deviceFlowRouter({ provider: githubPlugin.authenticate, tokenKey: 'githubToken' }));

// The picker: every repository the account can see, flagged with whether it is
// already on the map, so ingesting is a choice rather than all-or-nothing.
router.get('/repos', async (req, res, next) => {
  if (!requireConnection(req, res)) return;
  try {
    const [repos, ingested] = await Promise.all([
      githubPlugin.listRepos(req.session.githubToken),
      listProjects(req.session.userId),
    ]);
    const onMap = new Map(ingested.map((entry) => [entry.project, entry]));
    res.json({
      repos: repos.map((repo) => ({
        ...repo,
        ingested: onMap.has(repo.fullName),
        nodes: onMap.get(repo.fullName)?.nodes ?? 0,
      })),
    });
  } catch (err) {
    handleGitHubError(err, req, res, next);
  }
});

// Ingestion takes minutes, so it runs as a job and the client polls. One at a
// time per owner: two concurrent runs would fight over the same upserts.
router.post('/ingest', (req, res) => {
  if (!requireConnection(req, res)) return;
  const { repos } = req.body ?? {};
  if (repos !== undefined && (!Array.isArray(repos) || repos.some((name) => typeof name !== 'string'))) {
    return res.status(400).json({ error: 'repos must be an array of full names' });
  }

  const running = runningJobFor(req.session.userId);
  if (running) return res.status(409).json({ error: 'an ingest is already running', job: presentJob(running) });

  const token = req.session.githubToken;
  const ownerId = req.session.userId;
  const job = startJob(ownerId, 'github.ingest', (report) =>
    githubPlugin
      .ingest(token, ownerId, { repos, onProgress: report })
      // The node list is for callers that ingest inline; a polled job only
      // needs the counts.
      .then(({ nodes, ...summary }) => summary)
  );
  res.status(202).json(presentJob(job));
});

router.get('/jobs/:id', (req, res) => {
  const job = getJob(req.session.userId, req.params.id);
  if (!job) return res.status(404).json({ error: 'job not found' });
  res.json(presentJob(job));
});

router.post('/sync', async (req, res, next) => {
  if (!req.session.githubToken) {
    return res.status(400).json({ error: 'GitHub not connected — connect GitHub first' });
  }
  const since = req.body.since ? new Date(req.body.since) : null;
  try {
    res.json(await githubPlugin.sync(req.session.githubToken, since, req.session.userId));
  } catch (err) {
    next(err);
  }
});

export default router;
