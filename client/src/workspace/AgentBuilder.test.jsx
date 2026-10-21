import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import AgentBuilder from './AgentBuilder.jsx';
import { ApiError } from './api.js';
import { AGENT, fakeApi, renderWithWorkspace } from '../test/workspace.jsx';

function renderBuilder({ agent = null, api = fakeApi(), onSaved = vi.fn(), onClose = vi.fn() } = {}) {
  const result = renderWithWorkspace(<AgentBuilder agent={agent} onSaved={onSaved} onClose={onClose} />, { api });
  return { ...result, onSaved, onClose };
}

const slider = () => screen.getByRole('slider');
const row = (capability) => document.querySelector(`tr[data-capability="${capability}"]`);
// The "By setting" column for one capability.
const bySetting = (capability) => row(capability).cells[1].textContent;

describe('AgentBuilder', () => {
  it('starts new agents at Supervised and explains each level as the slider moves', async () => {
    renderBuilder();
    expect(slider()).toHaveValue('1');
    expect(slider()).toHaveAttribute('aria-valuetext', 'Supervised');
    expect(bySetting('web')).toBe('Ask');
    expect(bySetting('read_graph')).toBe('Allow');

    fireEvent.change(slider(), { target: { value: '3' } });
    expect(slider()).toHaveAttribute('aria-valuetext', 'Fully agentic');
    expect(bySetting('web')).toBe('Allow');

    fireEvent.change(slider(), { target: { value: '2' } });
    expect(bySetting('edit_files')).toBe('Allow (in sandbox, else ask)');
    expect(bySetting('run_generated_code')).toBe('Allow (in sandbox only)');

    fireEvent.change(slider(), { target: { value: '0' } });
    expect(bySetting('read_graph')).toBe('Ask');
  });

  it('uses a native, labelled range input so it is keyboard operable', () => {
    renderBuilder();
    expect(slider()).toHaveAttribute('type', 'range');
    expect(slider()).toHaveAccessibleName(/Permission level/);
  });

  it('copies a template into the role fields and creates from it with overrides', async () => {
    const user = userEvent.setup();
    const { api, onSaved } = renderBuilder();
    await waitFor(() => expect(screen.getByRole('option', { name: 'Builder' })).toBeInTheDocument());
    await user.selectOptions(screen.getByLabelText('Start from'), 'template:builder');
    expect(screen.getByLabelText('Title')).toHaveValue('Builder');
    expect(screen.getByLabelText('vcs')).toBeChecked();

    await user.type(screen.getByLabelText('Name'), 'Bob');
    await user.selectOptions(screen.getByLabelText('Override for Use the web'), 'deny');
    expect(bySetting('web')).toBe('Deny');
    await user.click(screen.getByRole('button', { name: 'Create agent' }));

    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const body = api.createAgent.mock.calls[0][0];
    expect(body).toMatchObject({ name: 'Bob', template: 'builder', level: 'supervised', overrides: { web: 'deny' }, modelPolicy: 'local_only' });
    expect(body.role).toBeUndefined();
    expect(body.budget).toEqual({ maxTokens: 200000, maxUsd: 0.5, maxWallMs: 3600000 });
    expect(body.scopes).toEqual({ read: { projects: ['*'], sources: ['*'] }, write: { projects: [] } });
    // The template was not edited, so nothing is patched afterwards.
    expect(api.updateAgent).not.toHaveBeenCalled();
  });

  it('patches the role right after creation when a template was edited', async () => {
    const user = userEvent.setup();
    const { api } = renderBuilder();
    await waitFor(() => expect(screen.getByRole('option', { name: 'Researcher' })).toBeInTheDocument());
    await user.selectOptions(screen.getByLabelText('Start from'), 'template:researcher');
    await user.type(screen.getByLabelText('Name'), 'Rae');
    await user.clear(screen.getByLabelText('Title'));
    await user.type(screen.getByLabelText('Title'), 'Literature scout');
    await user.click(screen.getByRole('button', { name: 'Create agent' }));
    await waitFor(() => expect(api.updateAgent).toHaveBeenCalled());
    expect(api.createAgent.mock.calls[0][0].template).toBe('researcher');
    expect(api.updateAgent.mock.calls[0][1].role.title).toBe('Literature scout');
  });

  it('surfaces validation errors on the fields and does not send', async () => {
    const user = userEvent.setup();
    const { api } = renderBuilder();
    const tokens = screen.getByLabelText('Tokens');
    await user.clear(tokens);
    await user.type(tokens, '-5');
    await user.click(screen.getByRole('button', { name: 'Create agent' }));

    const summary = await screen.findByText(/Check these before saving/);
    expect(summary).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Name')).toHaveAccessibleDescription('Give the agent a name.');
    expect(screen.getByLabelText('Title')).toHaveAttribute('aria-invalid', 'true');
    expect(tokens).toHaveAttribute('aria-invalid', 'true');
    expect(api.createAgent).not.toHaveBeenCalled();
  });

  it('shows a server rejection beside the field it names', async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      createAgent: vi.fn(async () => {
        throw new ApiError(400, 'invalid_scopes', 'scopes.write.projects must hold non-empty strings');
      }),
    });
    renderBuilder({ api });
    await user.type(screen.getByLabelText('Name'), 'Eve');
    await user.type(screen.getByLabelText('Title'), 'Custom');
    await user.click(screen.getByRole('button', { name: 'Create agent' }));
    const messages = await screen.findAllByText('scopes.write.projects must hold non-empty strings');
    expect(messages.some((element) => element.id === 'agent-error-scopes')).toBe(true);
  });

  it('offers your own key only on Key Pro', async () => {
    renderBuilder();
    const ownKey = screen.getByRole('radio', { name: /Own key/ });
    expect(ownKey).toBeDisabled();
    expect(screen.getByText('Needs the Key Pro plan.')).toBeInTheDocument();
  });

  it('allows your own key on Key Pro', async () => {
    const user = userEvent.setup();
    const api = fakeApi({ getPlan: vi.fn(async () => ({ ownKey: true })) });
    renderBuilder({ api });
    const ownKey = screen.getByRole('radio', { name: /Own key/ });
    await waitFor(() => expect(ownKey).toBeEnabled());
    await user.click(ownKey);
    expect(ownKey).toBeChecked();
  });

  it('shows the server’s effective decision per capability for a saved agent', async () => {
    const api = fakeApi({
      listAgents: vi.fn(async () => [AGENT]),
      can: vi.fn(async (id, capability, context) => {
        if (capability === 'cloud_model') return { decision: 'deny', reason: 'local_only_policy' };
        return { decision: context.online ? 'ask' : 'deny', reason: 'level' };
      }),
    });
    renderBuilder({ agent: AGENT, api });
    await waitFor(() => expect(screen.getByTestId('effective-cloud_model')).toHaveTextContent('Deny'));
    expect(screen.getByTestId('effective-cloud_model')).toHaveTextContent('the model policy is local only');
    expect(api.can).toHaveBeenCalledWith(AGENT.id, 'web', { project: 'alpha', inSandbox: true, online: true, privateContext: false });

    fireEvent.click(screen.getByLabelText('Online'));
    await waitFor(() => expect(screen.getByTestId('effective-web')).toHaveTextContent('Deny'));
  });

  it('saves an edited agent with PATCH, including overrides set back to inherit', async () => {
    const user = userEvent.setup();
    const agent = { ...AGENT, overrides: { web: 'allow' } };
    const api = fakeApi({ listAgents: vi.fn(async () => [agent]) });
    const { onSaved } = renderBuilder({ agent, api });
    expect(screen.getByLabelText('Override for Use the web')).toHaveValue('allow');
    await user.selectOptions(screen.getByLabelText('Override for Use the web'), 'inherit');
    await user.click(within(screen.getByRole('group', { name: 'May write to projects' })).getByLabelText('beta'));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const [id, body] = api.updateAgent.mock.calls[0];
    expect(id).toBe(AGENT.id);
    expect(body.overrides).toEqual({});
    expect(body.scopes.write.projects).toEqual(['alpha', 'beta']);
    expect(body.role).toEqual({ title: 'Researcher', description: 'Reads things.', embodiment: 'Cite sources.', tags: ['graph', 'research', 'web'] });
    expect(body).not.toHaveProperty('state');
  });

  it('closes on Escape', async () => {
    const user = userEvent.setup();
    const { onClose } = renderBuilder();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
  });
});
