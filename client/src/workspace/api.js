// The agent workspace's HTTP client, built to the shapes in
// docs/architecture/agent-workspace.md ("HTTP shapes"). Every call resolves to
// the unwrapped record the caller wants, or throws an ApiError carrying the
// server's `{ error, message }` so a form can point at the field it names.

export class ApiError extends Error {
  constructor(status, code, message, body = null) {
    super(message || code || `request failed (${status})`);
    this.name = 'ApiError';
    this.status = status;
    this.code = code ?? 'request_failed';
    // The whole error body: a 409 on an approval carries the approval as it
    // now stands.
    this.body = body;
  }
}

// `fetchImpl` is injectable so the tests can drive every branch without a
// network; the app uses the browser's fetch, which sends the session cookie
// because the API is same-origin.
export function createWorkspaceApi(fetchImpl = (...args) => globalThis.fetch(...args)) {
  async function request(method, path, body) {
    const init = { method, headers: {} };
    if (body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let response;
    try {
      response = await fetchImpl(path, init);
    } catch {
      throw new ApiError(0, 'network_error', 'The workspace server could not be reached.');
    }
    if (response.status === 204) return null;
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new ApiError(response.status, payload?.error, payload?.message, payload);
    }
    return payload;
  }

  const get = (path) => request('GET', path);
  const post = (path, body) => request('POST', path, body ?? {});
  const patch = (path, body) => request('PATCH', path, body);
  const del = (path) => request('DELETE', path);
  const id = (value) => encodeURIComponent(value);
  const query = (params) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue;
      search.set(key, String(value));
    }
    const text = search.toString();
    return text ? `?${text}` : '';
  };

  return {
    // Agents
    listAgents: async () => (await get('/api/agents')).agents,
    getAgent: async (agentId) => (await get(`/api/agents/${id(agentId)}`)).agent,
    createAgent: async (body) => (await post('/api/agents', body)).agent,
    updateAgent: async (agentId, body) => (await patch(`/api/agents/${id(agentId)}`, body)).agent,
    deleteAgent: (agentId) => del(`/api/agents/${id(agentId)}`),
    pauseAgent: async (agentId) => (await post(`/api/agents/${id(agentId)}/pause`)).agent,
    resumeAgent: async (agentId) => (await post(`/api/agents/${id(agentId)}/resume`)).agent,
    killAgent: async (agentId) => (await post(`/api/agents/${id(agentId)}/kill`)).agent,
    reactivateAgent: async (agentId) => (await post(`/api/agents/${id(agentId)}/reactivate`)).agent,
    // Omitted flags stay omitted: the server then takes the cautious value,
    // exactly as the runner would, so the grid never shows more than is true.
    can: (agentId, capability, context = {}) =>
      get(`/api/agents/${id(agentId)}/can${query({ capability, ...context })}`),

    // Roles
    listTemplates: async () => (await get('/api/agents/templates')).templates,
    listRoles: async () => (await get('/api/agents/roles')).roles,
    createRole: async (body) => (await post('/api/agents/roles', body)).role,
    updateRole: async (roleId, body) => (await patch(`/api/agents/roles/${id(roleId)}`, body)).role,
    deleteRole: (roleId) => del(`/api/agents/roles/${id(roleId)}`),

    // Tasks
    listTasks: async (agentId) => (await get(`/api/tasks${query({ agentId })}`)).tasks,
    createTask: async (body) => (await post('/api/tasks', body)).task,
    updateTask: async (taskId, body) => (await patch(`/api/tasks/${id(taskId)}`, body)).task,
    deleteTask: (taskId) => del(`/api/tasks/${id(taskId)}`),

    // Runs
    listRuns: async (filter = {}) => (await get(`/api/agent-runs${query(filter)}`)).runs,
    getRun: async (runId) => (await get(`/api/agent-runs/${id(runId)}`)).run,
    startRun: async (body) => (await post('/api/agent-runs', body)).run,
    cancelRun: async (runId) => (await post(`/api/agent-runs/${id(runId)}/cancel`)).run,

    // Approvals
    getApproval: async (approvalId) => (await get(`/api/approvals/${id(approvalId)}`)).approval,
    listApprovals: async (status) => (await get(`/api/approvals${query({ status })}`)).approvals,
    resolveApproval: async (approvalId, decision) =>
      (await post(`/api/approvals/${id(approvalId)}`, { decision })).approval,

    // One node of the map, with its content (what an agent wrote, say).
    getNode: (nodeId) => get(`/api/nodes/${id(nodeId)}`),

    // The plan, read the way the rest of the client reads it: `chooseCloud`
    // from /api/usage is true only on Key Pro, the one plan with its own key.
    getPlan: async () => {
      const body = await get('/api/usage?days=7');
      return { ownKey: body?.chooseCloud === true };
    },
  };
}

export const workspaceApi = createWorkspaceApi();
