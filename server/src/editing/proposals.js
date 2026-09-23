import { randomUUID } from 'node:crypto';

// A proposed edit is never applied by the model. It is parsed out of the
// answer, matched against the file it claims to change, and held until the
// user approves it — the plugin that owns the file is what finally writes.

const MAX_PROPOSALS = 200;
const TTL_MS = 2 * 60 * 60 * 1000;

const proposals = new Map();

// <edit path="src/quantify.py">
// <<<<<<< SEARCH
// old
// =======
// new
// >>>>>>> REPLACE
// </edit>
const EDIT_BLOCK = /<edit\s+path="([^"]+)"\s*>([\s\S]*?)<\/edit>/g;
const SEARCH_REPLACE = /<{5,9}\s*SEARCH\s*\n([\s\S]*?)\n={5,9}\s*\n([\s\S]*?)\n>{5,9}\s*REPLACE/;

// The answer is prose with edit blocks in it; anything that is not a
// well-formed block is left as prose rather than guessed at.
export function parseEdits(answer) {
  const edits = [];
  for (const [, path, body] of answer.matchAll(EDIT_BLOCK)) {
    const match = body.match(SEARCH_REPLACE);
    if (!match) continue;
    const [, search, replace] = match;
    if (search.trim() === '' && replace.trim() === '') continue;
    edits.push({ path: path.trim(), search, replace });
  }
  return edits;
}

// Which project the edit belongs to: the retrieved nodes are the only thing
// that ties a bare path to a repository, so an edit to a path we did not
// retrieve has no home and is reported unresolved rather than guessed.
export function resolveProject(path, sources) {
  const owning = sources.find(({ node }) => {
    const heading = node.content?.split('\n')[0] ?? '';
    return node.project && (heading === path || heading.startsWith(`${path} (part`));
  });
  return owning?.node.project ?? null;
}

function prune() {
  const cutoff = Date.now() - TTL_MS;
  for (const [id, proposal] of proposals) {
    if (proposal.createdAt < cutoff) proposals.delete(id);
  }
  while (proposals.size > MAX_PROPOSALS) proposals.delete(proposals.keys().next().value);
}

// Small models abbreviate: they write "# ... (rest of the function)" inside
// the SEARCH text, which can never match the real file. Checking the search
// against the excerpt the model was given catches that here, rather than after
// the user has clicked approve.
const ELISION = /^\s*(#|\/\/|--|<!--)?\s*\.\.\.|\brest of the (function|file|code)\b|^\s*\.\.\.\s*$/im;

export function verifyAgainstSources(edit, sources) {
  if (ELISION.test(edit.search)) {
    return { ok: false, reason: 'the lines to change were abbreviated, so they cannot be matched to the file' };
  }
  const seen = sources.some(({ node }) => node.content?.includes(edit.search));
  return seen
    ? { ok: true, reason: null }
    : { ok: false, reason: 'the lines to change are not in the excerpt that was read' };
}

export function recordProposals({ ownerId, queryId, conversationId, edits, sources }) {
  const recorded = edits.map((edit) => {
    const project = resolveProject(edit.path, sources);
    const verified = verifyAgainstSources(edit, sources);
    const proposal = {
      id: randomUUID(),
      ownerId,
      queryId,
      conversationId,
      path: edit.path,
      project,
      search: edit.search,
      replace: edit.replace,
      state: !project ? 'unresolved' : verified.ok ? 'proposed' : 'unverified',
      note: project ? verified.reason : null,
      createdAt: Date.now(),
      appliedTo: null,
      error: null,
    };
    proposals.set(proposal.id, proposal);
    return proposal;
  });
  prune();
  return recorded;
}

export function getProposal(ownerId, id) {
  const proposal = proposals.get(id);
  return proposal && proposal.ownerId === ownerId ? proposal : null;
}

export function listProposals(ownerId, { conversationId } = {}) {
  return [...proposals.values()].filter(
    (proposal) =>
      proposal.ownerId === ownerId &&
      (!conversationId || proposal.conversationId === conversationId)
  );
}

export function presentProposal(proposal) {
  return {
    id: proposal.id,
    path: proposal.path,
    project: proposal.project,
    state: proposal.state,
    search: proposal.search,
    replace: proposal.replace,
    appliedTo: proposal.appliedTo,
    note: proposal.note ?? null,
    error: proposal.error,
  };
}

export function resetProposals() {
  proposals.clear();
}
