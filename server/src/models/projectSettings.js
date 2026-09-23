import { getPool } from '../db/pool.js';

export async function getProjectSettings(ownerId, project) {
  const { rows } = await getPool().query(
    'SELECT project, local_path FROM project_settings WHERE owner_id = $1 AND project = $2',
    [ownerId, project]
  );
  return rows[0] ? { project: rows[0].project, localPath: rows[0].local_path } : null;
}

export async function listProjectSettings(ownerId) {
  const { rows } = await getPool().query(
    'SELECT project, local_path FROM project_settings WHERE owner_id = $1 ORDER BY project',
    [ownerId]
  );
  return rows.map((row) => ({ project: row.project, localPath: row.local_path }));
}

export async function setProjectPath(ownerId, project, localPath) {
  const { rows } = await getPool().query(
    `INSERT INTO project_settings (owner_id, project, local_path)
     VALUES ($1, $2, $3)
     ON CONFLICT (owner_id, project)
     DO UPDATE SET local_path = EXCLUDED.local_path, updated_at = now()
     RETURNING project, local_path`,
    [ownerId, project, localPath]
  );
  return { project: rows[0].project, localPath: rows[0].local_path };
}
