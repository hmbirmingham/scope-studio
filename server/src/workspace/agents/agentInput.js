import { currentPlan } from '../../control/plan.js';
import { roleTemplate } from '../roles.js';
import { getRole } from './roleStore.js';
import {
  DEFAULT_BUDGET,
  DEFAULT_LEVEL,
  DEFAULT_MODEL_POLICY,
  DEFAULT_SCOPES,
  validateBudget,
  validateColor,
  validateLevel,
  validateModelPolicy,
  validateName,
  validateOverrides,
  validateRoleFields,
  validateScopes,
} from './validation.js';

// Turns a create or patch body into complete agent fields, or a rejection
// `{ status, error, message }`. `state` is never settable here: it changes only
// through the pause / resume / kill / reactivate endpoints.
//
// The plan that decides whether `own_key` is allowed is the control plane's
// (control/plan.js): signed out, offline or unconfigured, that is Free.

const reject = (status, error, message) => ({ rejection: { status, error, message } });
const bad = (result) => reject(400, result.error, result.message);
const copyRole = (role) => ({ template: role.template ?? null, title: role.title, description: role.description ?? '', embodiment: role.embodiment ?? '', tags: [...(role.tags ?? [])] });

async function resolveRole(ownerId, body, name) {
  const sources = ['template', 'roleId', 'role'].filter((key) => body[key] !== undefined);
  if (sources.length > 1) return reject(400, 'ambiguous_role', 'give only one of template, roleId and role');
  if (body.template !== undefined) {
    const template = typeof body.template === 'string' ? roleTemplate(body.template) : null;
    return template ? { role: copyRole(template) } : reject(400, 'unknown_template', 'there is no built-in role with that key');
  }
  if (body.roleId !== undefined) {
    const stored = await getRole(ownerId, body.roleId);
    return stored ? { role: copyRole({ ...stored, template: null }) } : reject(404, 'role_not_found', 'no such role');
  }
  if (body.role !== undefined) {
    const checked = validateRoleFields(body.role);
    if (checked.error) return bad(checked);
    return { role: copyRole({ template: null, ...checked.value }) };
  }
  // No role given: a blank custom role named after the agent.
  return { role: copyRole({ template: null, title: name, tags: ['graph'] }) };
}

export async function buildNewAgent(ownerId, body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return reject(400, 'invalid_body', 'the body must be a JSON object');
  const name = validateName(body.name);
  if (name.error) return bad(name);
  const resolved = await resolveRole(ownerId, body, name.value);
  if (resolved.rejection) return resolved;

  const agent = {
    name: name.value,
    role: resolved.role,
    level: DEFAULT_LEVEL,
    overrides: {},
    scopes: structuredClone(DEFAULT_SCOPES),
    modelPolicy: DEFAULT_MODEL_POLICY,
    budget: { ...DEFAULT_BUDGET },
    color: null,
  };
  const checks = [
    ['level', body.level, validateLevel, 'level'],
    ['overrides', body.overrides, validateOverrides, 'overrides'],
    ['scopes', body.scopes, validateScopes, 'scopes'],
    ['budget', body.budget, (v) => validateBudget(v), 'budget'],
    ['color', body.color, validateColor, 'color'],
  ];
  for (const [, value, validate, field] of checks) {
    if (value === undefined) continue;
    const checked = validate(value);
    if (checked.error) return bad(checked);
    agent[field] = checked.value;
  }
  if (body.modelPolicy !== undefined) {
    const checked = validateModelPolicy(body.modelPolicy, await currentPlan(ownerId));
    if (checked.error) return bad(checked);
    agent.modelPolicy = checked.value;
  }
  return { agent };
}

// `current` is the stored agent as presented (camelCase).
export async function buildAgentPatch(ownerId, current, body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return reject(400, 'invalid_body', 'the body must be a JSON object');
  if (body.state !== undefined) return reject(400, 'state_not_editable', 'use pause, resume, kill or reactivate to change state');
  const next = { name: current.name, role: { ...current.role }, level: current.level, overrides: current.overrides, scopes: current.scopes, modelPolicy: current.modelPolicy, budget: current.budget, color: current.color };

  if (body.name !== undefined) {
    const checked = validateName(body.name);
    if (checked.error) return bad(checked);
    next.name = checked.value;
  }
  if (body.role !== undefined) {
    const checked = validateRoleFields(body.role, { partial: true });
    if (checked.error) return bad(checked);
    next.role = { ...next.role, ...checked.value };
  }
  for (const [field, validate] of [['level', validateLevel], ['overrides', validateOverrides], ['scopes', validateScopes], ['color', validateColor]]) {
    if (body[field] === undefined) continue;
    const checked = validate(body[field]);
    if (checked.error) return bad(checked);
    next[field] = checked.value;
  }
  if (body.budget !== undefined) {
    const checked = validateBudget(body.budget, current.budget);
    if (checked.error) return bad(checked);
    next.budget = checked.value;
  }
  if (body.modelPolicy !== undefined) {
    // Re-saving the policy the agent already has is always fine, so a downgraded
    // plan never blocks editing an unrelated field that happens to be re-sent.
    const unchanged = body.modelPolicy === current.modelPolicy;
    const checked = validateModelPolicy(body.modelPolicy, unchanged ? 'key_pro' : await currentPlan(ownerId));
    if (checked.error) return bad(checked);
    next.modelPolicy = checked.value;
  }
  return { next };
}
