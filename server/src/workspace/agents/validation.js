// Input validation for agents, roles, tasks and approvals. Every function
// returns `{ value }` or `{ error, message }`; the routes turn the latter into
// a 400. Codes are specific so the UI can point at the offending field.

import { CAPABILITIES, DECISIONS, DEFAULT_LEVEL, LEVELS } from '../permissions.js';
import { MODEL_POLICIES } from '../modelPort.js';
import { validateCron } from '../cron.js';

export const DEFAULT_BUDGET = Object.freeze({ maxTokens: 200_000, maxUsd: 0.5, maxWallMs: 3_600_000 });
export const DEFAULT_MODEL_POLICY = 'local_only';
// A new agent reads anything and writes nowhere until the user grants a project.
export const DEFAULT_SCOPES = Object.freeze({ read: { projects: ['*'], sources: ['*'] }, write: { projects: [] } });

// Fixed palette; an agent's colour is picked from it by position so the first
// few agents a user makes are always visibly distinct.
export const AGENT_COLORS = ['#e5484d', '#3e63dd', '#30a46c', '#f5a524', '#8e4ec6', '#12a594', '#d6409f', '#0090ff'];

const LIMITS = { name: 80, title: 120, description: 2000, embodiment: 8000, tags: 20, tag: 40, scopeItems: 200, scopeItem: 200 };
export const TASK_LIMITS = { title: 200, instructions: 20_000, project: 200 };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value) => typeof value === 'string' && UUID.test(value);

const fail = (error, message) => ({ error, message });
const ok = (value) => ({ value });
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value, max) => typeof value === 'string' && value.length <= max;

export function validateName(name) {
  if (typeof name !== 'string' || name.trim().length < 1 || name.trim().length > LIMITS.name) {
    return fail('invalid_name', `name must be 1 to ${LIMITS.name} characters`);
  }
  return ok(name.trim());
}

export function validateLevel(level) {
  return LEVELS.includes(level) ? ok(level) : fail('invalid_level', `level must be one of ${LEVELS.join(', ')}`);
}

export function validateOverrides(overrides) {
  if (!isObject(overrides)) return fail('invalid_overrides', 'overrides must be an object');
  for (const [capability, decision] of Object.entries(overrides)) {
    if (!CAPABILITIES.includes(capability)) return fail('invalid_overrides', `unknown capability "${capability}"`);
    if (!DECISIONS.includes(decision)) return fail('invalid_overrides', `override for ${capability} must be one of ${DECISIONS.join(', ')}`);
  }
  return ok({ ...overrides });
}

function scopeList(list, label) {
  if (!Array.isArray(list) || list.length > LIMITS.scopeItems) return fail('invalid_scopes', `${label} must be a list`);
  for (const item of list) {
    if (typeof item !== 'string' || item.length < 1 || item.length > LIMITS.scopeItem) {
      return fail('invalid_scopes', `${label} must hold non-empty strings`);
    }
  }
  return ok([...new Set(list)]);
}

// A scope left out is empty, never "everything": omitting a field can only
// narrow what an agent may touch.
export function validateScopes(scopes) {
  if (!isObject(scopes)) return fail('invalid_scopes', 'scopes must be an object');
  const { read = {}, write = {} } = scopes;
  if (!isObject(read) || !isObject(write)) return fail('invalid_scopes', 'scopes.read and scopes.write must be objects');
  const readProjects = scopeList(read.projects ?? [], 'scopes.read.projects');
  if (readProjects.error) return readProjects;
  const readSources = scopeList(read.sources ?? [], 'scopes.read.sources');
  if (readSources.error) return readSources;
  const writeProjects = scopeList(write.projects ?? [], 'scopes.write.projects');
  if (writeProjects.error) return writeProjects;
  return ok({ read: { projects: readProjects.value, sources: readSources.value }, write: { projects: writeProjects.value } });
}

