// The workspace tab registry (docs/architecture/agent-workspace.md, "Client").
// A feature registers a tab here and the strip beside the conversation shows
// it; nothing in App needs to know which tabs exist. A tab may also give a
// `Badge` component (the approvals count, say), drawn inside its tab button.

const tabs = [];
const selectListeners = new Set();

export function registerTab({ id, label, order = 100, Component, Badge = null }) {
  if (!id || !label || !Component) throw new Error('a workspace tab needs an id, a label and a Component');
  if (tabs.some((tab) => tab.id === id)) throw new Error(`workspace tab ${id} is already registered`);
  tabs.push({ id, label, order, Component, Badge });
  tabs.sort((a, b) => a.order - b.order);
}

export function listTabs() {
  return [...tabs];
}

// Lets one tab send the user to another ("Run now" opens the run's activity)
// without either knowing how the strip is drawn.
export function selectTab(id) {
  for (const listener of selectListeners) listener(id);
}

export function onSelectTab(listener) {
  selectListeners.add(listener);
  return () => selectListeners.delete(listener);
}

// For tests only: the registry is module state.
export function resetTabsForTest() {
  tabs.length = 0;
  selectListeners.clear();
}
