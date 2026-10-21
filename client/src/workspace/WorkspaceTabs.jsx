import { Suspense, useEffect, useRef, useState } from 'react';
import { listTabs, onSelectTab } from './tabs.js';

const CONVERSATION = 'conversation';

// The conversation is always the first tab. With nothing else registered the
// strip is not drawn at all, so the conversation looks exactly as it did.
// The conversation stays mounted while another tab is open, so a half-typed
// message survives a look at the activity.
export default function WorkspaceTabs({ children }) {
  const tabs = listTabs();
  const [active, setActive] = useState(CONVERSATION);
  const buttons = useRef(new Map());

  useEffect(() => onSelectTab((id) => setActive(id)), []);

  if (tabs.length === 0) return children;

  const current = tabs.find((tab) => tab.id === active) ?? null;
  const order = [CONVERSATION, ...tabs.map((tab) => tab.id)];
  const selected = current ? current.id : CONVERSATION;

  // Arrow keys move between tabs, as the WAI-ARIA tabs pattern expects.
  function onKeyDown(event) {
    const index = order.indexOf(selected);
    let next = null;
    if (event.key === 'ArrowRight') next = order[(index + 1) % order.length];
    else if (event.key === 'ArrowLeft') next = order[(index - 1 + order.length) % order.length];
    else if (event.key === 'Home') next = order[0];
    else if (event.key === 'End') next = order.at(-1);
    if (!next) return;
    event.preventDefault();
    setActive(next);
    buttons.current.get(next)?.focus();
  }

  const tabProps = (id) => ({
    type: 'button',
    role: 'tab',
    id: `workspace-tab-${id}`,
    'aria-selected': selected === id,
    'aria-controls': `workspace-panel-${id}`,
    tabIndex: selected === id ? 0 : -1,
    ref: (element) => {
      if (element) buttons.current.set(id, element);
      else buttons.current.delete(id);
    },
    onClick: () => setActive(id),
  });

  return (
    <div className="workspace-tabs">
      <nav className="workspace-tab-strip" role="tablist" aria-label="Workspace" onKeyDown={onKeyDown}>
        <button {...tabProps(CONVERSATION)}>Conversation</button>
        {tabs.map((tab) => (
          <button key={tab.id} {...tabProps(tab.id)}>
            {tab.label}
            {tab.Badge && <tab.Badge />}
          </button>
        ))}
      </nav>
      <div
        className="workspace-tab-panel is-conversation"
        role="tabpanel"
        id={`workspace-panel-${CONVERSATION}`}
        aria-labelledby={`workspace-tab-${CONVERSATION}`}
        hidden={selected !== CONVERSATION}
      >
        {children}
      </div>
      {current && (
        <div
          className="workspace-tab-panel"
          role="tabpanel"
          id={`workspace-panel-${current.id}`}
          aria-labelledby={`workspace-tab-${current.id}`}
        >
          <Suspense fallback={<p className="ws-hint">Loading…</p>}>
            <current.Component />
          </Suspense>
        </div>
      )}
    </div>
  );
}
