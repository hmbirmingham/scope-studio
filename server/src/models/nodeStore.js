import { getPool } from '../db/pool.js';

// Excludes embedding and content_tsv, which are large and internal to retrieval.
const NODE_COLUMNS =
  'id, type, content, source, external_id, project, created_at, last_accessed, ' +
  'last_confirmed_useful, access_count, confirmed_useful_count, token_length, privacy';

function toPgVector(embedding) {
  return embedding ? `[${embedding.join(',')}]` : null;
}

export async function createNode({ ownerId, type, content, embedding, source, project, privacy }) {
  const { rows } = await getPool().query(
    `INSERT INTO nodes (owner_id, type, content, embedding, source, project, privacy)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 'cloud'))
     RETURNING ${NODE_COLUMNS}`,
    [ownerId, type, content, toPgVector(embedding), source ?? null, project ?? null, privacy ?? null]
  );
  return rows[0];
}

export async function getNode(ownerId, id) {
  const { rows } = await getPool().query(
    `UPDATE nodes SET last_accessed = now(), access_count = access_count + 1
     WHERE id = $1 AND owner_id = $2
     RETURNING ${NODE_COLUMNS}`,
    [id, ownerId]
  );
  return rows[0] ?? null;
}

export async function listNodes(ownerId, { project, type } = {}) {
  const conditions = ['owner_id = $1'];
  const values = [ownerId];

  if (project) {
    values.push(project);
    conditions.push(`project = $${values.length}`);
  }
  if (type) {
    values.push(type);
    conditions.push(`type = $${values.length}`);
  }

  const { rows } = await getPool().query(
    `SELECT ${NODE_COLUMNS} FROM nodes WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`,
    values
  );
  return rows;
}

export async function updateNode(ownerId, id, { content, embedding, project, privacy }) {
  const { rows } = await getPool().query(
    `UPDATE nodes SET
       content = COALESCE($3, content),
       embedding = COALESCE($4, embedding),
       project = COALESCE($5, project),
       privacy = COALESCE($6, privacy)
     WHERE id = $1 AND owner_id = $2
     RETURNING ${NODE_COLUMNS}`,
    [id, ownerId, content ?? null, toPgVector(embedding), project ?? null, privacy ?? null]
  );
  return rows[0] ?? null;
}

// The privacy each node has now, by id. Context kept from an earlier turn
// carries node snapshots, and a node can be made private (or deleted) since:
// anything about to resend them asks the database, not the snapshot. A node
// that no longer exists is absent from the map.
export async function currentPrivacy(ownerId, ids) {
  if (ids.length === 0) return new Map();
  const { rows } = await getPool().query('SELECT id, privacy FROM nodes WHERE owner_id = $1 AND id = ANY($2)', [ownerId, ids]);
  return new Map(rows.map((row) => [row.id, row.privacy]));
}

export async function upsertNodeByExternalId({
  ownerId,
  type,
  content,
  embedding,
  source,
  externalId,
  project,
  privacy,
}) {
  const { rows } = await getPool().query(
    `INSERT INTO nodes (owner_id, type, content, embedding, source, external_id, project, privacy)
     VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, 'cloud'))
     ON CONFLICT (owner_id, source, external_id) WHERE external_id IS NOT NULL
     DO UPDATE SET
       content = EXCLUDED.content,
       embedding = COALESCE(EXCLUDED.embedding, nodes.embedding),
       project = EXCLUDED.project,
       last_accessed = now()
     RETURNING ${NODE_COLUMNS}`,
    [ownerId, type, content, toPgVector(embedding), source, externalId, project ?? null, privacy ?? null]
  );
  return rows[0];
}

// Which projects are already on the map, for the repository picker.
export async function listProjects(ownerId) {
  const { rows } = await getPool().query(
    `SELECT project, count(*)::int AS nodes
     FROM nodes
     WHERE owner_id = $1 AND project IS NOT NULL
     GROUP BY project`,
    [ownerId]
  );
  return rows;
}

