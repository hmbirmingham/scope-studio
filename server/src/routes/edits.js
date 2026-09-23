import { Router } from 'express';
import requireAuth from '../middleware/requireAuth.js';
import githubPlugin from '../plugins/github/index.js';
import { getProposal, listProposals, presentProposal } from '../editing/proposals.js';

const router = Router();
router.use(requireAuth);

router.get('/', (req, res) => {
  const { conversationId } = req.query;
  res.json({ edits: listProposals(req.session.userId, { conversationId }).map(presentProposal) });
});

// Approval is the only path that writes. It re-fetches the file, so an edit
// proposed against a stale chunk fails loudly instead of overwriting work.
router.post('/:id/approve', async (req, res, next) => {
  const proposal = getProposal(req.session.userId, req.params.id);
  if (!proposal) return res.status(404).json({ error: 'edit not found' });
  if (proposal.state !== 'proposed') {
    return res.status(409).json({ error: `this edit is ${proposal.state}`, edit: presentProposal(proposal) });
  }
  if (!req.session.githubToken) {
    return res.status(400).json({ error: 'GitHub not connected — reconnect to apply edits' });
  }

  try {
    const applied = await githubPlugin.applyEdit(req.session.githubToken, {
      project: proposal.project,
      path: proposal.path,
      search: proposal.search,
      replace: proposal.replace,
      message: req.body?.message?.trim() || `Update ${proposal.path}`,
    });
    proposal.state = 'applied';
    proposal.appliedTo = applied.url;
    res.json({ edit: presentProposal(proposal) });
  } catch (err) {
    if (err.status === 401) {
      delete req.session.githubToken;
      return res.status(401).json({ error: 'GitHub access expired — reconnect GitHub to apply edits' });
    }
    proposal.state = 'failed';
    proposal.error = err.message;
    if (err.status && err.status >= 500) return next(err);
    res.status(422).json({ edit: presentProposal(proposal), error: err.message });
  }
});

router.post('/:id/reject', (req, res) => {
  const proposal = getProposal(req.session.userId, req.params.id);
  if (!proposal) return res.status(404).json({ error: 'edit not found' });
  proposal.state = 'rejected';
  res.json({ edit: presentProposal(proposal) });
});

export default router;
