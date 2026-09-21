import { Router } from 'express';
import requireAuth from '../middleware/requireAuth.js';
import { retrieve } from '../retrieval/retrieve.js';

const router = Router();
router.use(requireAuth);

router.post('/', async (req, res) => {
  const { query, project, taskType } = req.body;
  if (!query || typeof query !== 'string' || !query.trim()) {
    return res.status(400).json({ error: 'query is required' });
  }

  const result = await retrieve({ query: query.trim(), project, taskType });
  res.json(result);
});

export default router;
