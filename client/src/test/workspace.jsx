import { render } from '@testing-library/react';
import { vi } from 'vitest';
import WorkspaceProvider from '../workspace/WorkspaceProvider.jsx';
import { WorkspaceEventStream } from '../workspace/eventStream.js';
import { FakeEventSource } from './fakeEventSource.js';

export const AGENT = Object.freeze({
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Ada',
  role: { template: 'researcher', title: 'Researcher', description: 'Reads things.', embodiment: 'Cite sources.', tags: ['graph', 'research', 'web'] },
  level: 'supervised',
  overrides: {},
  scopes: { read: { projects: ['*'], sources: ['*'] }, write: { projects: ['alpha'] } },
  modelPolicy: 'local_only',
  budget: { maxTokens: 200000, maxUsd: 0.5, maxWallMs: 3600000 },
  state: 'active',
  color: '#e5484d',
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
});

export const TEMPLATES = [
  { template: 'researcher', title: 'Researcher', description: 'Sweeps the literature.', embodiment: 'Cite a source for every claim.', tags: ['graph', 'research', 'web'] },
  { template: 'builder', title: 'Builder', description: 'Implements changes.', embodiment: 'Make the smallest change.', tags: ['graph', 'code', 'scripts', 'vcs'] },
];

// Every API call as a mock with a harmless default, so a test overrides only
// what it is about.
export function fakeApi(overrides = {}) {
  return {
    listAgents: vi.fn(async () => []),
    getAgent: vi.fn(),
    createAgent: vi.fn(async (body) => ({ ...AGENT, id: 'new-agent', name: body.name, state: 'active' })),
    updateAgent: vi.fn(async (id, body) => ({ ...AGENT, id, ...body })),
    deleteAgent: vi.fn(async () => null),
    pauseAgent: vi.fn(async (id) => ({ ...AGENT, id, state: 'paused' })),
    resumeAgent: vi.fn(async (id) => ({ ...AGENT, id, state: 'active' })),
    killAgent: vi.fn(async (id) => ({ ...AGENT, id, state: 'killed' })),
    reactivateAgent: vi.fn(async (id) => ({ ...AGENT, id, state: 'active' })),
    can: vi.fn(async () => ({ decision: 'ask', reason: 'level' })),
    listTemplates: vi.fn(async () => TEMPLATES),
    listRoles: vi.fn(async () => []),
    createRole: vi.fn(async (body) => ({ id: 'role-1', template: null, ...body })),
    updateRole: vi.fn(),
    deleteRole: vi.fn(),
    listTasks: vi.fn(async () => []),
    createTask: vi.fn(async (body) => ({ id: 'task-1', enabled: true, nextRunAt: null, ...body })),
    updateTask: vi.fn(async (id, body) => ({ id, ...body })),
    deleteTask: vi.fn(async () => null),
    listRuns: vi.fn(async () => []),
    getRun: vi.fn(),
    startRun: vi.fn(),
    cancelRun: vi.fn(),
    listApprovals: vi.fn(async () => []),
    getApproval: vi.fn(async () => null),
    getNode: vi.fn(async (id) => ({ id, content: "" })),
    resolveApproval: vi.fn(async (id, decision) => ({ id, status: decision === 'approve' ? 'approved' : 'rejected' })),
    getPlan: vi.fn(async () => ({ ownKey: false })),
    ...overrides,
  };
}

export function fakeStream() {
  return new WorkspaceEventStream({ createSource: (url) => new FakeEventSource(url), reopenDelayMs: 10 });
}

export function renderWithWorkspace(ui, { api = fakeApi(), stream = fakeStream(), ...props } = {}) {
  const result = render(
    <WorkspaceProvider api={api} stream={stream} projects={[{ project: 'alpha' }, { project: 'beta' }]} {...props}>
      {ui}
    </WorkspaceProvider>
  );
  return { ...result, api, stream };
}
