import { getPool } from '../db/pool.js';

// The canvas draws every node at once, so this payload carries only what a
// point on the map needs: size (token_length), type, privacy, and a label for
// hover. Content stays out — it is the bulk of the row and the inspector
// fetches it per node.
const MAX_NODES = 5000;
const LABEL_LENGTH = 80;

export async function getGraph(ownerId, { project, limit = MAX_NODES } = {}) {
  const pool = getPool();
  const filters = project ? 'AND project = $2' : '';
  const values = project ? [ownerId, project] : [ownerId];

  const { rows: nodes } = await pool.query(
    `SELECT id, type, project, privacy, source, token_length, access_count,
            confirmed_useful_count, created_at,
            left(split_part(content, E'\n', 1), ${LABEL_LENGTH}) AS label
     FROM nodes
     WHERE owner_id = $1 ${filters}
     ORDER BY project NULLS LAST, created_at
     LIMIT ${Number(limit)}`,
    values
  );

  const { rows: counted } = await pool.query(
    `SELECT count(*)::int AS total FROM nodes WHERE owner_id = $1 ${filters}`,
    values
  );

  const ids = nodes.map((node) => node.id);
  const { rows: edges } = await pool.query(
    `SELECT source_id, target_id, type, weight
     FROM node_relationships
     WHERE source_id = ANY($1::uuid[]) AND target_id = ANY($1::uuid[])`,
    [ids]
  );

  // Project totals cover the whole corpus, not the truncated page: the sidebar
  // reports what is ingested, and a project counts as private if any node is.
  const { rows: projects } = await pool.query(
    `SELECT project, count(*)::int AS nodes, COALESCE(sum(token_length), 0)::int AS tokens,
            bool_or(privacy = 'local') AS has_local
     FROM nodes
     WHERE owner_id = $1 AND project IS NOT NULL
     GROUP BY project
     ORDER BY tokens DESC`,
    [ownerId]
  );

  return {
    nodes: nodes.map((node) => ({
      id: node.id,
      type: node.type,
      project: node.project,
      privacy: node.privacy,
      source: node.source,
      label: node.label,
      tokenLength: node.token_length,
      // Chunking caps token_length near 800, so it barely varies across file
      // nodes; usage counts give the canvas a second, livelier size signal.
      accessCount: node.access_count,
      confirmedUsefulCount: node.confirmed_useful_count,
      createdAt: node.created_at,
    })),
    edges: edges.map((edge) => ({
      source: edge.source_id,
      target: edge.target_id,
      type: edge.type,
      weight: Number(edge.weight),
    })),
    projects: projects.map((row) => ({
      project: row.project,
      nodes: row.nodes,
      tokens: row.tokens,
      privacy: row.has_local ? 'local' : 'cloud',
    })),
    truncated: counted[0].total > nodes.length,
    total: counted[0].total,
  };
}
