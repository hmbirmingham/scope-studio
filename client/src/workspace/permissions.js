// Labels and the level-default table from "Permission spectrum" in
// docs/architecture/agent-workspace.md, for the builder to explain a level
// before it is saved. The server's can() is the only thing that decides; the
// grid shows its answer for a saved agent beside these defaults.

export const LEVELS = [
  { id: 'manual', label: 'Manual', blurb: 'Asks before every action, even reading the map.' },
  { id: 'supervised', label: 'Supervised', blurb: 'Reads and takes notes freely; asks before anything else.' },
  { id: 'sandboxed', label: 'Sandboxed autonomous', blurb: 'Works freely inside a sandbox copy; asks before anything leaves it.' },
  { id: 'agentic', label: 'Fully agentic', blurb: 'Acts without asking, within its scopes and the hard limits.' },
];

export const DEFAULT_LEVEL = 'supervised';

export const CAPABILITIES = [
  { id: 'read_graph', label: 'Read the map', blurb: 'Read nodes in the read scope.' },
  { id: 'write_notes', label: 'Write notes', blurb: 'Write plan, step, finding, decision, artifact and question nodes.' },
  { id: 'edit_files', label: 'Edit files', blurb: 'Change files in a sandbox copy or the checkout.' },
  { id: 'run_scripts', label: 'Run scripts', blurb: 'Run a verifier or a script the project declares.' },
  { id: 'run_generated_code', label: 'Run model-written code', blurb: 'Only ever inside the OS sandbox.' },
  { id: 'web', label: 'Use the web', blurb: 'Fetch from or search the web.' },
  { id: 'cloud_model', label: 'Use a cloud model', blurb: 'Send a step to a cloud model.' },
  { id: 'open_pr', label: 'Open pull requests', blurb: 'Open a pull request with the agent’s changes.' },
  { id: 'apply_merge', label: 'Apply or merge', blurb: 'Apply a result to the checkout or merge a pull request.' },
];

export const OVERRIDE_CHOICES = [
  { id: 'inherit', label: 'Level default' },
  { id: 'allow', label: 'Allow' },
  { id: 'ask', label: 'Ask' },
  { id: 'deny', label: 'Deny' },
];

const SANDBOX_FREE = new Set(['edit_files', 'run_scripts', 'run_generated_code']);

// `{ decision, note }`; the note carries the table's "in sandbox" qualifiers.
export function levelDefault(level, capability) {
  const quiet = capability === 'read_graph' || capability === 'write_notes';
  switch (level) {
    case 'supervised':
      return { decision: quiet ? 'allow' : 'ask', note: null };
    case 'sandboxed':
      if (quiet) return { decision: 'allow', note: null };
      if (capability === 'run_generated_code') return { decision: 'allow', note: 'in sandbox only' };
      if (SANDBOX_FREE.has(capability)) return { decision: 'allow', note: 'in sandbox, else ask' };
      return { decision: 'ask', note: null };
    case 'agentic':
      return { decision: 'allow', note: capability === 'run_generated_code' ? 'in sandbox only' : null };
    default:
      return { decision: 'ask', note: null };
  }
}

// What the grid expects for an edited (perhaps unsaved) agent, ignoring the
// hard denials that depend on where and how a step runs.
export function expectedDecision(level, overrides, capability) {
  const override = overrides?.[capability];
  // No override lifts the hard limit on model-written code: can() denies it
  // outside the sandbox whatever the setting, so an Allow says so.
  if (override === 'allow' && capability === 'run_generated_code') return { decision: 'allow', note: 'in sandbox only' };
  if (override === 'allow' || override === 'ask' || override === 'deny') return { decision: override, note: 'override' };
  return levelDefault(level, capability);
}

export const MODEL_POLICIES = [
  { id: 'local_only', label: 'Local only', blurb: 'Every step runs on this machine. Nothing leaves it.' },
  { id: 'local_cloud', label: 'Local + cloud for hard steps', blurb: 'Planning and hard steps may use the cloud, when your plan allows it.' },
  { id: 'own_key', label: 'Own key', blurb: 'Planning and hard steps use your own Anthropic key.', needsOwnKey: true },
];

export const KNOWN_TAGS = ['graph', 'research', 'web', 'code', 'scripts', 'vcs', 'sandbox', 'physics', 'kicad', 'cad'];
export const KNOWN_SOURCES = ['github', 'kicad', 'local', 'web'];

// The server's palette (server/src/workspace/agents/validation.js), offered
// as swatches; any #rrggbb is accepted.
export const AGENT_COLORS = ['#e5484d', '#3e63dd', '#30a46c', '#f5a524', '#8e4ec6', '#12a594', '#d6409f', '#0090ff'];

export const DECISION_LABELS = { allow: 'Allow', ask: 'Ask', deny: 'Deny' };

// The server's reasons, in words.
export const REASON_LABELS = {
  agent_killed: 'the agent is stopped by the kill switch',
  agent_paused: 'the agent is paused',
  agent_inactive: 'the agent is not active',
  unknown_capability: 'unknown capability',
  outside_sandbox: 'only inside the OS sandbox',
  outside_read_scope: 'outside the read scope',
  outside_write_scope: 'outside the write scope',
  offline: 'needs to be online',
  local_only_policy: 'the model policy is local only',
  private_context: 'the step holds private nodes',
  no_agent: 'no such agent',
  override: 'set by override',
  level: 'level default',
};

export function reasonText(reason) {
  return REASON_LABELS[reason] ?? (reason ? reason.replaceAll('_', ' ') : '');
}

// The project a new run or task for this agent should target unless the user
// picks another. A run writes its plan and notes into its project, and an
// agent writes only into the projects its write scope names, so a run with
// no project (or another one) would be refused at its first step. An agent
// that may write to exactly one of the listed projects gets that one;
// anything else (several, every project, none) leaves the choice to the user.
export function defaultProjectFor(agent, projectNames = []) {
  const writable = agent?.scopes?.write?.projects ?? [];
  if (writable.includes('*')) return '';
  const candidates = writable.filter((project) => projectNames.includes(project));
  return candidates.length === 1 ? candidates[0] : '';
}

// Plug-in capabilities by what they do, for the step stream and approvals.
// A capability not listed here (a new vertical's) shows its own name.
export const PLUGIN_CAPABILITY_LABELS = {
  'code.search': 'Search the code',
  'code.read': 'Read a file',
  'code.edit': 'Edit a file in the sandbox copy',
  'code.run_script': 'Run a project script',
  'code.run_generated': 'Run code in the sandbox',
  'graph.write_artifact': 'Save to the map',
};

export function capabilityLabel(name) {
  if (!name) return null;
  return PLUGIN_CAPABILITY_LABELS[name] ?? CAPABILITIES.find((capability) => capability.id === name)?.label ?? name;
}

// The runner writes a step approval's summary as "<capability>: <what the
// step does>". The capability is shown as a label beside it, so the prefix
// is dropped rather than shown twice.
export function approvalSummary(approval) {
  const summary = approval?.summary ?? '';
  const prefix = `${approval?.capability}: `;
  return summary.startsWith(prefix) ? summary.slice(prefix.length) : summary;
}
