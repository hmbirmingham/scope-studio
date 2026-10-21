import { decide } from '../../workspace/permissions.js';
import { readableProjects } from './store.js';
import { ResearchError, normalizeText } from './text.js';

// Input checks and model plumbing shared by the research capabilities.

export function requireText(input, key, { max = 1000 } = {}) {
  const value = input?.[key];
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new ResearchError('invalid_input', `${key} must be a non-empty string of at most ${max} characters`);
  }
  return value.trim();
}

export function optionalInt(input, key, { min, max, fallback }) {
  const value = input?.[key];
  if (value == null) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw new ResearchError('invalid_input', `${key} must be an integer from ${min} to ${max}`);
  return value;
}

// Papers named by the caller: citekeys, DOIs or node ids.
export function optionalRefs(input, key, { max = 20 } = {}) {
  const value = input?.[key];
  if (value == null) return null;
  if (!Array.isArray(value) || value.length === 0 || value.length > max || !value.every((ref) => typeof ref === 'string' && ref.trim() && ref.length <= 300)) {
    throw new ResearchError('invalid_input', `${key} must be a list of 1 to ${max} citekeys, DOIs or paper ids`);
  }
  return value.map((ref) => ref.trim().replace(/^@/, ''));
}

// The projects this step may read, narrowed to `input.project` if given.
export function scopeFor(ctx, input) {
  const projects = readableProjects(ctx.agent);
  if (input?.project == null) return projects;
  if (typeof input.project !== 'string' || !input.project) throw new ResearchError('invalid_input', 'project must be a project name');
  if (projects !== null && !projects.includes(input.project)) throw new ResearchError('outside_read_scope', `the agent may not read project ${input.project}`);
  return [input.project];
}

// A capability that sends library text to ctx.model must not let private
// (local) text reach a cloud model. The runner routes ctx.model by the
// privacy of the step's graph slice, which does not include what the
// capability itself read, so the capability checks for itself: private text
// goes to the model only when this agent could not use the cloud at all
// (offline, a local_only policy, or cloud_model denied by override).
export function assertModelMayRead(ctx, nodes) {
  if (!nodes.some((node) => node?.privacy === 'local')) return;
  if (ctx.model?.offline === true) return;
  const { decision } = decide(ctx.agent, 'cloud_model', { project: ctx.project, online: true, privateContext: false });
  if (decision === 'deny') return;
  throw new ResearchError(
    'private_sources',
    'the excerpts for this step are private (the library was ingested as local) and this agent may use a cloud model; ' +
      'set the agent to local_only, or ingest the library with privacy "cloud" if it may leave this machine'
  );
}

// The whole reply of one model call. Think blocks and code fences that small
// local models add around their answer are removed.
export async function complete(model, { messages, maxTokens, signal }) {
  if (!model?.stream) throw new ResearchError('no_model', 'this capability needs a model');
  let text = '';
  for await (const chunk of model.stream({ messages, maxTokens, signal })) {
    if (chunk?.text) text += chunk.text;
  }
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

export function clip(text, max) {
  const clean = normalizeText(text);
  if (clean.length <= max) return clean;
  const cut = clean.lastIndexOf(' ', max);
  return clean.slice(0, cut > max / 2 ? cut : max);
}

export function byline(paper) {
  const authors = paper.authors ?? [];
  const who = authors.length === 0 ? null : authors.length > 2 ? `${authors[0]} et al.` : authors.join(' and ');
  return [who, paper.year].filter(Boolean).join(', ');
}
