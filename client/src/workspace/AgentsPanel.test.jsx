import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AgentsPanel from './AgentsPanel.jsx';
import { useAgentCursor } from './useAgentCursor.js';
import { FakeEventSource, workspaceEvent } from '../test/fakeEventSource.js';
import { AGENT, fakeApi, renderWithWorkspace } from '../test/workspace.jsx';

afterEach(() => FakeEventSource.reset());

describe('AgentsPanel', () => {
  it('lists agents and pauses, resumes and kills them', async () => {
    const user = userEvent.setup();
    const api = fakeApi({ listAgents: vi.fn(async () => [AGENT]) });
    renderWithWorkspace(<AgentsPanel />, { api });
    expect(await screen.findByText('Ada', { selector: '.ws-agent-name' })).toBeInTheDocument();
    expect(screen.getByText(/Researcher · Supervised · Local only/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Pause Ada' }));
    expect(api.pauseAgent).toHaveBeenCalledWith(AGENT.id);
    await user.click(await screen.findByRole('button', { name: 'Resume Ada' }));
    expect(api.resumeAgent).toHaveBeenCalledWith(AGENT.id);

    // The kill switch asks once more before stopping every run.
    await user.click(await screen.findByRole('button', { name: 'Kill switch for Ada' }));
    expect(api.killAgent).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Confirm: stop every run of Ada' }));
    expect(api.killAgent).toHaveBeenCalledWith(AGENT.id);
    expect(await screen.findByText('Stopped')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reactivate Ada' }));
    expect(api.reactivateAgent).toHaveBeenCalledWith(AGENT.id);
  });

  it('shows a refused state change instead of pretending it worked', async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      listAgents: vi.fn(async () => [AGENT]),
      pauseAgent: vi.fn(async () => {
        throw Object.assign(new Error('cannot pause an agent that is killed'), { status: 409 });
      }),
    });
    renderWithWorkspace(<AgentsPanel />, { api });
    await user.click(await screen.findByRole('button', { name: 'Pause Ada' }));
    expect(await screen.findByText('cannot pause an agent that is killed')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
  });

  it('opens the builder for a new agent and returns focus when it closes', async () => {
    const user = userEvent.setup();
    renderWithWorkspace(<AgentsPanel />);
    const open = screen.getByRole('button', { name: 'New agent' });
    await user.click(open);
    expect(screen.getByRole('dialog', { name: 'New agent' })).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(open).toHaveFocus();
  });
});

describe('useAgentCursor', () => {
  function Probe({ engine }) {
    const ref = useRef(engine);
    useAgentCursor(ref);
    return null;
  }

  it('hands touches and writes to the engine in the agent’s colour', async () => {
    const engine = { markAgentNodes: vi.fn() };
    const api = fakeApi({ listAgents: vi.fn(async () => [AGENT]) });
    renderWithWorkspace(<Probe engine={engine} />, { api });
    await waitFor(() => expect(api.listAgents).toHaveBeenCalled());
    await act(async () => {});
    act(() => FakeEventSource.latest().emit(workspaceEvent('node.touched', { agentId: AGENT.id, data: { nodeIds: ['n1', 'n2'] } })));
    act(() => FakeEventSource.latest().emit(workspaceEvent('node.written', { agentId: AGENT.id, data: { nodeId: 'n3', type: 'finding' } })));
    act(() => FakeEventSource.latest().emit(workspaceEvent('node.touched', { agentId: 'someone-else', data: { nodeIds: ['n4'] } })));
    expect(engine.markAgentNodes.mock.calls).toEqual([
      [['n1', 'n2'], '#e5484d', 'touched'],
      [['n3'], '#e5484d', 'written'],
      [['n4'], '#8a8a96', 'touched'],
    ]);
  });

  it('does nothing outside a workspace', () => {
    const engine = { markAgentNodes: vi.fn() };
    expect(() => render(<Probe engine={engine} />)).not.toThrow();
  });
});
