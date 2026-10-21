import { useState } from 'react';
import { listTabs } from './tabs.js';

// The conversation is always the first tab. With nothing else registered the
// strip is not drawn at all, so the conversation looks exactly as it did.
export default function WorkspaceTabs({ children }) {
  const tabs = listTabs();
  const [active, setActive] = useState('conversation');
  if (tabs.length === 0) return children;

  const current = tabs.find((tab) => tab.id === active);
  return (
    <div className="workspace-tabs">
      <nav className="workspace-tab-strip" role="tablist">
        <button type="button" role="tab" aria-selected={!current} onClick={() => setActive('conversation')}>
          Conversation
        </button>
        {tabs.map((tab) => (
          <button key={tab.id} type="button" role="tab" aria-selected={current?.id === tab.id} onClick={() => setActive(tab.id)}>
            {tab.label}
          </button>
        ))}
      </nav>
      {current ? <current.Component /> : children}
    </div>
  );
}
