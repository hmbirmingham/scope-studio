import { Router } from 'express';
import requireAuth from '../../middleware/requireAuth.js';
import { getAgent } from '../../workspace/agents/agentStore.js';
import { presentTask } from '../../workspace/agents/presenters.js';
import { createTask, deleteTask, getTask, listTasks, updateTask } from '../../workspace/agents/taskStore.js';
import { isUuid, validateTask } from '../../workspace/agents/validation.js';

// Tasks and schedules (docs/architecture/agent-workspace.md, "HTTP shapes").
const router = Router();
router.use(requireAuth);

const owner = (req) => req.session.userId;
const notFound = (res) => res.status(404).json({ error: 'task_not_found' });
const agentMissing = (res) => res.status(404).json({ error: 'agent_not_found' });

router.get('/', async (req, res) => {
  const { agentId } = req.query;
  if (agentId !== undefined && !isUuid(agentId)) return res.status(400).json({ error: 'invalid_agent' });
  res.json({ tasks: (await listTasks(owner(req), { agentId })).map(presentTask) });
});

router.post('/', async (req, res) => {
  const checked = validateTask(req.body);
  if (checked.error) return res.status(400).json(checked);
  // The agent must be this user's; another user's agent is simply not found.
  if (!(await getAgent(owner(req), checked.value.agentId))) return agentMissing(res);
  const task = await createTask(owner(req), { project: null, schedule: null, enabled: true, ...checked.value });
  res.status(201).json({ task: presentTask(task) });
});

router.get('/:id', async (req, res) => {
  const task = await getTask(owner(req), req.params.id);
  if (!task) return notFound(res);
  res.json({ task: presentTask(task) });
});

router.patch('/:id', async (req, res) => {
  const current = await getTask(owner(req), req.params.id);
  if (!current) return notFound(res);
  const checked = validateTask(req.body, { partial: true });
  if (checked.error) return res.status(400).json(checked);
  if (checked.value.agentId && !(await getAgent(owner(req), checked.value.agentId))) return agentMissing(res);
  const task = await updateTask(owner(req), req.params.id, { ...presentTask(current), ...checked.value });
  if (!task) return notFound(res);
  res.json({ task: presentTask(task) });
});

router.delete('/:id', async (req, res) => {
  if (!(await deleteTask(owner(req), req.params.id))) return notFound(res);
  res.status(204).end();
});

export default router;
