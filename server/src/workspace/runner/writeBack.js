import { tryEmbedDocument } from '../../lib/embeddings.js';
import { AGENT_SOURCE, WRITE_BACK_RELATIONSHIPS as REL, inheritPrivacy } from '../nodeTypes.js';

// The write-back stage: what a step learned becomes linked nodes, so the next
// step (and the next run) reads it from the graph instead of a transcript.
// Everything here runs inside the checkpoint transaction, so a crash leaves
// either the step and its nodes, or neither.

const NOTE_MAX_CHARS = 4000;
const NOTES_PER_STEP = 10;
const STEP_OUTPUT_PREVIEW = 800;
// Error text comes from capabilities, verifiers and the model, and can be a
// whole stack trace or a script's output. It is kept short wherever it is
// stored, so a step record or a step node never grows with it.
export const ERROR_MAX_CHARS = 500;
const NOTE_KINDS = [
  ['findings', 'finding'],
  ['decisions', 'decision'],
  ['questions', 'question'],
  ['artifacts', 'artifact'],
];

function clip(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function clipError(text) {
  return text == null ? null : clip(String(text), ERROR_MAX_CHARS);
}

export function outputText(output) {
  if (output == null) return '';
  if (typeof output === 'string') return output;
  try {
    return JSON.stringify(output);
  } catch {
    return String(output);
  }
}

// The nodes a capability's result asks to keep: findings, decisions,
// questions and artifacts, each a string or `{ content, name? }`.
export function notesFrom(result) {
  const notes = [];
  for (const [field, type] of NOTE_KINDS) {
    const entries = Array.isArray(result?.[field]) ? result[field] : [];
    for (const entry of entries) {
      const content = typeof entry === 'string' ? entry : entry?.content != null ? outputText(entry.content) : '';
      const name = typeof entry === 'object' && typeof entry?.name === 'string' ? entry.name : null;
      const text = (name ? `${name}\n\n${content}` : content).trim();
      if (text) notes.push({ type, content: clip(text, NOTE_MAX_CHARS) });
      if (notes.length >= NOTES_PER_STEP) return notes;
    }
  }
  return notes;
}

export async function embedAll(texts, { embed = true } = {}) {
  if (!embed) return texts.map(() => null);
  const vectors = [];
  // One at a time: the step's notes are few, and this keeps a slow embedding
  // from piling requests onto a busy local model.
  for (const text of texts) vectors.push(await tryEmbedDocument(text));
  return vectors;
}

async function insertNode(client, { ownerId, type, content, project, privacy, embedding }) {
  const { rows } = await client.query(
    `INSERT INTO nodes (owner_id, type, content, embedding, source, project, privacy)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, type`,
    [ownerId, type, content, embedding ? `[${embedding.join(',')}]` : null, AGENT_SOURCE, project ?? null, privacy]
  );
  return rows[0];
}

async function link(client, sourceId, targetId, type) {
  if (!sourceId || !targetId) return;
  await client.query(
    'INSERT INTO node_relationships (source_id, target_id, type) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [sourceId, targetId, type]
  );
}

export function planContent({ goal, plan }) {
  return clip(`Plan for: ${clip(goal, 300)}\n\n${plan}`, NOTE_MAX_CHARS);
}

// The plan inherits privacy from what the planner read; like the step node it
// carries no derived_from edges, which the contract reserves for notes.
export async function writePlanNode(client, { ownerId, project, sources, content, embedding }) {
  return insertNode(client, { ownerId, type: 'plan', content, project, privacy: inheritPrivacy(sources), embedding });
}

export function stepContent({ index, capability, status, summary, output, reason }) {
  const lines = [`Step ${index}${capability ? ` · ${capability}` : ''} · ${status}`];
  if (summary) lines.push(summary);
  if (reason) lines.push(`Reason: ${clipError(reason)}`);
  const text = outputText(output).trim();
  if (text) lines.push(`Outcome: ${clip(text, STEP_OUTPUT_PREVIEW)}`);
  return lines.join('\n');
}

// Writes the step node and, for a verified step, its notes. A step that
// failed verification (or was refused) still leaves a step node, marked so,
// which is how later steps learn not to repeat it; it writes no findings.
export async function writeStepNodes(client, { ownerId, project, planNodeId, previousStepNodeId, sources, content, notes = [], embeddings = [] }) {
  const privacy = inheritPrivacy(sources);
  const step = await insertNode(client, { ownerId, type: 'step', content, project, privacy, embedding: embeddings[0] });
  await link(client, step.id, planNodeId, REL.partOf);
  await link(client, step.id, previousStepNodeId, REL.follows);

  const written = [];
  for (const [i, note] of notes.entries()) {
    const node = await insertNode(client, { ownerId, type: note.type, content: note.content, project, privacy, embedding: embeddings[i + 1] });
    await link(client, step.id, node.id, REL.produces);
    for (const source of sources) await link(client, node.id, source.id, REL.derivedFrom);
    written.push(node);
  }
  return { step, notes: written };
}
