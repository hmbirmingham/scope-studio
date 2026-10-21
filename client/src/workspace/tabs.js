// The workspace tab registry (docs/architecture/agent-workspace.md, "Client").
// A feature registers a tab here and the strip beside the conversation shows
// it; nothing in App needs to know which tabs exist.

const tabs = [];

export function registerTab({ id, label, order = 100, Component }) {
  if (!id || !label || !Component) throw new Error('a workspace tab needs an id, a label and a Component');
  if (tabs.some((tab) => tab.id === id)) throw new Error(`workspace tab ${id} is already registered`);
  tabs.push({ id, label, order, Component });
  tabs.sort((a, b) => a.order - b.order);
}

export function listTabs() {
  return [...tabs];
}
