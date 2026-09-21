import { getPool } from '../db/pool.js';

// Excludes embedding and content_tsv, which are large and internal to retrieval.
const NODE_COLUMNS =
  'id, type, content, source, external_id, project, created_at, last_accessed, access_count, privacy';

function toPgVector(embedding) {
  return embedding ? `[${embedding.join(',')}]` : null;
}

export async function createNode({ type, content, embedding, source, project, privacy }) {
  const pool = getPool();
  const { rows } = await pool.query(
    `INSERT INTO nodes (type, content, embedding, source, project, privacy)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6, 'cloud'))
     RETURNING ${NODE_COLUMNS}`,
    [type, content, toPgVector(embedding), source ?? null, project ?? null, privacy ?? null]
  );
  return rows[0];
}

export async function getNode(id) {
  const pool = getPool();
  const { rows } = await pool.query(
    `UPDATE nodes SET last_accessed = now(), access_count = access_count + 1
     WHERE id = $1
     RETURNING ${NODE_COLUMNS}`,
    [id]
  );
  return rows[0] ?? null;
}

export async function listNodes({ project, type } = {}) {
  const pool = getPool();
  const conditions = [];
  const values = [];

  if (project) {
    values.push(project);
    conditions.push(`project = $${values.length}`);
  }
  if (type) {
    values.push(type);
    conditions.push(`type = $${values.length}`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT ${NODE_COLUMNS} FROM nodes ${where} ORDER BY created_at DESC`,
    values
  );
  return rows;
}

export async function updateNode(id, { content, embedding, project, privacy }) {
  const pool = getPool();
  const { rows } = await pool.query(
    `UPDATE nodes SET
       content = COALESCE($2, content),
       embedding = COALESCE($3, embedding),
       project = COALESCE($4, project),
       privacy = COALESCE($5, privacy)
     WHERE id = $1
     RETURNING ${NODE_COLUMNS}`,
    [id, content ?? null, toPgVector(embedding), project ?? null, privacy ?? null]
  );
  return rows[0] ?? null;
}

export async function upsertNodeByExternalId({ type, content, embedding, source, externalId, project, privacy }) {
  const pool = getPool();
  const { rows } = await pool.query(
    `INSERT INTO nodes (type, content, embedding, source, external_id, project, privacy)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, 'cloud'))
     ON CONFLICT (source, external_id) WHERE external_id IS NOT NULL
     DO UPDATE SET
       content = EXCLUDED.content,
       embedding = COALESCE(EXCLUDED.embedding, nodes.embedding),
       project = EXCLUDED.project,
       last_accessed = now()
     RETURNING ${NODE_COLUMNS}`,
    [type, content, toPgVector(embedding), source, externalId, project ?? null, privacy ?? null]
  );
  return rows[0];
}

export async function listNodesMissingEmbedding() {
  const pool = getPool();
  const { rows } = await pool.query('SELECT id, content FROM nodes WHERE embedding IS NULL');
  return rows;
}

export async function setNodeEmbedding(id, embedding) {
  const pool = getPool();
  await pool.query('UPDATE nodes SET embedding = $2 WHERE id = $1', [id, toPgVector(embedding)]);
}

export async function deleteNode(id) {
  const pool = getPool();
  const { rowCount } = await pool.query('DELETE FROM nodes WHERE id = $1', [id]);
  return rowCount > 0;
}

export async function createRelationship({ sourceId, targetId, type, weight }) {
  const pool = getPool();
  const { rows } = await pool.query(
    `INSERT INTO node_relationships (source_id, target_id, type, weight)
     VALUES ($1, $2, $3, COALESCE($4, 1.0))
     RETURNING *`,
    [sourceId, targetId, type, weight ?? null]
  );
  return rows[0];
}

export async function listRelationships(nodeId) {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT * FROM node_relationships WHERE source_id = $1 OR target_id = $1`,
    [nodeId]
  );
  return rows;
}
