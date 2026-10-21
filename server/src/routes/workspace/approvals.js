import { Router } from 'express';
import requireAuth from '../../middleware/requireAuth.js';
import { APPROVAL_STATUSES, getApproval, listApprovals, resolveApproval } from '../../workspace/agents/approvalStore.js';
import { presentApproval } from '../../workspace/agents/presenters.js';

// The approvals inbox (docs/architecture/agent-workspace.md, "HTTP shapes").
const router = Router();
router.use(requireAuth);

const owner = (req) => req.session.userId;

router.get('/', async (req, res) => {
  const { status } = req.query;
  if (status !== undefined && !APPROVAL_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'invalid_status', message: `status must be one of ${APPROVAL_STATUSES.join(', ')}` });
  }
  res.json({ approvals: (await listApprovals(owner(req), { status })).map(presentApproval) });
});

router.get('/:id', async (req, res) => {
  const approval = await getApproval(owner(req), req.params.id);
  if (!approval) return res.status(404).json({ error: 'approval_not_found' });
  res.json({ approval: presentApproval(approval) });
});

router.post('/:id', async (req, res) => {
  const decision = req.body?.decision;
  if (decision !== 'approve' && decision !== 'reject') {
    return res.status(400).json({ error: 'invalid_decision', message: "decision must be 'approve' or 'reject'" });
  }
  const result = await resolveApproval(owner(req), req.params.id, decision);
  if (result.status === 404) return res.status(404).json({ error: 'approval_not_found' });
  if (result.status === 409) {
    return res.status(409).json({ error: 'already_resolved', message: `this approval is ${result.approval.status}`, approval: presentApproval(result.approval) });
  }
  res.json({ approval: presentApproval(result.approval) });
});

export default router;
