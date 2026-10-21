import { getPool } from '../../db/pool.js';
import { isUuid } from './validation.js';

// The user's own reusable roles. Every query carries owner_id, so another
// user's role is simply not found.

export async function listRoles(ownerId) {
  const { rows } = await getPool().query('SELECT * FROM agent_roles WHERE owner_id = $1 ORDER BY created_at, id', [ownerId]);
  return rows;
}

export async function getRole(ownerId, id) {
  if (!isUuid(id)) return null;
  const { rows } = await getPool().query('SELECT * FROM agent_roles WHERE id = $1 AND owner_id = $2', [id, ownerId]);
  return rows[0] ?? null;
}

export async function createRole(ownerId, { title, description = '', embodiment = '', tags = [] }) {
  const { rows } = await getPool().query(
    `INSERT INTO agent_roles (owner_id, title, description, embodiment, tags)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [ownerId, title, description, embodiment, tags]
  );
  return rows[0];
}

export async function updateRole(ownerId, id, patch) {
  if (!isUuid(id)) return null;
  const { rows } = await getPool().query(
    `UPDATE agent_roles SET
       title = COALESCE($3, title),
       description = COALESCE($4, description),
       embodiment = COALESCE($5, embodiment),
       tags = COALESCE($6, tags),
       updated_at = now()
     WHERE id = $1 AND owner_id = $2 RETURNING *`,
    [id, ownerId, patch.title ?? null, patch.description ?? null, patch.embodiment ?? null, patch.tags ?? null]
  );
  return rows[0] ?? null;
}

export async function deleteRole(ownerId, id) {
  if (!isUuid(id)) return false;
  const { rowCount } = await getPool().query('DELETE FROM agent_roles WHERE id = $1 AND owner_id = $2', [id, ownerId]);
  return rowCount > 0;
}
