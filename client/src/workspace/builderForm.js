// The agent builder's form model: turning an Agent into editable fields and
// back into the request bodies of "HTTP shapes", with the same limits the
// server checks (server/src/workspace/agents/validation.js) so most mistakes
// are caught before a round trip. The server's answer still wins: its error
// codes map back onto the field they concern.

import { AGENT_COLORS, DEFAULT_LEVEL } from './permissions.js';

export const LIMITS = { name: 80, title: 120, description: 2000, embodiment: 8000, tags: 20, tag: 40 };
export const DEFAULT_BUDGET = { maxTokens: 200_000, maxUsd: 0.5, maxWallMs: 3_600_000 };

const MS_PER_MINUTE = 60_000;

const scopeFields = (list = []) => ({ all: list.includes('*'), items: list.filter((item) => item !== '*') });
const scopeList = ({ all, items }) => (all ? ['*'] : [...new Set(items)]);

export function blankForm(existingCount = 0) {
  return {
    name: '',
    color: AGENT_COLORS[existingCount % AGENT_COLORS.length],
    start: 'custom',
    role: { template: null, title: '', description: '', embodiment: '', tags: ['graph'] },
    level: DEFAULT_LEVEL,
    overrides: {},
    modelPolicy: 'local_only',
    budget: { maxTokens: String(DEFAULT_BUDGET.maxTokens), maxUsd: String(DEFAULT_BUDGET.maxUsd), wallMinutes: String(DEFAULT_BUDGET.maxWallMs / MS_PER_MINUTE) },
    // A new agent reads anything and writes nowhere until the user grants a project.
    scopes: { readProjects: { all: true, items: [] }, readSources: { all: true, items: [] }, writeProjects: { all: false, items: [] } },
  };
}

export function formFromAgent(agent) {
  const budget = { ...DEFAULT_BUDGET, ...(agent.budget ?? {}) };
  return {
    name: agent.name,
    color: agent.color ?? AGENT_COLORS[0],
    start: agent.role?.template ? `template:${agent.role.template}` : 'custom',
    role: {
      template: agent.role?.template ?? null,
      title: agent.role?.title ?? '',
      description: agent.role?.description ?? '',
      embodiment: agent.role?.embodiment ?? '',
      tags: [...(agent.role?.tags ?? [])],
    },
    level: agent.level ?? DEFAULT_LEVEL,
    overrides: { ...(agent.overrides ?? {}) },
    modelPolicy: agent.modelPolicy ?? 'local_only',
    budget: { maxTokens: String(budget.maxTokens), maxUsd: String(budget.maxUsd), wallMinutes: String(Math.round((budget.maxWallMs / MS_PER_MINUTE) * 100) / 100) },
    scopes: {
      readProjects: scopeFields(agent.scopes?.read?.projects),
      readSources: scopeFields(agent.scopes?.read?.sources),
      writeProjects: scopeFields(agent.scopes?.write?.projects),
    },
  };
}

// Copies a role (template or saved) into the form, keeping everything else.
export function applyRole(form, start, role) {
  return {
    ...form,
    start,
    role: {
      template: start.startsWith('template:') ? role.template : null,
      title: role.title ?? '',
      description: role.description ?? '',
      embodiment: role.embodiment ?? '',
      tags: [...(role.tags ?? [])],
    },
  };
}

const positive = (text) => {
  const value = Number(text);
  return typeof text === 'string' && text.trim() !== '' && Number.isFinite(value) && value > 0 ? value : null;
};

