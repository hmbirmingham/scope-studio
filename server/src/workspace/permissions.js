// The one place that decides whether an agent may do something
// (docs/architecture/agent-workspace.md, "Permission spectrum"). Every
// capability call in the runner asks `can()` first; nothing else grants a
// permission, so a rule changed here changes it everywhere.

export const LEVELS = ['manual', 'supervised', 'sandboxed', 'agentic'];
export const DEFAULT_LEVEL = 'supervised';

export const CAPABILITIES = [
  'read_graph',
  'write_notes',
  'edit_files',
  'run_scripts',
  'run_generated_code',
  'web',
  'cloud_model',
  'open_pr',
  'apply_merge',
];

export const DECISIONS = ['allow', 'ask', 'deny'];

// Scripts run in the project's checkout (or its sandbox copy), so running one
// is a write to that project as far as scope goes.
const WRITE_CAPABILITIES = new Set(['write_notes', 'edit_files', 'run_scripts', 'open_pr', 'apply_merge']);
const NETWORK_CAPABILITIES = new Set(['web', 'cloud_model']);
// Inside the sandbox a sandboxed agent may work freely; the user approves the
// result (open_pr / apply_merge), not each step that produced it.
const SANDBOX_FREE = new Set(['edit_files', 'run_scripts', 'run_generated_code']);

function levelDefault(level, capability, context) {
  switch (level) {
    case 'manual':
      return 'ask';
    case 'supervised':
      return capability === 'read_graph' || capability === 'write_notes' ? 'allow' : 'ask';
    case 'sandboxed':
      if (capability === 'read_graph' || capability === 'write_notes') return 'allow';
      if (SANDBOX_FREE.has(capability)) return context.inSandbox === true ? 'allow' : 'ask';
      return 'ask';
    case 'agentic':
      return 'allow';
    default:
      // An unknown level is treated as the most cautious one, never a free pass.
      return 'ask';
  }
}

export function inScope(list, value) {
  if (!Array.isArray(list)) return false;
  if (list.includes('*')) return true;
  return value != null && list.includes(value);
}

// Whether a node (or a read of one plug-in's data) is inside the agent's read
// scope. Retrieval filters its candidates with this, so a packed slice never
// holds a node the agent may not read.
export function inReadScope(agent, { project, source } = {}) {
  const read = agent?.scopes?.read ?? {};
  if (!inScope(read.projects, project)) return false;
  if (source == null) return Array.isArray(read.sources) && read.sources.includes('*');
  return inScope(read.sources, source);
}

// Reasons are returned alongside the decision so an approval or a refusal can
// say why, and tests can assert on the rule that fired.
export function decide(agent, capability, context = {}) {
  if (!agent) return { decision: 'deny', reason: 'no_agent' };
  if (agent.state === 'killed') return { decision: 'deny', reason: 'agent_killed' };
  if (agent.state === 'paused') return { decision: 'deny', reason: 'agent_paused' };
  // Anything but an explicitly active agent is stopped, so a missing or
  // unexpected state fails closed.
  if (agent.state !== 'active') return { decision: 'deny', reason: 'agent_inactive' };
  if (!CAPABILITIES.includes(capability)) return { decision: 'deny', reason: 'unknown_capability' };

  // Model-written code only ever runs inside the OS sandbox, whatever the level.
  if (capability === 'run_generated_code' && context.inSandbox !== true) {
    return { decision: 'deny', reason: 'outside_sandbox' };
  }

  const scopes = agent.scopes ?? {};
  // A read that does not say which source it reads is only allowed for an
  // agent that may read every source; omitting the field never widens access.
  if (capability === 'read_graph' && !inReadScope(agent, context)) {
    return { decision: 'deny', reason: 'outside_read_scope' };
  }
  if (WRITE_CAPABILITIES.has(capability) && !inScope(scopes.write?.projects, context.project)) {
    return { decision: 'deny', reason: 'outside_write_scope' };
  }

  // Both network checks fail closed: the caller must say it is online, and a
  // cloud call must say its context holds no private node.
  if (NETWORK_CAPABILITIES.has(capability) && context.online !== true) {
    return { decision: 'deny', reason: 'offline' };
  }
  if (capability === 'cloud_model') {
    if ((agent.modelPolicy ?? 'local_only') === 'local_only') return { decision: 'deny', reason: 'local_only_policy' };
    // Private nodes never leave the machine, so a step that read one stays local.
    if (context.privateContext !== false) return { decision: 'deny', reason: 'private_context' };
  }

  const override = agent.overrides?.[capability];
  if (DECISIONS.includes(override)) return { decision: override, reason: 'override' };

  return { decision: levelDefault(agent.level ?? DEFAULT_LEVEL, capability, context), reason: 'level' };
}

export function can(agent, capability, context = {}) {
  return decide(agent, capability, context).decision;
}
