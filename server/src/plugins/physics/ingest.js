import { tryEmbedDocument } from '../../lib/embeddings.js';
import { upsertNodeByExternalId } from '../../models/nodeStore.js';
import { PhysicsError } from './python.js';
import { PHYSICS_SOURCE } from './nodes.js';

// Ingest for the physics vertical: problem statements a user brings (a
// homework set, a lab's open questions) become `spec` nodes with source
// `physics`, which physics.derive can be pointed at with `problemId`.
// Nothing here touches the network, and a problem's reference answer, if the
// caller has one, is never written: an answer in the graph would hand it to
// the agent that is meant to work it out.

const ID = /^[a-z0-9][a-z0-9._-]{0,99}$/i;
const MAX_PROBLEMS = 100;
const MAX_STATEMENT = 20_000;
const MAX_FIELDS = 32;

function invalid(message) {
  return new PhysicsError('invalid_input', message);
}

function fields(value, label) {
  if (value == null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw invalid(`${label} must be an object`);
  const entries = Object.entries(value);
  if (entries.length > MAX_FIELDS) throw invalid(`${label} has more than ${MAX_FIELDS} entries`);
  for (const [key, item] of entries) {
    if (key.length > 64 || typeof item !== 'string' || item.length > 200) throw invalid(`${label}.${key} must be a short string such as "9.81 m/s^2"`);
  }
  return value;
}

export function validateProblems(body) {
  const { project, problems, privacy = 'local' } = body ?? {};
  if (typeof project !== 'string' || !project.trim() || project.length > 200) throw invalid('project must be a non-empty string');
  if (!['local', 'cloud'].includes(privacy)) throw invalid('privacy must be "local" or "cloud"');
  if (!Array.isArray(problems) || problems.length === 0 || problems.length > MAX_PROBLEMS) throw invalid(`problems must be a list of 1 to ${MAX_PROBLEMS} problems`);
  const seen = new Set();
  const checked = problems.map((problem, i) => {
    if (!problem || typeof problem !== 'object') throw invalid(`problems[${i}] must be an object`);
    if (typeof problem.id !== 'string' || !ID.test(problem.id)) throw invalid(`problems[${i}].id must be letters, digits, ".", "_" or "-"`);
    if (seen.has(problem.id)) throw invalid(`problem ${problem.id} appears twice`);
    seen.add(problem.id);
    if (typeof problem.statement !== 'string' || !problem.statement.trim() || problem.statement.length > MAX_STATEMENT) {
      throw invalid(`problems[${i}].statement must be a non-empty string of at most ${MAX_STATEMENT} characters`);
    }
    if (problem.title != null && (typeof problem.title !== 'string' || problem.title.length > 300)) throw invalid(`problems[${i}].title must be a string`);
    return {
      id: problem.id,
      title: problem.title?.trim() || problem.id,
      statement: problem.statement.trim(),
      given: fields(problem.given, `problems[${i}].given`),
      find: fields(problem.find, `problems[${i}].find`),
    };
  });
  return { project: project.trim(), privacy, problems: checked };
}

export function problemContent(problem) {
  const lines = [`Physics problem: ${problem.title}`, '', problem.statement];
  const given = Object.entries(problem.given);
  const find = Object.entries(problem.find);
  if (given.length) lines.push('', 'Given:', ...given.map(([key, value]) => `- ${key} = ${value}`));
  if (find.length) lines.push('', 'Find:', ...find.map(([key, value]) => `- ${key} [${value}]`));
  return lines.join('\n');
}

// Re-ingesting a problem with the same id updates its node (external_id
// `problem:<id>`) rather than adding another.
export async function ingestProblems(ownerId, body, { onProgress, embed = tryEmbedDocument } = {}) {
  const { project, privacy, problems } = validateProblems(body);
  const nodes = [];
  for (const [i, problem] of problems.entries()) {
    onProgress?.({ done: i, total: problems.length });
    const content = problemContent(problem);
    const node = await upsertNodeByExternalId({
      ownerId,
      type: 'spec',
      content,
      embedding: embed ? await embed(content) : null,
      source: PHYSICS_SOURCE,
      externalId: `problem:${problem.id}`,
      project,
      privacy,
    });
    nodes.push({ id: node.id, problem: problem.id });
  }
  onProgress?.({ done: problems.length, total: problems.length });
  return { project, problems: nodes.length, nodes };
}
