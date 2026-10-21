import { Router } from 'express';
import requireAuth from '../../middleware/requireAuth.js';
import { buildAgentPatch, buildNewAgent } from '../../workspace/agents/agentInput.js';
import {
  createAgent,
  deleteAgent,
  getAgent,
  killAgent,
  listAgents,
  pauseAgent,
  reactivateAgent,
  resumeAgent,
  updateAgent,
} from '../../workspace/agents/agentStore.js';
import { presentAgent, presentRole } from '../../workspace/agents/presenters.js';
import { createRole, deleteRole, getRole, listRoles, updateRole } from '../../workspace/agents/roleStore.js';
import { validateRoleFields } from '../../workspace/agents/validation.js';
import { decide } from '../../workspace/permissions.js';
import { ROLE_TEMPLATES } from '../../workspace/roles.js';

// Agents, user roles and the kill switch (docs/architecture/agent-workspace.md,
// "HTTP shapes"). Fixed paths (`templates`, `roles`) are declared before `/:id`.
const router = Router();
router.use(requireAuth);

const owner = (req) => req.session.userId;
const notFound = (res, what = 'agent') => res.status(404).json({ error: `${what}_not_found` });
const sendRejection = (res, { status, error, message }) => res.status(status).json({ error, message });

router.get('/templates', (req, res) => {
  res.json({ templates: ROLE_TEMPLATES.map((role) => ({ ...role, tags: [...role.tags] })) });
});

router.get('/roles', async (req, res) => {
  res.json({ roles: (await listRoles(owner(req))).map(presentRole) });
});

router.post('/roles', async (req, res) => {
  const checked = validateRoleFields(req.body);
  if (checked.error) return res.status(400).json(checked);
  res.status(201).json({ role: presentRole(await createRole(owner(req), checked.value)) });
});

router.patch('/roles/:id', async (req, res) => {
  const checked = validateRoleFields(req.body, { partial: true });
  if (checked.error) return res.status(400).json(checked);
  const role = await updateRole(owner(req), req.params.id, checked.value);
  if (!role) return notFound(res, 'role');
  res.json({ role: presentRole(role) });
});

router.delete('/roles/:id', async (req, res) => {
  if (!(await deleteRole(owner(req), req.params.id))) return notFound(res, 'role');
  res.status(204).end();
});

router.get('/roles/:id', async (req, res) => {
  const role = await getRole(owner(req), req.params.id);
  if (!role) return notFound(res, 'role');
  res.json({ role: presentRole(role) });
});

router.get('/', async (req, res) => {
  res.json({ agents: (await listAgents(owner(req))).map(presentAgent) });
});

router.post('/', async (req, res) => {
  const built = await buildNewAgent(owner(req), req.body);
  if (built.rejection) return sendRejection(res, built.rejection);
  res.status(201).json({ agent: presentAgent(await createAgent(owner(req), built.agent)) });
});

// Booleans are strict: only the literal strings 'true' and 'false' count, and a
// flag left out stays undefined so decide() applies its cautious default.
function parseFlag(value) {
  if (value === undefined) return { value: undefined };
  if (value === 'true') return { value: true };
  if (value === 'false') return { value: false };
  return { error: true };
}

router.get('/:id/can', async (req, res) => {
  const row = await getAgent(owner(req), req.params.id);
  if (!row) return notFound(res);
  const { capability, project, source } = req.query;
  if (typeof capability !== 'string' || !capability) {
    return res.status(400).json({ error: 'capability_required', message: 'capability is required' });
  }
  const context = {};
  for (const [key, value] of [['project', project], ['source', source]]) {
    if (value === undefined || value === '') continue;
    if (typeof value !== 'string') return res.status(400).json({ error: `invalid_${key}` });
    context[key] = value;
  }
  for (const key of ['inSandbox', 'online', 'privateContext']) {
    const flag = parseFlag(req.query[key]);
    if (flag.error) return res.status(400).json({ error: `invalid_${key}`, message: `${key} must be true or false` });
    if (flag.value !== undefined) context[key] = flag.value;
  }
  const { decision, reason } = decide(presentAgent(row), capability, context);
  res.json({ decision, reason });
});

router.get('/:id', async (req, res) => {
  const row = await getAgent(owner(req), req.params.id);
  if (!row) return notFound(res);
  res.json({ agent: presentAgent(row) });
});

router.patch('/:id', async (req, res) => {
  const row = await getAgent(owner(req), req.params.id);
  if (!row) return notFound(res);
  const built = await buildAgentPatch(owner(req), presentAgent(row), req.body);
  if (built.rejection) return sendRejection(res, built.rejection);
  const updated = await updateAgent(owner(req), req.params.id, built.next);
  if (!updated) return notFound(res);
  res.json({ agent: presentAgent(updated) });
});

router.delete('/:id', async (req, res) => {
  if (!(await deleteAgent(owner(req), req.params.id))) return notFound(res);
  res.status(204).end();
});

for (const [action, run] of [['pause', pauseAgent], ['resume', resumeAgent], ['kill', killAgent], ['reactivate', reactivateAgent]]) {
  router.post(`/:id/${action}`, async (req, res) => {
    const result = await run(owner(req), req.params.id);
    if (result.status === 404) return notFound(res);
    if (result.status === 409) return res.status(409).json({ error: 'invalid_state', message: `cannot ${action} an agent that is ${result.state}` });
    res.json({ agent: presentAgent(result.agent) });
  });
}

export default router;
