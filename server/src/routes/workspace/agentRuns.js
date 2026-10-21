import { Router } from 'express';
import requireAuth from '../../middleware/requireAuth.js';
import { workspaceEvents } from '../../workspace/events.js';
import { notifyRunQueued } from '../../workspace/runner/index.js';
import { budgetError } from '../../workspace/runner/budget.js';
import { getOwnedRun, insertRun, killRun, listRuns, listSteps, loadAgent, presentRun, presentStep, TERMINAL_STATUSES } from '../../workspace/runner/store.js';
import { getPool } from '../../db/pool.js';

// Start, list, inspect and cancel agent runs (docs/architecture/agent-workspace.md,
// "HTTP shapes"). Starting a run only queues it; the worker executes it, so a
// request never waits on a model.
const router = Router();
router.use(requireAuth);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATUSES = ['queued', 'running', 'paused', 'waiting_approval', ...TERMINAL_STATUSES];
const INSTRUCTIONS_MAX = 20_000;
const PROJECT_MAX = 200;

function bad(res, message) {
  return res.status(400).json({ error: 'validation', message });
}

function notFound(res) {
  return res.status(404).json({ error: 'not_found' });
}

router.get('/', async (req, res) => {
  const agentId = typeof req.query.agentId === 'string' ? req.query.agentId : undefined;
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  if (agentId && !UUID.test(agentId)) return bad(res, 'agentId must be a UUID');
  if (status && !STATUSES.includes(status)) return bad(res, `status must be one of ${STATUSES.join(', ')}`);
  const rows = await listRuns(req.session.userId, { agentId, status });
  res.json({ runs: rows.map(presentRun) });
});

router.post('/', async (req, res) => {
  const ownerId = req.session.userId;
  const { taskId, agentId, instructions, project, budget } = req.body ?? {};
  const budgetProblem = budgetError(budget);
  if (budgetProblem) return bad(res, budgetProblem);

  let spec;
  if (taskId != null) {
    if (typeof taskId !== 'string' || !UUID.test(taskId)) return bad(res, 'taskId must be a UUID');
    if (agentId != null || instructions != null) return bad(res, 'send either taskId or agentId with instructions');
    const { rows } = await getPool().query('SELECT id, agent_id, instructions, project FROM tasks WHERE id = $1 AND owner_id = $2', [taskId, ownerId]);
    if (!rows[0]) return notFound(res);
    spec = { taskId, agentId: rows[0].agent_id, instructions: rows[0].instructions, project: rows[0].project };
  } else {
    if (typeof agentId !== 'string' || !UUID.test(agentId)) return bad(res, 'agentId must be a UUID');
    if (typeof instructions !== 'string' || !instructions.trim()) return bad(res, 'instructions are required');
    if (instructions.length > INSTRUCTIONS_MAX) return bad(res, `instructions must be at most ${INSTRUCTIONS_MAX} characters`);
    if (project != null && (typeof project !== 'string' || !project.trim() || project.length > PROJECT_MAX)) {
      return bad(res, 'project must be a non-empty string');
    }
    spec = { taskId: null, agentId, instructions: instructions.trim(), project: project ?? null };
  }

  const agent = await loadAgent(ownerId, spec.agentId);
  if (!agent) return notFound(res);
  // A paused or killed agent starts nothing new; the user resumes or
  // reactivates it first.
  if (agent.state !== 'active') return res.status(409).json({ error: 'agent_not_active', message: `the agent is ${agent.state}` });

  const run = await insertRun({ ownerId, ...spec, budget: budget ?? {} });
  workspaceEvents.publish({ runId: run.id, agentId: run.agent_id, ownerId, type: 'run.queued', data: {} });
  notifyRunQueued();
  res.status(201).json({ run: presentRun(run) });
});

router.get('/:id', async (req, res) => {
  if (!UUID.test(req.params.id)) return notFound(res);
  const run = await getOwnedRun(req.session.userId, req.params.id);
  if (!run) return notFound(res);
  const steps = await listSteps(run.id);
  res.json({ run: { ...presentRun(run), steps: steps.map(presentStep) } });
});

router.post('/:id/cancel', async (req, res) => {
  const ownerId = req.session.userId;
  if (!UUID.test(req.params.id)) return notFound(res);
  const killed = await killRun(ownerId, req.params.id);
  if (!killed) {
    const run = await getOwnedRun(ownerId, req.params.id);
    if (!run) return notFound(res);
    return res.status(409).json({ error: 'run_finished', message: `the run is ${run.status}` });
  }
  const { run, expiredApprovalIds } = killed;
  for (const approvalId of expiredApprovalIds) {
    workspaceEvents.publish({ runId: run.id, agentId: run.agent_id, ownerId, type: 'approval.resolved', data: { approvalId, status: 'expired' } });
  }
  workspaceEvents.publish({ runId: run.id, agentId: run.agent_id, ownerId, type: 'run.finished', data: { status: 'killed' } });
  res.json({ run: presentRun(run) });
});

export default router;
