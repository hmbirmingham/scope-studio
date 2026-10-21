import { Router } from 'express';
import requireAuth from '../../middleware/requireAuth.js';

// Stub from the agent-workspace contract; path B implements it
// (docs/architecture/agent-workspace.md, "HTTP surface").
const router = Router();
router.use(requireAuth);
router.all('/{*rest}', (req, res) => res.status(501).json({ error: 'not_implemented' }));

export default router;
