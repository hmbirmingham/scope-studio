import { Router } from 'express';
import requireAuth from '../middleware/requireAuth.js';
import { getUserPlan } from '../models/userStore.js';
import { usageSummary } from '../models/usageStore.js';

const MAX_DAYS = 365;

const router = Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  const { days = '7' } = req.query;
  if (!/^\d+$/.test(days) || Number(days) < 1 || Number(days) > MAX_DAYS) {
    return res.status(400).json({ error: `days must be a whole number between 1 and ${MAX_DAYS}` });
  }
  const plan = await getUserPlan(req.session.userId);
  res.json(await usageSummary(req.session.userId, { days: Number(days), plan }));
});

export default router;