// `own_key` needs the Key Pro plan; the plan is looked up by the caller.
export function validateModelPolicy(policy, plan) {
  if (!MODEL_POLICIES.includes(policy)) return fail('invalid_model_policy', `modelPolicy must be one of ${MODEL_POLICIES.join(', ')}`);
  if (policy === 'own_key' && plan !== 'key_pro') return fail('own_key_requires_key_pro', 'own_key needs the Key Pro plan');
  return ok(policy);
}

export function validateBudget(budget, base = DEFAULT_BUDGET) {
  if (!isObject(budget)) return fail('invalid_budget', 'budget must be an object');
  const merged = { ...base };
  for (const [key, value] of Object.entries(budget)) {
    if (!(key in DEFAULT_BUDGET)) return fail('invalid_budget', `unknown budget limit "${key}"`);
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      return fail('invalid_budget', `${key} must be a positive number`);
    }
    merged[key] = value;
  }
  return ok(merged);
}

export function validateColor(color) {
  return typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)
    ? ok(color.toLowerCase())
    : fail('invalid_color', 'color must look like #rrggbb');
}

// A role is `{ title, description, embodiment, tags }`. With `partial` only the
// fields present are checked (for PATCH); otherwise a title is required.
export function validateRoleFields(input, { partial = false } = {}) {
  if (!isObject(input)) return fail('invalid_role', 'role must be an object');
  const out = {};
  if (input.title !== undefined || !partial) {
    if (typeof input.title !== 'string' || input.title.trim().length < 1 || input.title.length > LIMITS.title) {
      return fail('invalid_role', `role title must be 1 to ${LIMITS.title} characters`);
    }
    out.title = input.title.trim();
  }
  for (const key of ['description', 'embodiment']) {
    if (input[key] === undefined) continue;
    if (!isText(input[key], LIMITS[key])) return fail('invalid_role', `role ${key} must be text of at most ${LIMITS[key]} characters`);
    out[key] = input[key];
  }
  if (input.tags !== undefined) {
    if (!Array.isArray(input.tags) || input.tags.length > LIMITS.tags) return fail('invalid_role', 'role tags must be a short list');
    for (const tag of input.tags) {
      if (typeof tag !== 'string' || tag.length < 1 || tag.length > LIMITS.tag) return fail('invalid_role', 'role tags must be non-empty strings');
    }
    out.tags = [...new Set(input.tags)];
  }
  return ok(out);
}

export function validateTask(input, { partial = false } = {}) {
  if (!isObject(input)) return fail('invalid_body', 'the body must be a JSON object');
  const out = {};
  if (input.title !== undefined || !partial) {
    if (typeof input.title !== 'string' || input.title.trim().length < 1 || input.title.length > TASK_LIMITS.title) {
      return fail('invalid_title', `title must be 1 to ${TASK_LIMITS.title} characters`);
    }
    out.title = input.title.trim();
  }
  if (input.instructions !== undefined || !partial) {
    if (typeof input.instructions !== 'string' || input.instructions.trim().length < 1 || input.instructions.length > TASK_LIMITS.instructions) {
      return fail('invalid_instructions', `instructions must be 1 to ${TASK_LIMITS.instructions} characters`);
    }
    out.instructions = input.instructions;
  }
  if (input.project !== undefined) {
    if (input.project !== null && (typeof input.project !== 'string' || input.project.length < 1 || input.project.length > TASK_LIMITS.project)) {
      return fail('invalid_project', 'project must be a non-empty string or null');
    }
    out.project = input.project;
  }
  if (input.schedule !== undefined) {
    if (input.schedule !== null) {
      const message = typeof input.schedule === 'string' ? validateCron(input.schedule) : 'a schedule must be a string';
      if (message) return fail('invalid_schedule', message);
    }
    out.schedule = input.schedule === null ? null : input.schedule.trim();
  }
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') return fail('invalid_enabled', 'enabled must be true or false');
    out.enabled = input.enabled;
  }
  if (input.agentId !== undefined || !partial) {
    if (!isUuid(input.agentId)) return fail('invalid_agent', 'agentId must be an agent id');
    out.agentId = input.agentId;
  }
  return ok(out);
}

export { DEFAULT_LEVEL };
