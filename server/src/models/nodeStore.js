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
