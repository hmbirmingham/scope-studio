import { Router } from 'express';
import requireAuth from '../middleware/requireAuth.js';
import { recordFeedback } from '../models/metricsStore.js';
import { retrieve } from '../retrieval/retrieve.js';
import { TIER_CONFIGS } from '../retrieval/score.js';

const router = Router();
router.use(requireAuth);

router.post('/', async (req, res) => {
  const { query, project, tier, overrides } = req.body;
  if (!query || typeof query !== 'string' || !query.trim()) {
    return res.status(400).json({ error: 'query is required' });
  }
  if (tier && !TIER_CONFIGS[tier]) {
    return res.status(400).json({ error: `tier must be one of: ${Object.keys(TIER_CONFIGS).join(', ')}` });
  }

  const { candidates, ...result } = await retrieve({
    ownerId: req.session.userId,
    query: query.trim(),
    project,
    tier,
    overrides,
    sessionId: req.sessionID,
  });
  res.json(result);
});

router.post('/:id/feedback', async (req, res) => {
  const { useful } = req.body;
  if (typeof useful !== 'boolean') {
    return res.status(400).json({ error: 'useful (boolean) is required' });
  }

  const found = await recordFeedback(req.params.id, req.sessionID, useful);
  if (!found) return res.status(404).json({ error: 'query not found for this session' });
  res.status(204).end();
});

export default router;
