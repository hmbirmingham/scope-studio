import { getPool } from '../../db/pool.js';
import { gatherCandidates, packForTier } from '../../retrieval/retrieve.js';
import { inReadScope, inScope } from '../permissions.js';

// The read stage: one packed slice of the graph per step. The budget is fixed,
// not a function of how far the run has got, which is the whole point of
// keeping the run's memory in the graph: step 40 reads as much as step 2.
export const SLICE_TOKENS = 1500;
export const SLICE_NODES = 8;
// How many of the nodes this run wrote are offered to each step, most recent
// first. Older ones age out of the slice; they stay in the graph for search
// and for later runs.
export const RUN_NODE_WINDOW = 12;
// The plan and the run's own recent notes outrank ordinary retrieval hits, a
// little less for each step further back, so they compete for the slice
// rather than crowding everything else out.
const PLAN_BOOST = 1.5;
const RUN_NODE_BOOST = 1.25;
const RUN_NODE_DECAY = 0.85;

// A candidate's score as a number. Retrieval without an embedding can leave
// a score undefined or NaN, and NaN compares false with everything, which
// would keep the run's own nodes from ever outranking it.
function scoreOf(entry) {
  const score = Number(entry?.score);
  return Number.isFinite(score) ? score : 0;
}

const NODE_COLUMNS = 'id, type, content, source, project, created_at, token_length, privacy';

async function loadRunNodes(ownerId, ids, db) {
  if (ids.length === 0) return new Map();
  const { rows } = await db.query(`SELECT ${NODE_COLUMNS} FROM nodes WHERE owner_id = $1 AND id = ANY($2)`, [ownerId, ids]);
  return new Map(rows.map((row) => [row.id, row]));
}

// The run's own plan and notes are its working memory, so they are readable
// to it whatever the agent's read sources say (they carry source 'agent');
// the project scope still applies.
function runNodeReadable(agent, node) {
  return inScope(agent?.scopes?.read?.projects, node.project);
}

export async function packSlice({
  ownerId,
  agent,
  goal,
  project = null,
  planNodeId = null,
  runNodeIds = [],
  embed = true,
  gather = gatherCandidates,
  tokens = SLICE_TOKENS,
  maxNodes = SLICE_NODES,
  db = getPool(),
}) {
  const gathered = await gather({ ownerId, query: goal, project, tier: 'local_7b', embed });
  // Retrieval never asks can() per node; it filters by read scope, so a packed
  // slice never holds a node the agent may not read.
  const candidates = gathered.candidates.filter((entry) => inReadScope(agent, entry.node));

  const boostIds = [...new Set([planNodeId, ...runNodeIds.slice(0, RUN_NODE_WINDOW)].filter(Boolean))];
  const runNodes = await loadRunNodes(ownerId, boostIds, db);
  // Retrieval returns the run's own notes too: plan, step and finding nodes
  // score like any other. The window decides which of them the step sees, so
  // a note that has aged out of it does not come back as an ordinary hit; if
  // it did, the older notes that echo the goal would stay in every slice and
  // fill it a little more each step. And the boosts are relative to the best
  // hit from the rest of the graph, not to the run's own notes.
  const runIds = new Set([planNodeId, ...runNodeIds].filter(Boolean));
  const boosted = new Set(boostIds);
  const ordinary = candidates.filter((entry) => !runIds.has(entry.node.id));
  const top = ordinary.reduce((best, entry) => Math.max(best, scoreOf(entry)), 0) || 1;

  const byId = new Map(candidates.filter((entry) => !runIds.has(entry.node.id) || boosted.has(entry.node.id)).map((entry) => [entry.node.id, entry]));
  boostIds.forEach((id, position) => {
    const node = runNodes.get(id);
    if (!node || !runNodeReadable(agent, node)) return;
    const boost = id === planNodeId ? PLAN_BOOST : RUN_NODE_BOOST * RUN_NODE_DECAY ** position;
    const score = top * boost;
    const existing = byId.get(id);
    if (!existing || scoreOf(existing) < score) byId.set(id, { ...(existing ?? {}), node, score, boosts: { run: boost } });
  });

  const ranked = [...byId.values()].sort((a, b) => scoreOf(b) - scoreOf(a));
  const packed = packForTier(ranked, 'local_7b', { max_context_tokens: tokens, max_nodes: maxNodes });
  const nodes = packed.selected.map((entry) => entry.node);
  return {
    nodes,
    tokens: packed.tokens,
    // Private nodes never leave the machine, and neither does a step that read one.
    privateContext: nodes.some((node) => node.privacy === 'local'),
  };
}
