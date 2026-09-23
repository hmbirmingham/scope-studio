import { Router } from 'express';
import requireAuth from '../middleware/requireAuth.js';
import { getGraph } from '../models/graphStore.js';

const router = Router();
router.use(requireAuth);

// One request for the whole map. Per-node relationships stay on
// GET /api/nodes/:id/relationships, which the inspector uses.
router.get('/', async (req, res) => {
  const { project, limit } = req.query;
  if (limit !== undefined && !/^\d+$/.test(limit)) {
    return res.status(400).json({ error: 'limit must be a positive integer' });
  }
  res.json(await getGraph(req.session.userId, { project, limit: limit ? Number(limit) : undefined }));
});

export default router;
