// Node and relationship types a run writes back into the graph
// (docs/architecture/agent-workspace.md, "Graph write-back"). The database
// enforces the same lists (migration 020).

export const WRITE_BACK_TYPES = ['plan', 'step', 'finding', 'decision', 'artifact', 'question'];

export const WRITE_BACK_RELATIONSHIPS = {
  derivedFrom: 'derived_from',
  produces: 'produces',
  follows: 'follows',
  answers: 'answers',
  partOf: 'part_of',
};

export const AGENT_SOURCE = 'agent';

// Anything learned from a private node is private: if one source is local,
// the new node is local, so it can never be sent to a cloud model later.
export function inheritPrivacy(sources = []) {
  return sources.some((node) => node?.privacy === 'local') ? 'local' : 'cloud';
}
