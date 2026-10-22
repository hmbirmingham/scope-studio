import { randomUUID } from 'node:crypto';
import { getNode, ensureRelationship, upsertNodeByExternalId } from '../../models/nodeStore.js';
import { decide } from '../../workspace/permissions.js';
import { PhysicsError } from './python.js';

// The physics plug-in's own nodes: `derivation` and `computation` (migration
// 039), source `physics`, written by the capability that made them once its
// checks have passed, and linked `derived_from` what they were built on.

export const PHYSICS_SOURCE = 'physics';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A node a capability reads by id: the run owner's, and inside the agent's
// read scope, which the capability asks about itself (the contract's
// "a capability that reads one plug-in's data asks can(read_graph)").
export async function readNode(ctx, id, { types } = {}) {
  if (typeof id !== 'string' || !UUID.test(id)) throw new PhysicsError('invalid_input', `${id} is not a node id`);
  const node = await getNode(ctx.ownerId, id);
  if (!node) throw new PhysicsError('not_found', `node ${id} does not exist`);
  const { decision, reason } = decide(ctx.agent, 'read_graph', { project: node.project, source: node.source });
  if (decision !== 'allow') throw new PhysicsError('read_denied', `this agent may not read node ${id} (${reason})`);
  if (types && !types.includes(node.type)) throw new PhysicsError('wrong_node_type', `node ${id} is a ${node.type}, not a ${types.join(' or ')}`);
  return node;
}

// Anything learned from a private node is private (inheritPrivacy in the
// contract). The capability is not told whether the step's graph slice held
// a private node, so it fails closed: the node is local unless the context
// says outright that it held none and every node it was built on is cloud.
export function physicsPrivacy(ctx, sources = []) {
  if (ctx?.privateContext !== false) return 'local';
  return sources.some((node) => node?.privacy !== 'cloud') ? 'local' : 'cloud';
}

// Keyed by the step, so a step that is run again after a crash updates its
// node instead of adding a second one.
export async function writePhysicsNode(ctx, { type, content, sources = [], embed }) {
  const key = ctx.step?.id ?? null;
  const node = await upsertNodeByExternalId({
    ownerId: ctx.ownerId,
    type,
    content,
    embedding: embed ? await embed(content) : null,
    source: PHYSICS_SOURCE,
    externalId: key ? `${type}:${key}` : `${type}:${randomUUID()}`,
    project: ctx.project ?? null,
    privacy: physicsPrivacy(ctx, sources),
  });
  for (const source of sources) {
    await ensureRelationship(ctx.ownerId, { sourceId: node.id, targetId: source.id, type: 'derived_from' });
  }
  return node;
}
