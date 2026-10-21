import { expect, test } from '@playwright/test';

// One pass through the agent workspace against a fully mocked API: signed in,
// create an agent, start a run, watch its steps stream in over SSE, approve
// the step that asks. The SSE mock answers each connection with the events
// after its Last-Event-ID and then ends it, so the browser's own reconnect
// (and the client's resync over HTTP) is exercised on every poll.

const BOOT = 'e2e';
const AGENT_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID = '22222222-2222-4222-8222-222222222222';
const APPROVAL_ID = '33333333-3333-4333-8333-333333333333';
const NODE_ID = '44444444-4444-4444-8444-444444444444';

const TEMPLATES = [
  { template: 'researcher', title: 'Researcher', description: 'Sweeps the literature and the project graph.', embodiment: 'Cite a source for every claim.', tags: ['graph', 'research', 'web'] },
  { template: 'builder', title: 'Builder', description: 'Implements changes.', embodiment: 'Make the smallest change.', tags: ['graph', 'code', 'scripts', 'vcs'] },
];

function createMockServer() {
  const state = { agents: [], run: null, approvals: [], events: [], requests: [] };

  function emit(type, data) {
    const seq = state.events.length + 1;
    const id = `${BOOT}-${seq}`;
    state.events.push({ v: 1, id, seq, runId: RUN_ID, agentId: AGENT_ID, at: new Date().toISOString(), type, data });
  }

  function step(id, index, capability) {
    const entry = { id, index, kind: 'act', capability, status: 'running', input: {}, output: null, verification: [], adapter: 'local', tokens: 0, costUsd: 0, nodeIds: [], startedAt: new Date().toISOString(), finishedAt: null };
    state.run.steps.push(entry);
    emit('step.started', { stepId: id, index, capability });
    return entry;
  }

  function startRun(body) {
    const agent = state.agents.find((entry) => entry.id === body.agentId);
    state.run = {
      id: RUN_ID, agentId: body.agentId, taskId: null, instructions: body.instructions, project: body.project ?? null,
      status: 'running', stepIndex: 0, tokensUsed: 0, costUsd: 0, wallMs: 0, budget: agent.budget, error: null,
      queuedAt: new Date().toISOString(), startedAt: new Date().toISOString(), finishedAt: null, planNodeId: null, steps: [],
    };
    emit('run.queued', {});
    emit('run.started', {});
    const first = step('s1', 0, 'read_graph');
    first.output = 'Read 1 note about sensor drift.';
    emit('step.output', { stepId: 's1', text: first.output });
    first.verification.push({ verifier: 'result.schema', ok: true, detail: null });
    emit('step.verified', { stepId: 's1', verifier: 'result.schema', ok: true, detail: null });
    first.nodeIds.push(NODE_ID);
    emit('node.written', { nodeId: NODE_ID, type: 'finding' });
    state.run.tokensUsed += 1200;
    emit('cost', { tokens: 1200, usd: 0, adapter: 'local' });
    first.status = 'succeeded';
    emit('step.finished', { stepId: 's1', status: 'succeeded' });

    const second = step('s2', 1, 'edit_files');
    second.status = 'waiting_approval';
    state.run.status = 'waiting_approval';
    state.approvals.push({ id: APPROVAL_ID, agentId: AGENT_ID, runId: RUN_ID, stepId: 's2', capability: 'edit_files', summary: 'Edit README.md', detail: { path: 'README.md' }, status: 'pending', createdAt: new Date().toISOString(), resolvedAt: null });
    // The runner's parking sequence: the request, then the run pauses on it.
    emit('approval.requested', { approvalId: APPROVAL_ID, capability: 'edit_files', summary: 'Edit README.md' });
    emit('run.paused', { reason: 'waiting_approval', approvalId: APPROVAL_ID });
    return state.run;
  }

  function approve(decision) {
    const approval = state.approvals.find((entry) => entry.id === APPROVAL_ID);
    approval.status = decision === 'approve' ? 'approved' : 'rejected';
    approval.resolvedAt = new Date().toISOString();
    emit('approval.resolved', { approvalId: APPROVAL_ID, status: approval.status });
    // As on the server: the approval store requeues the run, then a worker
    // reclaims it and resumes the parked step without a new step.started.
    const second = state.run.steps[1];
    state.run.status = 'queued';
    emit('run.queued', {});
    second.status = 'running';
    state.run.status = 'running';
    emit('run.resumed', { attempt: 1 });
    second.output = 'Edited README.md';
    emit('step.output', { stepId: 's2', text: second.output });
    second.status = 'succeeded';
    emit('step.finished', { stepId: 's2', status: 'succeeded' });
    state.run.status = 'succeeded';
    state.run.finishedAt = new Date().toISOString();
    emit('run.finished', { status: 'succeeded' });
    return approval;
  }

  async function handle(route) {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const body = request.postData() ? JSON.parse(request.postData()) : null;
    state.requests.push({ method, path, body });
    const json = (payload, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) });

    if (path === '/api/workspace/events') {
      const last = request.headers()['last-event-id'];
      const after = last && last.startsWith(`${BOOT}-`) ? Number(last.split('-').pop()) : 0;
      const text = state.events
        .filter((event) => event.seq > after)
        .map((event) => `id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
        .join('');
      return route.fulfill({ status: 200, headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' }, body: `retry: 250\n: connected\n\n${text}` });
    }
    if (path === '/api/auth/session') return json({ user: { id: 'u1', email: 'test@example.com' } });
    if (path === '/api/graph') {
      return json({ nodes: [{ id: NODE_ID, label: 'Drift is thermal', type: 'finding', project: 'alpha', tokenLength: 80, source: 'agent', privacy: 'shared' }], edges: [], projects: [{ project: 'alpha', nodes: 1, privacy: 'shared' }] });
    }
    if (path === '/api/usage') return json({ chooseCloud: false, autoCloud: false, monthlyAnswers: null });
    if (path === '/api/actions/consent') return json({ displayControl: false, available: false });
    if (path === '/api/projects/settings') return json({ projects: [] });
    if (path === '/api/billing') return json({ plan: 'free', configured: false });
    if (path === '/api/agents/templates') return json({ templates: TEMPLATES });
    if (path === '/api/agents/roles') return json({ roles: [] });
    if (path === '/api/agents' && method === 'GET') return json({ agents: state.agents });
    if (path === '/api/agents' && method === 'POST') {
      const template = TEMPLATES.find((entry) => entry.template === body.template);
      const agent = {
        id: AGENT_ID, name: body.name, role: { ...template }, level: body.level, overrides: body.overrides, scopes: body.scopes,
        modelPolicy: body.modelPolicy, budget: body.budget, state: 'active', color: body.color,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      state.agents.push(agent);
      return json({ agent }, 201);
    }
    if (/^\/api\/agents\/[^/]+\/can$/.test(path)) return json({ decision: 'ask', reason: 'level' });
    if (path === '/api/tasks') return json({ tasks: [] });
    if (path === '/api/agent-runs' && method === 'GET') return json({ runs: state.run ? [state.run] : [] });
    if (path === '/api/agent-runs' && method === 'POST') return json({ run: startRun(body) }, 201);
    if (path === `/api/agent-runs/${RUN_ID}`) return json({ run: state.run });
    if (path === '/api/approvals' && method === 'GET') {
      const status = url.searchParams.get('status');
      return json({ approvals: state.approvals.filter((entry) => !status || entry.status === status) });
    }
    if (path === `/api/approvals/${APPROVAL_ID}` && method === 'POST') return json({ approval: approve(body.decision) });
    return json({ error: 'not_mocked', message: `${method} ${path}` }, 404);
  }

  return { state, handle };
}

test('create an agent, run it, watch the steps stream and approve', async ({ page }) => {
  const server = createMockServer();
  await page.route('**/api/**', (route) => server.handle(route));
  await page.goto('/');

  // Signed in: the workspace strip sits beside the conversation.
  const tabs = page.getByRole('tablist', { name: 'Workspace' });
  await expect(tabs.getByRole('tab', { name: 'Conversation' })).toHaveAttribute('aria-selected', 'true');

  // Create an agent from the Researcher template, one notch more autonomous.
  await tabs.getByRole('tab', { name: 'Agents' }).click();
  await page.getByRole('button', { name: 'New agent' }).click();
  const builder = page.getByRole('dialog', { name: 'New agent' });
  await builder.getByLabel('Name').fill('Ada');
  await builder.getByLabel('Start from').selectOption('template:researcher');
  await expect(builder.getByLabel('Title')).toHaveValue('Researcher');
  const slider = builder.getByRole('slider');
  await expect(slider).toHaveAttribute('aria-valuetext', 'Supervised');
  await slider.focus();
  await page.keyboard.press('ArrowRight');
  await expect(slider).toHaveAttribute('aria-valuetext', 'Sandboxed autonomous');
  await builder.getByRole('button', { name: 'Create agent' }).click();
  await expect(builder).toBeHidden();
  await expect(page.getByRole('list', { name: 'Your agents' }).getByText('Ada')).toBeVisible();
  const created = server.state.requests.find((request) => request.method === 'POST' && request.path === '/api/agents');
  expect(created.body).toMatchObject({ name: 'Ada', template: 'researcher', level: 'sandboxed', modelPolicy: 'local_only' });

  // Start a run and follow it.
  await tabs.getByRole('tab', { name: 'Activity' }).click();
  await page.getByLabel('What should it do?').fill('Summarise the sensor drift notes');
  await page.getByRole('button', { name: 'Start run' }).click();
  const steps = page.getByRole('list', { name: 'Steps' });
  await expect(steps.getByText('Read 1 note about sensor drift.')).toBeVisible();
  await expect(steps.getByText(/result\.schema: passed/)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Findings and artifacts' }).getByRole('button', { name: /Drift is thermal/ })).toBeVisible();
  await expect(page.getByLabel('1 pending')).toBeVisible();
  await expect(page.getByRole('heading', { name: /Ada/ }).getByRole('status')).toHaveText('Waiting for approval');

  // Approve inline; the run finishes.
  await steps.getByRole('button', { name: 'Approve: Edit README.md' }).click();
  await expect(steps.getByText('Approved')).toBeVisible();
  await expect(steps.getByText('Edited README.md')).toBeVisible();
  await expect(page.getByRole('heading', { name: /Ada/ }).getByRole('status')).toHaveText('Succeeded');
  await expect(page.getByLabel('1 pending')).toBeHidden();
  expect(server.state.requests).toContainEqual({ method: 'POST', path: `/api/approvals/${APPROVAL_ID}`, body: { decision: 'approve' } });

  // The stream reconnected with Last-Event-ID along the way and nothing was shown twice.
  await expect(steps.getByText('Edited README.md')).toHaveCount(1);
  expect(server.state.requests.filter((request) => request.path === '/api/workspace/events').length).toBeGreaterThan(1);
});
