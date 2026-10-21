import { describe, expect, it, vi } from 'vitest';
import { ApiError, createWorkspaceApi } from './api.js';

function respond(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => (body === undefined ? Promise.reject(new Error('no body')) : body) };
}

describe('workspace API client', () => {
  it('unwraps the record and sends JSON bodies', async () => {
    const fetchImpl = vi.fn(async () => respond(201, { agent: { id: 'a1', name: 'Ada' } }));
    const api = createWorkspaceApi(fetchImpl);
    const agent = await api.createAgent({ name: 'Ada', template: 'researcher' });
    expect(agent).toEqual({ id: 'a1', name: 'Ada' });
    const [path, init] = fetchImpl.mock.calls[0];
    expect(path).toBe('/api/agents');
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ name: 'Ada', template: 'researcher' });
  });

  it('hits the documented paths for each agent action', async () => {
    const fetchImpl = vi.fn(async () => respond(200, { agent: { id: 'a/1' } }));
    const api = createWorkspaceApi(fetchImpl);
    await api.pauseAgent('a/1');
    await api.resumeAgent('a/1');
    await api.killAgent('a/1');
    await api.reactivateAgent('a/1');
    await api.updateAgent('a/1', { name: 'B' });
    expect(fetchImpl.mock.calls.map(([path, init]) => `${init.method} ${path}`)).toEqual([
      'POST /api/agents/a%2F1/pause',
      'POST /api/agents/a%2F1/resume',
      'POST /api/agents/a%2F1/kill',
      'POST /api/agents/a%2F1/reactivate',
      'PATCH /api/agents/a%2F1',
    ]);
  });

  it('leaves omitted can() flags out so the server takes the cautious value', async () => {
    const fetchImpl = vi.fn(async () => respond(200, { decision: 'deny', reason: 'offline' }));
    const api = createWorkspaceApi(fetchImpl);
    const answer = await api.can('a1', 'web', { project: 'alpha', online: false, inSandbox: undefined });
    expect(answer).toEqual({ decision: 'deny', reason: 'offline' });
    const url = new URL(fetchImpl.mock.calls[0][0], 'http://x');
    expect(url.pathname).toBe('/api/agents/a1/can');
    expect(Object.fromEntries(url.searchParams)).toEqual({ capability: 'web', project: 'alpha', online: 'false' });
  });

  it('resolves 204 deletes to null', async () => {
    const api = createWorkspaceApi(vi.fn(async () => respond(204)));
    await expect(api.deleteAgent('a1')).resolves.toBeNull();
  });

  it('throws ApiError with the server code, message and body', async () => {
    const body = { error: 'already_resolved', message: 'this approval is approved', approval: { id: 'p1', status: 'approved' } };
    const api = createWorkspaceApi(vi.fn(async () => respond(409, body)));
    const failure = await api.resolveApproval('p1', 'approve').catch((error) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure.status).toBe(409);
    expect(failure.code).toBe('already_resolved');
    expect(failure.message).toBe('this approval is approved');
    expect(failure.body.approval.status).toBe('approved');
  });

  it('turns a non-JSON error into a generic ApiError', async () => {
    const api = createWorkspaceApi(vi.fn(async () => respond(500)));
    const failure = await api.listAgents().catch((error) => error);
    expect(failure.code).toBe('request_failed');
    expect(failure.message).toBe('request failed (500)');
  });

  it('reports an unreachable server as network_error', async () => {
    const api = createWorkspaceApi(vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    await expect(api.listRuns()).rejects.toMatchObject({ status: 0, code: 'network_error' });
  });

  it('builds run, task and approval requests from the contract', async () => {
    const fetchImpl = vi.fn(async (path) => {
      if (path.startsWith('/api/agent-runs')) return respond(201, { run: { id: 'r1' }, runs: [] });
      if (path.startsWith('/api/tasks')) return respond(200, { tasks: [], task: { id: 't1' } });
      return respond(200, { approvals: [], approval: { id: 'p1', status: 'rejected' } });
    });
    const api = createWorkspaceApi(fetchImpl);
    await api.startRun({ taskId: 't1' });
    await api.listRuns({ agentId: 'a1', status: undefined });
    await api.listTasks('a1');
    await api.listTasks();
    await api.listApprovals('pending');
    await api.resolveApproval('p1', 'reject');
    expect(fetchImpl.mock.calls.map(([path, init]) => `${init.method} ${path}${init.body ? ` ${init.body}` : ''}`)).toEqual([
      'POST /api/agent-runs {"taskId":"t1"}',
      'GET /api/agent-runs?agentId=a1',
      'GET /api/tasks?agentId=a1',
      'GET /api/tasks',
      'GET /api/approvals?status=pending',
      'POST /api/approvals/p1 {"decision":"reject"}',
    ]);
  });

  it('reads Key Pro from /api/usage the way the rest of the client does', async () => {
    const keyPro = createWorkspaceApi(vi.fn(async () => respond(200, { chooseCloud: true })));
    const student = createWorkspaceApi(vi.fn(async () => respond(200, { chooseCloud: false, autoCloud: true })));
    await expect(keyPro.getPlan()).resolves.toEqual({ ownKey: true });
    await expect(student.getPlan()).resolves.toEqual({ ownKey: false });
  });
});
