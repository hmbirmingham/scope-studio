import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import WorkspaceTabs from './WorkspaceTabs.jsx';
import { registerTab, resetTabsForTest, selectTab } from './tabs.js';

afterEach(() => resetTabsForTest());

const Agents = () => <p>agents panel</p>;
const Inbox = () => <p>inbox panel</p>;
const Badge = () => <span aria-label="3 pending">3</span>;

describe('WorkspaceTabs', () => {
  it('renders the conversation alone when nothing is registered', () => {
    render(<WorkspaceTabs><p>chat</p></WorkspaceTabs>);
    expect(screen.getByText('chat')).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  });

  it('draws registered tabs in order, with badges, and keeps the conversation mounted', async () => {
    const user = userEvent.setup();
    registerTab({ id: 'approvals', label: 'Approvals', order: 30, Component: Inbox, Badge });
    registerTab({ id: 'agents', label: 'Agents', order: 10, Component: Agents });
    render(<WorkspaceTabs><input aria-label="message" /></WorkspaceTabs>);
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Conversation', 'Agents', 'Approvals3']);
    expect(screen.getByLabelText('3 pending')).toBeInTheDocument();

    await user.type(screen.getByLabelText('message'), 'half typed');
    await user.click(screen.getByRole('tab', { name: 'Agents' }));
    expect(screen.getByText('agents panel')).toBeInTheDocument();
    expect(screen.getByRole('tabpanel', { name: 'Agents' })).toBeVisible();
    await user.click(screen.getByRole('tab', { name: 'Conversation' }));
    expect(screen.getByLabelText('message')).toHaveValue('half typed');
  });

  it('moves between tabs with the arrow keys', async () => {
    const user = userEvent.setup();
    registerTab({ id: 'agents', label: 'Agents', order: 10, Component: Agents });
    registerTab({ id: 'approvals', label: 'Approvals', order: 30, Component: Inbox });
    render(<WorkspaceTabs><p>chat</p></WorkspaceTabs>);
    screen.getByRole('tab', { name: 'Conversation' }).focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: 'Agents' })).toHaveFocus();
    expect(screen.getByRole('tab', { name: 'Agents' })).toHaveAttribute('aria-selected', 'true');
    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(screen.getByRole('tab', { name: 'Approvals' })).toHaveFocus();
    await user.keyboard('{Home}');
    expect(screen.getByRole('tab', { name: 'Conversation' })).toHaveAttribute('tabindex', '0');
  });

  it('opens a tab when another part of the workspace asks', () => {
    registerTab({ id: 'activity', label: 'Activity', order: 20, Component: Inbox });
    render(<WorkspaceTabs><p>chat</p></WorkspaceTabs>);
    act(() => selectTab('activity'));
    expect(screen.getByText('inbox panel')).toBeInTheDocument();
  });

  it('refuses a duplicate or incomplete registration', () => {
    registerTab({ id: 'agents', label: 'Agents', Component: Agents });
    expect(() => registerTab({ id: 'agents', label: 'Again', Component: Agents })).toThrow(/already registered/);
    expect(() => registerTab({ id: 'x', label: 'X' })).toThrow(/needs an id, a label and a Component/);
  });
});