export async function listNodesMissingEmbedding() {
  const { rows } = await getPool().query('SELECT id, content FROM nodes WHERE embedding IS NULL');
  return rows;
}

export async function setNodeEmbedding(id, embedding) {
  await getPool().query('UPDATE nodes SET embedding = $2 WHERE id = $1', [id, toPgVector(embedding)]);
}

export async function deleteNode(ownerId, id) {
  const { rowCount } = await getPool().query(
    'DELETE FROM nodes WHERE id = $1 AND owner_id = $2',
    [id, ownerId]
  );
  return rowCount > 0;
}

// Both endpoints must belong to the owner, or a user could link into another user's graph.
export async function createRelationship(ownerId, { sourceId, targetId, type, weight }) {
  const { rows } = await getPool().query(
    `INSERT INTO node_relationships (source_id, target_id, type, weight)
     SELECT $1::uuid, $2::uuid, $3::text, COALESCE($4::real, 1.0)
     WHERE $1::uuid <> $2::uuid
       AND (SELECT count(*) FROM nodes WHERE id IN ($1::uuid, $2::uuid) AND owner_id = $5) = 2
     RETURNING *`,
    [sourceId, targetId, type, weight ?? null, ownerId]
  );
  return rows[0] ?? null;
}

export async function listRelationships(ownerId, nodeId) {
  const { rows } = await getPool().query(
    `SELECT r.* FROM node_relationships r
     WHERE (r.source_id = $1 OR r.target_id = $1)
       AND EXISTS (SELECT 1 FROM nodes WHERE id = $1 AND owner_id = $2)`,
    [nodeId, ownerId]
  );
  return rows;
}

// Idempotent variant for ingestion: re-running a sync must not fail on edges
// that already exist.
export async function ensureRelationship(ownerId, { sourceId, targetId, type, weight }) {
  await getPool().query(
    `INSERT INTO node_relationships (source_id, target_id, type, weight)
     SELECT $1::uuid, $2::uuid, $3::text, COALESCE($4::real, 1.0)
     WHERE $1::uuid <> $2::uuid
       AND (SELECT count(*) FROM nodes WHERE id IN ($1::uuid, $2::uuid) AND owner_id = $5) = 2
     ON CONFLICT (source_id, target_id, type) DO NOTHING`,
    [sourceId, targetId, type, weight ?? null, ownerId]
  );
}

// Chunked external ids are "<prefix><index>|<path>". Removes chunks for paths
// no longer present and trailing chunks of files that shrank.
const CHUNK_PATH_SQL = "regexp_replace(external_id, '^[^|]*\\|[^|]*\\|', '')";
const CHUNK_INDEX_SQL = "split_part(external_id, '|', 2)::int";

export async function pruneChunkedNodes(ownerId, source, prefix, { keepPaths, chunkCounts }) {
  const pool = getPool();
  const { rowCount: removedPaths } = await pool.query(
    `DELETE FROM nodes
     WHERE owner_id = $1 AND source = $2 AND starts_with(external_id, $3)
       AND NOT (${CHUNK_PATH_SQL} = ANY($4::text[]))`,
    [ownerId, source, prefix, keepPaths]
  );
  const { rowCount: removedTails } = await pool.query(
    `DELETE FROM nodes n
     USING unnest($4::text[], $5::int[]) AS c(path, count)
     WHERE n.owner_id = $1 AND n.source = $2 AND starts_with(n.external_id, $3)
       AND ${CHUNK_PATH_SQL.replaceAll('external_id', 'n.external_id')} = c.path
       AND ${CHUNK_INDEX_SQL.replaceAll('external_id', 'n.external_id')} >= c.count`,
    [ownerId, source, prefix, chunkCounts.map((c) => c.path), chunkCounts.map((c) => c.count)]
  );
  return removedPaths + removedTails;
}