// `{ field: message }`; empty when the form can be sent.
export function validateForm(form, { ownKey = false } = {}) {
  const errors = {};
  const name = form.name.trim();
  if (name.length < 1) errors.name = 'Give the agent a name.';
  else if (name.length > LIMITS.name) errors.name = `A name is at most ${LIMITS.name} characters.`;

  const title = form.role.title.trim();
  if (title.length < 1) errors.role = 'The role needs a title.';
  else if (title.length > LIMITS.title) errors.role = `A role title is at most ${LIMITS.title} characters.`;
  else if (form.role.description.length > LIMITS.description) errors.role = `A description is at most ${LIMITS.description} characters.`;
  else if (form.role.embodiment.length > LIMITS.embodiment) errors.role = `The persona is at most ${LIMITS.embodiment} characters.`;
  else if (form.role.tags.length > LIMITS.tags) errors.role = `A role has at most ${LIMITS.tags} tags.`;
  else if (form.role.tags.some((tag) => !tag || tag.length > LIMITS.tag)) errors.role = `Tags are 1 to ${LIMITS.tag} characters.`;

  if (!/^#[0-9a-f]{6}$/i.test(form.color)) errors.color = 'A colour looks like #rrggbb.';

  const budgetProblems = [];
  if (positive(form.budget.maxTokens) === null || !Number.isInteger(Number(form.budget.maxTokens))) budgetProblems.push('tokens must be a whole number above 0');
  if (positive(form.budget.maxUsd) === null) budgetProblems.push('dollars must be above 0');
  if (positive(form.budget.wallMinutes) === null) budgetProblems.push('minutes must be above 0');
  if (budgetProblems.length) errors.budget = `Budget: ${budgetProblems.join('; ')}.`;

  if (form.modelPolicy === 'own_key' && !ownKey) errors.modelPolicy = 'Your own key needs the Key Pro plan.';
  return errors;
}

function commonFields(form) {
  return {
    name: form.name.trim(),
    color: form.color.toLowerCase(),
    level: form.level,
    overrides: Object.fromEntries(Object.entries(form.overrides).filter(([, value]) => value === 'allow' || value === 'ask' || value === 'deny')),
    modelPolicy: form.modelPolicy,
    budget: {
      maxTokens: Number(form.budget.maxTokens),
      maxUsd: Number(form.budget.maxUsd),
      maxWallMs: Math.round(Number(form.budget.wallMinutes) * MS_PER_MINUTE),
    },
    scopes: {
      read: { projects: scopeList(form.scopes.readProjects), sources: scopeList(form.scopes.readSources) },
      write: { projects: scopeList(form.scopes.writeProjects) },
    },
  };
}

export const roleFields = (role) => ({ title: role.title.trim(), description: role.description, embodiment: role.embodiment, tags: [...new Set(role.tags)] });

function sameRole(a, b) {
  const left = roleFields(a);
  const right = roleFields({ description: '', embodiment: '', tags: [], ...b, title: b.title ?? '' });
  return left.title === right.title && left.description === right.description && left.embodiment === right.embodiment && left.tags.join('\n') === right.tags.join('\n');
}

// The create body, plus the role edits to PATCH right after when the user
// changed a template's fields: creating from `template` is what records which
// built-in the agent started from, and PATCH keeps that key.
export function createRequest(form, sourceRole) {
  const body = commonFields(form);
  if (form.start.startsWith('template:')) {
    body.template = form.start.slice('template:'.length);
    return { body, rolePatch: sourceRole && sameRole(form.role, sourceRole) ? null : roleFields(form.role) };
  }
  if (form.start.startsWith('role:')) {
    body.roleId = form.start.slice('role:'.length);
    return { body, rolePatch: sourceRole && sameRole(form.role, sourceRole) ? null : roleFields(form.role) };
  }
  body.role = roleFields(form.role);
  return { body, rolePatch: null };
}

export function patchRequest(form) {
  return { ...commonFields(form), role: roleFields(form.role) };
}

// Which field a server error code belongs to, so it is shown where it applies.
const FIELD_BY_CODE = {
  invalid_name: 'name',
  invalid_role: 'role',
  unknown_template: 'role',
  role_not_found: 'role',
  ambiguous_role: 'role',
  invalid_level: 'level',
  invalid_overrides: 'overrides',
  invalid_scopes: 'scopes',
  invalid_model_policy: 'modelPolicy',
  own_key_requires_key_pro: 'modelPolicy',
  invalid_budget: 'budget',
  invalid_color: 'color',
};

export function fieldForError(code) {
  return FIELD_BY_CODE[code] ?? 'form';
}
